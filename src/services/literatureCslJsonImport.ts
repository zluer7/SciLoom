import type { CreateLiteratureInput } from "./literatureService";
import type { LiteratureAuthor, LiteratureType } from "../types/literature";

export const CSL_JSON_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const CSL_JSON_IMPORT_MAX_ITEMS = 100;

export type CslImportEntry = {
  index: number;
  sourceId?: string;
  title: string;
  status: "ready" | "warning" | "invalid";
  input?: CreateLiteratureInput;
  warnings: string[];
  errors: string[];
  ignoredFields: string[];
};

export type CslImportPreflight =
  | { ok: true; entries: CslImportEntry[] }
  | { ok: false; code: "parse" | "structure" | "unsupported"; message: string };

const TYPE_MAP: Record<string, LiteratureType> = {
  "article-journal": "journal_article",
  "paper-conference": "conference_paper",
  book: "book",
  chapter: "book_chapter",
  thesis: "thesis",
  patent: "patent",
  report: "technical_report",
  webpage: "webpage",
  "post-weblog": "webpage",
  dataset: "dataset",
  software: "software"
};

const CONSUMED_FIELDS = new Set([
  "id", "type", "title", "author", "issued", "DOI", "URL", "keyword",
  "abstract", "container-title", "citation-key", "bibtexKey", "citationKey"
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authorsOf(value: unknown): { authors: LiteratureAuthor[]; error?: string; warnings: string[] } {
  if (value === undefined) return { authors: [], warnings: [] };
  if (!Array.isArray(value)) return { authors: [], error: "author 必须是作者数组。", warnings: [] };
  const authors: LiteratureAuthor[] = [];
  const warnings: string[] = [];
  for (const [position, item] of value.entries()) {
    if (!record(item)) return { authors: [], error: `第 ${position + 1} 位作者结构无效。`, warnings };
    const literal = nonempty(item.literal);
    const given = nonempty(item.given);
    const family = nonempty(item.family);
    const name = literal ?? [given, family].filter(Boolean).join(" ");
    if (!name) return { authors: [], error: `第 ${position + 1} 位作者缺少姓名。`, warnings };
    const author: LiteratureAuthor = { name };
    if (nonempty(item.ORCID)) author.orcid = nonempty(item.ORCID);
    if (nonempty(item.affiliation)) author.affiliation = nonempty(item.affiliation);
    const ignored = Object.keys(item).filter((key) =>
      !["literal", "given", "family", "ORCID", "affiliation"].includes(key)
    );
    if (ignored.length) warnings.push(`第 ${position + 1} 位作者未承接字段：${ignored.join("、")}。`);
    authors.push(author);
  }
  return { authors, warnings };
}

function yearOf(value: unknown): { year?: number; warning?: string } {
  if (value === undefined) return {};
  if (!record(value)) return { warning: "issued 结构无法确定年份，已留空。" };
  const parts = value["date-parts"];
  let candidate: unknown;
  if (Array.isArray(parts) && parts.length === 1 && Array.isArray(parts[0])) {
    candidate = parts[0][0];
  } else if (typeof value.raw === "string" && /^\d{4}$/.test(value.raw.trim())) {
    candidate = value.raw.trim();
  } else {
    return { warning: "issued 日期范围或复杂日期无法确定单一年份，已留空。" };
  }
  const year = typeof candidate === "number" || typeof candidate === "string"
    ? Number(candidate)
    : NaN;
  return Number.isInteger(year) && year >= 1000 && year <= 9999
    ? { year }
    : { warning: "issued 年份无效，已留空。" };
}

function optionalString(
  item: Record<string, unknown>,
  key: string,
  warnings: string[]
): string | undefined {
  if (item[key] === undefined) return undefined;
  const value = nonempty(item[key]);
  if (!value) warnings.push(`${key} 不是非空文本，已忽略。`);
  return value;
}

function entryOf(value: unknown, index: number): CslImportEntry {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!record(value)) {
    return { index, title: `条目 ${index + 1}`, status: "invalid", warnings, errors: ["条目必须是 CSL JSON 对象。"], ignoredFields: [] };
  }
  const title = nonempty(value.title) ?? `条目 ${index + 1}`;
  const sourceId = typeof value.id === "number" && Number.isFinite(value.id)
    ? String(value.id)
    : nonempty(value.id);
  if (!sourceId) errors.push("缺少有效 CSL id。");
  if (!nonempty(value.title)) errors.push("缺少有效标题。");
  const type = nonempty(value.type);
  if (!type) errors.push("缺少有效 CSL type。");
  const publicationType = type ? TYPE_MAP[type] ?? "other" : undefined;
  if (type && !TYPE_MAP[type]) warnings.push(`type=${type} 未精确映射，按现有 other 类型创建。`);
  const authorResult = authorsOf(value.author);
  warnings.push(...authorResult.warnings);
  if (authorResult.error) errors.push(authorResult.error);
  const issued = yearOf(value.issued);
  if (issued.warning) warnings.push(issued.warning);
  const ignoredFields = Object.keys(value).filter((key) => !CONSUMED_FIELDS.has(key));
  if (ignoredFields.length) warnings.push(`未承接字段：${ignoredFields.join("、")}。`);
  const keyword = optionalString(value, "keyword", warnings);
  const keywords = keyword ? keyword.split(/[,;；，]/u).map((part) => part.trim()).filter(Boolean) : [];
  const citationKey = optionalString(value, "citation-key", warnings)
    ?? optionalString(value, "citationKey", warnings);
  const bibtexKey = optionalString(value, "bibtexKey", warnings);
  const input: CreateLiteratureInput = {
    title: nonempty(value.title) ?? "",
    authors: authorResult.authors,
    year: issued.year,
    publicationType,
    venue: optionalString(value, "container-title", warnings),
    doi: optionalString(value, "DOI", warnings),
    url: optionalString(value, "URL", warnings),
    abstract: optionalString(value, "abstract", warnings),
    keywords,
    tags: keywords,
    citationKey,
    bibtexKey,
    externalIds: sourceId ? [{ source: "other", id: sourceId }] : [],
    readingStatus: "unread",
    primaryProjectId: null,
    source: "user"
  };
  return {
    index,
    sourceId,
    title,
    status: errors.length ? "invalid" : warnings.length ? "warning" : "ready",
    input: errors.length ? undefined : input,
    warnings,
    errors,
    ignoredFields
  };
}

export function preflightLiteratureCslJson(text: string): CslImportPreflight {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "parse", message: "JSON 解析失败；请选择有效的 CSL JSON 文件。" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, code: "unsupported", message: "本版只支持 CSL JSON 条目数组，不支持单对象或包装协议。" };
  }
  if (parsed.length === 0 || parsed.length > CSL_JSON_IMPORT_MAX_ITEMS) {
    return { ok: false, code: "structure", message: `条目数须为 1–${CSL_JSON_IMPORT_MAX_ITEMS}。` };
  }
  const entries = parsed.map(entryOf);
  if (entries.every((entry) => entry.status === "invalid")) {
    return { ok: false, code: "structure", message: "文件中没有可导入的 CSL JSON 条目；请检查 id、type、title 和作者结构。" };
  }
  return { ok: true, entries };
}
