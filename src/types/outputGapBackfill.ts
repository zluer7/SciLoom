import type { EntityId, ISODateString } from "./common";
import type { OutputGapStatus } from "./outputConversion";
import type { TaskStatus } from "./planning";

export type OutputGapBackfillKind = "taskCompletionResolved";

export type OutputGapBackfillStatus =
  | "draft"
  | "previewed"
  | "confirmed"
  | "applied"
  | "cancelled"
  | "expired";

export type OutputGapBackfillCandidateSource = "relatedTaskId" | "entityLink" | "both";

export type OutputGapBackfillConfidence = "high" | "medium" | "low";

export type OutputGapBackfillSource =
  | "planningTask"
  | "outputGap"
  | "relatedTaskId"
  | "crossModuleEntityLink"
  | "outputGapWriteback";

export interface OutputGapBackfillCandidate {
  taskId: EntityId;
  gapId: EntityId;
  projectId: EntityId;
  source: "relatedTaskId" | "entityLink" | "both";
  confidence: OutputGapBackfillConfidence;
  currentTaskStatus: TaskStatus;
  currentGapStatus: OutputGapStatus;
  canApply: boolean;
  warnings: string[];
}

export interface OutputGapBackfillDraft {
  id: string;
  kind: OutputGapBackfillKind;
  status: "draft";
  taskId: EntityId;
  gapId: EntityId;
  projectId: EntityId;
  sourceGapStatus: OutputGapStatus;
  sourceTaskStatus: TaskStatus;
  proposedGapStatus: "resolved";
  proposedResolutionNote?: string;
  warnings: string[];
  sourceBoundary: OutputGapBackfillSource[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface OutputGapBackfillProposedChange {
  targetType: "outputGap" | "entityLink" | "task";
  operation: "update" | "link" | "verify";
  summary: string;
}

export interface OutputGapBackfillPreview {
  draftId: string;
  kind: OutputGapBackfillKind;
  taskId: EntityId;
  gapId: EntityId;
  projectId: EntityId;
  status: "previewed";
  previewTitle: string;
  previewBody: string;
  proposedChanges: OutputGapBackfillProposedChange[];
  warnings: string[];
  sourceBoundary: OutputGapBackfillSource[];
  canApply: boolean;
  previewHash: string;
}

export interface OutputGapBackfillConfirmation {
  draftId: string;
  confirmedByUser: true;
  confirmedAt: ISODateString;
  previewHash: string;
}

export interface OutputGapBackfillApplyResult {
  draftId: string;
  taskId: EntityId;
  gapId: EntityId;
  applied: boolean;
  duplicate: boolean;
  alreadyResolved: boolean;
  updatedGapStatus?: "resolved";
  updatedGapId?: EntityId;
  verifiedEntityLinkIds: EntityId[];
  warnings: string[];
  sourceBoundary: OutputGapBackfillSource[];
}

export interface CreateOutputGapBackfillDraftInput {
  taskId: EntityId;
  gapId?: EntityId;
  proposedResolutionNote?: string;
}

export interface ApplyOutputGapBackfillDraftInput {
  draft: OutputGapBackfillDraft;
  confirmation: OutputGapBackfillConfirmation;
}
