import type {
  AIContextBudget,
  AIContextMode,
  AIContextRequestableRef,
  AIRequestedContributionKind,
  AIResearchObjectSelection
} from "./aiContext";

export type AIContextRequestLifecycle =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "STALE_OR_INVALID";

export type AIContextRequestedRefKind = "AI_RESEARCH_OBJECT" | "FILE_REF";

export interface AIContextRequestWireRef {
  refKind: AIContextRequestedRefKind;
  refId: string;
  contributionKind: AIRequestedContributionKind;
}

export interface AIContextRequestWirePayload {
  version: 1;
  assistantText: string;
  reason: string;
  requestedRefs: AIContextRequestWireRef[];
}

/** Exact contribution already present in the Provider-visible scope for this call. */
export interface AIContextRequestAlreadySuppliedRef {
  refKind: AIContextRequestedRefKind;
  refId: string;
  projectId: string;
  contributionKind: AIRequestedContributionKind;
}

export interface AIContextRequestResponseContract {
  contract: "LABPOD_CONTEXT_REQUEST_V1";
  wrapperStart: "<labpod_context_request>";
  wrapperEnd: "</labpod_context_request>";
  requestableRefs: AIContextRequestableRef[];
  alreadySuppliedRefs: AIContextRequestAlreadySuppliedRef[];
  contributionKinds: readonly ["IDENTITY_METADATA", "BODY_CONTENT"];
}

export interface AIContextRequestCandidate {
  refKind: AIContextRequestedRefKind;
  refId: string;
  entityType:
    | "task"
    | "review"
    | "experiment"
    | "experimentRun"
    | "literature"
    | "finding"
    | "resultItem"
    | "outputCandidate"
    | "outputGap"
    | "researchOutput"
    | "fileRef";
  projectId: string;
  label: string;
  contributionKind: AIRequestedContributionKind;
  availability: "available" | "unavailable";
  fileBodyAuthorizationRequired: boolean;
  proposedContribution: string;
  literatureProjectAssociationKind?: import("./aiContext").AILiteratureProjectAssociationKind;
  literatureCanonicalProjectId?: string | null;
  literatureConversationProjectEligibilityDisposition?: import("./aiContext").AILiteratureConversationProjectEligibilityDisposition;
  literatureNormalizedProjectionFingerprint?: string;
  warning?: string;
}

export type AIParseSupplementalContextProjectionDisposition =
  | "PROVIDED"
  | "MISSING"
  | "UNAVAILABLE"
  | "NOT_AUTHORIZED"
  | "AMBIGUOUS_TARGET"
  | "UNSUPPORTED_REQUEST_ITEM";

export type AIParseSupplementalContextResolutionReason =
  | "ALREADY_AUTHORIZED_AND_RESOLVABLE"
  | "ALREADY_AUTHORIZED_BUT_UNAVAILABLE"
  | "NOT_AUTHORIZED"
  | "AMBIGUOUS_TARGET"
  | "UNSUPPORTED_REQUEST_ITEM";

/** One exact Phase-A request item mapped to one mechanical Phase-B projection. */
export interface AIParseSupplementalContextProjection {
  requestItemId: string;
  ordinal: number;
  requestedRef: AIContextRequestWireRef;
  disposition: AIParseSupplementalContextProjectionDisposition;
  reasonCategory: AIParseSupplementalContextResolutionReason;
  exactSourceIdentity: string;
  providedValue?: {
    refKind: AIContextRequestedRefKind;
    refId: string;
    entityType: AIContextRequestCandidate["entityType"];
    projectId: string;
    label: string;
    contributionKind: AIRequestedContributionKind;
  };
}

export interface AIContextRequestSourceSnapshot {
  projectId: string;
  contextMode: AIContextMode;
  contextBudget: AIContextBudget;
  researchObjects: AIResearchObjectSelection[];
  contextReviewFingerprint: string;
  requestableRefs: AIContextRequestableRef[];
}

export interface AIContextRequest {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  sourceCallAttemptId: string;
  source: AIContextRequestSourceSnapshot;
  reason: string;
  requestedRefs: AIContextRequestWireRef[];
  reviewedCandidates: AIContextRequestCandidate[];
  state: AIContextRequestLifecycle;
  decisionActionMessageId?: string;
  decisionType?: "APPROVE" | "REJECT" | "STALE";
  decisionAt?: string;
  decisionReason?: string;
  approvedRefs?: AIContextRequestCandidate[];
  followupCallAttemptId?: string;
  createdAt: string;
}

export interface ParsedAIContextRequestResponse {
  kind: "context_request";
  assistantText: string;
  payload: AIContextRequestWirePayload;
}

export interface PlainAIContextRequestResponse {
  kind: "plain_text";
  assistantText: string;
}

export interface InvalidAIContextRequestResponse {
  kind: "invalid_structured";
  assistantText: string;
  errorCode: string;
  errorMessage: string;
}

export type ParsedAIContextRequestResult =
  | ParsedAIContextRequestResponse
  | PlainAIContextRequestResponse
  | InvalidAIContextRequestResponse;
