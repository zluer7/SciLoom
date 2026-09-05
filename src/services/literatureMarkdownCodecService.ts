import type { Literature, LiteratureImportance, LiteratureType, ManuscriptChannel } from "../types";
import type { LiteratureStructuredOutlineSummary } from "../types/literatureContext";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";

export const LITERATURE_CODEC_VERSION = "v2" as const;
export const LITERATURE_META_CODEC_MARKER =
  "<!-- LABPOD_LITERATURE_META_CODEC:v2 -->" as const;
export const LITERATURE_OUTLINE_CODEC_MARKER =
  "<!-- LABPOD_LITERATURE_OUTLINE_CODEC:v2 -->" as const;

export const LITERATURE_CODEC_ERROR_CODES = {
  versionMissing: "LITERATURE_CODEC_VERSION_MISSING",
  versionUnsupported: "LITERATURE_CODEC_VERSION_UNSUPPORTED",
  channelMismatch: "LITERATURE_CODEC_CHANNEL_MISMATCH",
  fieldMissing: "LITERATURE_CODEC_FIELD_MISSING",
  fieldDuplicate: "LITERATURE_CODEC_FIELD_DUPLICATE",
  fieldUnknown: "LITERATURE_CODEC_FIELD_UNKNOWN",
  invalid: "LITERATURE_CODEC_INVALID",
  ambiguous: "LITERATURE_CODEC_AMBIGUOUS",
  cutoverRequired: "LITERATURE_CODEC_CUTOVER_REQUIRED",
  cutoverConfirmationRequired: "LITERATURE_CUTOVER_CONFIRMATION_REQUIRED",
  cutoverAbstractConflict: "LITERATURE_CUTOVER_ABSTRACT_CONFLICT",
  cutoverTargetInvalid: "LITERATURE_CUTOVER_TARGET_INVALID",
  cutoverWriteFailed: "LITERATURE_CUTOVER_WRITE_FAILED"
} as const;

export type LiteratureCodecErrorCode =
  (typeof LITERATURE_CODEC_ERROR_CODES)[keyof typeof LITERATURE_CODEC_ERROR_CODES];

export interface LiteratureCodecDiagnostic {
  code: LiteratureCodecErrorCode;
  message: string;
  fieldKey?: string;
  details?: Record<string, string | number | boolean>;
}

export class LiteratureCodecError extends Error {
  readonly code: LiteratureCodecErrorCode;
  readonly diagnostics: LiteratureCodecDiagnostic[];

  constructor(
    code: LiteratureCodecErrorCode,
    message: string,
    diagnostics: LiteratureCodecDiagnostic[] = [{ code, message }]
  ) {
    super(`${code}: ${message}`);
    this.name = "LiteratureCodecError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface LiteratureMetaV2Data {
  title: string;
  authors: string;
  year: string;
  publicationType: string;
  venue: string;
  doi: string;
  url: string;
  importance: string;
  keywords: string;
}

export interface LiteratureDedicatedNotesSummary {
  projectSummary?: string;
  projectRelevance?: string;
  relatedObjectNotes?: string;
  reusableMethods?: string;
  comparableConclusions?: string;
  other?: string;
}

export type LiteratureCodecChannel = "literature_outline" | "dedicated_notes";

const META_FIELDS = [
  "title",
  "authors",
  "year",
  "publication_type",
  "venue",
  "doi",
  "url",
  "importance",
  "keywords"
] as const;

const OUTLINE_FIELDS = Object.freeze({
  literature_outline: getManuscriptOutlineDescriptor({ ownerType: "literature", channel: "literature_outline" }).fields.map((item) => item.stableKey),
  dedicated_notes: getManuscriptOutlineDescriptor({ ownerType: "literature", channel: "dedicated_notes" }).fields.map((item) => item.stableKey)
});

const OUTLINE_LABELS = Object.freeze({
  literature_outline: Object.fromEntries(
    getManuscriptOutlineDescriptor({ ownerType: "literature", channel: "literature_outline" })
      .fields.map((item) => [item.stableKey, item.displayLabel])
  ),
  dedicated_notes: Object.fromEntries(
    getManuscriptOutlineDescriptor({ ownerType: "literature", channel: "dedicated_notes" })
      .fields.map((item) => [item.stableKey, item.displayLabel])
  )
}) as Readonly<Record<LiteratureCodecChannel, Readonly<Record<string, string>>>>;

const META_LABELS: Record<(typeof META_FIELDS)[number], string> = {
  title: "标题",
  authors: "作者",
  year: "年份",
  publication_type: "类型",
  venue: "来源",
  doi: "DOI",
  url: "URL",
  importance: "重要性",
  keywords: "关键词"
};

const EMPTY_VALUE = "未填写";
const FIELD_MARKER_PATTERN = /^<!-- LABPOD_FIELD:([a-z0-9_]+) -->$/u;
const GROUP_MARKER_PATTERN = /^<!-- LABPOD_GROUP:([a-z0-9_]+) -->$/u;
const META_CODEC_PREFIX = "<!-- LABPOD_LITERATURE_META_CODEC:";
const OUTLINE_CODEC_PREFIX = "<!-- LABPOD_LITERATURE_OUTLINE_CODEC:";
const CHANNEL_PREFIX = "<!-- LABPOD_LITERATURE_CHANNEL:";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function oneLine(value: unknown) {
  return text(value).replace(/\s+/gu, " ");
}

function normalizedLines(raw: string) {
  return String(raw ?? "").replace(/\r\n?/gu, "\n").split("\n");
}

function fail(
  code: LiteratureCodecErrorCode,
  message: string,
  details?: Omit<LiteratureCodecDiagnostic, "code" | "message">
): never {
  throw new LiteratureCodecError(code, message, [{ code, message, ...details }]);
}

function validateCodecMarker(
  lines: string[],
  exactMarker: string,
  prefix: string
) {
  const markers = lines.filter((line) => line.trim().startsWith(prefix));
  if (markers.length === 0) {
    fail(LITERATURE_CODEC_ERROR_CODES.versionMissing, "Literature codec version marker is missing.");
  }
  if (markers.length > 1) {
    fail(LITERATURE_CODEC_ERROR_CODES.ambiguous, "Literature codec version marker is duplicated.");
  }
  if (markers[0].trim() !== exactMarker) {
    fail(LITERATURE_CODEC_ERROR_CODES.versionUnsupported, "Literature codec version is unsupported.");
  }
}

function validateChannel(lines: string[], channel: LiteratureCodecChannel) {
  const markers = lines.filter((line) => line.trim().startsWith(CHANNEL_PREFIX));
  const exact = `<!-- LABPOD_LITERATURE_CHANNEL:${channel} -->`;
  if (markers.length !== 1 || markers[0].trim() !== exact) {
    fail(
      LITERATURE_CODEC_ERROR_CODES.channelMismatch,
      `Literature codec channel does not match ${channel}.`,
      { details: { expectedChannel: channel, markerCount: markers.length } }
    );
  }
}

function parseFieldSegments(
  raw: string,
  requiredFields: readonly string[],
  allowedGroups: readonly string[] = []
) {
  const lines = normalizedLines(raw);
  const fieldMarkers: Array<{ index: number; key: string }> = [];
  const boundaryIndexes = new Set<number>();
  const counts = new Map<string, number>();
  const allowed = new Set(requiredFields);
  const groups = new Set(allowedGroups);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const field = FIELD_MARKER_PATTERN.exec(trimmed);
    const group = GROUP_MARKER_PATTERN.exec(trimmed);
    if (field) {
      const key = field[1];
      fieldMarkers.push({ index, key });
      boundaryIndexes.add(index);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!allowed.has(key)) {
        fail(LITERATURE_CODEC_ERROR_CODES.fieldUnknown, `Unknown Literature codec field: ${key}.`, {
          fieldKey: key
        });
      }
      return;
    }
    if (group) {
      boundaryIndexes.add(index);
      if (!groups.has(group[1])) {
        fail(LITERATURE_CODEC_ERROR_CODES.invalid, `Unknown Literature codec group: ${group[1]}.`, {
          details: { groupKey: group[1] }
        });
      }
      return;
    }
    if (trimmed.includes("LABPOD_FIELD:")) {
      fail(LITERATURE_CODEC_ERROR_CODES.invalid, "Malformed Literature field marker.");
    }
    if (trimmed.includes("LABPOD_GROUP:")) {
      fail(LITERATURE_CODEC_ERROR_CODES.invalid, "Malformed Literature group marker.");
    }
  });

  for (const key of requiredFields) {
    const count = counts.get(key) ?? 0;
    if (count === 0) {
      fail(LITERATURE_CODEC_ERROR_CODES.fieldMissing, `Required Literature codec field is missing: ${key}.`, {
        fieldKey: key
      });
    }
    if (count > 1) {
      fail(LITERATURE_CODEC_ERROR_CODES.fieldDuplicate, `Literature codec field is duplicated: ${key}.`, {
        fieldKey: key,
        details: { count }
      });
    }
  }

  const boundaries = [...boundaryIndexes].sort((left, right) => left - right);
  return Object.fromEntries(fieldMarkers.map(({ index, key }) => {
    const end = boundaries.find((candidate) => candidate > index) ?? lines.length;
    return [key, lines.slice(index + 1, end)];
  })) as Record<string, string[]>;
}

function trimBlankLines(lines: string[]) {
  const next = [...lines];
  while (next.length && !next[0].trim()) next.shift();
  while (next.length && !next[next.length - 1].trim()) next.pop();
  return next;
}

function parseMetaValue(lines: string[], fieldKey: string) {
  const valueLines = trimBlankLines(lines);
  const first = valueLines.shift();
  if (!first) return "";
  const match = /^\s*[-*]\s+[^：:\n]+[：:]\s*(.*)$/u.exec(first);
  if (!match) {
    fail(LITERATURE_CODEC_ERROR_CODES.invalid, `Literature META field has invalid visible syntax: ${fieldKey}.`, {
      fieldKey
    });
  }
  const value = [match[1], ...valueLines].join("\n").trim();
  return value === EMPTY_VALUE ? "" : value;
}

function parseOutlineValue(lines: string[]) {
  const valueLines = trimBlankLines(lines);
  if (valueLines[0] && /^#{1,6}\s+.+$/u.test(valueLines[0].trim())) {
    valueLines.shift();
  }
  return trimBlankLines(valueLines).join("\n");
}

function displayValue(value: unknown) {
  return text(value) || EMPTY_VALUE;
}

function fieldMarker(key: string) {
  return `<!-- LABPOD_FIELD:${key} -->`;
}

function outlineField(key: string, heading: string, value: unknown, level = 3) {
  return [fieldMarker(key), `${"#".repeat(level)} ${heading}`, "", text(value)].join("\n").trimEnd();
}

function literatureOutlineField(
  channel: LiteratureCodecChannel,
  key: string,
  value: unknown,
  level = 3
) {
  const label = OUTLINE_LABELS[channel][key];
  if (!label) {
    fail(LITERATURE_CODEC_ERROR_CODES.fieldUnknown, `Unknown Literature descriptor field: ${key}.`, {
      fieldKey: key
    });
  }
  return outlineField(key, label, value, level);
}

function requireLiteratureChannel(channel: ManuscriptChannel): asserts channel is LiteratureCodecChannel {
  if (channel !== "literature_outline" && channel !== "dedicated_notes") {
    fail(LITERATURE_CODEC_ERROR_CODES.channelMismatch, `Unsupported Literature codec channel: ${channel}.`);
  }
}

export function buildLiteratureMetaV2Data(literature: Literature): LiteratureMetaV2Data {
  return {
    title: oneLine(literature.title),
    authors: literature.authors.map((author) => oneLine(author.name)).filter(Boolean).join(", "),
    year: literature.year === undefined ? "" : String(literature.year),
    publicationType: text(literature.publicationType as LiteratureType | undefined),
    venue: oneLine(literature.venue),
    doi: oneLine(literature.doi),
    url: oneLine(literature.url),
    importance: text(literature.importance as LiteratureImportance | undefined),
    keywords: (literature.keywords ?? []).map(oneLine).filter(Boolean).join(", ")
  };
}

export function serializeLiteratureMetaV2(data: LiteratureMetaV2Data) {
  const values: Record<(typeof META_FIELDS)[number], string> = {
    title: data.title,
    authors: data.authors,
    year: data.year,
    publication_type: data.publicationType,
    venue: data.venue,
    doi: data.doi,
    url: data.url,
    importance: data.importance,
    keywords: data.keywords
  };
  return [
    LITERATURE_META_CODEC_MARKER,
    "",
    "# 文献信息",
    "",
    ...META_FIELDS.flatMap((key, index) => [
      ...(index > 0 ? [""] : []),
      fieldMarker(key),
      `- ${META_LABELS[key]}：${displayValue(values[key])}`
    ])
  ].join("\n").trimEnd();
}

export function buildLiteratureMetaSnapshotV2(literature: Literature) {
  return serializeLiteratureMetaV2(buildLiteratureMetaV2Data(literature));
}

export function parseLiteratureMetaV2(raw: string): LiteratureMetaV2Data {
  const lines = normalizedLines(raw);
  validateCodecMarker(lines, LITERATURE_META_CODEC_MARKER, META_CODEC_PREFIX);
  const fields = parseFieldSegments(raw, META_FIELDS);
  return {
    title: parseMetaValue(fields.title, "title"),
    authors: parseMetaValue(fields.authors, "authors"),
    year: parseMetaValue(fields.year, "year"),
    publicationType: parseMetaValue(fields.publication_type, "publication_type"),
    venue: parseMetaValue(fields.venue, "venue"),
    doi: parseMetaValue(fields.doi, "doi"),
    url: parseMetaValue(fields.url, "url"),
    importance: parseMetaValue(fields.importance, "importance"),
    keywords: parseMetaValue(fields.keywords, "keywords")
  };
}

export function serializeLiteratureOutlineV2(outline: LiteratureStructuredOutlineSummary) {
  return [
    LITERATURE_OUTLINE_CODEC_MARKER,
    "<!-- LABPOD_LITERATURE_CHANNEL:literature_outline -->",
    "",
    literatureOutlineField("literature_outline", "summary", outline.abstract),
    "",
    "<!-- LABPOD_GROUP:research_problem_and_object -->",
    "### 研究问题和对象",
    "",
    literatureOutlineField("literature_outline", "research_problem", outline.researchProblem, 4),
    "",
    literatureOutlineField("literature_outline", "application_object", outline.applicationObject, 4),
    "",
    literatureOutlineField("literature_outline", "method_overview", outline.methodOverview),
    "",
    literatureOutlineField("literature_outline", "main_conclusion", outline.mainConclusion),
    "",
    literatureOutlineField("literature_outline", "limitations", outline.limitations),
    "",
    literatureOutlineField("literature_outline", "other", outline.other)
  ].join("\n").trimEnd();
}

export function parseLiteratureOutlineV2(raw: string): LiteratureStructuredOutlineSummary {
  const lines = normalizedLines(raw);
  validateCodecMarker(lines, LITERATURE_OUTLINE_CODEC_MARKER, OUTLINE_CODEC_PREFIX);
  validateChannel(lines, "literature_outline");
  const fields = parseFieldSegments(
    raw,
    OUTLINE_FIELDS.literature_outline,
    ["research_problem_and_object"]
  );
  return {
    abstract: parseOutlineValue(fields.summary) || undefined,
    researchProblem: parseOutlineValue(fields.research_problem) || undefined,
    applicationObject: parseOutlineValue(fields.application_object) || undefined,
    methodOverview: parseOutlineValue(fields.method_overview) || undefined,
    mainConclusion: parseOutlineValue(fields.main_conclusion) || undefined,
    limitations: parseOutlineValue(fields.limitations) || undefined,
    other: parseOutlineValue(fields.other) || undefined
  };
}

export function serializeLiteratureDedicatedNotesV2(notes: LiteratureDedicatedNotesSummary) {
  return [
    LITERATURE_OUTLINE_CODEC_MARKER,
    "<!-- LABPOD_LITERATURE_CHANNEL:dedicated_notes -->",
    "",
    literatureOutlineField("dedicated_notes", "summary", notes.projectSummary),
    "",
    literatureOutlineField("dedicated_notes", "project_relevance", notes.projectRelevance),
    "",
    literatureOutlineField("dedicated_notes", "related_objects", notes.relatedObjectNotes),
    "",
    literatureOutlineField("dedicated_notes", "reusable_methods", notes.reusableMethods),
    "",
    literatureOutlineField("dedicated_notes", "comparable_conclusions", notes.comparableConclusions),
    "",
    literatureOutlineField("dedicated_notes", "other", notes.other)
  ].join("\n").trimEnd();
}

export function parseLiteratureDedicatedNotesV2(raw: string): LiteratureDedicatedNotesSummary {
  const lines = normalizedLines(raw);
  validateCodecMarker(lines, LITERATURE_OUTLINE_CODEC_MARKER, OUTLINE_CODEC_PREFIX);
  validateChannel(lines, "dedicated_notes");
  const fields = parseFieldSegments(raw, OUTLINE_FIELDS.dedicated_notes);
  return {
    projectSummary: parseOutlineValue(fields.summary) || undefined,
    projectRelevance: parseOutlineValue(fields.project_relevance) || undefined,
    relatedObjectNotes: parseOutlineValue(fields.related_objects) || undefined,
    reusableMethods: parseOutlineValue(fields.reusable_methods) || undefined,
    comparableConclusions: parseOutlineValue(fields.comparable_conclusions) || undefined,
    other: parseOutlineValue(fields.other) || undefined
  };
}

export function parseLiteratureOutlineForRuntime(raw: string, channel: ManuscriptChannel) {
  requireLiteratureChannel(channel);
  if (!raw.includes(LITERATURE_OUTLINE_CODEC_MARKER)) {
    fail(
      LITERATURE_CODEC_ERROR_CODES.cutoverRequired,
      "需要先执行 Literature 文稿格式转换。"
    );
  }
  return channel === "dedicated_notes"
    ? parseLiteratureDedicatedNotesV2(raw)
    : parseLiteratureOutlineV2(raw);
}

export function assertLiteratureDocumentV2(input: {
  metaSnapshot: string;
  outline: string;
  channel: ManuscriptChannel;
}) {
  requireLiteratureChannel(input.channel);
  const hasMeta = input.metaSnapshot.includes(LITERATURE_META_CODEC_MARKER);
  const hasOutline = input.outline.includes(LITERATURE_OUTLINE_CODEC_MARKER);
  if (!hasMeta && !hasOutline) {
    fail(
      LITERATURE_CODEC_ERROR_CODES.cutoverRequired,
      "需要先执行 Literature 文稿格式转换。"
    );
  }
  if (!hasMeta || !hasOutline) {
    fail(
      LITERATURE_CODEC_ERROR_CODES.versionMissing,
      "Literature v2 文稿缺少 META 或 OUTLINE codec marker。"
    );
  }
  const meta = parseLiteratureMetaV2(input.metaSnapshot);
  const outline = parseLiteratureOutlineForRuntime(input.outline, input.channel);
  return { meta, outline };
}

export function canonicalizeLiteratureDocumentV2(input: {
  metaSnapshot: string;
  outline: string;
  channel: ManuscriptChannel;
}) {
  const parsed = assertLiteratureDocumentV2(input);
  return {
    metaSnapshot: serializeLiteratureMetaV2(parsed.meta),
    outline: input.channel === "dedicated_notes"
      ? serializeLiteratureDedicatedNotesV2(parsed.outline as LiteratureDedicatedNotesSummary)
      : serializeLiteratureOutlineV2(parsed.outline as LiteratureStructuredOutlineSummary)
  };
}

export function literatureCodecDiagnosticFromUnknown(error: unknown): LiteratureCodecDiagnostic[] {
  if (error instanceof LiteratureCodecError) return error.diagnostics;
  const message = error instanceof Error ? error.message : String(error);
  return [{ code: LITERATURE_CODEC_ERROR_CODES.invalid, message }];
}

export const literatureMarkdownCodecService = {
  version: LITERATURE_CODEC_VERSION,
  metaMarker: LITERATURE_META_CODEC_MARKER,
  outlineMarker: LITERATURE_OUTLINE_CODEC_MARKER,
  buildMetaSnapshot: buildLiteratureMetaSnapshotV2,
  parseMeta: parseLiteratureMetaV2,
  serializeMeta: serializeLiteratureMetaV2,
  parseOutline: parseLiteratureOutlineV2,
  serializeOutline: serializeLiteratureOutlineV2,
  parseDedicatedNotes: parseLiteratureDedicatedNotesV2,
  serializeDedicatedNotes: serializeLiteratureDedicatedNotesV2,
  assertDocument: assertLiteratureDocumentV2,
  canonicalizeDocument: canonicalizeLiteratureDocumentV2
};
