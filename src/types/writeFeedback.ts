import type { EntityId, ISODateString } from "./common";
import type { MissingEntityReference } from "./entityReference";

export type WriteFeedbackStatus = "success" | "skipped" | "partial" | "error";

export type WriteFeedbackSeverity = "info" | "success" | "warning" | "error";

export type AffectedEntityType =
  | "project"
  | "route"
  | "routeNode"
  | "task"
  | "review"
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "literature"
  | "literatureLink"
  | "output"
  | "researchOutput"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "entityLink"
  | "aiContext"
  | "other";

export type AffectedScopeModule =
  | "planning"
  | "project"
  | "route"
  | "task"
  | "review"
  | "experiment"
  | "literature"
  | "output"
  | "outputConversion"
  | "link"
  | "ai"
  | "global";

export type RefreshKey =
  | "project.changed"
  | "route.changed"
  | "task.changed"
  | "review.changed"
  | "experiment.changed"
  | "experimentRun.changed"
  | "resultMetric.changed"
  | "fileRef.changed"
  | "literature.changed"
  | "output.resultItem.changed"
  | "output.finding.changed"
  | "output.candidate.changed"
  | "output.gap.changed"
  | "output.researchOutput.changed"
  | "researchTrace.changed"
  | "entityLink.changed"
  | "literatureLink.changed"
  | "researcherProfile.changed"
  | "operationLog.changed"
  | "recycleBin.changed"
  | "reviewContext.changed"
  | "aiContext.changed"
  | "global.changed";

export interface AffectedEntity {
  type: AffectedEntityType | string;
  id: EntityId;
  relation?: "created" | "updated" | "deleted" | "linked" | "reused" | "skipped" | string;
  label?: string;
}

export interface AffectedScope {
  module: AffectedScopeModule | string;
  projectId?: EntityId;
  routeNodeId?: EntityId;
  taskId?: EntityId;
  reviewId?: EntityId;
  experimentId?: EntityId;
  literatureId?: EntityId;
  outputGapId?: EntityId;
  outputCandidateId?: EntityId;
  researchOutputId?: EntityId;
  reason?: string;
}

export interface WriteFeedbackMessage {
  severity: WriteFeedbackSeverity;
  message: string;
  code?: string;
  entity?: AffectedEntity;
}

export interface WriteFeedbackResult<T = unknown> {
  status: WriteFeedbackStatus;
  operation: string;
  data?: T;
  affectedEntities: AffectedEntity[];
  affectedScopes: AffectedScope[];
  refreshKeys: RefreshKey[];
  messages: WriteFeedbackMessage[];
  warnings: string[];
  errors: string[];
  skipped: string[];
  partial?: boolean;
  missingReferences?: MissingEntityReference[];
  createdAt?: ISODateString;
}

export type WriteFeedbackResultInput<T = unknown> = Partial<
  Omit<WriteFeedbackResult<T>, "status" | "operation">
> & {
  status?: WriteFeedbackStatus;
  operation: string;
  data?: T;
};
