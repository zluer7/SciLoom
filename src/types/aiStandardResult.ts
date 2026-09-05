import type {
  AIContextBudget,
  AIContextMode,
  AIExperimentRunParentRelation,
  AILiteratureAssociationTuple,
  AILiteratureSelectionAggregateEligibility
} from "./aiContext";
import type { FileRefOwnerType } from "./experiment";
import type { ManuscriptChannel } from "./manuscriptChannel";

export type AIStandardResultCategory = "DATA_OPERATION" | "MANUSCRIPT_RESULT";
/** The only Provider/product-level actions accepted for fresh Standard Results. */
export type AIStandardResultProductAction = "CREATE" | "UPDATE" | "DELETE";
/**
 * Fresh durable parents use CREATE/UPDATE/DELETE_SUGGESTION only. NEW_MANUSCRIPT
 * remains an internal adapter discriminator for the existing canonical writers;
 * it is never accepted as a fresh Provider action or persisted as a fresh peer.
 */
export type AIStandardResultAction =
  | "CREATE"
  | "UPDATE"
  | "DELETE_SUGGESTION"
  | "NEW_MANUSCRIPT";
export type AIStandardResultDisposition =
  | "PENDING"
  | "CONFIRMED"
  | "DISMISSED"
  | "STALE"
  | "FAILED";

export type AIStandardResultTarget =
  | {
      module: "route";
      projectId: string;
      entityType: "routeNode";
      entityId?: string;
    }
  | {
      module: "task";
      projectId: string;
      entityType: "task";
      entityId?: string;
    }
  | {
      module: "review";
      projectId: string;
      entityType: "review";
      entityId?: string;
      /** Parsed intent only; the Review adapter accepts exactly `primary`. */
      manuscriptChannel?: string;
    }
  | {
      module: "experiment";
      projectId: string;
      entityType: "experiment";
      entityId?: string;
      /** Parsed intent only; the Experiment manuscript adapter accepts exactly `primary`. */
      manuscriptChannel?: string;
    }
  | {
      module: "experimentRun";
      projectId: string;
      entityType: "experimentRun";
      entityId?: string;
      /** Parsed intent only; the ExperimentRun manuscript adapter accepts exactly `primary`. */
      manuscriptChannel?: string;
      /** Application-owned reviewed target facts; never accepted from the model wire shape. */
      parentExperimentId?: string;
      parentExperimentLabel?: string;
      projectLabel?: string;
      /** Exact existing `updatedAt` used by the canonical atomic UPDATE condition. */
      expectedUpdatedAt?: string;
    }
  | {
      module: "literature";
      /** Conversation Project scope; it is not automatic Literature association authority. */
      projectId: string;
      entityType: "literature";
      entityId?: string;
      /** Exact Literature manuscript channel; production dispatch has no wildcard/default branch. */
      manuscriptChannel?: string;
      /** Application-owned canonical association snapshot; provider wire cannot supply it. */
      primaryProjectId?: string | null;
      /** Application-owned reviewed CAS token for UPDATE only. */
      expectedUpdatedAt?: string;
    }
  | {
      module: "finding";
      projectId: string;
      entityType: "finding";
      entityId?: string;
      manuscriptChannel?: string;
    }
  | {
      module: "resultItem";
      projectId: string;
      entityType: "resultItem";
      entityId?: string;
      manuscriptChannel?: string;
    }
  | {
      module: "outputCandidate";
      projectId: string;
      entityType: "outputCandidate";
      entityId?: string;
      manuscriptChannel?: string;
    }
  | {
      module: "outputGap";
      projectId: string;
      entityType: "outputGap";
      entityId?: string;
      manuscriptChannel?: string;
    }
  | {
      module: "researchOutput";
      projectId: string;
      entityType: "researchOutput";
      entityId?: string;
      manuscriptChannel?: string;
    };

export interface AIStandardResultValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export interface AIParseDraftDiscussionMessageIdentity {
  id: string;
  sequence: number;
  role: "user" | "assistant";
}

/** Application-owned source identity; it contains no material body or model-supplied authority. */
export interface AIParseDraftSourceSnapshot {
  conversationId: string;
  projectId: string;
  /** Optional only so retained pre-B4 records remain readable. New Parse attempts always persist it. */
  selectedRouteIds?: string[];
  selectedTaskIds: string[];
  selectedReviewIds: string[];
  selectedExperimentIds: string[];
  selectedExperimentRunIds: string[];
  experimentRunParentRelations: AIExperimentRunParentRelation[];
  selectedLiteratureIds: string[];
  selectedFindingIds: string[];
  literatureAssociationTuples: AILiteratureAssociationTuple[];
  literatureSelectionAggregateEligibility: AILiteratureSelectionAggregateEligibility;
  contextMode: AIContextMode;
  contextBudget: AIContextBudget;
  contextReviewFingerprint: string;
  authorizedMaterialFileRefIds: string[];
  approvedContextRequestContributions: import("./aiContext").AIApprovedContextRequestContribution[];
  discussionFingerprint: string;
  discussionMessages: AIParseDraftDiscussionMessageIdentity[];
  firstMessageId: string;
  lastMessageId: string;
  triggerMessageId: string;
  triggerCallAttemptId?: string;
  /** Exact application-owned Quick Analysis target; absent for ordinary Parse Draft. */
  quickAnalysisTarget?: {
    ownerType: FileRefOwnerType;
    ownerId: string;
    channel: ManuscriptChannel;
    projectOrScopeId: string;
    sourceFileRefId: string;
    sourceDirectoryFileRefId: string;
    whitelistFingerprint: string;
  };
}

export type AIStandardResultLeafEffectReceipt =
  | {
      module: "route";
      entityType: "routeNode";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "planningService.createRouteNode" | "planningService.updateRouteNode";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "task";
      entityType: "task";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "planningService.createTask" | "planningService.updateTask";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "review";
      entityType: "review";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "planningService.createReviewWithTargets" | "planningService.updateReview";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "review";
      entityType: "fileRef";
      entityId: string;
      operation: "NEW_MANUSCRIPT";
      service: "reviewCandidateService.saveCandidate";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "experiment";
      entityType: "experiment";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "experimentService.createExperiment" | "experimentService.updateExperiment";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "experiment";
      entityType: "fileRef";
      entityId: string;
      operation: "NEW_MANUSCRIPT";
      service:
        | "experimentManuscriptSaveAsAdapter.saveAs"
        | "candidateManuscriptService.saveCandidate";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "experimentRun";
      entityType: "experimentRun";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service:
        | "experimentRunService.createExperimentRun"
        | "experimentRunService.updateExperimentRun";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "literature";
      entityType: "literature";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service:
        | "literatureService.createLiteratureWithOperation"
        | "literatureService.updateLiteratureWithExpectedUpdatedAtAndOperation";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "literature";
      entityType: "fileRef";
      entityId: string;
      operation: "NEW_MANUSCRIPT";
      service: "literatureManuscriptSaveAsAdapter.saveAs";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "experimentRun";
      entityType: "fileRef";
      entityId: string;
      operation: "NEW_MANUSCRIPT";
      service: "experimentRunManuscriptSaveAsAdapter.saveAs";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "finding";
      entityType: "finding";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "outputConversionService.createFinding" | "outputConversionService.updateFinding";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "resultItem";
      entityType: "resultItem";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "outputConversionService.createResultItem" | "outputConversionService.updateResultItem";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "outputCandidate";
      entityType: "outputCandidate";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "outputConversionService.createOutputCandidate" | "outputConversionService.updateOutputCandidate";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "outputGap";
      entityType: "outputGap";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "outputConversionService.createOutputGapForDeposition" | "outputConversionService.updateOutputGap";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: "researchOutput";
      entityType: "researchOutput";
      entityId: string;
      operation: "CREATE" | "UPDATE";
      service: "outputService.create" | "outputService.update";
      canonicalReadback: Record<string, unknown>;
    }
  | {
      module: FileRefOwnerType;
      entityType: "fileRef";
      entityId: string;
      operation: "NEW_MANUSCRIPT";
      service: "candidateManuscriptService.saveCandidate";
      canonicalReadback: Record<string, unknown>;
    };

export type AIStandardResultParentOutcomeClass = "FULL_SUCCESS" | "PROVEN_PARTIAL";

export type AIStandardResultBusinessOutcome = "PROVEN_SUCCESS" | "NOT_REQUESTED";

export type AIStandardResultManuscriptOutcome =
  | {
      effectResultId: string;
      channel: ManuscriptChannel;
      outcome: "PROVEN_SUCCESS";
      receipt: AIStandardResultLeafEffectReceipt;
      failureCode: null;
      failureMessage: null;
    }
  | {
      effectResultId: string;
      channel: ManuscriptChannel;
      outcome: "PROVEN_NO_EFFECT_FAILURE";
      receipt: null;
      failureCode: string;
      failureMessage: string;
    }
  | {
      effectResultId: string;
      channel: ManuscriptChannel;
      outcome: "NOT_REACHED";
      receipt: null;
      failureCode: null;
      failureMessage: null;
    };

export interface AIStandardResultParentSettlement {
  parentResultId: string;
  productAction: AIStandardResultAction;
  settledTarget: AIStandardResultTarget;
  outcomeClass: AIStandardResultParentOutcomeClass;
  requestedBusinessEffect: boolean;
  businessOutcome: AIStandardResultBusinessOutcome;
  requestedManuscriptEffects: ManuscriptChannel[];
  settledEffectCount: number;
  businessReceipt: AIStandardResultLeafEffectReceipt | null;
  manuscriptReceipts: Array<{
    channel: ManuscriptChannel;
    receipt: AIStandardResultLeafEffectReceipt;
  }>;
  manuscriptOutcomes: AIStandardResultManuscriptOutcome[];
}

/**
 * A manuscript-only UPDATE has no business receipt to reuse as its aggregate
 * carrier. This root is settlement metadata only: it never claims a business
 * service invocation and its nested settlement keeps `businessReceipt = null`.
 */
export interface AIStandardResultAggregateRootReceipt {
  module: FileRefOwnerType;
  entityType: FileRefOwnerType;
  entityId: string;
  operation: "UPDATE";
  service: "aiStandardResultAdapterService.aggregateParentReceipt";
  canonicalReadback: Record<string, unknown> & {
    projectId: string;
    parentResultId: string;
    parentAction: "UPDATE";
    parentTarget: AIStandardResultTarget;
    requestedBusinessEffect: false;
  };
  standardResultParentSettlement: AIStandardResultParentSettlement;
}

export type AIStandardResultEffectReceipt =
  | (AIStandardResultLeafEffectReceipt & {
      standardResultParentSettlement?: AIStandardResultParentSettlement;
    })
  | AIStandardResultAggregateRootReceipt;

export interface AIStandardResult {
  id: string;
  batchId: string;
  ordinal: number;
  conversationId: string;
  parseCallAttemptId: string;
  category: AIStandardResultCategory;
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source: AIParseDraftSourceSnapshot;
  originalPayload: Record<string, unknown>;
  visiblePayload: Record<string, unknown>;
  visiblePayloadFingerprint: string;
  targetSnapshotFingerprint?: string;
  validationIssues: AIStandardResultValidationIssue[];
  disposition: AIStandardResultDisposition;
  confirmationStartedAt?: string;
  authorizationId?: string;
  confirmedPayload?: Record<string, unknown>;
  confirmedPayloadFingerprint?: string;
  decidedAt?: string;
  effectReceipt?: AIStandardResultEffectReceipt;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIStandardResultWireProposal {
  category: AIStandardResultCategory;
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  payload: Record<string, unknown>;
}

/** One explicit manuscript effect nested under exactly one CREATE/UPDATE parent. */
export interface AIStandardResultManuscriptEffect {
  channel: ManuscriptChannel;
  body: string;
}

/**
 * Provider-visible, batch-local mechanical metadata carried inside `payload._labpod`.
 * It never becomes an editable business field and never supplies a final entity ID.
 */
export interface AIStandardResultProposalMetadata {
  protocol: "labpod-standard-result-proposal-v1";
  originalOrdinal: number;
  proposalRef: string;
  parentProposalRef?: string;
}

export interface AIStandardResultBatchWirePayload {
  version: 1;
  results: AIStandardResultWireProposal[];
}

export const AI_STANDARD_RESULT_ALLOWED_CAPABILITY_TUPLES = [
  "DATA_OPERATION.CREATE.route.routeNode",
  "DATA_OPERATION.UPDATE.route.routeNode",
  "DATA_OPERATION.DELETE_SUGGESTION.route.routeNode",
  "DATA_OPERATION.CREATE.task.task",
  "DATA_OPERATION.UPDATE.task.task",
  "DATA_OPERATION.DELETE_SUGGESTION.task.task",
  "DATA_OPERATION.CREATE.review.review",
  "DATA_OPERATION.UPDATE.review.review",
  "DATA_OPERATION.DELETE_SUGGESTION.review.review",
  "DATA_OPERATION.CREATE.experiment.experiment",
  "DATA_OPERATION.UPDATE.experiment.experiment",
  "DATA_OPERATION.DELETE_SUGGESTION.experiment.experiment",
  "DATA_OPERATION.CREATE.experimentRun.experimentRun",
  "DATA_OPERATION.UPDATE.experimentRun.experimentRun",
  "DATA_OPERATION.DELETE_SUGGESTION.experimentRun.experimentRun",
  "DATA_OPERATION.CREATE.literature.literature",
  "DATA_OPERATION.UPDATE.literature.literature",
  "DATA_OPERATION.DELETE_SUGGESTION.literature.literature",
  "DATA_OPERATION.CREATE.finding.finding",
  "DATA_OPERATION.UPDATE.finding.finding",
  "DATA_OPERATION.DELETE_SUGGESTION.finding.finding",
  "DATA_OPERATION.CREATE.resultItem.resultItem",
  "DATA_OPERATION.UPDATE.resultItem.resultItem",
  "DATA_OPERATION.DELETE_SUGGESTION.resultItem.resultItem",
  "DATA_OPERATION.CREATE.outputCandidate.outputCandidate",
  "DATA_OPERATION.UPDATE.outputCandidate.outputCandidate",
  "DATA_OPERATION.DELETE_SUGGESTION.outputCandidate.outputCandidate",
  "DATA_OPERATION.CREATE.outputGap.outputGap",
  "DATA_OPERATION.UPDATE.outputGap.outputGap",
  "DATA_OPERATION.DELETE_SUGGESTION.outputGap.outputGap",
  "DATA_OPERATION.CREATE.researchOutput.researchOutput",
  "DATA_OPERATION.UPDATE.researchOutput.researchOutput",
  "DATA_OPERATION.DELETE_SUGGESTION.researchOutput.researchOutput"
] as const;

export interface AIStandardResultResponseContract {
  contract: "LABPOD_STANDARD_RESULT_OUTCOME_V2";
  outputSerialization: {
    responseType: "ONE_COMPLETE_JSON_OBJECT";
    markdownFences: "FORBIDDEN";
    prosePrefixOrSuffix: "FORBIDDEN";
    multipleTopLevelObjects: "FORBIDDEN";
    partialOrTruncatedJson: "FORBIDDEN";
  };
  resultItemContract: {
    exactKeys: readonly ["category", "action", "target", "payload"];
    capabilitySelectionRule: "COPY_ONE_WHOLE_ALLOWED_CAPABILITY_TUPLE_WITHOUT_SUBSTITUTION";
    targetExactKeysByAction: {
      CREATE: readonly ["projectId", "entityType"];
      UPDATE: readonly ["projectId", "entityType", "entityId"];
      DELETE: readonly ["projectId", "entityType", "entityId"];
    };
    manuscriptEffects: {
      payloadKey: "manuscriptEffects";
      allowedParentActions: readonly ["CREATE", "UPDATE"];
      exactEffectKeys: readonly ["channel", "body"];
      maximumEffectsPerParent: 2;
      allowedCapabilityTuples: readonly string[];
      presentation: "SUBORDINATE_TO_ONE_PARENT_CARD_AND_ONE_USER_DECISION";
    };
    payloadRules: readonly [
      "ONE_BOUNDED_MODULE_LOCAL_JSON_OBJECT",
      "TARGET_IDENTITY_FIELDS_FORBIDDEN_IN_PAYLOAD",
      "ONLY_TYPED_LABPOD_BATCH_LOCAL_REFERENCES_ALLOWED"
    ];
  };
  /** Provider-facing DELETE semantics; the runtime maps it to the existing advisory carrier. */
  allowedCapabilityTuples: readonly string[];
  minResults: 1;
  maxResults: number;
  contextRequestContract: "LABPOD_CONTEXT_REQUEST_V1";
}

export type AIParseDraftOutcome =
  | {
      kind: "standard_result_batch";
      payload: AIStandardResultBatchWirePayload;
    }
  | {
      kind: "context_request";
      assistantText: string;
      payload: import("./aiContextRequest").AIContextRequestWirePayload;
    };

export interface NewAIStandardResultInput {
  id: string;
  ordinal: number;
  category: AIStandardResultCategory;
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source: AIParseDraftSourceSnapshot;
  originalPayload: Record<string, unknown>;
  visiblePayload: Record<string, unknown>;
  visiblePayloadFingerprint: string;
  targetSnapshotFingerprint?: string;
  validationIssues: AIStandardResultValidationIssue[];
}

export interface NewAIStandardResultBatchInput {
  id: string;
  results: NewAIStandardResultInput[];
  createdAt: string;
}
