import type { ManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import {
  serializeCanonicalManuscriptOutline,
  type ManuscriptOutlineTypedValues
} from "./manuscriptOutlineSerializer";

export const STRUCTURED_OUTLINE_ARCHIVE_BEGIN_TOKEN =
  "LABPOD:STRUCTURED_OUTLINE_ARCHIVE_BEGIN_V1" as const;
export const STRUCTURED_OUTLINE_ARCHIVE_END_TOKEN =
  "LABPOD:STRUCTURED_OUTLINE_ARCHIVE_END_V1" as const;

export type StructuredOutlineArchiveIdentityTerminal =
  | "UNIQUE"
  | "NONE"
  | "MULTIPLE_OR_AMBIGUOUS";

export type StructuredOutlineArchiveParserProtocolTerminal =
  | "EXECUTABLE"
  | "TECHNICAL_FAILURE";

export type StructuredOutlineArchiveLineTerminator =
  | "LF"
  | "CRLF"
  | "CR"
  | "NONE";

export interface StructuredOutlineArchiveMarkerLineSpan {
  readonly markerKind: "BEGIN" | "END";
  readonly lineStartByte: number;
  readonly markerLineEndByte: number;
  readonly ownedEndByte: number;
  readonly lineTerminator: StructuredOutlineArchiveLineTerminator;
}

export interface StructuredOutlineArchivePair {
  readonly beginMarker: StructuredOutlineArchiveMarkerLineSpan;
  readonly endMarker: StructuredOutlineArchiveMarkerLineSpan;
  readonly archiveInternalContentStartByte: number;
  readonly archiveInternalContentEndByte: number;
  readonly archiveBlockStartByte: number;
  readonly archiveBlockEndByte: number;
}

export type StructuredOutlineArchiveIdentity = Readonly<{
  terminal: StructuredOutlineArchiveIdentityTerminal;
  exactBeginMarkerCount: number;
  exactEndMarkerCount: number;
  exactMarkerLines: readonly StructuredOutlineArchiveMarkerLineSpan[];
  pair?: StructuredOutlineArchivePair;
}>;

export type StructuredOutlineArchiveParserInput =
  | Readonly<{
      parserProtocolTerminal: "EXECUTABLE";
      archiveIdentityTerminal: StructuredOutlineArchiveIdentityTerminal;
      identity: StructuredOutlineArchiveIdentity;
      canonicalParserInputRawMarkdown: string;
      useCanonicalEmptyOutline: boolean;
    }>
  | Readonly<{
      parserProtocolTerminal: "TECHNICAL_FAILURE";
      archiveIdentityTerminal: "UNIQUE";
      identity: StructuredOutlineArchiveIdentity;
      errorCode: "STRUCTURED_OUTLINE_ARCHIVE_INTERIOR_INVALID_UTF8";
    }>;

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);
const BEGIN_NO_HINT = encoder.encode(
  `<!-- ${STRUCTURED_OUTLINE_ARCHIVE_BEGIN_TOKEN} -->`
);
const BEGIN_HINT_PREFIX = encoder.encode(
  `<!-- ${STRUCTURED_OUTLINE_ARCHIVE_BEGIN_TOKEN} | `
);
const END_MARKER = encoder.encode(
  `<!-- ${STRUCTURED_OUTLINE_ARCHIVE_END_TOKEN} -->`
);
const COMMENT_SUFFIX = encoder.encode(" -->");

function bytesEqual(
  value: Uint8Array,
  expected: Uint8Array,
  start = 0,
  end = value.length
) {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (value[start + index] !== expected[index]) return false;
  }
  return true;
}

function startsWithBytes(value: Uint8Array, expected: Uint8Array) {
  if (value.length < expected.length) return false;
  return bytesEqual(value, expected, 0, expected.length);
}

function endsWithBytes(value: Uint8Array, expected: Uint8Array) {
  if (value.length < expected.length) return false;
  return bytesEqual(
    value,
    expected,
    value.length - expected.length,
    value.length
  );
}

function hasUtf8Bom(value: Uint8Array) {
  return value.length >= UTF8_BOM.length &&
    UTF8_BOM.every((byte, index) => value[index] === byte);
}

function containsDoubleHyphen(
  value: Uint8Array,
  start: number,
  end: number
) {
  for (let index = start; index + 1 < end; index += 1) {
    if (value[index] === 0x2d && value[index + 1] === 0x2d) return true;
  }
  return false;
}

function isExactBeginMarkerLine(line: Uint8Array) {
  if (bytesEqual(line, BEGIN_NO_HINT)) return true;
  if (
    !startsWithBytes(line, BEGIN_HINT_PREFIX) ||
    !endsWithBytes(line, COMMENT_SUFFIX)
  ) return false;
  const hintStart = BEGIN_HINT_PREFIX.length;
  const hintEnd = line.length - COMMENT_SUFFIX.length;
  return hintEnd > hintStart && !containsDoubleHyphen(line, hintStart, hintEnd);
}

function isExactEndMarkerLine(line: Uint8Array) {
  return bytesEqual(line, END_MARKER);
}

function scanExactMarkerLines(rawBytes: Uint8Array) {
  const markers: StructuredOutlineArchiveMarkerLineSpan[] = [];
  let cursor = hasUtf8Bom(rawBytes) ? UTF8_BOM.length : 0;
  while (cursor <= rawBytes.length) {
    const lineStartByte = cursor;
    let markerLineEndByte = cursor;
    while (
      markerLineEndByte < rawBytes.length &&
      rawBytes[markerLineEndByte] !== 0x0a &&
      rawBytes[markerLineEndByte] !== 0x0d
    ) markerLineEndByte += 1;

    let ownedEndByte = markerLineEndByte;
    let lineTerminator: StructuredOutlineArchiveLineTerminator = "NONE";
    if (rawBytes[markerLineEndByte] === 0x0d) {
      if (rawBytes[markerLineEndByte + 1] === 0x0a) {
        ownedEndByte += 2;
        lineTerminator = "CRLF";
      } else {
        ownedEndByte += 1;
        lineTerminator = "CR";
      }
    } else if (rawBytes[markerLineEndByte] === 0x0a) {
      ownedEndByte += 1;
      lineTerminator = "LF";
    }

    const line = rawBytes.slice(lineStartByte, markerLineEndByte);
    const markerKind = isExactBeginMarkerLine(line)
      ? "BEGIN" as const
      : isExactEndMarkerLine(line)
        ? "END" as const
        : undefined;
    if (markerKind) {
      markers.push(Object.freeze({
        markerKind,
        lineStartByte,
        markerLineEndByte,
        ownedEndByte,
        lineTerminator
      }));
    }
    if (ownedEndByte >= rawBytes.length) break;
    cursor = ownedEndByte;
  }
  return Object.freeze(markers);
}

/**
 * The sole V1 Archive identity authority. It only recognizes exact physical
 * comment lines; legacy outline markers and nearby lookalikes are BODY bytes.
 */
export function resolveStructuredOutlineArchiveIdentity(
  sourceBytes: Uint8Array
): StructuredOutlineArchiveIdentity {
  const exactMarkerLines = scanExactMarkerLines(sourceBytes);
  const begins = exactMarkerLines.filter((marker) => marker.markerKind === "BEGIN");
  const ends = exactMarkerLines.filter((marker) => marker.markerKind === "END");
  if (begins.length === 0 && ends.length === 0) {
    return Object.freeze({
      terminal: "NONE",
      exactBeginMarkerCount: 0,
      exactEndMarkerCount: 0,
      exactMarkerLines
    });
  }
  if (
    begins.length === 1 &&
    ends.length === 1 &&
    begins[0].ownedEndByte <= ends[0].lineStartByte
  ) {
    const pair: StructuredOutlineArchivePair = Object.freeze({
      beginMarker: begins[0],
      endMarker: ends[0],
      archiveInternalContentStartByte: begins[0].ownedEndByte,
      archiveInternalContentEndByte: ends[0].lineStartByte,
      archiveBlockStartByte: begins[0].lineStartByte,
      archiveBlockEndByte: ends[0].ownedEndByte
    });
    return Object.freeze({
      terminal: "UNIQUE",
      exactBeginMarkerCount: 1,
      exactEndMarkerCount: 1,
      exactMarkerLines,
      pair
    });
  }
  return Object.freeze({
    terminal: "MULTIPLE_OR_AMBIGUOUS",
    exactBeginMarkerCount: begins.length,
    exactEndMarkerCount: ends.length,
    exactMarkerLines
  });
}

/**
 * Separates content identity from canonical-parser technical executability.
 * NONE and MULTIPLE_OR_AMBIGUOUS intentionally produce canonical-empty input
 * without invoking or imitating the stable-key parser.
 */
export function resolveStructuredOutlineArchiveParserInput(
  sourceBytes: Uint8Array
): StructuredOutlineArchiveParserInput {
  const identity = resolveStructuredOutlineArchiveIdentity(sourceBytes);
  if (identity.terminal !== "UNIQUE" || !identity.pair) {
    return Object.freeze({
      parserProtocolTerminal: "EXECUTABLE",
      archiveIdentityTerminal: identity.terminal,
      identity,
      canonicalParserInputRawMarkdown: "",
      useCanonicalEmptyOutline: true
    });
  }
  try {
    const canonicalParserInputRawMarkdown = fatalDecoder.decode(sourceBytes.slice(
      identity.pair.archiveInternalContentStartByte,
      identity.pair.archiveInternalContentEndByte
    ));
    return Object.freeze({
      parserProtocolTerminal: "EXECUTABLE",
      archiveIdentityTerminal: "UNIQUE",
      identity,
      canonicalParserInputRawMarkdown,
      useCanonicalEmptyOutline: false
    });
  } catch {
    return Object.freeze({
      parserProtocolTerminal: "TECHNICAL_FAILURE",
      archiveIdentityTerminal: "UNIQUE",
      identity,
      errorCode: "STRUCTURED_OUTLINE_ARCHIVE_INTERIOR_INVALID_UTF8"
    });
  }
}

export function structuredOutlineArchiveBeginMarker(humanHint?: string) {
  if (humanHint === undefined || humanHint.length === 0) {
    return fatalDecoder.decode(BEGIN_NO_HINT);
  }
  if (/\r|\n|--/u.test(humanHint)) {
    throw new Error("STRUCTURED_OUTLINE_ARCHIVE_HINT_INVALID");
  }
  return `<!-- ${STRUCTURED_OUTLINE_ARCHIVE_BEGIN_TOKEN} | ${humanHint} -->`;
}

export function structuredOutlineArchiveEndMarker() {
  return fatalDecoder.decode(END_MARKER);
}

export function serializeCanonicalStructuredOutlineArchive(input: Readonly<{
  descriptor: ManuscriptOutlineDescriptor;
  values: ManuscriptOutlineTypedValues;
  humanHint?: string;
  lineEnding?: "\n" | "\r\n";
}>) {
  const lineEnding = input.lineEnding ?? "\n";
  const outline = serializeCanonicalManuscriptOutline(
    input.descriptor,
    input.values
  ).replace(/\r\n|\r|\n/gu, lineEnding);
  return [
    structuredOutlineArchiveBeginMarker(input.humanHint),
    "",
    outline,
    "",
    structuredOutlineArchiveEndMarker()
  ].join(lineEnding);
}

export function serializeCanonicalStructuredOutlineArchiveBytes(
  input: Parameters<typeof serializeCanonicalStructuredOutlineArchive>[0]
) {
  return encoder.encode(serializeCanonicalStructuredOutlineArchive(input));
}

export type StructuredOutlineArchiveDemotion = Readonly<{
  resultBytes: Uint8Array;
  removedMarkerLineSpans: readonly StructuredOutlineArchiveMarkerLineSpan[];
  removedMarkerLineCount: number;
  archiveInteriorMutationCount: 0;
  archiveOutsideBodyMutationCount: 0;
}>;

/** Deletes every exact V1 marker line and that line's own terminator only. */
export function demoteStructuredOutlineArchiveMarkers(
  sourceBytes: Uint8Array
): StructuredOutlineArchiveDemotion {
  const spans = scanExactMarkerLines(sourceBytes);
  if (spans.length === 0) {
    return Object.freeze({
      resultBytes: sourceBytes.slice(),
      removedMarkerLineSpans: spans,
      removedMarkerLineCount: 0,
      archiveInteriorMutationCount: 0,
      archiveOutsideBodyMutationCount: 0
    });
  }
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  let resultLength = 0;
  for (const span of spans) {
    const chunk = sourceBytes.slice(cursor, span.lineStartByte);
    chunks.push(chunk);
    resultLength += chunk.length;
    cursor = span.ownedEndByte;
  }
  const tail = sourceBytes.slice(cursor);
  chunks.push(tail);
  resultLength += tail.length;
  const resultBytes = new Uint8Array(resultLength);
  let resultOffset = 0;
  for (const chunk of chunks) {
    resultBytes.set(chunk, resultOffset);
    resultOffset += chunk.length;
  }
  return Object.freeze({
    resultBytes,
    removedMarkerLineSpans: spans,
    removedMarkerLineCount: spans.length,
    archiveInteriorMutationCount: 0,
    archiveOutsideBodyMutationCount: 0
  });
}

function archiveSeparator(archiveBytes: Uint8Array) {
  const identity = resolveStructuredOutlineArchiveIdentity(archiveBytes);
  if (
    identity.terminal !== "UNIQUE" ||
    !identity.pair ||
    identity.pair.archiveBlockStartByte !== 0 ||
    identity.pair.archiveBlockEndByte !== archiveBytes.length
  ) throw new Error("STRUCTURED_OUTLINE_ARCHIVE_APPEND_INPUT_INVALID");
  const marker = identity.pair.beginMarker;
  const separator = archiveBytes.slice(marker.markerLineEndByte, marker.ownedEndByte);
  if (separator.length === 0) {
    throw new Error("STRUCTURED_OUTLINE_ARCHIVE_BEGIN_TERMINATOR_REQUIRED");
  }
  return separator;
}

export function appendStructuredOutlineArchiveAtEof(input: Readonly<{
  existingRawBytes: Uint8Array;
  archiveBytes: Uint8Array;
}>) {
  const separator = archiveSeparator(input.archiveBytes);
  const existingBodyStart = hasUtf8Bom(input.existingRawBytes) ? UTF8_BOM.length : 0;
  const needsSeparator = input.existingRawBytes.length > existingBodyStart &&
    input.existingRawBytes[input.existingRawBytes.length - 1] !== 0x0a &&
    input.existingRawBytes[input.existingRawBytes.length - 1] !== 0x0d;
  const resultBytes = new Uint8Array(
    input.existingRawBytes.length +
    (needsSeparator ? separator.length : 0) +
    input.archiveBytes.length
  );
  resultBytes.set(input.existingRawBytes, 0);
  let offset = input.existingRawBytes.length;
  if (needsSeparator) {
    resultBytes.set(separator, offset);
    offset += separator.length;
  }
  resultBytes.set(input.archiveBytes, offset);
  return Object.freeze({
    resultBytes,
    appendedArchiveStartByte: offset,
    separatorBytesAdded: needsSeparator ? separator.slice() : new Uint8Array(),
    existingByteMutationCount: 0 as const
  });
}

/** Pure future settlement construction; it performs no file or business write. */
export function buildStructuredOutlineArchiveSettlementBytes(input: Readonly<{
  existingRawBytes: Uint8Array;
  archiveBytes: Uint8Array;
}>) {
  const demotion = demoteStructuredOutlineArchiveMarkers(input.existingRawBytes);
  const append = appendStructuredOutlineArchiveAtEof({
    existingRawBytes: demotion.resultBytes,
    archiveBytes: input.archiveBytes
  });
  return Object.freeze({
    resultBytes: append.resultBytes,
    demotion,
    append
  });
}

export const manuscriptStructuredOutlineArchive = Object.freeze({
  resolveIdentity: resolveStructuredOutlineArchiveIdentity,
  resolveParserInput: resolveStructuredOutlineArchiveParserInput,
  serialize: serializeCanonicalStructuredOutlineArchive,
  serializeBytes: serializeCanonicalStructuredOutlineArchiveBytes,
  demoteMarkers: demoteStructuredOutlineArchiveMarkers,
  appendAtEof: appendStructuredOutlineArchiveAtEof,
  buildSettlementBytes: buildStructuredOutlineArchiveSettlementBytes
});
