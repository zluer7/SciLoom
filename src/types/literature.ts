import type { AuditableEntity, EntityId, ISODateString } from "./common";
import type { CustomField } from "./experiment";
import type { EntitySource } from "./planning";

export const LITERATURE_SCHEMA_VERSION = 2;

export type LiteratureType =
  | "journal_article"
  | "conference_paper"
  | "review"
  | "book"
  | "book_chapter"
  | "thesis"
  | "patent"
  | "standard"
  | "technical_report"
  | "preprint"
  | "dataset"
  | "software"
  | "webpage"
  | "other";

export type LiteratureReadingStatus =
  | "unread"
  | "skimmed"
  | "reading"
  | "intensive_read"
  | "summarized"
  | "reused"
  | "discarded"
  | "archived";

export type LiteratureImportance =
  | "core"
  | "important"
  | "useful"
  | "background"
  | "low"
  | "uncertain";

export type LiteratureArchiveStatus = "active" | "all" | "archived";

export interface LiteratureAuthor {
  name: string;
  affiliation?: string;
  orcid?: string;
}

export interface LiteratureExternalId {
  source:
    | "zotero"
    | "doi"
    | "bibtex"
    | "ris"
    | "endnote"
    | "mendeley"
    | "readpaper"
    | "cnki"
    | "manual"
    | "other";
  id: string;
  url?: string;
  importedAt?: ISODateString;
}

export interface AiMetadata {
  generatedByAi?: boolean;
  aiModel?: string;
  generatedAt?: ISODateString;
  promptVersion?: string;

  userConfirmed?: boolean;
  confirmedAt?: ISODateString | null;

  includeInAiContext?: boolean;

  sourceReliability?: "high" | "medium" | "low" | "uncertain";

  /**
   * Application-owned A16 operation correlation. It is never accepted from a
   * provider payload or rendered as an editable bibliography field.
   */
  standardResultOperation?: LiteratureStandardResultOperationCorrelation;
}

export interface LiteratureStandardResultOperationCorrelation {
  version: 1;
  action: "CREATE" | "UPDATE";
  operationKey: string;
  resultId: string;
  authorizationId: string;
  confirmedPayloadFingerprint: string;
  appliedUpdatedAt: ISODateString;
}

export type Literature = AuditableEntity & {
  schemaVersion: number;
  source?: EntitySource;
  tags: string[];
  customFields?: CustomField[];
  aiMetadata?: AiMetadata;

  title: string;
  authors: LiteratureAuthor[];
  year?: number;
  venue?: string;
  publicationType?: LiteratureType;

  abstract?: string;
  keywords?: string[];

  doi?: string;
  url?: string;
  pdfPath?: string;
  localFilePath?: string;

  bibtexKey?: string;
  citationKey?: string;
  externalIds?: LiteratureExternalId[];

  readingStatus: LiteratureReadingStatus;
  importance?: LiteratureImportance;

  primaryProjectId?: EntityId | null;

  isArchived?: boolean;
  archivedAt?: ISODateString | null;
};

/**
 * LiteratureLink targets are research objects that a literature item can support,
 * compare with, question, or inform as evidence. Deleted legacy literature
 * maintenance objects are intentionally not valid targets.
 */
export type LiteratureLinkTargetType =
  | "project"
  | "route"
  | "task"
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "output"
  | "review"
  | "aiContext"
  | "other";

export type LiteratureRelationType =
  | "background_support"
  | "core_related_work"
  | "method_reference"
  | "theory_support"
  | "problem_source"
  | "baseline"
  | "parameter_reference"
  | "data_processing_reference"
  | "evaluation_metric_reference"
  | "experiment_comparison"
  | "result_interpretation"
  | "related_work"
  | "writing_support"
  | "patent_background"
  | "contradicts"
  | "extends"
  | "inspired_by"
  | "other";

export type LiteratureEvidenceRole =
  | "introduction"
  | "related_work"
  | "method"
  | "experiment"
  | "discussion"
  | "conclusion"
  | "patent_background"
  | "report_support"
  | "future_work"
  | "other";

export type LinkStrength = "strong" | "medium" | "weak" | "uncertain";

export type LinkConfidence = "confirmed" | "probable" | "tentative" | "ai_suggested";

/**
 * A literature-specific evidence relation.
 *
 * This is not a generic cross-module relation replacement for EntityLink and is
 * not a raw UI target form contract. It always starts from one Literature item
 * and records how that paper/book/source relates to one research object.
 */
export type LiteratureLink = AuditableEntity & {
  schemaVersion: number;
  tags?: string[];
  customFields?: CustomField[];
  aiMetadata?: AiMetadata;

  literatureId: EntityId;

  targetType: LiteratureLinkTargetType;
  targetId: EntityId;

  projectId?: EntityId | null;

  relationType: LiteratureRelationType;
  role?: LiteratureEvidenceRole;

  description?: string;
  note?: string;

  strength?: LinkStrength;
  confidence?: LinkConfidence;
};
