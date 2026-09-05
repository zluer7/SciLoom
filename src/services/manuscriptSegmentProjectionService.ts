import type {
  ManuscriptEditableProjectionNode,
  ManuscriptPresentationNode,
  ManuscriptProjectionBaselineIdentity,
  ManuscriptSegmentProjectionBuildInput,
  ManuscriptProjectionNode,
  ManuscriptSegmentProjection,
  ManuscriptSourceByteRange,
  ManuscriptSourceSegment,
  ManuscriptSourceSegmentKind,
  ManuscriptUnmanagedInsertionAnchor
} from "../types/manuscriptSegmentProjection";

const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);
const MARKER_LIKE_USER_TEXT_PATTERN = /<!--[\s\S]*?labpod:[\s\S]*?-->/giu;
const textEncoder = new TextEncoder();

export const MANUSCRIPT_NEWLINE_DELIMITER_OWNERSHIP = Object.freeze([
  { item: "marker line ending", owner: "PROTOCOL_CONTROL_SOURCE" },
  { item: "protocol heading line ending", owner: "PROTOCOL_HEADING_SOURCE" },
  { item: "managed value leading separator", owner: "PROTOCOL_CONTROL_SOURCE" },
  { item: "managed value trailing separator", owner: "PROTOCOL_CONTROL_SOURCE" },
  { item: "inter-field blank line", owner: "PROTOCOL_CONTROL_SOURCE" },
  { item: "unmanaged section separator", owner: "UNMANAGED_RAW_SOURCE" },
  { item: "document final newline", owner: "CONTAINING_SOURCE_REGION" }
] as const);

export function manuscriptSegmentFingerprint(bytes: Uint8Array) {
  let state = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    state ^= BigInt(byte);
    state = BigInt.asUintN(64, state * 0x100000001b3n);
  }
  return `fnv1a64:${state.toString(16).padStart(16, "0")}`;
}

export function manuscriptByteSliceFingerprint(
  bytes: Uint8Array,
  startByte: number,
  endByte: number
) {
  return manuscriptSegmentFingerprint(bytes.slice(startByte, endByte));
}

function hasUtf8Bom(bytes: Uint8Array) {
  return bytes.length >= 3 &&
    UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

export function createPhysicalRawBytesFromSnapshot(input: Readonly<{
  rawText: string;
  encoding: "utf-8" | "utf-8-bom";
}>) {
  const body = textEncoder.encode(input.rawText);
  if (input.encoding !== "utf-8-bom") return body;
  const result = new Uint8Array(body.length + UTF8_BOM.length);
  result.set(UTF8_BOM, 0);
  result.set(body, UTF8_BOM.length);
  return result;
}

export function decodePhysicalRawBytes(bytes: Uint8Array) {
  const bom = hasUtf8Bom(bytes);
  return Object.freeze({
    hasUtf8Bom: bom,
    bodyByteOffset: bom ? UTF8_BOM.length : 0,
    decodedRawMarkdown: new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(bom ? UTF8_BOM.length : 0)
    )
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function createUtf16ToUtf8ByteMap(value: string, bodyByteOffset: number) {
  const result = new Map<number, number>();
  let utf16Offset = 0;
  let byteOffset = bodyByteOffset;
  result.set(utf16Offset, byteOffset);
  while (utf16Offset < value.length) {
    const codePoint = value.codePointAt(utf16Offset);
    if (codePoint === undefined) throw new Error("INVALID_UNICODE_CODE_POINT");
    const character = String.fromCodePoint(codePoint);
    utf16Offset += character.length;
    byteOffset += textEncoder.encode(character).length;
    result.set(utf16Offset, byteOffset);
  }
  return result;
}

export function isValidatedUnicodeBoundary(text: string, utf16Offset: number) {
  if (!Number.isInteger(utf16Offset) || utf16Offset < 0 || utf16Offset > text.length) {
    return false;
  }
  if (utf16Offset > 0 && utf16Offset < text.length) {
    const previous = text.charCodeAt(utf16Offset - 1);
    const current = text.charCodeAt(utf16Offset);
    if (
      previous >= 0xd800 && previous <= 0xdbff &&
      current >= 0xdc00 && current <= 0xdfff
    ) return false;
  }
  return true;
}

type SegmenterLike = new (
  locale?: string | string[],
  options?: { granularity: "grapheme" }
) => { segment(value: string): Iterable<{ index: number; segment: string }> };

export function isAtomicGraphemeBoundary(text: string, utf16Offset: number) {
  if (!isValidatedUnicodeBoundary(text, utf16Offset)) return false;
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter;
  if (Segmenter) {
    const boundaries = new Set<number>([0, text.length]);
    for (const item of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      boundaries.add(item.index);
      boundaries.add(item.index + item.segment.length);
    }
    return boundaries.has(utf16Offset);
  }
  if (utf16Offset === 0 || utf16Offset === text.length) return true;
  const next = String.fromCodePoint(text.codePointAt(utf16Offset) ?? 0);
  const previousCodePoint = text.codePointAt(
    utf16Offset - (text.charCodeAt(utf16Offset - 1) >= 0xdc00 &&
      text.charCodeAt(utf16Offset - 1) <= 0xdfff ? 2 : 1)
  );
  const previous = String.fromCodePoint(previousCodePoint ?? 0);
  if (/^\p{M}$/u.test(next)) return false;
  if (/^[\uFE00-\uFE0F]$/u.test(next)) return false;
  if (previous === "\u200d" || next === "\u200d") return false;
  if (previous === "\r" && next === "\n") return false;
  return true;
}

function baselineEvidence(input: ManuscriptSegmentProjectionBuildInput, rawHash: string) {
  return [
    input.sessionKey,
    input.sessionGeneration,
    input.projectionGeneration,
    input.baseline.revision,
    input.baseline.physicalIdentity ?? "",
    rawHash
  ].join("|");
}

function controlFingerprint(
  rawBytes: Uint8Array,
  segments: readonly ManuscriptSourceSegment[]
) {
  const chunks = segments
    .filter((segment) =>
      segment.sourceKind === "PROTOCOL_CONTROL_SOURCE" ||
      segment.sourceKind === "PROTOCOL_HEADING_SOURCE" ||
      segment.sourceKind === "PROTECTED_PREAMBLE_SOURCE"
    )
    .map((segment) => rawBytes.slice(
      segment.sourceRange.startByte,
      segment.sourceRange.endByte
    ));
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return manuscriptSegmentFingerprint(merged);
}

function buildProjectionNodes(
  segments: readonly ManuscriptSourceSegment[]
): readonly ManuscriptProjectionNode[] {
  const managedKeys = new Set(
    segments
      .filter((segment) => segment.sourceKind === "MANAGED_VALUE_SOURCE")
      .map((segment) => segment.stableKey)
  );
  const result: ManuscriptProjectionNode[] = [];
  for (const segment of segments) {
    if (segment.protocolRole === "FIELD_MARKER" && segment.stableKey) {
      const heading: ManuscriptPresentationNode = Object.freeze({
        nodeId: `synthetic-heading:${segment.stableKey}:${segment.segmentId}`,
        nodeKind: "SYNTHETIC_MANAGED_HEADING",
        stableKey: segment.stableKey,
        displayText: segment.displayLabel,
        sourceRange: null,
        persistentByteCount: 0,
        reverseMapping: "PROHIBITED"
      });
      result.push(heading);
      if (!managedKeys.has(segment.stableKey)) {
        result.push(Object.freeze({
          nodeId: `empty-hint:${segment.stableKey}:${segment.segmentId}`,
          nodeKind: "EMPTY_STATE_HINT",
          stableKey: segment.stableKey,
          displayText: "",
          sourceRange: null,
          persistentByteCount: 0,
          reverseMapping: "PROHIBITED"
        }));
      }
    }
    if (segment.editable) {
      const node: ManuscriptEditableProjectionNode = Object.freeze({
        nodeId: `editable:${segment.segmentId}`,
        nodeKind: "EDITABLE_SOURCE_REGION",
        segmentId: segment.segmentId,
        sourceKind: segment.sourceKind as ManuscriptEditableProjectionNode["sourceKind"],
        stableKey: segment.stableKey,
        text: segment.decodedText,
        sourceRange: segment.sourceRange
      });
      result.push(node);
    }
  }
  return Object.freeze(result);
}

function createInsertionAnchors(
  identity: ManuscriptProjectionBaselineIdentity,
  rawBytes: Uint8Array,
  segments: readonly ManuscriptSourceSegment[],
  candidateOffsets: readonly number[]
) {
  return Object.freeze(
    [...new Set(candidateOffsets)]
      .sort((left, right) => left - right)
      .map((anchorByteOffset, index): ManuscriptUnmanagedInsertionAnchor => {
        const left = [...segments].reverse().find(
          (segment) => segment.sourceRange.endByte === anchorByteOffset
        );
        const right = segments.find(
          (segment) => segment.sourceRange.startByte === anchorByteOffset
        );
        const fingerprintBytes = textEncoder.encode([
          identity.ownerType,
          identity.ownerId,
          identity.channel,
          identity.fileRefId,
          identity.sessionKey,
          identity.sessionGeneration,
          identity.projectionGeneration,
          identity.baselineRevisionEvidence,
          anchorByteOffset,
          manuscriptByteSliceFingerprint(
            rawBytes,
            Math.max(0, anchorByteOffset - 16),
            anchorByteOffset
          ),
          manuscriptByteSliceFingerprint(
            rawBytes,
            anchorByteOffset,
            Math.min(rawBytes.length, anchorByteOffset + 16)
          )
        ].join("|"));
        return Object.freeze({
          anchorId: `unmanaged-anchor:${index}:${anchorByteOffset}`,
          projectionGeneration: identity.projectionGeneration,
          baselineRevisionEvidence: identity.baselineRevisionEvidence,
          baselineIdentityEvidence: identity.rawSliceHash,
          ownerType: identity.ownerType,
          ownerId: identity.ownerId,
          channel: identity.channel,
          fileRefId: identity.fileRefId,
          leftSourceBoundary: left?.segmentId ?? "DOCUMENT_START",
          rightSourceBoundary: right?.segmentId ?? "DOCUMENT_END",
          anchorByteOffset,
          anchorFingerprint: manuscriptSegmentFingerprint(fingerprintBytes),
          allowedInsertionPolicy:
            anchorByteOffset === 0 ||
            (anchorByteOffset === UTF8_BOM.length && hasUtf8Bom(rawBytes))
              ? "DOCUMENT_START_OUTSIDE_PROTOCOL"
              : anchorByteOffset === rawBytes.length
                ? "DOCUMENT_END_OUTSIDE_PROTOCOL"
                : "UNMANAGED_REGION_BOUNDARY"
        });
      })
  );
}

function nonProjectable(
  input: ManuscriptSegmentProjectionBuildInput,
  rawBytes: Uint8Array,
  rawHash: string,
  diagnostics: readonly string[],
  controlHash = manuscriptSegmentFingerprint(new Uint8Array())
): ManuscriptSegmentProjection {
  const baselineIdentity: ManuscriptProjectionBaselineIdentity = Object.freeze({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    channel: input.channel,
    fileRefId: input.fileRefId,
    sessionKey: input.sessionKey,
    sessionGeneration: input.sessionGeneration,
    projectionGeneration: input.projectionGeneration,
    baselineRevisionEvidence: input.baseline.revision,
    baselinePhysicalIdentity: input.baseline.physicalIdentity,
    rawByteLength: rawBytes.length,
    rawSliceHash: rawHash,
    controlFingerprint: controlHash,
    encoding: input.baseline.encoding
  });
  return Object.freeze({
    classification: "NON_PROJECTABLE_FAIL_CLOSED",
    writableProjection: null,
    status: "FAIL_CLOSED",
    baselineIdentity,
    authoritativeRawBytes: rawBytes,
    diagnostics: Object.freeze([...diagnostics]),
    editableRegionCount: 0,
    physicalWriteCount: 0
  });
}

export function buildManuscriptSegmentProjection(
  input: ManuscriptSegmentProjectionBuildInput
): ManuscriptSegmentProjection {
  // F5-3 production authority: ordinary editing is one complete Raw draft.
  // The legacy source-span implementation remains below as unreachable audit
  // residue for later B3 retirement; it is no longer an ordinary-edit path.
  {
    const rawBytes = input.rawBytes.slice();
    const rawHash = manuscriptSegmentFingerprint(rawBytes);
    if (!bytesEqual(rawBytes, createPhysicalRawBytesFromSnapshot(input.baseline))) {
      return nonProjectable(
        input,
        rawBytes,
        rawHash,
        ["BASELINE_PHYSICAL_BYTES_MISMATCH"]
      );
    }
    let decoded: ReturnType<typeof decodePhysicalRawBytes>;
    try {
      decoded = decodePhysicalRawBytes(rawBytes);
    } catch {
      return nonProjectable(input, rawBytes, rawHash, ["INVALID_UTF8"]);
    }
    const evidence = baselineEvidence(input, rawHash);
    const segment: ManuscriptSourceSegment = Object.freeze({
      segmentId: "session-raw-draft",
      sourceKind: "UNMANAGED_RAW_SOURCE",
      sourceRange: Object.freeze({
        startByte: decoded.bodyByteOffset,
        endByte: rawBytes.length
      }),
      rawSliceHash: manuscriptByteSliceFingerprint(
        rawBytes,
        decoded.bodyByteOffset,
        rawBytes.length
      ),
      baselineIdentityEvidence: evidence,
      editable: true,
      decodedText: decoded.decodedRawMarkdown
    });
    const baselineIdentity: ManuscriptProjectionBaselineIdentity = Object.freeze({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      channel: input.channel,
      fileRefId: input.fileRefId,
      sessionKey: input.sessionKey,
      sessionGeneration: input.sessionGeneration,
      projectionGeneration: input.projectionGeneration,
      baselineRevisionEvidence: input.baseline.revision,
      baselinePhysicalIdentity: input.baseline.physicalIdentity,
      rawByteLength: rawBytes.length,
      rawSliceHash: rawHash,
      // Compatibility-shaped evidence only. No ordinary operation interprets
      // protocol/control regions after F5-3.
      controlFingerprint: manuscriptSegmentFingerprint(new Uint8Array()),
      encoding: input.baseline.encoding
    });
    const projectionNode: ManuscriptEditableProjectionNode = Object.freeze({
      nodeId: "editable:session-raw-draft",
      nodeKind: "EDITABLE_SOURCE_REGION",
      segmentId: segment.segmentId,
      sourceKind: "UNMANAGED_RAW_SOURCE",
      text: decoded.decodedRawMarkdown,
      sourceRange: segment.sourceRange
    });
    return Object.freeze({
      classification: "PROJECTABLE",
      writableProjection: "AVAILABLE",
      status: "ACTIVE",
      baselineIdentity,
      descriptorLookupIdentity: Object.freeze({ ...input.descriptorLookupIdentity }),
      authoritativeRawBytes: rawBytes,
      decodedRawMarkdown: decoded.decodedRawMarkdown,
      hasUtf8Bom: decoded.hasUtf8Bom,
      sourceSegments: Object.freeze([segment]),
      projectionNodes: Object.freeze([projectionNode]),
      insertionAnchors: Object.freeze([]),
      editableRegionCount: 1,
      physicalWriteCount: 0,
      protocolOwnedControlSpanRenderedInEditableRegionCount: 0,
      userOwnedMarkerLikeTextRenderedCount: [
        ...decoded.decodedRawMarkdown.matchAll(MARKER_LIKE_USER_TEXT_PATTERN)
      ].length
    });
  }

  /*
   * RETIRED F5-3 AUDIT RESIDUE (not compiled or production-reachable):
   * the former controlled source-span projection implementation follows.
   * It remains temporarily readable for B3 retirement evidence only.
   *
  const rawBytes = input.rawBytes.slice();
  const rawHash = manuscriptSegmentFingerprint(rawBytes);
  if (!bytesEqual(rawBytes, createPhysicalRawBytesFromSnapshot(input.baseline))) {
    return nonProjectable(
      input,
      rawBytes,
      rawHash,
      ["BASELINE_PHYSICAL_BYTES_MISMATCH"]
    );
  }
  let decoded: ReturnType<typeof decodePhysicalRawBytes>;
  try {
    decoded = decodePhysicalRawBytes(rawBytes);
  } catch {
    return nonProjectable(input, rawBytes, rawHash, ["INVALID_UTF8"]);
  }
  const byteMap = createUtf16ToUtf8ByteMap(
    decoded.decodedRawMarkdown,
    decoded.bodyByteOffset
  );
  const byteAt = (utf16Offset: number) => {
    const result = byteMap.get(utf16Offset);
    if (result === undefined) throw new Error("INVALID_UTF8_BOUNDARY");
    return result;
  };
  const canonical = parseCanonicalManuscriptSourceSpans({
    rawMarkdown: decoded.decodedRawMarkdown,
    descriptorLookupIdentity: input.descriptorLookupIdentity
  });
  if (!canonical.ok) {
    return nonProjectable(
      input,
      rawBytes,
      rawHash,
      [`CANONICAL_SOURCE_AUTHORITY_FAILURE:${canonical.error.code}`]
    );
  }
  if (canonical.sourceMap.classification === "FAIL_CLOSED") {
    return nonProjectable(
      input,
      rawBytes,
      rawHash,
      canonical.sourceMap.diagnostics
    );
  }
  const provisional: ManuscriptSourceSegment[] = [];
  let sequence = 0;
  const evidence = baselineEvidence(input, rawHash);
  const appendByteSegment = (
    sourceKind: ManuscriptSourceSegmentKind,
    startByte: number,
    endByte: number,
    decodedText: string,
    metadata: Partial<Pick<
      ManuscriptSourceSegment,
      "stableKey" | "displayLabel" | "protocolRole"
    >> = {}
  ) => {
    if (endByte <= startByte) return;
    provisional.push(Object.freeze({
      segmentId: `source-segment:${sequence++}:${startByte}:${endByte}`,
      sourceKind,
      sourceRange: Object.freeze({ startByte, endByte }),
      rawSliceHash: manuscriptByteSliceFingerprint(rawBytes, startByte, endByte),
      baselineIdentityEvidence: evidence,
      editable:
        sourceKind === "MANAGED_VALUE_SOURCE" ||
        sourceKind === "UNMANAGED_RAW_SOURCE",
      decodedText,
      ...metadata
    }));
  };
  const appendUtf16Segment = (
    sourceKind: ManuscriptSourceSegmentKind,
    startUtf16: number,
    endUtf16: number,
    metadata: Partial<Pick<
      ManuscriptSourceSegment,
      "stableKey" | "displayLabel" | "protocolRole"
    >> = {}
  ) => appendByteSegment(
    sourceKind,
    byteAt(startUtf16),
    byteAt(endUtf16),
    decoded.decodedRawMarkdown.slice(startUtf16, endUtf16),
    metadata
  );
  if (decoded.hasUtf8Bom) {
    appendByteSegment(
      "PROTECTED_PREAMBLE_SOURCE",
      0,
      UTF8_BOM.length,
      "",
      { protocolRole: "BOM" }
    );
  }
  const anchorOffsets: number[] = [];
  if (canonical.sourceMap.classification === "NO_OUTLINE") {
    appendUtf16Segment(
      "UNMANAGED_RAW_SOURCE",
      0,
      decoded.decodedRawMarkdown.length
    );
    anchorOffsets.push(decoded.bodyByteOffset, rawBytes.length);
  } else {
    const protocolRange = canonical.sourceMap.protocolRange;
    if (!protocolRange) {
      return nonProjectable(
        input,
        rawBytes,
        rawHash,
        ["CANONICAL_PROTOCOL_RANGE_MISSING"]
      );
    }
    appendUtf16Segment(
      "UNMANAGED_RAW_SOURCE",
      0,
      protocolRange.startUtf16
    );
    anchorOffsets.push(decoded.bodyByteOffset, byteAt(protocolRange.startUtf16));
    for (const span of canonical.sourceMap.spans) {
      appendUtf16Segment(
        span.sourceKind,
        span.sourceRange.startUtf16,
        span.sourceRange.endUtf16,
        {
          stableKey: span.stableKey,
          displayLabel: span.displayLabel,
          protocolRole: span.protocolRole
        }
      );
    }
    appendUtf16Segment(
      "UNMANAGED_RAW_SOURCE",
      protocolRange.endUtf16,
      decoded.decodedRawMarkdown.length
    );
    anchorOffsets.push(byteAt(protocolRange.endUtf16), rawBytes.length);
    for (const segment of provisional) {
      if (segment.sourceKind === "UNMANAGED_RAW_SOURCE") {
        anchorOffsets.push(
          segment.sourceRange.startByte,
          segment.sourceRange.endByte
        );
      }
    }
  }
  let cursor = 0;
  for (const segment of provisional) {
    if (segment.sourceRange.startByte !== cursor) {
      return nonProjectable(
        input,
        rawBytes,
        rawHash,
        ["SOURCE_PARTITION_GAP_OR_OVERLAP"]
      );
    }
    cursor = segment.sourceRange.endByte;
  }
  if (cursor !== rawBytes.length) {
    return nonProjectable(
      input,
      rawBytes,
      rawHash,
      ["SOURCE_PARTITION_NOT_EXHAUSTIVE"]
    );
  }
  const controlHash = controlFingerprint(rawBytes, provisional);
  const baselineIdentity: ManuscriptProjectionBaselineIdentity = Object.freeze({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    channel: input.channel,
    fileRefId: input.fileRefId,
    sessionKey: input.sessionKey,
    sessionGeneration: input.sessionGeneration,
    projectionGeneration: input.projectionGeneration,
    baselineRevisionEvidence: input.baseline.revision,
    baselinePhysicalIdentity: input.baseline.physicalIdentity,
    rawByteLength: rawBytes.length,
    rawSliceHash: rawHash,
    controlFingerprint: controlHash,
    encoding: input.baseline.encoding
  });
  const projectionNodes = buildProjectionNodes(provisional);
  const insertionAnchors = createInsertionAnchors(
    baselineIdentity,
    rawBytes,
    provisional,
    anchorOffsets
  );
  return Object.freeze({
    classification: "PROJECTABLE",
    writableProjection: "AVAILABLE",
    status: "ACTIVE",
    baselineIdentity,
    descriptorLookupIdentity: Object.freeze({ ...input.descriptorLookupIdentity }),
    authoritativeRawBytes: rawBytes,
    decodedRawMarkdown: decoded.decodedRawMarkdown,
    hasUtf8Bom: decoded.hasUtf8Bom,
    sourceSegments: Object.freeze(provisional),
    projectionNodes,
    insertionAnchors,
    editableRegionCount: projectionNodes.filter(
      (node) => node.nodeKind === "EDITABLE_SOURCE_REGION"
    ).length,
    physicalWriteCount: 0,
    protocolOwnedControlSpanRenderedInEditableRegionCount: 0,
    userOwnedMarkerLikeTextRenderedCount: projectionNodes.reduce(
      (count, node) => node.nodeKind === "EDITABLE_SOURCE_REGION"
        ? count + [...node.text.matchAll(MARKER_LIKE_USER_TEXT_PATTERN)].length
        : count,
      0
    )
  });
  */
}

function editableSegment(
  projection: ManuscriptSegmentProjection,
  segmentId: string
) {
  return projection.classification === "PROJECTABLE"
    ? projection.sourceSegments.find(
      (segment) => segment.segmentId === segmentId && segment.editable
    )
    : undefined;
}

export function mapRegionEditorOffsetToSourceByte(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  segmentId: string;
  editorLocalUtf16Offset: number;
  requireAtomicGraphemeBoundary?: boolean;
}>) {
  const segment = editableSegment(input.projection, input.segmentId);
  if (!segment) throw new Error("EDITABLE_REGION_NOT_FOUND");
  if (!isValidatedUnicodeBoundary(segment.decodedText, input.editorLocalUtf16Offset)) {
    throw new Error("EDITOR_OFFSET_NOT_UNICODE_BOUNDARY");
  }
  if (
    input.requireAtomicGraphemeBoundary !== false &&
    !isAtomicGraphemeBoundary(segment.decodedText, input.editorLocalUtf16Offset)
  ) throw new Error("EDITOR_OFFSET_NOT_GRAPHEME_BOUNDARY");
  const localMap = createUtf16ToUtf8ByteMap(
    segment.decodedText,
    segment.sourceRange.startByte
  );
  const result = localMap.get(input.editorLocalUtf16Offset);
  if (result === undefined) throw new Error("EDITOR_OFFSET_NOT_UTF8_BOUNDARY");
  return result;
}

export function mapSourceByteToRegionEditorOffset(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  segmentId: string;
  sourceByte: number;
}>) {
  const segment = editableSegment(input.projection, input.segmentId);
  if (!segment) throw new Error("EDITABLE_REGION_NOT_FOUND");
  const localMap = createUtf16ToUtf8ByteMap(
    segment.decodedText,
    segment.sourceRange.startByte
  );
  for (const [editorOffset, byteOffset] of localMap.entries()) {
    if (byteOffset === input.sourceByte) return editorOffset;
  }
  throw new Error("SOURCE_BYTE_NOT_REGION_BOUNDARY");
}

type ResolvedNewline = "\n" | "\r\n";

function uniformNewline(value: string): ResolvedNewline | null {
  const withoutCrlf = value.replace(/\r\n/gu, "");
  if (withoutCrlf.includes("\r")) return null;
  const crlf = /\r\n/u.test(value);
  const lf = /(^|[^\r])\n/u.test(value);
  if (crlf && lf) return null;
  if (crlf) return "\r\n";
  if (lf) return "\n";
  return null;
}

function uniqueNewline(candidates: readonly (ResolvedNewline | null)[]) {
  const observed = [...new Set(candidates.filter(
    (candidate): candidate is ResolvedNewline => candidate !== null
  ))];
  return observed.length === 1 ? observed[0] : null;
}

export function resolveManuscriptSegmentNewlineConvention(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  segmentId?: string;
  anchorId?: string;
}>): ResolvedNewline | null {
  if (input.projection.classification !== "PROJECTABLE") return null;
  const segments = input.projection.sourceSegments;
  const segmentIndex = input.segmentId
    ? segments.findIndex(
      (segment) => segment.segmentId === input.segmentId && segment.editable
    )
    : -1;
  if (segmentIndex >= 0) {
    const local = uniformNewline(segments[segmentIndex].decodedText);
    if (local) return local;
    return uniqueNewline([
      segments[segmentIndex - 1] && !segments[segmentIndex - 1].editable
        ? uniformNewline(segments[segmentIndex - 1].decodedText)
        : null,
      segments[segmentIndex + 1] && !segments[segmentIndex + 1].editable
        ? uniformNewline(segments[segmentIndex + 1].decodedText)
        : null
    ]);
  }
  const anchor = input.anchorId
    ? input.projection.insertionAnchors.find(
      (candidate) => candidate.anchorId === input.anchorId
    )
    : undefined;
  if (!anchor) return null;
  // F1 product rule: a truly zero-byte manuscript has no existing newline
  // evidence, but its sole legal start-body anchor must accept Markdown.
  if (
    input.projection.authoritativeRawBytes.length === 0 &&
    input.projection.insertionAnchors.length === 1 &&
    input.projection.insertionAnchors[0].anchorId === anchor.anchorId
  ) {
    return "\n";
  }
  const adjacent = segments.filter((segment) =>
    segment.sourceRange.startByte === anchor.anchorByteOffset ||
    segment.sourceRange.endByte === anchor.anchorByteOffset
  );
  const local = uniqueNewline(
    adjacent.filter((segment) => segment.editable).map(
      (segment) => uniformNewline(segment.decodedText)
    )
  );
  return local ?? uniqueNewline(
    adjacent.filter((segment) => !segment.editable).map(
      (segment) => uniformNewline(segment.decodedText)
    )
  );
}

export function normalizeManuscriptSegmentInsertedNewlines(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  segmentId?: string;
  anchorId?: string;
  replacementText: string;
}>) {
  if (!/[\r\n]/u.test(input.replacementText)) return input.replacementText;
  const convention = resolveManuscriptSegmentNewlineConvention(input);
  if (!convention) throw new Error("NEWLINE_CONVENTION_UNRESOLVED");
  return input.replacementText.replace(/\r\n|\r|\n/gu, convention);
}

export function validateSingleEditableProjectionRegion(input: Readonly<{
  projection: ManuscriptSegmentProjection;
  startSegmentId: string;
  endSegmentId: string;
}>) {
  if (input.startSegmentId !== input.endSegmentId) {
    return Object.freeze({ accepted: false as const, reason: "CROSS_REGION_SELECTION" });
  }
  if (!editableSegment(input.projection, input.startSegmentId)) {
    return Object.freeze({ accepted: false as const, reason: "NON_EDITABLE_REGION" });
  }
  return Object.freeze({ accepted: true as const, segmentId: input.startSegmentId });
}

export function firstDifferingManuscriptByte(
  left: Uint8Array,
  right: Uint8Array
) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? null : length;
}

export function sourceRangeContains(
  outer: ManuscriptSourceByteRange,
  inner: ManuscriptSourceByteRange
) {
  return inner.startByte >= outer.startByte && inner.endByte <= outer.endByte;
}

export const manuscriptSegmentProjectionService = Object.freeze({
  build: buildManuscriptSegmentProjection,
  mapEditorOffset: mapRegionEditorOffsetToSourceByte,
  mapSourceByte: mapSourceByteToRegionEditorOffset,
  resolveNewlineConvention: resolveManuscriptSegmentNewlineConvention,
  normalizeInsertedNewlines: normalizeManuscriptSegmentInsertedNewlines,
  validateSelection: validateSingleEditableProjectionRegion,
  fingerprint: manuscriptSegmentFingerprint,
  sliceFingerprint: manuscriptByteSliceFingerprint
});
