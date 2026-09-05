import { invoke } from "@tauri-apps/api/core";
import type {
  AICallAttemptPurpose,
  AIConversation,
  AIConversationSummary,
  AIConversationReadback,
  AIErrorCode,
  AIContextRequestCandidate,
  AIContextRequestSourceSnapshot,
  AIContextRequestWireRef,
  AISelectableFileRefCatalog
} from "../types";
import type {
  AIStandardResultEffectReceipt,
  AIStandardResultValidationIssue,
  NewAIStandardResultBatchInput
} from "../types/aiStandardResult";
import type {
  AIContextBudgetSummary,
  AIContextSourceRef,
  AIContextWarning
} from "../types/aiContext";

export type NewAIMessageInput = {
  id: string;
  content: string;
  createdAt: string;
};

export type CreateAIConversationInput = {
  id: string;
  stableKey: string;
  createdAt: string;
};

export type PrepareAICallAttemptInput = {
  conversationId: string;
  attemptId: string;
  requestId: string;
  purpose: AICallAttemptPurpose;
  userMessage?: NewAIMessageInput;
  triggerMessageId?: string;
  triggerCallAttemptId?: string;
  provider: string;
  model: string;
  contextPackageId: string;
  contextPackageVersion: string;
  contextSourceRefs: AIContextSourceRef[];
  warnings: AIContextWarning[];
  budgetSummary?: AIContextBudgetSummary;
  promptPackageId: string;
  promptCreatedAt: string;
  startedAt: string;
  authorizedFileRefIds: string[];
};

export type PreparedAICallAttempt = {
  providerInvocationAuthorized: boolean;
  readback: AIConversationReadback;
};

export type AIChatRetryRegenerateActionIntent = "retry" | "regenerate";

export type PrepareAIRetryRegenerateAttemptInput = {
  conversationId: string;
  attemptId: string;
  requestId: string;
  actionIntent: AIChatRetryRegenerateActionIntent;
  triggerMessageId: string;
  expectedSourceAttemptId: string;
  expectedEffectiveMessageId?: string;
  provider: string;
  model: string;
  contextPackageId: string;
  contextPackageVersion: string;
  contextSourceRefs: AIContextSourceRef[];
  warnings: AIContextWarning[];
  budgetSummary?: AIContextBudgetSummary;
  promptPackageId: string;
  promptCreatedAt: string;
  startedAt: string;
};

export type SettleAICallAttemptSuccessInput = {
  attemptId: string;
  provider: string;
  model: string;
  responseTruncated?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  assistantMessage?: NewAIMessageInput;
  contextRequest?: {
    id: string;
    source: AIContextRequestSourceSnapshot;
    reason: string;
    requestedRefs: AIContextRequestWireRef[];
    reviewedCandidates: AIContextRequestCandidate[];
    initialState: "PENDING" | "STALE_OR_INVALID";
    invalidReason?: string;
    createdAt: string;
  };
  standardResultBatch?: NewAIStandardResultBatchInput;
  settledAt: string;
};

export type PrepareAIContextRequestFollowupInput = {
  conversationId: string;
  contextRequestId: string;
  actionMessageId: string;
  attemptId: string;
  requestId: string;
  purpose: "chat_response" | "parse_draft";
  provider: string;
  model: string;
  contextPackageId: string;
  contextPackageVersion: string;
  contextSourceRefs: AIContextSourceRef[];
  warnings: AIContextWarning[];
  budgetSummary?: AIContextBudgetSummary;
  promptPackageId: string;
  promptCreatedAt: string;
  expectedReviewedCandidates: AIContextRequestCandidate[];
  approvedRefs: AIContextRequestCandidate[];
  startedAt: string;
  authorizedFileRefIds: string[];
};

export type UpdateAIStandardResultDraftInput = {
  conversationId: string;
  resultId: string;
  expectedVisiblePayloadFingerprint: string;
  visiblePayload: Record<string, unknown>;
  visiblePayloadFingerprint: string;
  validationIssues: AIStandardResultValidationIssue[];
  updatedAt: string;
};

export type DecideAIStandardResultInput = {
  conversationId: string;
  resultId: string;
  expectedVisiblePayloadFingerprint: string;
  decidedAt: string;
};

export type BeginAIStandardResultConfirmationInput = {
  conversationId: string;
  resultId: string;
  parseCallAttemptId: string;
  expectedVisiblePayloadFingerprint: string;
  authorizationId: string;
  confirmedPayload: Record<string, unknown>;
  confirmedPayloadFingerprint: string;
  startedAt: string;
};

export type SettleAIStandardResultEffectInput = {
  conversationId: string;
  resultId: string;
  authorizationId: string;
  effectReceipt: AIStandardResultEffectReceipt;
  settledAt: string;
};

export type FailAIStandardResultInput = {
  conversationId: string;
  resultId: string;
  authorizationId?: string;
  failureCode: string;
  failureMessage: string;
  disposition: "STALE" | "FAILED";
  failedAt: string;
};

export type DecideAIContextRequestInput = {
  conversationId: string;
  contextRequestId: string;
  actionMessageId: string;
  decidedAt: string;
};

export type MarkAIContextRequestStaleInput = {
  conversationId: string;
  contextRequestId: string;
  reason: string;
  decidedAt: string;
};

export type SettleAICallAttemptFailureInput = {
  attemptId: string;
  errorCode: AIErrorCode;
  errorMessage?: string;
  errorRetryable: boolean;
  providerStatus?: number;
  settledAt: string;
};

export const aiConversationRepository = {
  createConversation(input: CreateAIConversationInput) {
    return invoke<AIConversation>("db_create_ai_conversation", { input });
  },

  prepareCallAttempt(input: PrepareAICallAttemptInput) {
    return invoke<PreparedAICallAttempt>("db_prepare_ai_call_attempt", { input });
  },

  prepareRetryRegenerateCallAttempt(input: PrepareAIRetryRegenerateAttemptInput) {
    return invoke<PreparedAICallAttempt>("db_prepare_ai_retry_regenerate_attempt", { input });
  },

  prepareContextRequestFollowup(input: PrepareAIContextRequestFollowupInput) {
    return invoke<PreparedAICallAttempt>("db_prepare_ai_context_request_followup", { input });
  },

  rejectContextRequest(input: DecideAIContextRequestInput) {
    return invoke<AIConversationReadback>("db_reject_ai_context_request", { input });
  },

  markContextRequestStale(input: MarkAIContextRequestStaleInput) {
    return invoke<AIConversationReadback>("db_mark_ai_context_request_stale", { input });
  },

  updateStandardResultDraft(input: UpdateAIStandardResultDraftInput) {
    return invoke<AIConversationReadback>("db_update_ai_standard_result_draft", { input });
  },

  dismissStandardResult(input: DecideAIStandardResultInput) {
    return invoke<AIConversationReadback>("db_dismiss_ai_standard_result", { input });
  },

  beginStandardResultConfirmation(input: BeginAIStandardResultConfirmationInput) {
    return invoke<AIConversationReadback>("db_begin_ai_standard_result_confirmation", { input });
  },

  settleStandardResultEffect(input: SettleAIStandardResultEffectInput) {
    return invoke<AIConversationReadback>("db_settle_ai_standard_result_effect", { input });
  },

  failStandardResult(input: FailAIStandardResultInput) {
    return invoke<AIConversationReadback>("db_fail_ai_standard_result", { input });
  },

  settleCallAttemptSuccess(input: SettleAICallAttemptSuccessInput) {
    return invoke<AIConversationReadback>("db_settle_ai_call_attempt_success", { input });
  },

  settleCallAttemptFailure(input: SettleAICallAttemptFailureInput) {
    return invoke<AIConversationReadback>("db_settle_ai_call_attempt_failure", { input });
  },

  readConversation(conversationId: string) {
    return invoke<AIConversationReadback>("db_read_ai_conversation", { conversationId });
  },

  listConversations() {
    return invoke<AIConversationSummary[]>("db_list_ai_conversations");
  },

  listAttachmentFileRefs() {
    return invoke<AISelectableFileRefCatalog>("db_list_ai_attachment_file_refs");
  }
};
