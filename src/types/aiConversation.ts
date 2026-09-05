import type {
  AIContextBudgetSummary,
  AIContextSourceRef,
  AIContextWarning,
  AIMaterialFreshnessReceipt
} from "./aiContext";
import type { AIErrorCode, AIProvider, AITextResponse } from "./ai";
import type { AIContextRequest } from "./aiContextRequest";
import type { AIStandardResult } from "./aiStandardResult";

export type AICallAttemptPurpose = "chat_response" | "action_draft_generation" | "parse_draft";
export type AICallAttemptStatus = "started" | "succeeded" | "failed";
export type AIMessageRole = "user" | "assistant";
export type AIMessageKind = "text" | "context_request_action";
export type AIFileRefAvailabilityStatus = "available" | "unavailable" | "unsupported_kind";
export type AIMaterialReadStatus = "supported" | "unsupported_type" | "unsupported_kind" | "unavailable";

export interface AIAuthorizedFileRefSnapshot {
  fileRefId: string;
  displayName: string;
  resourceKind: string;
  fileType: string;
  availabilityStatus: Exclude<AIFileRefAvailabilityStatus, "unsupported_kind">;
}

export interface AISelectableFileRef {
  fileRefId: string;
  displayName: string;
  resourceKind: string;
  fileType: string;
  availabilityStatus: AIFileRefAvailabilityStatus;
  materialReadStatus: AIMaterialReadStatus;
  /** Rust-owned safe upper bound for this FileRef's late typed material section. */
  materialPromptReservationCharacters?: number;
  /** Rust-owned metadata-only freshness baseline; absent when the source cannot be reviewed safely. */
  materialFreshnessReceipt?: AIMaterialFreshnessReceipt;
}

export interface AISelectableFileRefCatalog {
  fileRefs: AISelectableFileRef[];
  effectiveReadableSelectionLimit: number;
  supportedExtensions: string[];
}

export interface AIConversation {
  id: string;
  stableKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIConversationSummary {
  id: string;
  stableKey: string;
  createdAt: string;
  updatedAt: string;
  firstUserMessage?: string;
  latestMessage?: string;
  messageCount: number;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: AIMessageRole;
  content: string;
  messageKind: AIMessageKind;
  actionType?: "APPROVE_CONTEXT_REQUEST" | "REJECT_CONTEXT_REQUEST";
  actionRefId?: string;
  createdAt: string;
}

export interface AICallAttempt {
  id: string;
  requestId: string;
  conversationId: string;
  sequence: number;
  purpose: AICallAttemptPurpose;
  triggerMessageId?: string;
  triggerCallAttemptId?: string;
  resultMessageId?: string;
  provider: AIProvider;
  model: string;
  status: AICallAttemptStatus;
  contextPackageId: string;
  contextPackageVersion: string;
  contextSourceRefs: AIContextSourceRef[];
  warnings: AIContextWarning[];
  budgetSummary?: AIContextBudgetSummary;
  promptPackageId: string;
  promptCreatedAt: string;
  responseTruncated?: boolean;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageTotalTokens?: number;
  errorCode?: AIErrorCode;
  errorMessage?: string;
  errorRetryable?: boolean;
  providerStatus?: number;
  startedAt: string;
  settledAt?: string;
  authorizedFileRefs: AIAuthorizedFileRefSnapshot[];
}

export interface AIConversationReadback {
  conversation: AIConversation;
  messages: AIMessage[];
  projectedMessages: AIMessage[];
  callAttempts: AICallAttempt[];
  contextRequests: AIContextRequest[];
  standardResults: AIStandardResult[];
  retryRegenerate: AIRetryRegenerateProjection;
}

export type AIRetryRegenerateIntegrityState = "ok" | "malformed_success_ignored";

export interface AIRetryRegenerateProjection {
  latestTurnId?: string;
  effectiveAssistantMessageId?: string;
  effectiveSourceAttemptId?: string;
  latestAttemptId?: string;
  latestAttemptStatus?: AICallAttemptStatus;
  retryEligible: boolean;
  regenerateEligible: boolean;
  attachmentReauthorizationRequired: boolean;
  activeConflict: boolean;
  safeIntegrityState: AIRetryRegenerateIntegrityState;
}

export interface DurableAIInvocationResult {
  response: AITextResponse;
  conversation: AIConversation;
  triggerMessage: AIMessage;
  resultMessage?: AIMessage;
  callAttempt: AICallAttempt;
  readback: AIConversationReadback;
}
