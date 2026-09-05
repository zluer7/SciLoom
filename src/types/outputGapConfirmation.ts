import type { EntityId, ISODateString } from "./common";
import type {
  Priority,
  RouteNodeStatus,
  RouteNodeType,
  TaskStatus,
  TaskType,
  TimeBucket
} from "./planning";
import type { OutputGapStatus } from "./outputConversion";

export type OutputGapFeedbackKind = "task" | "routeFeedback";

export type OutputGapDraftStatus =
  | "draft"
  | "previewed"
  | "confirmed"
  | "applied"
  | "cancelled"
  | "expired";

export type OutputGapFeedbackSource =
  | "outputGapDetail"
  | "outputConversionRelations"
  | "planningTask"
  | "planningRouteNode"
  | "crossModuleEntityLink"
  | "outputGapWriteback";

export interface OutputGapTaskDraftPayload {
  title: string;
  description: string;
  taskType: TaskType;
  status: Exclude<TaskStatus, "done">;
  priority: Priority;
  dueDate?: ISODateString;
  routeNodeId?: EntityId;
  timeBucket: TimeBucket;
  captureState: "pending";
  orderIndex: number;
  customFields: Record<string, unknown>;
}

export interface OutputGapRouteFeedbackDraftPayload {
  title: string;
  description: string;
  nodeType: RouteNodeType;
  status: Exclude<RouteNodeStatus, "completed">;
  parentNodeId?: EntityId;
  orderIndex: number;
  captureState: "pending";
  customFields: Record<string, unknown>;
}

export type OutputGapFeedbackProposedPayload =
  | OutputGapTaskDraftPayload
  | OutputGapRouteFeedbackDraftPayload;

export interface OutputGapFeedbackDraft {
  id: string;
  gapId: EntityId;
  kind: OutputGapFeedbackKind;
  projectId: EntityId;
  sourceGapStatus: OutputGapStatus;
  sourceGapUpdatedAt: ISODateString;
  status: "draft";
  title: string;
  summary: string;
  proposedPayload: OutputGapFeedbackProposedPayload;
  warnings: string[];
  sourceBoundary: OutputGapFeedbackSource[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface OutputGapFeedbackProposedChange {
  targetType: "task" | "routeNode" | "outputGap" | "entityLink";
  operation: "create" | "update" | "link";
  summary: string;
}

export interface OutputGapFeedbackPreview {
  draftId: string;
  gapId: EntityId;
  kind: OutputGapFeedbackKind;
  projectId: EntityId;
  status: "previewed";
  previewTitle: string;
  previewBody: string;
  proposedChanges: OutputGapFeedbackProposedChange[];
  warnings: string[];
  sourceBoundary: OutputGapFeedbackSource[];
  canApply: boolean;
  previewHash: string;
}

export interface OutputGapFeedbackConfirmation {
  draftId: string;
  confirmedByUser: true;
  confirmedAt: ISODateString;
  previewHash: string;
}

export interface OutputGapFeedbackApplyResult {
  draftId: string;
  gapId: EntityId;
  kind: OutputGapFeedbackKind;
  applied: boolean;
  duplicate: boolean;
  createdTaskId?: EntityId;
  createdRouteNodeId?: EntityId;
  updatedGapStatus?: OutputGapStatus;
  createdEntityLinkIds: EntityId[];
  warnings: string[];
  sourceBoundary: OutputGapFeedbackSource[];
}

export interface CreateOutputGapFeedbackDraftInput {
  gapId: EntityId;
  kind: OutputGapFeedbackKind;
  title?: string;
  description?: string;
  priority?: Priority;
  dueDate?: ISODateString;
  routeNodeId?: EntityId;
  parentNodeId?: EntityId;
  note?: string;
}

export interface ApplyOutputGapFeedbackDraftInput {
  draft: OutputGapFeedbackDraft;
  confirmation: OutputGapFeedbackConfirmation;
}
