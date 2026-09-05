import type { EntityId, ISODateString } from "./common";
import type { AIContextEntityType, AIContextModule, AIContextSourceRef } from "./aiContext";
import type {
  EntityType,
  Priority,
  RelationType,
  TaskStatus,
  TaskType,
  TimeBucket
} from "./planning";
import type {
  FindingConfidence,
  FindingMaturity,
  FindingStatus,
  FindingType,
  OutputCandidateStatus,
  OutputCandidateType,
  OutputGapStatus,
  OutputGapType
} from "./outputConversion";
import type {
  LinkConfidence,
  LinkStrength,
  LiteratureEvidenceRole,
  LiteratureLinkTargetType,
  LiteratureRelationType
} from "./literature";

/**
 * AI-D1 defines type-only contracts for AI action drafts.
 * It does not parse AI replies, manage drafts, execute write-back, call services,
 * or turn AI output into LabPod business facts.
 * Future write-back must remain: draft -> user confirmation -> allowed service -> context reread.
 */

export type AISupportedActionDraftType = "task_create";

export type AIPlannedActionDraftType =
  | "review_candidate"
  | "output_gap_create"
  | "finding_create"
  | "output_candidate_create"
  | "entity_link_create"
  | "literature_link_create";

export type AIDeferredActionDraftType =
  | "task_update"
  | "route_update"
  | "review_overwrite"
  | "output_gap_update"
  | "output_gap_close"
  | "finding_verify"
  | "finding_verified_create"
  | "output_candidate_to_formal_output"
  | "formal_output_create"
  | "bulk_link_create"
  | "bulk_accept_all"
  | "bulk_write_all"
  | "auto_execute_all";

export type AIActionDraftType =
  | AISupportedActionDraftType
  | AIPlannedActionDraftType
  | AIDeferredActionDraftType;

export type AIActionDraftCapability = "supported" | "planned" | "deferred" | "prohibited";

export type AIActionDraftTargetModule =
  | "planning"
  | "project"
  | "route"
  | "task"
  | "review"
  | "experiment"
  | "literature"
  | "output"
  | "link"
  | "ai"
  | "unknown";

export type AIActionDraftTargetEntityType =
  | "project"
  | "routeNode"
  | "task"
  | "review"
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "literature"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "output"
  | "formalOutput"
  | "entityLink"
  | "literatureLink"
  | "aiRun"
  | "unknown";

export interface AIActionDraftTarget {
  module: AIActionDraftTargetModule;
  entityType: AIActionDraftTargetEntityType;
  entityId?: EntityId;
  label?: string;
}

export type AIActionDraftSourceType =
  | "aiContext"
  | "promptPackage"
  | "aiRun"
  | "userQuestion"
  | "manual"
  | "unknown";

export type AIActionDraftSourceConfidence = "high" | "medium" | "low" | "unknown";

declare const draftInstanceIdBrand: unique symbol;

export type DraftInstanceId = string & {
  readonly [draftInstanceIdBrand]: "DraftInstanceId";
};

export interface CanonicalTargetScope {
  readonly scopeKind: "project";
  readonly scopeId: EntityId;
}

export interface ActionDraftSourceTuple {
  readonly conversationId: EntityId;
  readonly canonicalBusinessScopeIdentity: CanonicalTargetScope;
  readonly effectiveSourceAssistantMessageId: EntityId;
  readonly sourceOrdinaryChatCallAttemptId: EntityId;
  readonly actionDraftGenerationCallAttemptId: EntityId;
}

export interface ActionDraftGenerationReadback {
  readonly generatedText: string;
  readonly sourceTuple: ActionDraftSourceTuple;
}

export interface MountedSelectionSnapshot {
  readonly conversationId: EntityId;
  readonly scopeIdentity: CanonicalTargetScope;
  readonly tupleKey: string;
  readonly uiGeneration: number;
}

export interface AIActionDraftSourceRef {
  sourceType: AIActionDraftSourceType;
  sourceId?: string;
  module?: AIContextModule | AIActionDraftTargetModule;
  entityType?: AIContextEntityType | AIActionDraftTargetEntityType;
  entityId?: EntityId;
  label?: string;
  field?: string;
  sectionId?: string;
  itemId?: string;
  excerpt?: string;
  confidence?: AIActionDraftSourceConfidence;
  aiContextSourceRef?: AIContextSourceRef;
}

export interface AIActionDraftPayloadBase {
  sourceRefs?: AIActionDraftSourceRef[];
  reason?: string;
}

export interface AITaskCreateDraftPayload extends AIActionDraftPayloadBase {
  projectId: EntityId;
  routeNodeId?: EntityId;
  title: string;
  description?: string;
  priority?: Priority;
  status?: Exclude<TaskStatus, "done" | "archived">;
  taskType?: TaskType;
  timeBucket?: TimeBucket;
  scheduledDate?: ISODateString;
  dueDate?: ISODateString;
  tags?: string[];
  sourceOutputGapId?: EntityId;
}

export interface AIReviewCandidateDraftPayload extends AIActionDraftPayloadBase {
  reviewId?: EntityId;
  projectId?: EntityId;
  candidateMarkdown?: string;
  suggestedSummary?: string;
  suggestedWarnings?: string[];
  suggestedNextActionsText?: string;
  suggestedQuestions?: string[];
  suggestedTargetNotes?: string;
}

export interface AIOutputGapCreateDraftPayload extends AIActionDraftPayloadBase {
  projectId?: EntityId;
  routeNodeId?: EntityId;
  taskId?: EntityId;
  reviewId?: EntityId;
  outputCandidateId?: EntityId;
  title: string;
  description?: string;
  gapType?: OutputGapType;
  priority?: Priority;
  status?: Extract<OutputGapStatus, "pending">;
}

export interface AIFindingCreateDraftPayload extends AIActionDraftPayloadBase {
  projectId?: EntityId;
  routeNodeId?: EntityId;
  taskId?: EntityId;
  experimentId?: EntityId;
  resultItemIds?: EntityId[];
  linkedResultItemIds?: EntityId[];
  linkedAssetIds?: EntityId[];
  title: string;
  summary?: string;
  evidenceSummary?: string;
  findingType?: FindingType;
  confidence?: FindingConfidence;
  confidenceLabel?: string;
  status?: FindingStatus;
  maturity?: FindingMaturity;
}

export interface AIOutputCandidateCreateDraftPayload extends AIActionDraftPayloadBase {
  projectId?: EntityId;
  routeNodeId?: EntityId;
  taskId?: EntityId;
  findingIds?: EntityId[];
  linkedFindingIds?: EntityId[];
  resultItemIds?: EntityId[];
  linkedResultItemIds?: EntityId[];
  linkedAssetIds?: EntityId[];
  title: string;
  summary?: string;
  description?: string;
  candidateType?: OutputCandidateType;
  status?: Exclude<OutputCandidateStatus, "converted">;
  noveltyNotes?: string;
}

export interface AIEntityLinkCreateDraftPayload extends AIActionDraftPayloadBase {
  sourceType: EntityType;
  sourceId: EntityId;
  targetType: EntityType;
  targetId: EntityId;
  relationType: RelationType;
}

export interface AILiteratureLinkCreateDraftPayload extends AIActionDraftPayloadBase {
  literatureId: EntityId;
  targetType: LiteratureLinkTargetType;
  targetId: EntityId;
  relationType: LiteratureRelationType;
  role?: LiteratureEvidenceRole;
  strength?: LinkStrength;
  confidence?: LinkConfidence;
}

export interface AIDeferredActionDraftPayload extends AIActionDraftPayloadBase {
  deferredReason?: string;
}

export interface AIActionDraftPayloadMap {
  task_create: AITaskCreateDraftPayload;
  review_candidate: AIReviewCandidateDraftPayload;
  output_gap_create: AIOutputGapCreateDraftPayload;
  finding_create: AIFindingCreateDraftPayload;
  output_candidate_create: AIOutputCandidateCreateDraftPayload;
  entity_link_create: AIEntityLinkCreateDraftPayload;
  literature_link_create: AILiteratureLinkCreateDraftPayload;
  task_update: AIDeferredActionDraftPayload;
  route_update: AIDeferredActionDraftPayload;
  review_overwrite: AIDeferredActionDraftPayload;
  output_gap_update: AIDeferredActionDraftPayload;
  output_gap_close: AIDeferredActionDraftPayload;
  finding_verify: AIDeferredActionDraftPayload;
  finding_verified_create: AIDeferredActionDraftPayload;
  output_candidate_to_formal_output: AIDeferredActionDraftPayload;
  formal_output_create: AIDeferredActionDraftPayload;
  bulk_link_create: AIDeferredActionDraftPayload;
  bulk_accept_all: AIDeferredActionDraftPayload;
  bulk_write_all: AIDeferredActionDraftPayload;
  auto_execute_all: AIDeferredActionDraftPayload;
}

export type AIActionDraftProposedPayload<
  TDraftType extends AIActionDraftType = AIActionDraftType
> = AIActionDraftPayloadMap[TDraftType];

export type AIActionDraftPayload = AIActionDraftProposedPayload;

export interface AIActionDraftEntityRef {
  module: AIActionDraftTargetModule;
  entityType: AIActionDraftTargetEntityType;
  entityId?: EntityId;
  label?: string;
}

export type AIActionDraftPreviewOperation = "create" | "append" | "update" | "link" | "none";

export interface AIActionDraftFieldChange {
  field: string;
  label?: string;
  currentValueSummary?: string;
  proposedValueSummary?: string;
  operation: AIActionDraftPreviewOperation;
}

export interface AIActionDraftRelationPreview {
  source?: AIActionDraftEntityRef;
  target?: AIActionDraftEntityRef;
  relationType?: RelationType | LiteratureRelationType | string;
  summary?: string;
}

export interface AIActionDraftWritePreview {
  actionLabel: string;
  targetLabel?: string;
  target: AIActionDraftTarget;
  fieldChanges: AIActionDraftFieldChange[];
  linkedEntities: AIActionDraftRelationPreview[];
  impactSummary?: string;
  willCreate: AIActionDraftEntityRef[];
  willUpdate: AIActionDraftEntityRef[];
  willNotModify: string[];
  warnings: string[];
  requiresUserConfirmation: true;
}

export type AIActionDraftReviewStatus = "pending" | "edited" | "accepted" | "rejected";

export type AIActionDraftApplyStatus =
  | "none"
  | "ready"
  | "writing"
  | "written"
  | "failed"
  | "partial";

export interface AIActionDraftApplyResult {
  success: boolean;
  result: AIActionDraftApplyStatus;
  message?: string;
  createdEntity?: AIActionDraftEntityRef;
  updatedEntity?: AIActionDraftEntityRef;
  linkedEntities?: AIActionDraftRelationPreview[];
  errorCode?: string;
  errorMessage?: string;
  partialSuccess?: boolean;
  sourceDraftId: EntityId;
  appliedAt?: ISODateString;
}

export interface AIActionDraftResult {
  reviewStatus: AIActionDraftReviewStatus;
  applyStatus: AIActionDraftApplyStatus;
  message?: string;
  applyResult?: AIActionDraftApplyResult;
  updatedAt?: ISODateString;
}

export interface AIActionDraft<TDraftType extends AIActionDraftType = AIActionDraftType> {
  readonly draftInstanceId: DraftInstanceId;
  batchId?: EntityId;
  draftType: TDraftType;
  capability: AIActionDraftCapability;
  targetModule: AIActionDraftTargetModule;
  targetEntityType: AIActionDraftTargetEntityType;
  targetEntityId?: EntityId;
  target?: AIActionDraftTarget;
  title: string;
  summary?: string;
  detail?: string;
  sourceRefs: AIActionDraftSourceRef[];
  proposedPayload: AIActionDraftProposedPayload<TDraftType>;
  writePreview?: AIActionDraftWritePreview;
  handled: boolean;
  result: AIActionDraftResult;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type AIActionDraftUnion = {
  [TDraftType in AIActionDraftType]: AIActionDraft<TDraftType>;
}[AIActionDraftType];

export interface AIActionDraftBatch {
  id: EntityId;
  readonly sourceTuple: ActionDraftSourceTuple;
  question?: string;
  drafts: AIActionDraftUnion[];
  createdAt: ISODateString;
  sourceContextSummary?: string;
  sourceRefs?: AIActionDraftSourceRef[];
}
