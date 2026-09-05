import type {
  OutputManuscriptOwnerType,
  StructuredSummary
} from "../types";
import { getOutputManuscriptStaticDescriptor } from "./outputManuscriptDescriptorService";
import { OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA } from "./outputManuscriptCanonicalProducerService";
import { parseLabPodMarkdownDocument } from "./labPodMarkdownDocumentService";

const SCHEMA_MARKER = `<!-- LABPOD_DOCUMENT_SCHEMA:${OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA} -->`;
const PROJECT_TITLE_FIELD_KEY = "outputs.meta.projectTitle";
const FIELD_PATTERN = /^<!-- LABPOD_FIELD:([A-Za-z0-9_.-]+) -->\s*$/gmu;
const PROJECT_PATTERN = /^<!-- LABPOD_PROJECT_ID:([^\r\n<>]+) -->\s*$/gmu;

type ParsedField = { key: string; value: string };

function parseFields(block: string) {
  const malformed = block.split(/\r?\n/u).some(
    (line) => line.includes("LABPOD_FIELD:") && !/^<!-- LABPOD_FIELD:[A-Za-z0-9_.-]+ -->\s*$/u.test(line)
  );
  if (malformed) return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_FIELD_MARKER_MALFORMED" };
  const matches = [...block.matchAll(FIELD_PATTERN)];
  const fields: ParsedField[] = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? block.length;
    const lines = block.slice(start, end).trim().split(/\r?\n/u);
    if (lines[0]?.startsWith("### ")) lines.shift();
    const value = lines.join("\n").trim();
    return { key: match[1], value: value === "未填写" ? "" : value };
  });
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_FIELD_DUPLICATE" };
    seen.add(field.key);
  }
  return { status: "success" as const, fields };
}

export type OutputManuscriptStructuredPatch = {
  briefDescription: string;
  structuredSummary: StructuredSummary;
};

export function decodeOutputManuscriptStructuredBlocks(input: {
  ownerType: OutputManuscriptOwnerType;
  projectId: string;
  projectTitle: string;
  rawMarkdown: string;
}) {
  const document = parseLabPodMarkdownDocument(input.rawMarkdown);
  if (document.status !== "valid" && document.status !== "valid-empty") {
    return { status: "error" as const, error: `OUTPUT_MANUSCRIPT_DOCUMENT_${document.status.toUpperCase()}` };
  }
  const meta = document.metaSnapshot ?? "";
  const outline = document.outline ?? "";
  if (meta.split(SCHEMA_MARKER).length - 1 !== 1) {
    return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_SCHEMA_UNSUPPORTED" };
  }
  if (/LABPOD_DOCUMENT_SCHEMA:(?!outputs-manuscript@1)/u.test(meta)) {
    return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_SCHEMA_UNSUPPORTED" };
  }
  const projects = [...meta.matchAll(PROJECT_PATTERN)];
  if (projects.length !== 1 || projects[0][1] !== input.projectId) {
    return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_PROJECT_CONFLICT" };
  }
  const parsedMeta = parseFields(meta);
  const parsedOutline = parseFields(outline);
  if (parsedMeta.status === "error") return parsedMeta;
  if (parsedOutline.status === "error") return parsedOutline;
  const descriptor = getOutputManuscriptStaticDescriptor(input.ownerType);
  const allowedMeta = new Set([descriptor.briefField.fieldKey, PROJECT_TITLE_FIELD_KEY]);
  const allowedOutline = new Set(descriptor.structuredFields.map((field) => field.fieldKey));
  if (parsedMeta.fields.some((field) => !allowedMeta.has(field.key)) || parsedOutline.fields.some((field) => !allowedOutline.has(field.key))) {
    return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_FIELD_UNKNOWN" };
  }
  const metaByKey = new Map(parsedMeta.fields.map((field) => [field.key, field.value]));
  const outlineByKey = new Map(parsedOutline.fields.map((field) => [field.key, field.value]));
  const projectTitle = metaByKey.get(PROJECT_TITLE_FIELD_KEY);
  if (projectTitle !== undefined && projectTitle.trim() && projectTitle.trim() !== input.projectTitle.trim()) {
    return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_PROJECT_CONFLICT" };
  }
  const importableKeys = [descriptor.briefField.fieldKey, ...descriptor.structuredFields.map((field) => field.fieldKey)];
  const present = new Set([...parsedMeta.fields, ...parsedOutline.fields].map((field) => field.key));
  const missingFieldKeys = importableKeys.filter((key) => !present.has(key));
  const briefValue = metaByKey.get(descriptor.briefField.fieldKey) ?? descriptor.briefField.emptyValue;
  if (!descriptor.briefField.validate(briefValue)) {
    return { status: "error" as const, error: "OUTPUT_MANUSCRIPT_FIELD_INVALID" };
  }
  const structuredSummary = descriptor.structuredFields.map((field, order) => {
    const raw = outlineByKey.get(field.fieldKey) ?? field.emptyValue;
    if (!field.validate(raw)) throw new Error(`OUTPUT_MANUSCRIPT_FIELD_INVALID:${field.fieldKey}`);
    return {
      key: field.key,
      label: field.displayLabel,
      value: field.parseFromMarkdown(raw),
      order: order + 1
    };
  });
  return {
    status: "success" as const,
    schemaVersion: OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA,
    patch: {
      briefDescription: descriptor.briefField.parseFromMarkdown(briefValue),
      structuredSummary
    },
    body: document.body ?? "",
    parsed: document,
    importedFieldCount: importableKeys.length - missingFieldKeys.length,
    missingFieldCount: missingFieldKeys.length,
    missingFieldKeys,
    warnings: missingFieldKeys.length ? ["OUTPUT_MANUSCRIPT_OPTIONAL_FIELDS_MISSING"] : []
  };
}

export const outputManuscriptStructuredCodecService = {
  schemaVersion: OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA,
  decode: decodeOutputManuscriptStructuredBlocks
};
