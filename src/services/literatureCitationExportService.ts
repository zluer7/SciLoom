import { exportService, sanitizeFileName, saveTextFile, type ExportResult } from "./exportService";
import { literatureService } from "./literatureService";
import type { Literature, LiteratureType } from "../types/literature";

type CslType =
  | "article-journal" | "paper-conference" | "review" | "book" | "chapter"
  | "thesis" | "patent" | "standard" | "report" | "manuscript"
  | "dataset" | "software" | "webpage" | "document";

const cslTypes: Record<LiteratureType, CslType> = {
  journal_article: "article-journal",
  conference_paper: "paper-conference",
  review: "review",
  book: "book",
  book_chapter: "chapter",
  thesis: "thesis",
  patent: "patent",
  standard: "standard",
  technical_report: "report",
  preprint: "manuscript",
  dataset: "dataset",
  software: "software",
  webpage: "webpage",
  other: "document"
};

const venueTypes = new Set<LiteratureType>([
  "journal_article", "conference_paper", "book_chapter", "review"
]);

export type CitationExportIssue = {
  item: string;
  kind: "missing" | "unsupported" | "invalid";
  field: string;
  detail: string;
};

export type PreparedCitationExport = {
  format: "CSL JSON";
  selectedCount: number;
  includedCount: number;
  omittedCount: number;
  issues: CitationExportIssue[];
  contents: string;
  defaultFileName: string;
};

export class CitationExportPreflightError extends Error {
  constructor(readonly issues: CitationExportIssue[]) {
    super("Citation export preflight failed. No file was prepared.");
  }
}

function optionalText(value: unknown, item: string, field: string, issues: CitationExportIssue[]) {
  if (value === undefined || value === null || value === "") {
    issues.push({ item, kind: "missing", field, detail: "Optional field is absent." });
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push({ item, kind: "invalid", field, detail: "Expected text." });
    return undefined;
  }
  if (!value.trim()) {
    issues.push({ item, kind: "missing", field, detail: "Optional field is blank." });
    return undefined;
  }
  return value.trim();
}

function projectLiterature(literature: Literature, position: number, issues: CitationExportIssue[]) {
  const item = typeof literature.title === "string" && literature.title.trim()
    ? literature.title.trim()
    : `Selected literature ${position}`;
  if (typeof literature.id !== "string" || !literature.id.trim()) {
    issues.push({ item, kind: "invalid", field: "id", detail: "Canonical ID is absent." });
  }
  const sourceType = literature.publicationType;
  const knownType = typeof sourceType === "string" && Object.prototype.hasOwnProperty.call(cslTypes, sourceType);
  if (sourceType !== undefined && sourceType !== null && !knownType) {
    issues.push({ item, kind: "invalid", field: "publicationType", detail: "Unknown type." });
  }
  const type = knownType ? cslTypes[sourceType as LiteratureType] : "document";
  if (!sourceType || sourceType === "other") {
    issues.push({ item, kind: "unsupported", field: "publicationType", detail: "Generic CSL document type used." });
  }
  if (sourceType === "preprint") {
    issues.push({ item, kind: "unsupported", field: "publicationType", detail: "Mapped to CSL manuscript; existing importer does not preserve preprint type." });
  }
  if (sourceType === "review") {
    issues.push({ item, kind: "unsupported", field: "publicationType", detail: "CSL review is valid; existing importer does not preserve SciLoom review type." });
  }
  const title = optionalText(literature.title, item, "title", issues);
  if (!Array.isArray(literature.authors)) {
    issues.push({ item, kind: "invalid", field: "authors", detail: "Expected author array." });
  }
  const author = Array.isArray(literature.authors) ? literature.authors.map((value, index) => {
    if (!value || typeof value.name !== "string" || !value.name.trim()) {
      issues.push({ item, kind: "invalid", field: `authors[${index}].name`, detail: "Expected literal author name." });
      return null;
    }
    if (value.orcid || value.affiliation) {
      issues.push({ item, kind: "unsupported", field: `authors[${index}]`, detail: "ORCID/affiliation omitted; literal name retained." });
    }
    return { literal: value.name.trim() };
  }).filter((value): value is { literal: string } => value !== null) : [];
  if (!author.length && Array.isArray(literature.authors)) {
    issues.push({ item, kind: "missing", field: "authors", detail: "No author recorded." });
  }
  let issued: { "date-parts": [[number]] } | undefined;
  if (literature.year === undefined || literature.year === null) {
    issues.push({ item, kind: "missing", field: "year", detail: "No year recorded." });
  } else if (!Number.isFinite(literature.year) || !Number.isInteger(literature.year)) {
    issues.push({ item, kind: "invalid", field: "year", detail: "Expected finite integer year." });
  } else {
    issued = { "date-parts": [[literature.year]] };
  }
  const venue = optionalText(literature.venue, item, "venue", issues);
  const containerTitle = venue && sourceType && venueTypes.has(sourceType) ? venue : undefined;
  if (venue && !containerTitle) {
    issues.push({ item, kind: "unsupported", field: "venue", detail: "Current type has no bounded container-title mapping." });
  }
  const DOI = optionalText(literature.doi, item, "doi", issues);
  const URL = optionalText(literature.url, item, "url", issues);
  const abstract = optionalText(literature.abstract, item, "abstract", issues);
  const citationKey = optionalText(literature.citationKey, item, "citationKey", issues);
  const bibtexKey = citationKey
    ? undefined
    : optionalText(literature.bibtexKey, item, "bibtexKey", issues);
  if (citationKey && literature.bibtexKey) {
    issues.push({ item, kind: "unsupported", field: "bibtexKey", detail: "citationKey takes precedence." });
  }
  let keyword: string | undefined;
  if (literature.keywords !== undefined && literature.keywords !== null) {
    if (!Array.isArray(literature.keywords) || literature.keywords.some((word) => typeof word !== "string")) {
      issues.push({ item, kind: "invalid", field: "keywords", detail: "Expected text array." });
    } else if (literature.keywords.some((word) => /[,;，；]/u.test(word))) {
      issues.push({ item, kind: "unsupported", field: "keywords", detail: "Separator-bearing keywords omitted to avoid lossy import splitting." });
    } else {
      keyword = literature.keywords.map((word) => word.trim()).filter(Boolean).join("; ") || undefined;
      if (!keyword) issues.push({ item, kind: "missing", field: "keywords", detail: "No keyword recorded." });
    }
  } else {
    issues.push({ item, kind: "missing", field: "keywords", detail: "No keyword recorded." });
  }
  if (literature.externalIds?.length) {
    issues.push({ item, kind: "unsupported", field: "externalIds", detail: "Heterogeneous external IDs omitted." });
  }
  const record = {
    id: literature.id,
    type,
    ...(title ? { title } : {}),
    ...(author.length ? { author } : {}),
    ...(issued ? { issued } : {}),
    ...(containerTitle ? { "container-title": containerTitle } : {}),
    ...(DOI ? { DOI } : {}),
    ...(URL ? { URL } : {}),
    ...(abstract ? { abstract } : {}),
    ...(keyword ? { keyword } : {}),
    ...(citationKey || bibtexKey ? { "citation-key": citationKey || bibtexKey } : {})
  };
  return { item, record };
}

async function prepare(selectedIds: readonly string[]): Promise<PreparedCitationExport> {
  if (!selectedIds.length) throw new CitationExportPreflightError([
    { item: "Selection", kind: "invalid", field: "selection", detail: "Select at least one literature." }
  ]);
  const issues: CitationExportIssue[] = [];
  const records: ReturnType<typeof projectLiterature>["record"][] = [];
  const seen = new Set<string>();
  for (const [index, id] of selectedIds.entries()) {
    const item = `Selected literature ${index + 1}`;
    if (typeof id !== "string" || !id.trim() || seen.has(id)) {
      issues.push({ item, kind: "invalid", field: "selection", detail: "Missing or duplicate selected ID." });
      continue;
    }
    seen.add(id);
    try {
      const literature = await literatureService.getLiteratureById(id);
      if (!literature || literature.id !== id || literature.deletedAt) {
        issues.push({ item, kind: "invalid", field: "selection", detail: "Selected canonical literature is missing, deleted or mismatched." });
        continue;
      }
      const projected = projectLiterature(literature, index + 1, issues);
      records.push(projected.record);
    } catch (error) {
      issues.push({ item, kind: "invalid", field: "read", detail: error instanceof Error ? error.message : "Canonical read failed." });
    }
  }
  if (issues.some((issue) => issue.kind === "invalid") || records.length !== selectedIds.length) {
    throw new CitationExportPreflightError(issues);
  }
  const base = selectedIds.length === 1 ? "literature-citation" : "literature-citations";
  return {
    format: "CSL JSON",
    selectedCount: selectedIds.length,
    includedCount: records.length,
    omittedCount: 0,
    issues,
    contents: `${JSON.stringify(records, null, 2)}\n`,
    defaultFileName: `${sanitizeFileName(base)}.csl.json`
  };
}

async function save(prepared: PreparedCitationExport): Promise<ExportResult> {
  if (!exportService.isDesktopRuntime()) {
    throw new Error("Confirmed Save As requires the desktop app.");
  }
  const result = await saveTextFile(prepared.defaultFileName, prepared.contents, "application/vnd.citationstyles.csl+json;charset=utf-8");
  if (result.saved && !result.filePath) throw new Error("Save backend did not confirm a written file.");
  return result;
}

export const literatureCitationExportService = { prepare, save };
