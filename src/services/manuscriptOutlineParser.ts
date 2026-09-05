import type { ReviewType } from "../types/planning";
import {
  getManuscriptOutlineDescriptor,
  type ManuscriptOutlineChannel,
  type ManuscriptOutlineDescriptor,
  type ManuscriptOutlineOwnerType
} from "./manuscriptOutlineDescriptorRegistry";
import {
  MANUSCRIPT_OUTLINE_END_MARKER,
  MANUSCRIPT_OUTLINE_START_MARKER
} from "./manuscriptOutlineSerializer";

export interface ManuscriptOutlineDescriptorLookupIdentity {
  readonly ownerType: ManuscriptOutlineOwnerType;
  readonly channel: ManuscriptOutlineChannel;
  readonly reviewType?: ReviewType;
}

export type ManuscriptOutlineContentStatus =
  | "VALID_OUTLINE"
  | "NO_OUTLINE"
  | "MALFORMED_OUTLINE";

export type ManuscriptOutlineClearReason =
  | "NO_OUTLINE"
  | "MALFORMED_OUTLINE"
  | "MISSING"
  | "EMPTY"
  | "DUPLICATE";

export type ManuscriptOutlineDiagnosticCode =
  | "NO_OUTLINE"
  | "MALFORMED_OUTLINE"
  | "FIELD_MISSING"
  | "FIELD_EMPTY"
  | "FIELD_DUPLICATE"
  | "FIELD_UNKNOWN"
  | "DISPLAY_HEADING_CHANGED"
  | "DISPLAY_HEADING_MISSING"
  | "FIELD_REORDERED"
  | "LEGACY_FORMAT_DETECTED"
  | "CANONICAL_MARKER_OUTSIDE_OUTLINE"
  | "MALFORMED_FIELD_MARKER"
  | "OUTLINE_BODY_EMPTY";

export interface ManuscriptOutlineDiagnostic {
  readonly code: ManuscriptOutlineDiagnosticCode;
  readonly stableKey?: string;
  readonly sourceStableKey?: string;
  readonly line?: number;
  readonly expectedOrder?: number;
  readonly observedOrder?: number;
}

export type ManuscriptOutlineOrderedReplacement =
  | Readonly<{
    stableKey: string;
    order: number;
    action: "set";
    value: string;
  }>
  | Readonly<{
    stableKey: string;
    order: number;
    action: "clear";
    clearReason: ManuscriptOutlineClearReason;
  }>;

export interface ManuscriptOutlineReplacementDto {
  readonly ownerType: ManuscriptOutlineOwnerType;
  readonly channel: ManuscriptOutlineChannel;
  readonly reviewType?: ReviewType;
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  readonly orderedReplacements: readonly ManuscriptOutlineOrderedReplacement[];
  readonly diagnostics: readonly ManuscriptOutlineDiagnostic[];
  readonly contentStatus: ManuscriptOutlineContentStatus;
}

export type ManuscriptOutlineParserSystemFailureCode =
  | "REGISTRY_LOOKUP_FAILED"
  | "IDENTITY_UNSUPPORTED"
  | "DESCRIPTOR_INVARIANT_INVALID"
  | "INVALID_PARSER_INPUT"
  | "INTERNAL_PARSER_FAILURE";

export interface ManuscriptOutlineParserSystemFailure {
  readonly code: ManuscriptOutlineParserSystemFailureCode;
  readonly message: string;
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}

export type ManuscriptOutlineParserResult =
  | Readonly<{ ok: true; dto: ManuscriptOutlineReplacementDto }>
  | Readonly<{ ok: false; error: ManuscriptOutlineParserSystemFailure }>;

export interface CanonicalManuscriptUtf16Range {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export type CanonicalManuscriptSourceSpanKind =
  | "PROTOCOL_CONTROL_SOURCE"
  | "PROTOCOL_HEADING_SOURCE"
  | "MANAGED_VALUE_SOURCE";

export interface CanonicalManuscriptClassifiedSourceSpan {
  readonly sourceKind: CanonicalManuscriptSourceSpanKind;
  readonly sourceRange: CanonicalManuscriptUtf16Range;
  readonly stableKey?: string;
  readonly displayLabel?: string;
  readonly protocolRole?:
    | "OUTLINE_START"
    | "OUTLINE_END"
    | "OUTLINE_DELIMITER"
    | "OUTLINE_HEADING"
    | "FIELD_MARKER"
    | "FIELD_HEADING"
    | "FIELD_DELIMITER";
}

export type CanonicalManuscriptSourceSpanMap = Readonly<{
  classification: "VALID_SOURCE_SPANS" | "NO_OUTLINE" | "FAIL_CLOSED";
  rawUtf16Length: number;
  protocolRange?: CanonicalManuscriptUtf16Range;
  spans: readonly CanonicalManuscriptClassifiedSourceSpan[];
  diagnostics: readonly string[];
}>;

export type CanonicalManuscriptSourceSpanResult =
  | Readonly<{
    ok: true;
    dto: ManuscriptOutlineReplacementDto;
    sourceMap: CanonicalManuscriptSourceSpanMap;
  }>
  | Readonly<{ ok: false; error: ManuscriptOutlineParserSystemFailure }>;

type ScannedLine = Readonly<{
  start: number;
  contentEnd: number;
  end: number;
  content: string;
  ordinary: boolean;
  line: number;
}>;

type FieldBoundary = Readonly<{
  kind: "field" | "malformed";
  lineIndex: number;
  stableKey?: string;
}>;

const FIELD_MARKER_PATTERN = /^<!-- labpod:field=([A-Za-z0-9_-]+) -->$/u;
const MALFORMED_FIELD_MARKER_PATTERN = /^<!--[ \t]*labpod:field(?:=|\b)/u;
const MALFORMED_CONTROL_MARKER_PATTERN = /^<!--[ \t]*labpod:outline:/u;
const LEGACY_MARKER_PATTERN = /<!--[ \t]*LABPOD_(?:FIELD|GROUP|LITERATURE|DOCUMENT|PROJECT)[^>]*-->/u;
const REVIEW_TYPES = new Set<ReviewType>([
  "stage",
  "periodic",
  "experiment_comparison",
  "literature_comparison",
  "custom"
]);

function freezeIdentity(
  identity: ManuscriptOutlineDescriptorLookupIdentity
): ManuscriptOutlineDescriptorLookupIdentity {
  return Object.freeze({
    ownerType: identity.ownerType,
    channel: identity.channel,
    ...(identity.reviewType ? { reviewType: identity.reviewType } : {})
  });
}

function failure(
  code: ManuscriptOutlineParserSystemFailureCode,
  message: string,
  identity: ManuscriptOutlineDescriptorLookupIdentity
): ManuscriptOutlineParserResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, descriptorLookupIdentity: freezeIdentity(identity) })
  });
}

function scanMarkdownLines(rawMarkdown: string): readonly ScannedLine[] {
  const result: ScannedLine[] = [];
  let offset = 0;
  let lineNumber = 1;
  let fence: Readonly<{ character: "`" | "~"; length: number }> | undefined;

  while (offset < rawMarkdown.length) {
    let contentEnd = offset;
    while (
      contentEnd < rawMarkdown.length &&
      rawMarkdown[contentEnd] !== "\r" &&
      rawMarkdown[contentEnd] !== "\n"
    ) contentEnd += 1;
    let end = contentEnd;
    if (rawMarkdown[end] === "\r" && rawMarkdown[end + 1] === "\n") end += 2;
    else if (rawMarkdown[end] === "\r" || rawMarkdown[end] === "\n") end += 1;

    const content = rawMarkdown.slice(offset, contentEnd);
    let ordinary = true;
    if (fence) {
      ordinary = false;
      const closing = content.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u);
      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) fence = undefined;
    } else {
      const opening = content.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u);
      if (opening) {
        ordinary = false;
        fence = {
          character: opening[1][0] as "`" | "~",
          length: opening[1].length
        };
      }
    }
    result.push(Object.freeze({
      start: offset,
      contentEnd,
      end,
      content,
      ordinary,
      line: lineNumber
    }));
    offset = end;
    lineNumber += 1;
  }
  return Object.freeze(result);
}

function descriptorInvariantValid(
  descriptor: ManuscriptOutlineDescriptor,
  identity: ManuscriptOutlineDescriptorLookupIdentity
) {
  if (
    descriptor.ownerType !== identity.ownerType ||
    descriptor.channel !== identity.channel ||
    descriptor.reviewType !== identity.reviewType ||
    descriptor.fields.length === 0
  ) return false;
  const keys = new Set<string>();
  return descriptor.fields.every((field, index) => {
    if (
      field.ownerType !== descriptor.ownerType ||
      field.channel !== descriptor.channel ||
      field.order !== index ||
      !/^[A-Za-z0-9_-]+$/u.test(field.stableKey) ||
      keys.has(field.stableKey) ||
      field.setClearRule.presentNonEmpty !== "set" ||
      field.setClearRule.presentEmpty !== "clear" ||
      field.setClearRule.absent !== "clear"
    ) return false;
    keys.add(field.stableKey);
    return true;
  });
}

function allClear(
  descriptor: ManuscriptOutlineDescriptor,
  reason: "NO_OUTLINE" | "MALFORMED_OUTLINE"
) {
  return Object.freeze(descriptor.fields.map((field) => Object.freeze({
    stableKey: field.stableKey,
    order: field.order,
    action: "clear" as const,
    clearReason: reason
  })));
}

function makeDto(
  descriptor: ManuscriptOutlineDescriptor,
  identity: ManuscriptOutlineDescriptorLookupIdentity,
  contentStatus: ManuscriptOutlineContentStatus,
  replacements: readonly ManuscriptOutlineOrderedReplacement[],
  diagnostics: readonly ManuscriptOutlineDiagnostic[]
): ManuscriptOutlineReplacementDto {
  return Object.freeze({
    ownerType: identity.ownerType,
    channel: identity.channel,
    ...(identity.reviewType ? { reviewType: identity.reviewType } : {}),
    descriptorLookupIdentity: freezeIdentity(identity),
    orderedReplacements: Object.freeze([...replacements]),
    diagnostics: Object.freeze(diagnostics.map((item) => Object.freeze({ ...item }))),
    contentStatus
  });
}

function removeStructuralSuffix(value: string) {
  const newline = value.match(/(?:\r\n|\r|\n)$/u)?.[0];
  if (!newline) return value;
  let result = value.slice(0, -newline.length);
  const lastBreak = Math.max(result.lastIndexOf("\n"), result.lastIndexOf("\r"));
  const finalLine = result.slice(lastBreak + 1);
  if (lastBreak >= 0 && /^[ \t]*$/u.test(finalLine)) {
    let breakStart = lastBreak;
    if (result[lastBreak] === "\n" && result[lastBreak - 1] === "\r") breakStart -= 1;
    result = result.slice(0, breakStart);
  }
  return result;
}

function structuralValueEndOffset(
  rawMarkdown: string,
  valueStart: number,
  boundaryStart: number
) {
  return valueStart + removeStructuralSuffix(
    rawMarkdown.slice(valueStart, boundaryStart)
  ).length;
}

function extractFieldValue(
  rawMarkdown: string,
  lines: readonly ScannedLine[],
  markerLineIndex: number,
  boundaryStart: number,
  expectedDisplayLabel: string,
  diagnostics: ManuscriptOutlineDiagnostic[],
  stableKey: string
) {
  const marker = lines[markerLineIndex];
  const segmentLines = lines.filter((line, index) =>
    index > markerLineIndex && line.start < boundaryStart
  );
  const firstNonEmpty = segmentLines.find((line) => line.content.trim().length > 0);
  let valueStart = marker.end;
  if (firstNonEmpty) {
    const heading = firstNonEmpty.ordinary
      ? firstNonEmpty.content.match(/^[ \t]{0,3}###[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u)
      : null;
    if (heading) {
      const observedLabel = heading[1].trim();
      if (observedLabel !== expectedDisplayLabel) {
        diagnostics.push({
          code: "DISPLAY_HEADING_CHANGED",
          stableKey,
          line: firstNonEmpty.line
        });
      }
      valueStart = firstNonEmpty.end;
      const afterHeading = rawMarkdown.slice(valueStart, boundaryStart);
      const blankSeparator = afterHeading.match(/^[ \t]*(?:\r\n|\r|\n)/u)?.[0];
      if (blankSeparator) valueStart += blankSeparator.length;
    } else {
      diagnostics.push({
        code: "DISPLAY_HEADING_MISSING",
        stableKey,
        line: firstNonEmpty.line
      });
    }
  } else {
    diagnostics.push({
      code: "DISPLAY_HEADING_MISSING",
      stableKey,
      line: marker.line
    });
  }
  return removeStructuralSuffix(rawMarkdown.slice(valueStart, boundaryStart));
}

function parseWithDescriptor(
  rawMarkdown: string,
  identity: ManuscriptOutlineDescriptorLookupIdentity,
  descriptor: ManuscriptOutlineDescriptor
) {
  const lines = scanMarkdownLines(rawMarkdown);
  const diagnostics: ManuscriptOutlineDiagnostic[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const malformedControls: number[] = [];
  let legacyDetected = false;

  lines.forEach((line, index) => {
    if (!line.ordinary) return;
    const trimmed = line.content.trim();
    if (trimmed === MANUSCRIPT_OUTLINE_START_MARKER) starts.push(index);
    else if (trimmed === MANUSCRIPT_OUTLINE_END_MARKER) ends.push(index);
    else if (MALFORMED_CONTROL_MARKER_PATTERN.test(trimmed)) malformedControls.push(index);
    if (LEGACY_MARKER_PATTERN.test(trimmed)) legacyDetected = true;
  });
  if (legacyDetected) diagnostics.push({ code: "LEGACY_FORMAT_DETECTED" });

  const validControlShape =
    malformedControls.length === 0 &&
    starts.length === 1 &&
    ends.length === 1 &&
    starts[0] < ends[0];
  const noControls = starts.length === 0 && ends.length === 0 && malformedControls.length === 0;
  const contentStatus: ManuscriptOutlineContentStatus = noControls
    ? "NO_OUTLINE"
    : validControlShape
      ? "VALID_OUTLINE"
      : "MALFORMED_OUTLINE";

  const regionStart = validControlShape ? starts[0] : -1;
  const regionEnd = validControlShape ? ends[0] : -1;
  lines.forEach((line, index) => {
    if (!line.ordinary) return;
    const match = FIELD_MARKER_PATTERN.exec(line.content.trim());
    if (match && !(index > regionStart && index < regionEnd)) {
      diagnostics.push({
        code: "CANONICAL_MARKER_OUTSIDE_OUTLINE",
        sourceStableKey: match[1],
        line: line.line
      });
    }
  });

  if (contentStatus !== "VALID_OUTLINE") {
    diagnostics.push({ code: contentStatus });
    return makeDto(
      descriptor,
      identity,
      contentStatus,
      allClear(descriptor, contentStatus),
      diagnostics
    );
  }

  const boundaries: FieldBoundary[] = [];
  for (let index = regionStart + 1; index < regionEnd; index += 1) {
    const line = lines[index];
    if (!line.ordinary) continue;
    const trimmed = line.content.trim();
    const field = FIELD_MARKER_PATTERN.exec(trimmed);
    if (field) {
      boundaries.push({ kind: "field", lineIndex: index, stableKey: field[1] });
    } else if (MALFORMED_FIELD_MARKER_PATTERN.test(trimmed)) {
      boundaries.push({ kind: "malformed", lineIndex: index });
      diagnostics.push({ code: "MALFORMED_FIELD_MARKER", line: line.line });
    }
  }
  if (boundaries.length === 0) diagnostics.push({ code: "OUTLINE_BODY_EMPTY" });

  const descriptorByKey = new Map(descriptor.fields.map((field) => [field.stableKey, field]));
  const occurrences = new Map<string, FieldBoundary[]>();
  const observedKnownKeys: string[] = [];
  boundaries.forEach((boundary) => {
    if (boundary.kind !== "field") return;
    const stableKey = boundary.stableKey as string;
    const field = descriptorByKey.get(stableKey);
    if (!field) {
      diagnostics.push({
        code: "FIELD_UNKNOWN",
        sourceStableKey: stableKey,
        line: lines[boundary.lineIndex].line
      });
      return;
    }
    observedKnownKeys.push(stableKey);
    const current = occurrences.get(stableKey) ?? [];
    current.push(boundary);
    occurrences.set(stableKey, current);
  });

  let maximumOrder = -1;
  observedKnownKeys.forEach((stableKey, observedOrder) => {
    const expectedOrder = descriptorByKey.get(stableKey)?.order ?? -1;
    if (expectedOrder < maximumOrder) {
      diagnostics.push({
        code: "FIELD_REORDERED",
        stableKey,
        expectedOrder,
        observedOrder
      });
    }
    maximumOrder = Math.max(maximumOrder, expectedOrder);
  });

  const replacements = descriptor.fields.map((field): ManuscriptOutlineOrderedReplacement => {
    const found = occurrences.get(field.stableKey) ?? [];
    if (found.length === 0) {
      diagnostics.push({ code: "FIELD_MISSING", stableKey: field.stableKey });
      return Object.freeze({
        stableKey: field.stableKey,
        order: field.order,
        action: "clear",
        clearReason: "MISSING"
      });
    }
    if (found.length > 1) {
      diagnostics.push({
        code: "FIELD_DUPLICATE",
        stableKey: field.stableKey,
        line: lines[found[1].lineIndex].line
      });
      return Object.freeze({
        stableKey: field.stableKey,
        order: field.order,
        action: "clear",
        clearReason: "DUPLICATE"
      });
    }
    const boundaryIndex = boundaries.indexOf(found[0]);
    const nextBoundary = boundaries[boundaryIndex + 1];
    const boundaryStart = nextBoundary
      ? lines[nextBoundary.lineIndex].start
      : lines[regionEnd].start;
    const value = extractFieldValue(
      rawMarkdown,
      lines,
      found[0].lineIndex,
      boundaryStart,
      field.displayLabel,
      diagnostics,
      field.stableKey
    );
    if (value.trim().length === 0) {
      diagnostics.push({
        code: "FIELD_EMPTY",
        stableKey: field.stableKey,
        line: lines[found[0].lineIndex].line
      });
      return Object.freeze({
        stableKey: field.stableKey,
        order: field.order,
        action: "clear",
        clearReason: "EMPTY"
      });
    }
    return Object.freeze({
      stableKey: field.stableKey,
      order: field.order,
      action: "set",
      value
    });
  });

  return makeDto(descriptor, identity, contentStatus, replacements, diagnostics);
}

export function parseCanonicalManuscriptOutline(input: Readonly<{
  rawMarkdown: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}>): ManuscriptOutlineParserResult {
  const identity = input?.descriptorLookupIdentity ?? ({} as ManuscriptOutlineDescriptorLookupIdentity);
  if (
    typeof input?.rawMarkdown !== "string" ||
    !identity ||
    typeof identity.ownerType !== "string" ||
    typeof identity.channel !== "string"
  ) return failure("INVALID_PARSER_INPUT", "Canonical OUTLINE parser input is invalid.", identity);
  if (
    (identity.ownerType === "review" && !REVIEW_TYPES.has(identity.reviewType as ReviewType)) ||
    (identity.ownerType !== "review" && identity.reviewType !== undefined)
  ) return failure("IDENTITY_UNSUPPORTED", "Descriptor lookup identity is unsupported.", identity);

  let descriptor: ManuscriptOutlineDescriptor;
  try {
    descriptor = getManuscriptOutlineDescriptor(identity);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return message.startsWith("MANUSCRIPT_OUTLINE_DESCRIPTOR_NOT_FOUND:")
      ? failure("IDENTITY_UNSUPPORTED", "Descriptor lookup identity is unsupported.", identity)
      : failure("REGISTRY_LOOKUP_FAILED", "Descriptor registry lookup failed.", identity);
  }
  if (!descriptorInvariantValid(descriptor, identity)) {
    return failure(
      "DESCRIPTOR_INVARIANT_INVALID",
      "Descriptor registry returned an invalid descriptor.",
      identity
    );
  }
  try {
    return Object.freeze({
      ok: true,
      dto: parseWithDescriptor(input.rawMarkdown, identity, descriptor)
    });
  } catch {
    return failure("INTERNAL_PARSER_FAILURE", "Canonical OUTLINE parser failed.", identity);
  }
}

function sourceMap(
  classification: CanonicalManuscriptSourceSpanMap["classification"],
  rawUtf16Length: number,
  spans: readonly CanonicalManuscriptClassifiedSourceSpan[] = [],
  diagnostics: readonly string[] = [],
  protocolRange?: CanonicalManuscriptUtf16Range
): CanonicalManuscriptSourceSpanMap {
  return Object.freeze({
    classification,
    rawUtf16Length,
    ...(protocolRange ? { protocolRange: Object.freeze(protocolRange) } : {}),
    spans: Object.freeze(spans),
    diagnostics: Object.freeze(diagnostics)
  });
}

export function parseCanonicalManuscriptSourceSpans(input: Readonly<{
  rawMarkdown: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}>): CanonicalManuscriptSourceSpanResult {
  const parsed = parseCanonicalManuscriptOutline(input);
  if (!parsed.ok) return parsed;
  const rawMarkdown = input.rawMarkdown;
  const blockedCodes = new Set<ManuscriptOutlineDiagnosticCode>([
    "MALFORMED_OUTLINE",
    "FIELD_DUPLICATE",
    "FIELD_UNKNOWN",
    "CANONICAL_MARKER_OUTSIDE_OUTLINE",
    "MALFORMED_FIELD_MARKER"
  ]);
  const blocked = parsed.dto.diagnostics.find((diagnostic) =>
    blockedCodes.has(diagnostic.code)
  );
  if (blocked) {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap(
        "FAIL_CLOSED",
        rawMarkdown.length,
        [],
        [`CANONICAL_SOURCE_SPAN_BLOCKED:${blocked.code}`]
      )
    });
  }
  if (parsed.dto.contentStatus === "NO_OUTLINE") {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap("NO_OUTLINE", rawMarkdown.length)
    });
  }
  if (parsed.dto.contentStatus !== "VALID_OUTLINE") {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap(
        "FAIL_CLOSED",
        rawMarkdown.length,
        [],
        ["CANONICAL_SOURCE_SPAN_MALFORMED_OUTLINE"]
      )
    });
  }
  let descriptor: ManuscriptOutlineDescriptor;
  try {
    descriptor = getManuscriptOutlineDescriptor(input.descriptorLookupIdentity);
  } catch {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap(
        "FAIL_CLOSED",
        rawMarkdown.length,
        [],
        ["CANONICAL_SOURCE_SPAN_DESCRIPTOR_LOOKUP_FAILED"]
      )
    });
  }
  const lines = scanMarkdownLines(rawMarkdown);
  const startIndex = lines.findIndex((line) =>
    line.ordinary && line.content.trim() === MANUSCRIPT_OUTLINE_START_MARKER
  );
  const endIndex = lines.findIndex((line) =>
    line.ordinary && line.content.trim() === MANUSCRIPT_OUTLINE_END_MARKER
  );
  if (startIndex < 0 || endIndex <= startIndex) {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap(
        "FAIL_CLOSED",
        rawMarkdown.length,
        [],
        ["CANONICAL_SOURCE_SPAN_OUTLINE_BOUNDARY_UNRESOLVED"]
      )
    });
  }
  const startLine = lines[startIndex];
  const endLine = lines[endIndex];
  const fieldLines = lines
    .map((line, lineIndex) => ({
      line,
      lineIndex,
      match: line.ordinary
        ? FIELD_MARKER_PATTERN.exec(line.content.trim())
        : null
    }))
    .filter((item) =>
      item.lineIndex > startIndex &&
      item.lineIndex < endIndex &&
      item.match
    );
  const descriptorByKey = new Map(
    descriptor.fields.map((field) => [field.stableKey, field])
  );
  const observed = new Set<string>();
  for (const fieldLine of fieldLines) {
    const stableKey = fieldLine.match?.[1] ?? "";
    if (!descriptorByKey.has(stableKey) || observed.has(stableKey)) {
      return Object.freeze({
        ok: true as const,
        dto: parsed.dto,
        sourceMap: sourceMap(
          "FAIL_CLOSED",
          rawMarkdown.length,
          [],
          [`CANONICAL_SOURCE_SPAN_FIELD_IDENTITY_AMBIGUOUS:${stableKey}`]
        )
      });
    }
    observed.add(stableKey);
  }
  const firstFieldStart = fieldLines[0]?.line.start ?? endLine.start;
  const prefixLines = lines.filter((line, lineIndex) =>
    lineIndex > startIndex && line.start < firstFieldStart
  );
  const nonEmptyPrefixLines = prefixLines.filter(
    (line) => line.content.trim().length > 0
  );
  const outlineHeading = nonEmptyPrefixLines.length === 1
    ? nonEmptyPrefixLines[0]
    : undefined;
  const outlineHeadingMatch = outlineHeading?.ordinary
    ? outlineHeading.content.match(
      /^[ \t]{0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u
    )
    : null;
  if (
    !outlineHeading ||
    !outlineHeadingMatch ||
    outlineHeadingMatch[1].trim() !== descriptor.outlineHeading
  ) {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap(
        "FAIL_CLOSED",
        rawMarkdown.length,
        [],
        ["CANONICAL_SOURCE_SPAN_OUTLINE_HEADING_AMBIGUOUS"]
      )
    });
  }
  const spans: CanonicalManuscriptClassifiedSourceSpan[] = [];
  const append = (
    sourceKind: CanonicalManuscriptSourceSpanKind,
    startUtf16: number,
    endUtf16: number,
    metadata: Partial<Pick<
      CanonicalManuscriptClassifiedSourceSpan,
      "stableKey" | "displayLabel" | "protocolRole"
    >> = {}
  ) => {
    if (endUtf16 <= startUtf16) return;
    spans.push(Object.freeze({
      sourceKind,
      sourceRange: Object.freeze({ startUtf16, endUtf16 }),
      ...metadata
    }));
  };
  append("PROTOCOL_CONTROL_SOURCE", startLine.start, startLine.end, {
    protocolRole: "OUTLINE_START"
  });
  append(
    "PROTOCOL_CONTROL_SOURCE",
    startLine.end,
    outlineHeading.start,
    { protocolRole: "OUTLINE_DELIMITER" }
  );
  append(
    "PROTOCOL_HEADING_SOURCE",
    outlineHeading.start,
    outlineHeading.end,
    { protocolRole: "OUTLINE_HEADING" }
  );
  append(
    "PROTOCOL_CONTROL_SOURCE",
    outlineHeading.end,
    firstFieldStart,
    { protocolRole: "OUTLINE_DELIMITER" }
  );
  for (let fieldIndex = 0; fieldIndex < fieldLines.length; fieldIndex += 1) {
    const item = fieldLines[fieldIndex];
    const stableKey = item.match?.[1] ?? "";
    const field = descriptorByKey.get(stableKey);
    if (!field) continue;
    const nextBoundaryStart = fieldLines[fieldIndex + 1]?.line.start ?? endLine.start;
    append(
      "PROTOCOL_CONTROL_SOURCE",
      item.line.start,
      item.line.end,
      {
        stableKey,
        displayLabel: field.displayLabel,
        protocolRole: "FIELD_MARKER"
      }
    );
    const firstNonEmpty = lines.find((line) =>
      line.start >= item.line.end &&
      line.start < nextBoundaryStart &&
      line.content.trim().length > 0
    );
    const headingMatch = firstNonEmpty?.ordinary
      ? firstNonEmpty.content.match(
        /^[ \t]{0,3}###[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u
      )
      : null;
    if (!firstNonEmpty || !headingMatch) {
      return Object.freeze({
        ok: true as const,
        dto: parsed.dto,
        sourceMap: sourceMap(
          "FAIL_CLOSED",
          rawMarkdown.length,
          [],
          [`CANONICAL_SOURCE_SPAN_FIELD_HEADING_AMBIGUOUS:${stableKey}`]
        )
      });
    }
    append(
      "PROTOCOL_CONTROL_SOURCE",
      item.line.end,
      firstNonEmpty.start,
      { stableKey, protocolRole: "FIELD_DELIMITER" }
    );
    append(
      "PROTOCOL_HEADING_SOURCE",
      firstNonEmpty.start,
      firstNonEmpty.end,
      {
        stableKey,
        displayLabel: field.displayLabel,
        protocolRole: "FIELD_HEADING"
      }
    );
    const afterHeading = rawMarkdown.slice(firstNonEmpty.end, nextBoundaryStart);
    const leadingSeparator = afterHeading.match(/^[ \t]*(?:\r\n|\r|\n)/u)?.[0];
    if (!leadingSeparator) {
      return Object.freeze({
        ok: true as const,
        dto: parsed.dto,
        sourceMap: sourceMap(
          "FAIL_CLOSED",
          rawMarkdown.length,
          [],
          [`CANONICAL_SOURCE_SPAN_FIELD_DELIMITER_UNRESOLVED:${stableKey}`]
        )
      });
    }
    const valueStart = firstNonEmpty.end + leadingSeparator.length;
    const valueEnd = structuralValueEndOffset(
      rawMarkdown,
      valueStart,
      nextBoundaryStart
    );
    if (valueEnd < valueStart) {
      return Object.freeze({
        ok: true as const,
        dto: parsed.dto,
        sourceMap: sourceMap(
          "FAIL_CLOSED",
          rawMarkdown.length,
          [],
          [`CANONICAL_SOURCE_SPAN_FIELD_RANGE_INVALID:${stableKey}`]
        )
      });
    }
    append(
      "PROTOCOL_CONTROL_SOURCE",
      firstNonEmpty.end,
      valueStart,
      { stableKey, protocolRole: "FIELD_DELIMITER" }
    );
    append("MANAGED_VALUE_SOURCE", valueStart, valueEnd, {
      stableKey,
      displayLabel: field.displayLabel
    });
    append(
      "PROTOCOL_CONTROL_SOURCE",
      valueEnd,
      nextBoundaryStart,
      { stableKey, protocolRole: "FIELD_DELIMITER" }
    );
  }
  append("PROTOCOL_CONTROL_SOURCE", endLine.start, endLine.end, {
    protocolRole: "OUTLINE_END"
  });
  let cursor = startLine.start;
  for (const span of spans) {
    if (span.sourceRange.startUtf16 !== cursor) {
      return Object.freeze({
        ok: true as const,
        dto: parsed.dto,
        sourceMap: sourceMap(
          "FAIL_CLOSED",
          rawMarkdown.length,
          [],
          ["CANONICAL_SOURCE_SPAN_GAP_OR_OVERLAP"]
        )
      });
    }
    cursor = span.sourceRange.endUtf16;
  }
  if (cursor !== endLine.end) {
    return Object.freeze({
      ok: true as const,
      dto: parsed.dto,
      sourceMap: sourceMap(
        "FAIL_CLOSED",
        rawMarkdown.length,
        [],
        ["CANONICAL_SOURCE_SPAN_NOT_EXHAUSTIVE"]
      )
    });
  }
  return Object.freeze({
    ok: true as const,
    dto: parsed.dto,
    sourceMap: sourceMap(
      "VALID_SOURCE_SPANS",
      rawMarkdown.length,
      spans,
      [],
      { startUtf16: startLine.start, endUtf16: endLine.end }
    )
  });
}

export const manuscriptOutlineParser = Object.freeze({
  parse: parseCanonicalManuscriptOutline,
  parseSourceSpans: parseCanonicalManuscriptSourceSpans
});
