import type { EntityId } from "./common";
import type { LabPodMarkdownDiagnostic, LabPodMarkdownDocumentStatus } from "./labPodMarkdownBlocks";
import type { ReviewOutlineSectionKey, ReviewType } from "./planning";

export const REVIEW_MANUSCRIPT_ERROR_CODES = {
  ownerMissing: "REVIEW_MANUSCRIPT_OWNER_MISSING",
  ownerDeleted: "REVIEW_MANUSCRIPT_OWNER_DELETED",
  bindingMissing: "REVIEW_MANUSCRIPT_BINDING_MISSING",
  currentMissing: "REVIEW_MANUSCRIPT_CURRENT_MISSING",
  fileRefMissing: "REVIEW_MANUSCRIPT_FILE_REF_MISSING",
  fileRefInactive: "REVIEW_MANUSCRIPT_FILE_REF_INACTIVE",
  ownerMismatch: "REVIEW_MANUSCRIPT_OWNER_MISMATCH",
  channelMismatch: "REVIEW_MANUSCRIPT_CHANNEL_MISMATCH",
  resourceKindMismatch: "REVIEW_MANUSCRIPT_RESOURCE_KIND_MISMATCH",
  fileRoleMismatch: "REVIEW_MANUSCRIPT_FILE_ROLE_MISMATCH",
  extensionUnsupported: "REVIEW_MANUSCRIPT_EXTENSION_UNSUPPORTED",
  fileMissing: "REVIEW_MANUSCRIPT_FILE_MISSING",
  fileUnreadable: "REVIEW_MANUSCRIPT_FILE_UNREADABLE",
  parseInvalid: "REVIEW_MANUSCRIPT_PARSE_INVALID",
  parseAmbiguous: "REVIEW_MANUSCRIPT_PARSE_AMBIGUOUS",
  pathUnsafe: "REVIEW_MANUSCRIPT_PATH_UNSAFE",
  saveFailed: "REVIEW_MANUSCRIPT_SAVE_FAILED",
  serializeFailed: "REVIEW_MANUSCRIPT_SERIALIZE_FAILED",
  staleRequest: "REVIEW_MANUSCRIPT_STALE_REQUEST",
  targetMismatch: "REVIEW_MANUSCRIPT_TARGET_MISMATCH",
  targetDeleted: "REVIEW_MANUSCRIPT_TARGET_DELETED"
} as const;

export type ReviewManuscriptErrorCode =
  (typeof REVIEW_MANUSCRIPT_ERROR_CODES)[keyof typeof REVIEW_MANUSCRIPT_ERROR_CODES];

export type ReviewManuscriptTargetType =
  | "project"
  | "routeNode"
  | "task"
  | "experiment"
  | "experimentRun"
  | "literature";

export interface ReviewManuscriptTargetDto {
  targetType: ReviewManuscriptTargetType;
  targetId: EntityId;
  displayName: string;
  missing: boolean;
  order: number;
}

export interface ReviewManuscriptOutlineSectionDto {
  key: ReviewOutlineSectionKey;
  displayName: string;
  content: string;
  missing: boolean;
  order: number;
}

export interface ReviewManuscriptWarning {
  code: string;
  message: string;
}

export interface ReviewManuscriptProvenance {
  source: "复盘结构化记录" | "正式复盘对象关系" | "复盘对象选择服务";
  confidence: "direct" | "derived" | "missing";
  note?: string;
}

export interface ReviewManuscriptStructuredDto {
  reviewId: EntityId;
  projectId: EntityId;
  projectDisplayName: string;
  projectMissing: boolean;
  title: string;
  description: string;
  reviewType: ReviewType;
  reviewTypeDisplayName: string;
  periodStart?: string;
  periodEnd?: string;
  periodLabel?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  outlineSections: ReviewManuscriptOutlineSectionDto[];
  targets: ReviewManuscriptTargetDto[];
  warnings: ReviewManuscriptWarning[];
  provenance: ReviewManuscriptProvenance[];
}

export type ReviewManuscriptStructuredResult =
  | { status: "success"; dto: ReviewManuscriptStructuredDto }
  | { status: "error"; error: ReviewManuscriptError };

export interface ReviewManuscriptError {
  code: ReviewManuscriptErrorCode;
  message: string;
  diagnostics?: string[];
}

export type ReviewManuscriptRequestScope = "current" | "target" | "filename";

export interface ReviewManuscriptRequestIdentity {
  scope: ReviewManuscriptRequestScope;
  requestToken: number;
  refreshIdentity: string;
}

export interface ReviewManuscriptDocument {
  ownerType: "review";
  reviewId: EntityId;
  manuscriptChannel: "primary";
  fileRefId: EntityId;
  filename: string;
  rawMarkdown: string;
  metaSnapshot: string;
  outline: string;
  body: string;
  parseStatus: LabPodMarkdownDocumentStatus;
  diagnostics: LabPodMarkdownDiagnostic[];
  warnings: ReviewManuscriptWarning[];
  updatedAt: string;
  request: ReviewManuscriptRequestIdentity;
}

export type ReviewManuscriptDocumentResult =
  | { status: "success"; document: ReviewManuscriptDocument }
  | {
      status: "error";
      reviewId: EntityId;
      error: ReviewManuscriptError;
      request: ReviewManuscriptRequestIdentity;
    };

export type ReviewCurrentFilenameDto =
  | {
      status: "ready";
      reviewId: EntityId;
      manuscriptChannel: "primary";
      currentFileRefId: EntityId;
      filename: string;
    }
  | {
      status: "error";
      reviewId: EntityId;
      manuscriptChannel: "primary";
      currentFileRefId?: EntityId;
      error: ReviewManuscriptError;
    };
