import { createRepositoryEntityId } from "../repositories/entityId";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AICallAttempt,
  AICallAttemptPurpose,
  AIConversation,
  AIConversationReadback,
  AIErrorCode,
  AIErrorInfo,
  AIMessage,
  AIProviderResponseFormat,
  AITextStreamCompletedEvent,
  AITextStreamEvent,
  AITextStreamFailedEvent,
  AITextStreamCancelledEvent,
  AITextStreamRequest,
  AITextResponse,
  AIProviderConfigurationStatus,
  CancelAITextStreamResponse,
  DurableAIInvocationResult
} from "../types";
import type {
  AIContextBudgetSummary,
  AIContextPackage,
  AIContextSourceRef,
  AIContextWarning,
  AIMaterialFreshnessReceipt,
  AIProviderPromptEnvelope,
  AIPromptPackage
} from "../types/aiContext";
import {
  buildAIPromptPackage,
  CURRENT_CALL_AUTHORIZED_MATERIAL_CONTRACT_HEADING,
  type AIPromptPackageBuildOptions
} from "./aiPromptPackageService";
import {
  AI_CONTEXT_REQUEST_BOUNDED_POLICY,
  assertAIConstraintSemanticSegments,
  assertAIInvocationConstraint,
  resolveAIActiveConstraintRequest
} from "./aiConstraintService";
import type { AIConstraintResolutionRequest } from "../types/aiConstraint";
import { selectCanonicalPromptHistory } from "./aiConversationHistoryService";
export { selectCanonicalPromptHistory } from "./aiConversationHistoryService";
import {
  runAIText,
  startAITextStream,
  type AITextStreamTransport,
  validatePrompt
} from "./aiClient";
import { getAIProviderConfigurationStatus } from "./aiProviderConfigurationClient";
import { normalizeAIError } from "./aiErrorService";
import { createAIContextRequestResponseContract } from "./aiContextRequestService";
import {
  createAIContextRequestId,
  parseAIContextRequestResponse,
  resolveAIContextRequestCandidates
} from "./aiContextRequestService";
import type {
  AIContextRequestSourceSnapshot,
  AIContextRequestWirePayload
} from "../types/aiContextRequest";
import type { SettleAICallAttemptSuccessInput } from "../repositories/aiConversationRepository";
import type {
  AIParseDraftSourceSnapshot,
  AIStandardResultAction,
  AIStandardResultTarget,
  NewAIStandardResultBatchInput
} from "../types/aiStandardResult";
import {
  attachAIStandardResultManuscriptEffects,
  canonicalAIStandardResultFingerprint,
  parseAIParseDraftOutcome,
  readAIStandardResultBlockingValidationIssues,
  readAIStandardResultManuscriptEffects,
  readAIStandardResultProposalMetadata,
  stripAIStandardResultManuscriptEffects,
  stripAIStandardResultProposalMetadata
} from "./aiStandardResultService";
import { validateAIStandardResultProposal } from "./aiStandardResultAdapterService";
import { validateAIExperimentRunSiblingCreateProposal } from "./aiExperimentRunStandardResultAdapter";
import { readAIStandardOperationProposalPayload } from "./aiStandardOperationDraftService";
import {
  AI_PARSE_MECHANICAL_RETRYABLE_CODES,
  assertAIParseDraftSourceSnapshotStillCurrentAndEligible,
  buildAIParseMechanicalRetryPrompt,
  classifyAIParseMechanicalRetryFailure,
  type AIParseMechanicalRetryFailureCode
} from "./aiParseDraftService";
import { terminalizeAICallAttempt } from "./aiCallAttemptTerminalizationService";
import {
  sanitizeAIDurableSettlementCause,
  type SanitizedAIDurableSettlementCause
} from "./aiDurableSettlementCauseService";
import {
  awaitAIProviderAdmission,
  trackAIProviderExecution
} from "./aiCallAttemptLifecycleService";
import {
  assessAIParseSemanticCorrectionEligibility,
  assertAIParseSemanticCorrectionPreservesProposal,
  buildAIParseSemanticCorrectionPromptPackage,
  traceSelectsAIParseSemanticCorrectionPolicy
} from "./aiParseSemanticCorrectionService";
import {
  createAIParseSupplementalContextPhaseASourceRef,
  prepareAIParseSupplementalContextContinuation,
  resolveAIParseSupplementalContext,
  type AIParseSupplementalContextResolution
} from "./aiParseSupplementalContextService";

export type DurablePromptIdentity = {
  id: string;
  createdAt: string;
};

export type DurableAIInvocationTrace = {
  contextPackage: AIContextPackage;
  prompt: DurablePromptIdentity;
  sourceRefs: AIContextSourceRef[];
  warnings: AIContextWarning[];
  budgetSummary?: AIContextBudgetSummary;
  parseDraftSource?: AIParseDraftSourceSnapshot;
};

type DurableAIInvocationBase = {
  conversationId: string;
  requestId: string;
  promptText: string;
  trace: DurableAIInvocationTrace;
};

export type RunDurableAIInvocationInput = DurableAIInvocationBase & (
  | {
      purpose: "chat_response";
      userMessageContent: string;
      authorizedFileRefIds?: readonly string[];
      validateAuthorizedFileRefSelection?: () => void;
      onAuthorizationCommitted?: (readback: AIConversationReadback) => void;
    }
  | {
      purpose: "action_draft_generation";
      triggerMessageId: string;
      triggerCallAttemptId: string;
    }
);

type StartDurableAIStreamingInvocationCommon = DurableAIInvocationBase & {
  purpose: "chat_response" | "parse_draft";
  promptEnvelope: AIProviderPromptEnvelope;
  onEvent?: (event: AITextStreamEvent) => void;
  onParseMechanicalRetryPrepared?: (callAttemptId: string) => void;
  onParseSemanticCorrectionPrepared?: (callAttemptId: string) => void;
  onParseSupplementalContextContinuationPrepared?: (callAttemptId: string) => void;
};

export function selectAIProviderResponseFormat(
  purpose: StartDurableAIStreamingInvocationCommon["purpose"]
): AIProviderResponseFormat | undefined {
  return purpose === "parse_draft" ? { type: "json_object" } : undefined;
}

export type AIChatRetryRegenerateActionIntent = "retry" | "regenerate";
export type AIContextRequestApprovalActionIntent = "approve_context_request";

export type StartDurableAIStreamingInvocationInput =
  StartDurableAIStreamingInvocationCommon & (
    | {
        purpose: "chat_response";
        actionIntent?: undefined;
        userMessageContent: string;
        authorizedFileRefIds?: readonly string[];
        validateAuthorizedFileRefSelection?: () => void;
        onAuthorizationCommitted?: (readback: AIConversationReadback) => void;
      }
    | {
      purpose: "chat_response";
      actionIntent: AIChatRetryRegenerateActionIntent;
        userMessageContent: string;
        triggerMessageId: string;
        expectedSourceAttemptId: string;
      expectedEffectiveMessageId?: string;
    }
    | {
      purpose: "chat_response" | "parse_draft";
      actionIntent: AIContextRequestApprovalActionIntent;
      userMessageContent: string;
      contextRequestId: string;
      expectedReviewedCandidates: import("../types/aiContextRequest").AIContextRequestCandidate[];
      approvedRefs: import("../types/aiContextRequest").AIContextRequestCandidate[];
      authorizedFileRefIds?: readonly string[];
      validateAuthorizedFileRefSelection?: () => void;
      onAuthorizationCommitted?: (readback: AIConversationReadback) => void;
    }
    | {
      purpose: "parse_draft";
      actionIntent?: undefined;
      triggerMessageId: string;
      triggerCallAttemptId?: string;
      authorizedFileRefIds?: readonly string[];
      validateAuthorizedFileRefSelection?: () => void;
      onAuthorizationCommitted?: (readback: AIConversationReadback) => void;
    }
  );

export type DurableAIStreamingCancellationOutcome =
  | {
      kind: "succeeded";
      result: DurableAIInvocationResult;
    }
  | {
      kind: "failed";
      error: AIErrorInfo;
      callAttempt: AICallAttempt;
      readback: AIConversationReadback;
    }
  | {
      kind: "started";
      callAttempt: AICallAttempt;
      readback: AIConversationReadback;
    };

export type DurableAIStreamingCancelResult = CancelAITextStreamResponse & {
  outcome: DurableAIStreamingCancellationOutcome;
};

export type DurableAIStreamingInvocationHandle = {
  requestId: string;
  callAttemptId: string;
  conversationId: string;
  triggerMessageId: string;
  preparedReadback: AIConversationReadback;
  completion: Promise<DurableAIInvocationResult>;
  cancel: () => Promise<DurableAIStreamingCancelResult>;
};

type AIParseSemanticCorrectionInvocationMarker = {
  sourceCallAttemptId: string;
  firstProposalText: string;
  expectedProvider: string;
  expectedModel: string;
};

type AIParseMechanicalRetryInvocationMarker = {
  sourceCallAttemptId: string;
  mechanicalFailureCode: AIParseMechanicalRetryFailureCode;
  expectedProvider: string;
  expectedModel: string;
  expectedConfigurationRevision: number;
};

type InternalStartDurableAIStreamingInvocationInput =
  StartDurableAIStreamingInvocationInput & {
    parseMechanicalRetry?: AIParseMechanicalRetryInvocationMarker;
    parseSemanticCorrection?: AIParseSemanticCorrectionInvocationMarker;
    parseSupplementalContextContinuation?: {
      sourceCallAttemptId: string;
      expectedProvider: string;
      expectedModel: string;
    };
  };

export type AIDurablePersistencePhase = "pre_provider" | "post_provider";

export class AIDurablePersistenceError extends Error {
  readonly code: "ai_durable_persistence_failed" | "ai_durable_settlement_validation_failed";

  constructor(
    readonly phase: AIDurablePersistencePhase,
    readonly settlementCause?: SanitizedAIDurableSettlementCause
  ) {
    super(
      phase === "pre_provider"
        ? "AI 调用未发送：无法建立 durable 调用记录。"
        : settlementCause
          ? `AI 已返回，但 durable 结果提交失败；本次结果不会显示为成功。 ${settlementCause.durableMessage}`
          : "AI 已返回，但 durable 结果提交失败；本次结果不会显示为成功。"
    );
    this.code = settlementCause
      ? "ai_durable_settlement_validation_failed"
      : "ai_durable_persistence_failed";
    this.name = "AIDurablePersistenceError";
  }
}

class AIParseSemanticCorrectionCandidateError extends Error {
  readonly code = "parse_semantic_correction_eligible" as const;

  constructor(
    readonly firstAttemptId: string,
    readonly firstProposalText: string,
    readonly provider: string,
    readonly model: string,
    readonly firstTerminalReadback: AIConversationReadback
  ) {
    super("The first Parse Draft attempt truthfully failed with one allowlisted semantic-envelope defect.");
    this.name = "AIParseSemanticCorrectionCandidateError";
  }
}

class AIParseMechanicalRetryCandidateError extends Error {
  readonly code = "parse_mechanical_retry_eligible" as const;

  constructor(
    readonly firstAttemptId: string,
    readonly mechanicalFailureCode: AIParseMechanicalRetryFailureCode,
    readonly provider: string,
    readonly model: string,
    readonly configurationRevision: number,
    readonly firstTerminalReadback: AIConversationReadback
  ) {
    super("The first Parse Draft attempt truthfully failed with one allowlisted mechanical contract defect.");
    this.name = "AIParseMechanicalRetryCandidateError";
  }
}

class AIParseSupplementalContextCandidateError extends Error {
  readonly code = "parse_supplemental_context_eligible" as const;

  constructor(
    readonly sourceCallAttemptId: string,
    readonly baseContextPackage: AIContextPackage,
    readonly baseSource: AIParseDraftSourceSnapshot,
    readonly resolution: AIParseSupplementalContextResolution,
    readonly provider: string,
    readonly model: string,
    readonly firstTerminalReadback: AIConversationReadback
  ) {
    super("The Parse Draft Phase-A request is ready for one automatic attempt-scoped continuation.");
    this.name = "AIParseSupplementalContextCandidateError";
  }
}

class AIParseSupplementalContextSecondRequestError extends Error {
  readonly code = "parse_supplemental_context_second_request" as const;

  constructor() {
    super("Parse Draft Phase B returned a second Context Request; the at-most-once protocol forbids another continuation.");
    this.name = "AIParseSupplementalContextSecondRequestError";
  }
}

export function isAIDurablePersistenceError(error: unknown): error is AIDurablePersistenceError {
  return error instanceof AIDurablePersistenceError;
}

const ATTACHMENT_AUTHORIZATION_ERROR_CODES = new Set([
  "AI_ATTACHMENT_ID_INVALID",
  "AI_ATTACHMENT_COUNT_EXCEEDED",
  "AI_ATTACHMENT_REFERENCE_KIND_UNSUPPORTED",
  "AI_ATTACHMENT_UNAVAILABLE",
  "AI_ATTACHMENT_PURPOSE_INVALID"
]);

const RETRY_REGENERATE_PREPARE_ERROR_CODES = new Set<AIErrorCode>([
  "retry_regenerate_not_latest",
  "retry_regenerate_not_eligible",
  "retry_regenerate_active_conflict",
  "retry_regenerate_attachment_reauthorization_required",
  "retry_regenerate_prepare_failed",
  "attempt_identity_conflict",
  "retry_regenerate_projection_integrity_error"
]);

function parseDurableCommandError(error: unknown): { code: string; message: string } | null {
  const raw = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  const structured = /^code=([^\s]+)\s+message=([\s\S]*)$/u.exec(raw.trim());
  if (structured) {
    return { code: structured[1], message: structured[2].trim() };
  }
  const separator = raw.indexOf(":");
  if (separator > 0) {
    return {
      code: raw.slice(0, separator).trim(),
      message: raw.slice(separator + 1).trim()
    };
  }
  return null;
}

export class AIAttachmentAuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIAttachmentAuthorizationError";
  }
}

export function isAIAttachmentAuthorizationError(
  error: unknown
): error is AIAttachmentAuthorizationError {
  return error instanceof AIAttachmentAuthorizationError;
}

function attachmentAuthorizationError(error: unknown): AIAttachmentAuthorizationError | null {
  const parsed = parseDurableCommandError(error);
  if (!parsed || !ATTACHMENT_AUTHORIZATION_ERROR_CODES.has(parsed.code)) return null;
  return new AIAttachmentAuthorizationError(
    parsed.code,
    parsed.message || "Selected attachment authorization failed."
  );
}

export class AIRetryRegeneratePrepareError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: AIErrorCode,
    message: string,
    readonly authoritativeReadback?: AIConversationReadback
  ) {
    super(message);
    this.name = "AIRetryRegeneratePrepareError";
  }
}

export function isAIRetryRegeneratePrepareError(
  error: unknown
): error is AIRetryRegeneratePrepareError {
  return error instanceof AIRetryRegeneratePrepareError;
}

function retryRegeneratePrepareError(error: unknown): AIRetryRegeneratePrepareError | null {
  const parsed = parseDurableCommandError(error);
  if (!parsed || !RETRY_REGENERATE_PREPARE_ERROR_CODES.has(parsed.code as AIErrorCode)) {
    return null;
  }
  return new AIRetryRegeneratePrepareError(
    parsed.code as AIErrorCode,
    parsed.message || "Retry/Regenerate preparation was rejected safely."
  );
}

export class AIContextRequestPrepareError extends Error {
  readonly retryable = false;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AIContextRequestPrepareError";
  }
}

export function isAIContextRequestPrepareError(
  error: unknown
): error is AIContextRequestPrepareError {
  return error instanceof AIContextRequestPrepareError;
}

function contextRequestPrepareError(error: unknown): AIContextRequestPrepareError | null {
  const parsed = parseDurableCommandError(error);
  if (!parsed || !parsed.code.startsWith("AI_CONTEXT_REQUEST_")) return null;
  return new AIContextRequestPrepareError(
    parsed.code,
    parsed.message || "Context Request approval was rejected safely."
  );
}

export class AIProviderConfigurationPreGateError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: AIErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AIProviderConfigurationPreGateError";
    this.retryable = retryable;
  }
}

export function isAIProviderConfigurationPreGateError(
  error: unknown
): error is AIProviderConfigurationPreGateError {
  return error instanceof AIProviderConfigurationPreGateError;
}

async function requireEligibleProviderConfiguration(
  readStatus: typeof getAIProviderConfigurationStatus
): Promise<AIProviderConfigurationStatus> {
  let status: AIProviderConfigurationStatus;
  try {
    status = await readStatus();
  } catch {
    throw new AIProviderConfigurationPreGateError(
      "secure_store_unavailable",
      "AI provider configuration could not be read safely. Open Settings and retry.",
      true
    );
  }
  if (
    status.eligibility === "eligible" &&
    status.effectiveConfigured === true &&
    status.localConfigurationState === "valid" &&
    Number.isSafeInteger(status.configurationRevision) &&
    status.configurationRevision > 0 &&
    status.provider.trim() &&
    status.model.trim()
  ) {
    return status;
  }
  if (status.localConfigurationState === "secure_store_unavailable") {
    throw new AIProviderConfigurationPreGateError(
      "secure_store_unavailable",
      "The operating system credential store is unavailable. No AI request was started.",
      true
    );
  }
  if (status.localConfigurationState === "invalid_shape") {
    throw new AIProviderConfigurationPreGateError(
      "invalid_provider_configuration",
      "The local AI provider configuration is invalid. Open Settings to replace it."
    );
  }
  throw new AIProviderConfigurationPreGateError(
    "missing_api_key",
    `No API key is configured for ${status.provider}. Open Settings to add one.`
  );
}

export function createDurableAIInvocationRequestId(): string {
  return createRepositoryEntityId("ai-invocation");
}

export function createDurablePromptIdentity(prefix: string): DurablePromptIdentity {
  return {
    id: createRepositoryEntityId(prefix),
    createdAt: new Date().toISOString()
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function findAttempt(
  readback: AIConversationReadback,
  requestId: string,
  phase: AIDurablePersistencePhase
): AICallAttempt {
  const attempt = readback.callAttempts.find((candidate) => candidate.requestId === requestId);
  if (!attempt) {
    throw new AIDurablePersistenceError(phase);
  }
  return attempt;
}

function findMessage(readback: AIConversationReadback, messageId: string): AIMessage {
  const message = readback.messages.find((candidate) => candidate.id === messageId);
  if (!message) {
    throw new AIDurablePersistenceError("post_provider");
  }
  return message;
}

function responseFromReadback(
  attempt: AICallAttempt,
  resultMessage: AIMessage
): AITextResponse {
  return {
    text: resultMessage.content,
    provider: attempt.provider,
    model: attempt.model,
    truncated: attempt.responseTruncated,
    usage: attempt.usageInputTokens === undefined &&
      attempt.usageOutputTokens === undefined &&
      attempt.usageTotalTokens === undefined
      ? undefined
      : {
          inputTokens: attempt.usageInputTokens,
          outputTokens: attempt.usageOutputTokens,
          totalTokens: attempt.usageTotalTokens
        }
  };
}

function completedResultFromReadback(
  readback: AIConversationReadback,
  requestId: string,
  fallbackResponse?: AITextResponse
): DurableAIInvocationResult {
  const attempt = findAttempt(readback, requestId, "post_provider");
  const triggerMessageId = attempt.triggerMessageId;
  if (!triggerMessageId || attempt.status !== "succeeded") {
    throw new AIDurablePersistenceError("post_provider");
  }
  const triggerMessage = findMessage(readback, triggerMessageId);
  const resultMessage = attempt.resultMessageId
    ? findMessage(readback, attempt.resultMessageId)
    : undefined;
  const response = resultMessage
    ? responseFromReadback(attempt, resultMessage)
    : fallbackResponse;
  if (!response) {
    throw new AIDurablePersistenceError("post_provider");
  }
  return {
    response,
    conversation: readback.conversation,
    triggerMessage,
    resultMessage,
    callAttempt: attempt,
    readback
  };
}

export function effectiveDurableResultFromReadback(
  readback: AIConversationReadback
): DurableAIInvocationResult | null {
  const projection = readback.retryRegenerate;
  const triggerMessageId = projection.latestTurnId;
  const resultMessageId = projection.effectiveAssistantMessageId;
  const sourceAttemptId = projection.effectiveSourceAttemptId;
  // A prepared/failed first turn may legitimately have a latest User Message
  // before any effective Assistant result exists. Only an incomplete effective
  // result tuple is corrupt.
  if (!resultMessageId && !sourceAttemptId) return null;
  if (!triggerMessageId || !resultMessageId || !sourceAttemptId) {
    throw new AIDurablePersistenceError("post_provider");
  }
  const callAttempt = readback.callAttempts.find((attempt) => attempt.id === sourceAttemptId);
  if (
    !callAttempt ||
    callAttempt.purpose !== "chat_response" ||
    callAttempt.status !== "succeeded" ||
    callAttempt.triggerMessageId !== triggerMessageId ||
    callAttempt.resultMessageId !== resultMessageId
  ) {
    throw new AIDurablePersistenceError("post_provider");
  }
  const triggerMessage = findMessage(readback, triggerMessageId);
  const resultMessage = findMessage(readback, resultMessageId);
  if (triggerMessage.role !== "user" || resultMessage.role !== "assistant") {
    throw new AIDurablePersistenceError("post_provider");
  }
  return {
    response: responseFromReadback(callAttempt, resultMessage),
    conversation: readback.conversation,
    triggerMessage,
    resultMessage,
    callAttempt,
    readback
  };
}

function cancellationOutcomeFromReadback(
  readback: AIConversationReadback,
  requestId: string
): DurableAIStreamingCancellationOutcome {
  const callAttempt = findAttempt(readback, requestId, "post_provider");
  if (callAttempt.status === "succeeded") {
    return {
      kind: "succeeded",
      result: completedResultFromReadback(readback, requestId)
    };
  }
  if (callAttempt.status === "failed") {
    if (!callAttempt.errorCode || !callAttempt.errorMessage) {
      throw new AIDurablePersistenceError("post_provider");
    }
    return {
      kind: "failed",
      error: {
        code: callAttempt.errorCode,
        message: callAttempt.errorMessage,
        retryable: Boolean(callAttempt.errorRetryable),
        status: callAttempt.providerStatus
      },
      callAttempt,
      readback
    };
  }
  return {
    kind: "started",
    callAttempt,
    readback
  };
}

async function readCancellationOutcome(
  dependencies: Pick<DurableAIStreamingInvocationDependencies, "repository">,
  conversationId: string,
  requestId: string
): Promise<DurableAIStreamingCancellationOutcome> {
  let readback: AIConversationReadback;
  try {
    readback = await dependencies.repository.readConversation(conversationId);
  } catch {
    throw new AIDurablePersistenceError("post_provider");
  }
  return cancellationOutcomeFromReadback(readback, requestId);
}

function validateInvocationInput(
  input: RunDurableAIInvocationInput | StartDurableAIStreamingInvocationInput,
  validatePromptText: typeof validatePrompt
): string {
  requireText(input.conversationId, "conversationId");
  requireText(input.requestId, "requestId");
  requireText(input.trace.contextPackage.id, "contextPackage.id");
  requireText(input.trace.contextPackage.version, "contextPackage.version");
  requireText(input.trace.prompt.id, "prompt.id");
  requireText(input.trace.prompt.createdAt, "prompt.createdAt");
  if (input.purpose === "chat_response") {
    requireText(input.userMessageContent, "userMessageContent");
    if ("actionIntent" in input && input.actionIntent) {
      if (input.actionIntent === "approve_context_request") {
        requireText(input.contextRequestId, "contextRequestId");
        if (input.expectedReviewedCandidates.length === 0 || input.approvedRefs.length === 0) {
          throw new Error("Context Request approval requires the exact reviewed candidate set.");
        }
      } else {
        requireText(input.triggerMessageId, "triggerMessageId");
        requireText(input.expectedSourceAttemptId, "expectedSourceAttemptId");
        if (input.actionIntent === "regenerate") {
          requireText(input.expectedEffectiveMessageId ?? "", "expectedEffectiveMessageId");
        } else if (input.expectedEffectiveMessageId) {
          throw new Error("Retry cannot bind an effective assistant Message.");
        }
      }
    }
  } else if (input.purpose === "action_draft_generation") {
    requireText(input.triggerMessageId, "triggerMessageId");
    requireText(input.triggerCallAttemptId, "triggerCallAttemptId");
  } else {
    if (input.actionIntent === "approve_context_request") {
      requireText(input.contextRequestId, "contextRequestId");
      if (input.expectedReviewedCandidates.length === 0 || input.approvedRefs.length === 0) {
        throw new Error("Context Request approval requires the exact reviewed candidate set.");
      }
    } else {
      requireText(input.triggerMessageId, "triggerMessageId");
      if (input.triggerCallAttemptId) requireText(input.triggerCallAttemptId, "triggerCallAttemptId");
    }
    if (!input.trace.parseDraftSource || input.trace.parseDraftSource.conversationId !== input.conversationId) {
      throw new Error("parseDraftSource must match the canonical Parse Draft invocation identity.");
    }
    if (
      input.actionIntent !== "approve_context_request" &&
      input.trace.parseDraftSource.triggerMessageId !== input.triggerMessageId
    ) {
      throw new Error("parseDraftSource must match the canonical Parse Draft trigger Message.");
    }
    if (!("promptEnvelope" in input) || !input.promptEnvelope.standardResultResponseContract) {
      throw new Error("PARSE_DRAFT requires the typed Standard Result outcome contract.");
    }
  }
  const promptDescriptor = "promptEnvelope" in input
    ? input.promptEnvelope.constraintDescriptor
    : undefined;
  assertAIInvocationConstraint({
    purpose: input.purpose,
    sourceRefs: input.trace.sourceRefs,
    promptDescriptor
  });
  if ("promptEnvelope" in input) {
    assertAIConstraintSemanticSegments(
      input.promptEnvelope.constraintDescriptor,
      input.promptEnvelope.constraintSegments
    );
  }
  const validation = validatePromptText(
    input.promptText,
    input.purpose === "parse_draft"
      ? { enforceLegacyTotalCharacterGuard: false }
      : undefined
  );
  if (!validation.ok) {
    throw validation.error;
  }
  return validation.value;
}

function canonicalFileRefIdSet(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])].sort((left, right) => left.localeCompare(right));
}

function reviewedMaterialFreshnessReceipts(
  contextPackage: AIContextPackage,
  authorizedFileRefIds: readonly string[]
): AIMaterialFreshnessReceipt[] {
  const expectedIds = canonicalFileRefIdSet(authorizedFileRefIds);
  if (expectedIds.length === 0) return [];
  const decisions = contextPackage.materialDecisions ?? [];
  const decisionIds = decisions.map((decision) => decision.fileRefId);
  const canonicalDecisionIds = canonicalFileRefIdSet(decisionIds);
  if (
    new Set(decisionIds).size !== decisions.length ||
    decisions.length !== expectedIds.length ||
    expectedIds.some((fileRefId, index) => canonicalDecisionIds[index] !== fileRefId)
  ) {
    throw new AIAttachmentAuthorizationError(
      "AI_ATTACHMENT_FRESHNESS_RECEIPT_INVALID",
      "The reviewed material scope no longer matches the exact per-call authorization scope."
    );
  }
  return expectedIds.map((fileRefId) => {
    const receipt = decisions.find((decision) => decision.fileRefId === fileRefId)
      ?.materialFreshnessReceipt;
    if (
      !receipt || receipt.fileRefId !== fileRefId ||
      receipt.receiptVersion !== "material-source-v1" ||
      !/^[a-f0-9]{64}$/.test(receipt.sourceToken)
    ) {
      throw new AIAttachmentAuthorizationError(
        "AI_ATTACHMENT_FRESHNESS_RECEIPT_INVALID",
        "A selected FileRef does not have the canonical metadata-only baseline reviewed for this call."
      );
    }
    return { ...receipt };
  });
}

/**
 * Adds provider-visible material state only after the durable per-call authorization
 * readback has matched the exact CallAttempt. Rust remains the sole body reader and
 * will not start the Provider if the following material section cannot be assembled.
 */
export function applyCurrentCallAuthorizedMaterialContract(
  promptEnvelope: AIProviderPromptEnvelope,
  authorizedFileRefIds: readonly string[]
): AIProviderPromptEnvelope {
  const canonicalIds = canonicalFileRefIdSet(authorizedFileRefIds);
  if (canonicalIds.length === 0) return promptEnvelope;
  if (
    canonicalIds.length !== authorizedFileRefIds.length ||
    promptEnvelope.currentCallAuthorizedMaterialRefs?.length ||
    promptEnvelope.researchContext.includes(CURRENT_CALL_AUTHORIZED_MATERIAL_CONTRACT_HEADING)
  ) {
    throw new Error("The current-call authorized material receipt must be assembled exactly once.");
  }
  return {
    ...promptEnvelope,
    currentCallAuthorizedMaterialRefs: canonicalIds.map((refId, index) => ({
      ordinal: index + 1,
      refId
    }))
  };
}

function traceSelectsContextRequestPolicy(trace: DurableAIInvocationTrace): boolean {
  return trace.sourceRefs.some((sourceRef) =>
    sourceRef.boundedPolicyDocuments?.some((document) =>
      document.documentId === AI_CONTEXT_REQUEST_BOUNDED_POLICY.documentId &&
      document.semanticVersion === AI_CONTEXT_REQUEST_BOUNDED_POLICY.semanticVersion
    )
  );
}

function invocationContextSourceRefs(
  input: InternalStartDurableAIStreamingInvocationInput
): AIContextSourceRef[] {
  const sourceRefs = input.trace.sourceRefs.map((sourceRef) => structuredClone(sourceRef));
  const workflowRefs = sourceRefs.filter((sourceRef) => (
    sourceRef.field === "parseSupplementalContextWorkflow"
  ));
  if (input.purpose !== "parse_draft") {
    if (workflowRefs.length > 0) {
      throw new Error("Natural Chat cannot carry Parse supplemental-context workflow provenance.");
    }
    return sourceRefs;
  }
  const automaticPhaseB = input.promptEnvelope.contextRequestFollowupState?.scope ===
    "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP";
  if (automaticPhaseB) {
    if (
      workflowRefs.length !== 1 ||
      workflowRefs[0].parseSupplementalContextWorkflowKind !== "PARSE_DRAFT" ||
      workflowRefs[0].parseSupplementalContextPhase !== "PHASE_B_AUTOMATIC" ||
      workflowRefs[0].parseSupplementalContextRequestRemaining !== 0 ||
      workflowRefs[0].parseSupplementalContextAutomaticContinuationCount !== 1
    ) {
      throw new Error("Parse Phase B requires one exact exhausted automatic-continuation receipt.");
    }
    return sourceRefs;
  }
  if (workflowRefs.length > 0) {
    throw new Error("Parse Phase A cannot inherit supplemental-context continuation provenance.");
  }
  return input.promptEnvelope.contextRequestResponseContract
    ? [...sourceRefs, createAIParseSupplementalContextPhaseASourceRef(input.requestId)]
    : sourceRefs;
}

type ContextRequestSettlement = {
  assistantText: string;
  contextRequest?: NonNullable<SettleAICallAttemptSuccessInput["contextRequest"]>;
};

type InvocationSuccessSettlement = {
  assistantText?: string;
  contextRequest?: NonNullable<SettleAICallAttemptSuccessInput["contextRequest"]>;
  standardResultBatch?: NewAIStandardResultBatchInput;
  parseSupplementalContext?: {
    resolution: AIParseSupplementalContextResolution;
  };
};

async function buildContextRequestFromDecodedPayload(
  payload: AIContextRequestWirePayload,
  trace: DurableAIInvocationTrace,
  createdAt: string
): Promise<ContextRequestSettlement> {
  const contextPackage = trace.contextPackage;
  const requestableRefs = createAIContextRequestResponseContract(contextPackage)?.requestableRefs ?? [];
  const researchObjects = contextPackage.researchObjects ?? [];
  const projectId = requestableRefs[0]?.projectId;
  if (
    !projectId || !contextPackage.contextMode || !contextPackage.budget ||
    !contextPackage.reviewFingerprint ||
    requestableRefs.some((ref) => ref.projectId !== projectId) ||
    researchObjects.some((object) => object.projectId !== projectId)
  ) {
    return {
      assistantText: "The assistant requested more context, but its source context is no longer reviewable. No request was created."
    };
  }
  let reviewedCandidates;
  try {
    reviewedCandidates = await resolveAIContextRequestCandidates(
      projectId,
      requestableRefs,
      payload.requestedRefs
    );
  } catch {
    return {
      assistantText: `${payload.assistantText}\n\nThe requested context could not be resolved within the current Project and research-object scope.`
    };
  }
  const source: AIContextRequestSourceSnapshot = {
    projectId,
    contextMode: contextPackage.contextMode,
    contextBudget: { ...contextPackage.budget },
    researchObjects: researchObjects.map((object) => ({
      objectType: object.objectType,
      objectId: object.objectId
    })),
    contextReviewFingerprint: contextPackage.reviewFingerprint,
    requestableRefs: requestableRefs.map((ref) => ({
      ...ref,
      allowedContributionKinds: [...ref.allowedContributionKinds]
    }))
  };
  const unavailable = reviewedCandidates.some((candidate) => candidate.availability !== "available");
  return {
    assistantText: payload.assistantText,
    contextRequest: {
      id: createAIContextRequestId(),
      source,
      reason: payload.reason,
      requestedRefs: payload.requestedRefs,
      reviewedCandidates,
      initialState: unavailable ? "STALE_OR_INVALID" : "PENDING",
      ...(unavailable
        ? { invalidReason: "One or more canonical requested refs were unavailable at response settlement." }
        : {}),
      createdAt
    }
  };
}

async function buildContextRequestSettlement(
  providerText: string,
  trace: DurableAIInvocationTrace,
  createdAt: string
): Promise<ContextRequestSettlement> {
  if (!traceSelectsContextRequestPolicy(trace)) {
    return { assistantText: providerText };
  }
  const parsed = parseAIContextRequestResponse(providerText);
  if (parsed.kind === "invalid_structured") {
    throw new Error(`Context Request protocol error (${parsed.errorCode}): ${parsed.errorMessage}`);
  }
  if (parsed.kind === "plain_text") {
    return { assistantText: parsed.assistantText };
  }
  return buildContextRequestFromDecodedPayload(parsed.payload, trace, createdAt);
}

export function selectDurableAIStandardResultTarget(input: {
  action: AIStandardResultAction;
  proposalTarget: AIStandardResultTarget;
  resolvedTarget?: AIStandardResultTarget;
  source: Pick<AIParseDraftSourceSnapshot, "quickAnalysisTarget">;
}): AIStandardResultTarget {
  const target = input.action === "NEW_MANUSCRIPT" && input.source.quickAnalysisTarget
    ? input.proposalTarget
    : (input.resolvedTarget ?? input.proposalTarget);
  return structuredClone(target);
}

export function isAIStandardResultProposalSettlementAdmissible(input: {
  action: AIStandardResultAction;
  executable: boolean;
  validationIssues: readonly { code: string; field?: string }[];
}): boolean {
  if (readAIStandardResultBlockingValidationIssues(input.validationIssues).length > 0) return false;
  return input.executable || input.action === "DELETE_SUGGESTION";
}

/**
 * Preserves the Provider's complete parent-proposal set at the durable boundary.
 * A mechanically unsafe proposal must reject the whole batch explicitly; it may
 * neither reach the Rust provenance validator nor disappear as a filtered sibling.
 */
export function assertAIStandardResultProposalSettlementBatchAdmissible(input: readonly {
  originalOrdinal: number;
  action: AIStandardResultAction;
  executable: boolean;
  validationIssues: readonly { code: string; field?: string }[];
}[]): void {
  const rejected = input.flatMap((candidate) => {
    if (isAIStandardResultProposalSettlementAdmissible(candidate)) return [];
    const blockingCodes = readAIStandardResultBlockingValidationIssues(
      candidate.validationIssues
    ).map((issue) => issue.code);
    return [{
      originalOrdinal: candidate.originalOrdinal,
      reasonCodes: blockingCodes.length > 0 ? blockingCodes : ["NON_EXECUTABLE"]
    }];
  });
  if (rejected.length === 0) return;
  const diagnostic = rejected.map((candidate) => (
    `ordinal=${candidate.originalOrdinal} codes=${candidate.reasonCodes.join(",")}`
  )).join("; ");
  throw new Error(
    `Standard Result proposal settlement rejected before durable persistence: ${diagnostic}`
  );
}

async function buildParseDraftSuccessSettlement(
  providerText: string,
  trace: DurableAIInvocationTrace,
  createdAt: string,
  contextRequestFollowupState?: AIProviderPromptEnvelope["contextRequestFollowupState"]
): Promise<InvocationSuccessSettlement> {
  const source = trace.parseDraftSource;
  if (!source || source.contextReviewFingerprint !== trace.contextPackage.reviewFingerprint) {
    throw new Error("The frozen Parse Draft source does not match its A2 ContextPackage.");
  }
  const outcome = parseAIParseDraftOutcome(providerText);
  if (outcome.kind === "context_request") {
    if (contextRequestFollowupState) {
      throw new AIParseSupplementalContextSecondRequestError();
    }
    const requestableRefs = createAIContextRequestResponseContract(
      trace.contextPackage
    )?.requestableRefs ?? [];
    const resolution = await resolveAIParseSupplementalContext({
      payload: outcome.payload,
      requestableRefs,
      source
    });
    return { parseSupplementalContext: { resolution } };
  }
  const batchId = createRepositoryEntityId("ai-standard-result-batch");
  const indexedProposals = outcome.payload.results.map((proposal, index) => ({
    proposal,
    originalOrdinal: index + 1,
    metadata: readAIStandardResultProposalMetadata(proposal.payload)
  }));
  const proposalByRef = new Map(indexedProposals.flatMap((candidate) =>
    candidate.metadata ? [[candidate.metadata.proposalRef, candidate] as const] : []));
  for (const candidate of indexedProposals) {
    const metadata = candidate.metadata;
    if (!metadata?.parentProposalRef) continue;
    const parent = proposalByRef.get(metadata.parentProposalRef);
    if (
      candidate.proposal.action !== "CREATE" ||
      candidate.proposal.target.module !== "experimentRun" ||
      !parent || parent.originalOrdinal >= candidate.originalOrdinal ||
      parent.proposal.category !== "DATA_OPERATION" ||
      parent.proposal.action !== "CREATE" ||
      parent.proposal.target.module !== "experiment" ||
      parent.proposal.target.projectId !== candidate.proposal.target.projectId
    ) {
      throw new Error(
        `Proposal ${candidate.originalOrdinal} has no exact earlier same-Project Experiment CREATE sibling parent.`
      );
    }
  }
  const reviewedProposals = await Promise.all(indexedProposals.map(async (candidate) => {
    const { proposal, metadata } = candidate;
    const decodedPayload = stripAIStandardResultProposalMetadata(proposal.payload);
    const manuscriptEffects = readAIStandardResultManuscriptEffects(decodedPayload, {
      action: proposal.action,
      target: proposal.target
    });
    const businessPayload = stripAIStandardResultManuscriptEffects(decodedPayload);
    const tolerantRead = readAIStandardOperationProposalPayload({
      action: proposal.action,
      target: proposal.target,
      payload: businessPayload
    });
    const normalizedParentPayload = attachAIStandardResultManuscriptEffects(
      tolerantRead.payload,
      manuscriptEffects
    );
    const parentProposal = metadata?.parentProposalRef
      ? proposalByRef.get(metadata.parentProposalRef)?.proposal
      : undefined;
    const validation = parentProposal && proposal.action === "CREATE" && proposal.target.module === "experimentRun"
      ? await validateAIExperimentRunSiblingCreateProposal({
          target: proposal.target,
          payload: tolerantRead.payload,
          expectedProjectId: source.projectId,
          parentProposalRef: metadata!.parentProposalRef!,
          parentProposalLabel: String(stripAIStandardResultProposalMetadata(parentProposal.payload).title ?? "同批实验")
        }).then((candidateValidation) => ({
          ...candidateValidation,
          normalizedPayload: attachAIStandardResultManuscriptEffects(
            candidateValidation.normalizedPayload,
            manuscriptEffects
          )
        }))
      : await validateAIStandardResultProposal({
          action: proposal.action,
          target: proposal.target,
          source,
          frozenContextSourceRefs: trace.sourceRefs,
          payload: normalizedParentPayload,
          expectedProjectId: source.projectId,
          fallbackSections: tolerantRead.unknownSafeSections
        });
    return { ...candidate, tolerantRead, validation };
  }));
  assertAIStandardResultProposalSettlementBatchAdmissible(reviewedProposals.map((candidate) => ({
    originalOrdinal: candidate.originalOrdinal,
    action: candidate.proposal.action,
    executable: candidate.validation.executable,
    validationIssues: candidate.validation.validationIssues
  })));
  const results = reviewedProposals.map(({ proposal, tolerantRead, validation, originalOrdinal }) => {
    const originalPayload = structuredClone(proposal.payload);
    const visiblePayload = structuredClone(validation.normalizedPayload);
    return {
      id: createRepositoryEntityId("ai-standard-result"),
      ordinal: originalOrdinal,
      category: proposal.category,
      action: proposal.action,
      target: selectDurableAIStandardResultTarget({
        action: proposal.action,
        proposalTarget: proposal.target,
        resolvedTarget: validation.resolvedTarget,
        source
      }),
      source: structuredClone(source),
      originalPayload,
      visiblePayload,
      visiblePayloadFingerprint: canonicalAIStandardResultFingerprint(visiblePayload),
      ...(validation.targetSnapshotFingerprint
        ? { targetSnapshotFingerprint: validation.targetSnapshotFingerprint }
        : {}),
      validationIssues: [...validation.validationIssues, ...tolerantRead.nonBlockingIssues]
        .map((issue) => ({ ...issue }))
    };
  });
  return {
    standardResultBatch: {
      id: batchId,
      results,
      createdAt
    }
  };
}

async function buildInvocationSuccessSettlement(
  purpose: AICallAttemptPurpose,
  providerText: string,
  trace: DurableAIInvocationTrace,
  createdAt: string,
  promptEnvelope?: AIProviderPromptEnvelope
): Promise<InvocationSuccessSettlement> {
  if (purpose === "chat_response") {
    return buildContextRequestSettlement(providerText, trace, createdAt);
  }
  if (purpose === "parse_draft") {
    return buildParseDraftSuccessSettlement(
      providerText,
      trace,
      createdAt,
      promptEnvelope?.contextRequestFollowupState
    );
  }
  return {};
}

function assertAuthorizedFileRefReadback(
  attempt: AICallAttempt,
  expectedIds: readonly string[] | undefined
) {
  const expected = canonicalFileRefIdSet(expectedIds);
  const actual = canonicalFileRefIdSet(
    (attempt.authorizedFileRefs ?? []).map((snapshot) => snapshot.fileRefId)
  );
  if (
    expected.length !== actual.length ||
    expected.some((id, index) => id !== actual[index])
  ) {
    throw new AIDurablePersistenceError("pre_provider");
  }
}

export type DurableAIInvocationDependencies = {
  repository: Pick<
    typeof aiConversationRepository,
    | "prepareCallAttempt"
    | "settleCallAttemptSuccess"
    | "settleCallAttemptFailure"
    | "readConversation"
  >;
  getProviderConfigurationStatus: typeof getAIProviderConfigurationStatus;
  runProvider: typeof runAIText;
  normalizeProviderError: typeof normalizeAIError;
  validatePromptText: typeof validatePrompt;
  awaitProviderAdmission: () => Promise<void>;
  now: () => string;
};

async function assertParseDraftInvocationSourceEligibility(
  input: Pick<
    RunDurableAIInvocationInput | StartDurableAIStreamingInvocationInput,
    "purpose" | "conversationId" | "trace"
  >,
  repository: Pick<typeof aiConversationRepository, "readConversation">
): Promise<void> {
  if (input.purpose !== "parse_draft") return;
  const source = input.trace.parseDraftSource;
  if (!source) {
    throw new Error("PARSE_DRAFT requires one frozen source snapshot.");
  }
  let readback: AIConversationReadback;
  try {
    readback = await repository.readConversation(input.conversationId);
  } catch {
    throw new AIDurablePersistenceError("pre_provider");
  }
  assertAIParseDraftSourceSnapshotStillCurrentAndEligible(readback, source);
}

async function executeDurableAIInvocationWithDependencies(
  input: RunDurableAIInvocationInput,
  dependencies: DurableAIInvocationDependencies
): Promise<DurableAIInvocationResult> {
  await dependencies.awaitProviderAdmission();
  const promptText = validateInvocationInput(input, dependencies.validatePromptText);
  await assertParseDraftInvocationSourceEligibility(input, dependencies.repository);
  const configuration = await requireEligibleProviderConfiguration(
    dependencies.getProviderConfigurationStatus
  );
  const attemptId = `ai-call-attempt-${input.requestId}`;
  const userMessageId = input.purpose === "chat_response"
    ? `ai-message-user-${input.requestId}`
    : undefined;
  const startedAt = dependencies.now();
  const authorizedFileRefIds = input.purpose === "chat_response"
    ? canonicalFileRefIdSet(input.authorizedFileRefIds)
    : [];
  if (input.purpose === "chat_response") {
    input.validateAuthorizedFileRefSelection?.();
  }

  let prepared;
  try {
    prepared = await dependencies.repository.prepareCallAttempt({
      conversationId: input.conversationId,
      attemptId,
      requestId: input.requestId,
      purpose: input.purpose,
      ...(input.purpose === "chat_response"
        ? {
            userMessage: {
              id: userMessageId!,
              content: input.userMessageContent.trim(),
              createdAt: startedAt
            }
          }
        : {
            triggerMessageId: input.triggerMessageId,
            triggerCallAttemptId: input.triggerCallAttemptId
          }),
      provider: configuration.provider,
      model: configuration.model,
      contextPackageId: input.trace.contextPackage.id,
      contextPackageVersion: input.trace.contextPackage.version,
      contextSourceRefs: input.trace.sourceRefs,
      warnings: input.trace.warnings,
      budgetSummary: input.trace.budgetSummary,
      promptPackageId: input.trace.prompt.id,
      promptCreatedAt: input.trace.prompt.createdAt,
      startedAt,
      authorizedFileRefIds
    });
  } catch (error) {
    const authorizationError = attachmentAuthorizationError(error);
    if (authorizationError) throw authorizationError;
    throw new AIDurablePersistenceError("pre_provider");
  }

  if (prepared.readback.conversation.id !== input.conversationId) {
    throw new AIDurablePersistenceError("pre_provider");
  }
  const preparedAttempt = findAttempt(prepared.readback, input.requestId, "pre_provider");
  assertAuthorizedFileRefReadback(preparedAttempt, authorizedFileRefIds);
  assertAIInvocationConstraint({
    purpose: input.purpose,
    sourceRefs: preparedAttempt.contextSourceRefs,
    promptDescriptor: undefined
  });
  if (input.purpose === "chat_response") {
    input.onAuthorizationCommitted?.(prepared.readback);
  }
  if (!prepared.providerInvocationAuthorized) {
    return completedResultFromReadback(prepared.readback, input.requestId);
  }
  if (preparedAttempt.status !== "started") {
    throw new AIDurablePersistenceError("pre_provider");
  }

  let providerResponse: AITextResponse;
  try {
    providerResponse = await dependencies.runProvider(
      promptText,
      configuration.configurationRevision
    );
  } catch (providerError) {
    const safeError = dependencies.normalizeProviderError(providerError);
    try {
      const failureReadback = await terminalizeAICallAttempt(dependencies.repository, {
        kind: "failure",
        conversationId: input.conversationId,
        input: {
          attemptId,
          errorCode: safeError.code,
          errorMessage: safeError.message,
          errorRetryable: safeError.retryable,
          providerStatus: safeError.status,
          settledAt: dependencies.now()
        }
      });
      const failedAttempt = findAttempt(failureReadback, input.requestId, "post_provider");
      if (failedAttempt.status !== "failed") {
        throw new AIDurablePersistenceError("post_provider");
      }
    } catch {
      throw new AIDurablePersistenceError("post_provider");
    }
    throw providerError;
  }

  const settledAt = dependencies.now();
  let successSettlement: InvocationSuccessSettlement;
  try {
    successSettlement = await buildInvocationSuccessSettlement(
      input.purpose,
      providerResponse.text,
      input.trace,
      settledAt
    );
  } catch (outcomeError) {
    await terminalizeAICallAttempt(dependencies.repository, {
      kind: "failure",
      conversationId: input.conversationId,
      input: {
        attemptId,
        errorCode: "invalid_response",
        errorMessage: outcomeError instanceof Error ? outcomeError.message : "The Parse Draft outcome was invalid.",
        errorRetryable: true,
        settledAt
      }
    }).catch(() => {
      throw new AIDurablePersistenceError("post_provider");
    });
    throw outcomeError;
  }
  const assistantMessage = successSettlement.assistantText
    ? {
        id: `ai-message-assistant-${input.requestId}`,
        content: successSettlement.assistantText,
        createdAt: settledAt
      }
    : undefined;
  let readback: AIConversationReadback;
  try {
    readback = await terminalizeAICallAttempt(dependencies.repository, {
      kind: "success",
      conversationId: input.conversationId,
      input: {
        attemptId,
        provider: providerResponse.provider,
        model: providerResponse.model,
        responseTruncated: providerResponse.truncated,
        usage: providerResponse.usage,
        assistantMessage,
        contextRequest: successSettlement.contextRequest,
        standardResultBatch: successSettlement.standardResultBatch,
        settledAt
      }
    });
  } catch (settlementError) {
    const settlementCause = sanitizeAIDurableSettlementCause(settlementError);
    const persistenceError = new AIDurablePersistenceError("post_provider", settlementCause);
    try {
      await terminalizeAICallAttempt(dependencies.repository, {
        kind: "failure",
        conversationId: input.conversationId,
        input: {
          attemptId,
          errorCode: settlementCause.errorCode,
          errorMessage: persistenceError.message,
          errorRetryable: false,
          settledAt: dependencies.now()
        }
      });
    } catch {
      // The canonical seam already performed authoritative readback. Preserve
      // the original persistence failure when even the fail-closed terminal
      // transition cannot be durably verified.
    }
    throw persistenceError;
  }
  return completedResultFromReadback(readback, input.requestId, providerResponse);
}

export function createDurableAIInvocationRunner(
  dependencies: DurableAIInvocationDependencies
) {
  const requests = new Map<string, Promise<DurableAIInvocationResult>>();
  return function run(
    input: RunDurableAIInvocationInput
  ): Promise<DurableAIInvocationResult> {
    const requestId = requireText(input.requestId, "requestId");
    const existing = requests.get(requestId);
    if (existing) {
      return existing;
    }
    const invocation = executeDurableAIInvocationWithDependencies(input, dependencies).finally(() => {
      if (requests.get(requestId) === invocation) {
        requests.delete(requestId);
      }
    });
    trackAIProviderExecution(`nonstream:${requestId}`, invocation);
    requests.set(requestId, invocation);
    return invocation;
  };
}

export const runDurableAIInvocation = createDurableAIInvocationRunner({
  repository: aiConversationRepository,
  getProviderConfigurationStatus: getAIProviderConfigurationStatus,
  runProvider: runAIText,
  normalizeProviderError: normalizeAIError,
  validatePromptText: validatePrompt,
  awaitProviderAdmission: awaitAIProviderAdmission,
  now: () => new Date().toISOString()
});

export type DurableAIStreamingInvocationDependencies = {
  repository: Pick<
    typeof aiConversationRepository,
    | "prepareCallAttempt"
    | "prepareRetryRegenerateCallAttempt"
    | "prepareContextRequestFollowup"
    | "settleCallAttemptSuccess"
    | "settleCallAttemptFailure"
    | "readConversation"
  >;
  getProviderConfigurationStatus: typeof getAIProviderConfigurationStatus;
  startProvider: (
    request: AITextStreamRequest,
    onEvent?: (event: AITextStreamEvent) => void
  ) => AITextStreamTransport;
  normalizeProviderError: typeof normalizeAIError;
  validatePromptText: typeof validatePrompt;
  awaitProviderAdmission: () => Promise<void>;
  now: () => string;
};

function terminalErrorInfo(
  event: AITextStreamFailedEvent | AITextStreamCancelledEvent
): AIErrorInfo {
  return {
    code: event.errorCode,
    message: event.errorMessage,
    retryable: event.errorRetryable,
    status: event.eventKind === "failed" ? event.providerStatus : undefined
  };
}

function isNonSettlingStartIdentityLoss(code: AIErrorCode): boolean {
  return code === "material_not_authorized" ||
    code === "material_attempt_not_active" ||
    code === "material_attempt_already_owned_or_replayed";
}

function terminalIdentityMatches(
  event: AITextStreamCompletedEvent | AITextStreamFailedEvent | AITextStreamCancelledEvent,
  request: AITextStreamRequest
): boolean {
  return (
    event.requestId === request.requestId &&
    event.callAttemptId === request.callAttemptId &&
    event.conversationId === request.conversationId &&
    event.triggerMessageId === request.triggerMessageId &&
    request.requestId === request.callAttemptId
  );
}

async function settleStreamingSuccess(
  event: AITextStreamCompletedEvent,
  purpose: "chat_response" | "parse_draft",
  attemptId: string,
  conversationId: string,
  trace: DurableAIInvocationTrace,
  promptEnvelope: AIProviderPromptEnvelope,
  configurationRevision: number,
  parseMechanicalRetry: AIParseMechanicalRetryInvocationMarker | undefined,
  parseSemanticCorrection: AIParseSemanticCorrectionInvocationMarker | undefined,
  dependencies: DurableAIStreamingInvocationDependencies
): Promise<DurableAIInvocationResult> {
  const response: AITextResponse = {
    text: event.text,
    provider: event.provider,
    model: event.model,
    truncated: event.truncated,
    usage: event.usage
  };
  const settledAt = dependencies.now();
  let successSettlement: InvocationSuccessSettlement;
  try {
    if (purpose === "parse_draft" && event.truncated) {
      throw new Error("A truncated Parse Draft outcome cannot create Standard Results.");
    }
    if (parseSemanticCorrection) {
      assertAIParseSemanticCorrectionPreservesProposal({
        firstProposalText: parseSemanticCorrection.firstProposalText,
        correctedText: event.text
      });
    }
    successSettlement = await buildInvocationSuccessSettlement(
      purpose,
      event.text,
      trace,
      settledAt,
      promptEnvelope
    );
    if (parseMechanicalRetry && successSettlement.parseSupplementalContext) {
      throw new Error(
        "The one mechanical retry returned a Context Request that would require a forbidden third Provider call."
      );
    }
  } catch (error) {
    const invalidResponse: AIErrorInfo = {
      code: "invalid_response",
      message: error instanceof Error ? error.message : "The Parse Draft outcome was invalid.",
      retryable: true
    };
    const firstTerminalReadback = await terminalizeStreamingFailure(
      invalidResponse,
      event.requestId,
      attemptId,
      conversationId,
      dependencies
    );
    const mechanicalRetry = classifyAIParseMechanicalRetryFailure({
      purpose,
      providerResponseCompleted: true,
      responseTruncated: event.truncated === true,
      parserError: error,
      acceptedStandardResultCount: 0,
      automaticRetryAlreadyUsed: Boolean(
        parseMechanicalRetry ||
        parseSemanticCorrection ||
        promptEnvelope.contextRequestFollowupState
      )
    });
    if (mechanicalRetry.eligible) {
      throw new AIParseMechanicalRetryCandidateError(
        attemptId,
        mechanicalRetry.code,
        event.provider,
        event.model,
        configurationRevision,
        firstTerminalReadback
      );
    }
    if (
      purpose === "parse_draft" &&
      !parseMechanicalRetry &&
      !parseSemanticCorrection &&
      !(error instanceof AIParseSupplementalContextSecondRequestError) &&
      !promptEnvelope.contextRequestFollowupState &&
      !traceSelectsAIParseSemanticCorrectionPolicy(trace.sourceRefs)
    ) {
      const eligibility = await assessAIParseSemanticCorrectionEligibility({
        event,
        readback: firstTerminalReadback,
        firstAttemptId: attemptId,
        source: trace.parseDraftSource
      }).catch(() => ({
        eligible: false as const,
        reason: "PROPOSAL_SEMANTICS_INCOMPLETE_OR_UNSAFE" as const
      }));
      if (eligibility.eligible) {
        throw new AIParseSemanticCorrectionCandidateError(
          attemptId,
          eligibility.firstProposalText,
          event.provider,
          event.model,
          firstTerminalReadback
        );
      }
    }
    throw invalidResponse;
  }
  let readback: AIConversationReadback;
  try {
    readback = await terminalizeAICallAttempt(dependencies.repository, {
      kind: "success",
      conversationId,
      input: {
        attemptId,
        provider: event.provider,
        model: event.model,
        responseTruncated: event.truncated,
        usage: event.usage,
        assistantMessage: successSettlement.assistantText
          ? {
              id: `ai-message-assistant-${event.requestId}`,
              content: successSettlement.assistantText,
              createdAt: settledAt
            }
          : undefined,
        contextRequest: successSettlement.contextRequest,
        standardResultBatch: successSettlement.standardResultBatch,
        settledAt
      }
    });
  } catch (settlementError) {
    const settlementCause = sanitizeAIDurableSettlementCause(settlementError);
    const persistenceError = new AIDurablePersistenceError("post_provider", settlementCause);
    try {
      await terminalizeAICallAttempt(dependencies.repository, {
        kind: "failure",
        conversationId,
        input: {
          attemptId,
          errorCode: settlementCause.errorCode,
          errorMessage: persistenceError.message,
          errorRetryable: false,
          settledAt: dependencies.now()
        }
      });
    } catch {
      // The canonical seam already performed authoritative readback. Preserve
      // the original persistence failure when even the fail-closed terminal
      // transition cannot be durably verified.
    }
    throw persistenceError;
  }
  if (successSettlement.parseSupplementalContext) {
    const source = trace.parseDraftSource;
    if (!source) {
      throw new AIDurablePersistenceError("post_provider");
    }
    throw new AIParseSupplementalContextCandidateError(
      event.requestId,
      structuredClone(trace.contextPackage),
      structuredClone(source),
      successSettlement.parseSupplementalContext.resolution,
      event.provider,
      event.model,
      readback
    );
  }
  return completedResultFromReadback(readback, event.requestId, response);
}

async function terminalizeStreamingFailure(
  error: AIErrorInfo,
  requestId: string,
  attemptId: string,
  conversationId: string,
  dependencies: DurableAIStreamingInvocationDependencies
): Promise<AIConversationReadback> {
  let readback: AIConversationReadback;
  try {
    readback = await terminalizeAICallAttempt(dependencies.repository, {
      kind: "failure",
      conversationId,
      input: {
        attemptId,
        errorCode: error.code,
        errorMessage: error.message,
        errorRetryable: Boolean(error.retryable),
        providerStatus: error.status,
        settledAt: dependencies.now()
      }
    });
  } catch {
    throw new AIDurablePersistenceError("post_provider");
  }
  const failedAttempt = findAttempt(readback, requestId, "post_provider");
  if (failedAttempt.status !== "failed" || failedAttempt.errorCode !== error.code) {
    throw new AIDurablePersistenceError("post_provider");
  }
  return readback;
}

async function settleStreamingFailure(
  error: AIErrorInfo,
  requestId: string,
  attemptId: string,
  conversationId: string,
  dependencies: DurableAIStreamingInvocationDependencies
): Promise<never> {
  await terminalizeStreamingFailure(
    error,
    requestId,
    attemptId,
    conversationId,
    dependencies
  );
  throw error;
}

async function startDurableAIStreamingInvocationWithDependencies(
  input: InternalStartDurableAIStreamingInvocationInput,
  dependencies: DurableAIStreamingInvocationDependencies
): Promise<DurableAIStreamingInvocationHandle> {
  await dependencies.awaitProviderAdmission();
  const promptText = validateInvocationInput(input, dependencies.validatePromptText);
  await assertParseDraftInvocationSourceEligibility(input, dependencies.repository);
  const configuration = await requireEligibleProviderConfiguration(
    dependencies.getProviderConfigurationStatus
  );
  if (
    input.parseMechanicalRetry &&
    (input.purpose !== "parse_draft" ||
      input.parseSemanticCorrection ||
      input.parseSupplementalContextContinuation ||
      input.actionIntent !== undefined ||
      input.triggerCallAttemptId !== input.parseMechanicalRetry.sourceCallAttemptId ||
      input.promptEnvelope.contextRequestFollowupState !== undefined ||
      !AI_PARSE_MECHANICAL_RETRYABLE_CODES.includes(
        input.parseMechanicalRetry.mechanicalFailureCode
      ))
  ) {
    throw {
      code: "invalid_request" as const,
      message: "Parse mechanical retry provenance is incomplete or does not identify one eligible first attempt.",
      retryable: false
    };
  }
  if (
    input.parseSemanticCorrection &&
    (input.purpose !== "parse_draft" ||
      !("triggerCallAttemptId" in input) ||
      input.triggerCallAttemptId !== input.parseSemanticCorrection.sourceCallAttemptId ||
      !input.parseSemanticCorrection.firstProposalText.trim() ||
      !traceSelectsAIParseSemanticCorrectionPolicy(input.trace.sourceRefs))
  ) {
    throw {
      code: "invalid_request" as const,
      message: "Parse semantic correction provenance is incomplete or does not identify the terminal source attempt.",
      retryable: false
    };
  }
  if (
    input.parseMechanicalRetry &&
    (configuration.provider !== input.parseMechanicalRetry.expectedProvider ||
      configuration.model !== input.parseMechanicalRetry.expectedModel ||
      configuration.configurationRevision !==
        input.parseMechanicalRetry.expectedConfigurationRevision)
  ) {
    throw {
      code: "configuration_changed" as const,
      message: "Parse mechanical retry was not sent because the configured Provider, model, or configuration revision changed after the first attempt.",
      retryable: false
    };
  }
  if (
    input.parseSupplementalContextContinuation &&
    (input.purpose !== "parse_draft" ||
      input.parseSemanticCorrection ||
      input.actionIntent !== undefined ||
      input.triggerCallAttemptId !==
        input.parseSupplementalContextContinuation.sourceCallAttemptId ||
      input.promptEnvelope.contextRequestFollowupState?.scope !==
        "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP")
  ) {
    throw {
      code: "invalid_request" as const,
      message: "Parse supplemental-context continuation provenance is incomplete or does not identify the exact Phase-A attempt.",
      retryable: false
    };
  }
  if (
    input.parseSupplementalContextContinuation &&
    (configuration.provider !==
      input.parseSupplementalContextContinuation.expectedProvider ||
      configuration.model !== input.parseSupplementalContextContinuation.expectedModel)
  ) {
    throw {
      code: "configuration_changed" as const,
      message: "Parse supplemental-context continuation was not sent because the configured Provider/model changed after Phase A.",
      retryable: false
    };
  }
  if (
    input.parseSemanticCorrection &&
    (configuration.provider !== input.parseSemanticCorrection.expectedProvider ||
      configuration.model !== input.parseSemanticCorrection.expectedModel)
  ) {
    throw {
      code: "configuration_changed" as const,
      message: "Parse semantic correction was not sent because the configured Provider/model changed after the first attempt.",
      retryable: false
    };
  }
  // B3 deliberately uses one canonical identity across durable storage and transport.
  const attemptId = input.requestId;
  const isContextRequestApproval = input.actionIntent === "approve_context_request";
  const isRetryRegenerate = Boolean(input.actionIntent) && !isContextRequestApproval;
  const triggerMessageId = isContextRequestApproval
    ? `ai-message-context-request-action-${input.requestId}`
    : input.actionIntent
      ? input.triggerMessageId
      : input.purpose === "parse_draft"
        ? input.triggerMessageId
        : `ai-message-user-${input.requestId}`;
  const startedAt = dependencies.now();
  const authorizedFileRefIds = input.actionIntent === "retry" || input.actionIntent === "regenerate"
    ? []
    : canonicalFileRefIdSet("authorizedFileRefIds" in input ? input.authorizedFileRefIds : undefined);
  const materialFreshnessReceipts = reviewedMaterialFreshnessReceipts(
    input.trace.contextPackage,
    authorizedFileRefIds
  );
  if (!input.actionIntent || input.actionIntent === "approve_context_request") {
    input.validateAuthorizedFileRefSelection?.();
  }

  let prepared;
  try {
    const shared = {
      conversationId: input.conversationId,
      attemptId,
      requestId: input.requestId,
      provider: configuration.provider,
      model: configuration.model,
      contextPackageId: input.trace.contextPackage.id,
      contextPackageVersion: input.trace.contextPackage.version,
      contextSourceRefs: invocationContextSourceRefs(input),
      warnings: input.trace.warnings,
      budgetSummary: input.trace.budgetSummary,
      promptPackageId: input.trace.prompt.id,
      promptCreatedAt: input.trace.prompt.createdAt,
      startedAt
    };
    if (input.actionIntent === "approve_context_request") {
      prepared = await dependencies.repository.prepareContextRequestFollowup({
        ...shared,
        purpose: input.purpose,
        contextRequestId: input.contextRequestId,
        actionMessageId: triggerMessageId,
        expectedReviewedCandidates: input.expectedReviewedCandidates,
        approvedRefs: input.approvedRefs,
        authorizedFileRefIds
      });
    } else if (input.actionIntent) {
      prepared = await dependencies.repository.prepareRetryRegenerateCallAttempt({
          ...shared,
          actionIntent: input.actionIntent,
          triggerMessageId,
          expectedSourceAttemptId: input.expectedSourceAttemptId,
          expectedEffectiveMessageId: input.expectedEffectiveMessageId
        });
    } else if (input.purpose === "parse_draft") {
      prepared = await dependencies.repository.prepareCallAttempt({
        ...shared,
        purpose: "parse_draft",
        triggerMessageId,
        triggerCallAttemptId: input.triggerCallAttemptId,
        authorizedFileRefIds
      });
    } else {
      prepared = await dependencies.repository.prepareCallAttempt({
          ...shared,
          purpose: "chat_response",
          userMessage: {
            id: triggerMessageId,
            content: input.userMessageContent.trim(),
            createdAt: startedAt
          },
          authorizedFileRefIds
        });
    }
  } catch (error) {
    if (isContextRequestApproval) {
      const prepareError = contextRequestPrepareError(error);
      if (prepareError) throw prepareError;
    }
    if (isRetryRegenerate) {
      const prepareError = retryRegeneratePrepareError(error);
      if (prepareError) throw prepareError;
    }
    const authorizationError = attachmentAuthorizationError(error);
    if (authorizationError) throw authorizationError;
    throw new AIDurablePersistenceError("pre_provider");
  }

  const preparedAttempt = findAttempt(
    prepared.readback,
    input.requestId,
    "pre_provider"
  );
  if (prepared.readback.conversation.id !== input.conversationId) {
    throw new AIDurablePersistenceError("pre_provider");
  }
  assertAuthorizedFileRefReadback(preparedAttempt, authorizedFileRefIds);
  assertAIInvocationConstraint({
    purpose: input.purpose,
    sourceRefs: preparedAttempt.contextSourceRefs,
    promptDescriptor: input.promptEnvelope.constraintDescriptor
  });
  if (!input.actionIntent || input.actionIntent === "approve_context_request") {
    input.onAuthorizationCommitted?.(prepared.readback);
  }
  if (!prepared.providerInvocationAuthorized) {
    let completed: DurableAIInvocationResult;
    try {
      completed = completedResultFromReadback(
        prepared.readback,
        input.requestId,
        input.purpose === "parse_draft"
          ? {
              text: "",
              provider: preparedAttempt.provider,
              model: preparedAttempt.model
            }
          : undefined
      );
    } catch (error) {
      if (isRetryRegenerate && preparedAttempt.status === "failed") {
        throw new AIRetryRegeneratePrepareError(
          preparedAttempt.errorCode ?? "retry_regenerate_not_eligible",
          preparedAttempt.errorMessage ?? "This Retry/Regenerate action is already terminal.",
          prepared.readback
        );
      }
      throw error;
    }
    return {
      requestId: input.requestId,
      callAttemptId: preparedAttempt.id,
      conversationId: prepared.readback.conversation.id,
      triggerMessageId: completed.triggerMessage.id,
      preparedReadback: prepared.readback,
      completion: Promise.resolve(completed),
      cancel: async () => ({
        requestId: input.requestId,
        callAttemptId: preparedAttempt.id,
        status: "ALREADY_TERMINAL",
        outcome: cancellationOutcomeFromReadback(
          prepared.readback,
          input.requestId
        )
      })
    };
  }
  if (
    preparedAttempt.status !== "started" ||
    preparedAttempt.id !== attemptId ||
    preparedAttempt.requestId !== attemptId ||
    preparedAttempt.triggerMessageId !== triggerMessageId
  ) {
    throw new AIDurablePersistenceError("pre_provider");
  }
  if (input.parseSupplementalContextContinuation) {
    input.onParseSupplementalContextContinuationPrepared?.(preparedAttempt.id);
  }
  if (input.parseMechanicalRetry) {
    input.onParseMechanicalRetryPrepared?.(preparedAttempt.id);
  }

  const streamRequest: AITextStreamRequest = {
    promptEnvelope: applyCurrentCallAuthorizedMaterialContract(
      input.promptEnvelope,
      authorizedFileRefIds
    ),
    materialFreshnessReceipts,
    expectedConfigurationRevision: configuration.configurationRevision,
    ...(input.purpose === "parse_draft"
      ? { responseFormat: selectAIProviderResponseFormat(input.purpose) }
      : {}),
    requestId: attemptId,
    callAttemptId: attemptId,
    conversationId: prepared.readback.conversation.id,
    triggerMessageId
  };
  let transport: AITextStreamTransport;
  try {
    transport = dependencies.startProvider(streamRequest, input.onEvent);
  } catch (transportError) {
    const normalized = dependencies.normalizeProviderError(transportError);
    const safeError: AIErrorInfo = {
      code: normalized.code === "unknown_error" ? "transport_error" : normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      status: normalized.status
    };
    if (isNonSettlingStartIdentityLoss(safeError.code)) {
      throw safeError;
    }
    const completion = settleStreamingFailure(
      safeError,
      input.requestId,
      attemptId,
      streamRequest.conversationId,
      dependencies
    );
    return {
      requestId: input.requestId,
      callAttemptId: attemptId,
      conversationId: streamRequest.conversationId,
      triggerMessageId: streamRequest.triggerMessageId,
      preparedReadback: prepared.readback,
      completion,
      cancel: async () => {
        await completion.catch(() => undefined);
        return {
          requestId: input.requestId,
          callAttemptId: attemptId,
          status: "ACTIVE_REQUEST_NOT_FOUND",
          outcome: await readCancellationOutcome(
            dependencies,
            streamRequest.conversationId,
            input.requestId
          )
        };
      }
    };
  }
  const completion = transport.completion.then(
    (event) => {
      if (!terminalIdentityMatches(event, streamRequest)) {
        void transport.cancel().catch(() => undefined);
        return settleStreamingFailure(
          {
            code: "stream_protocol_error",
            message: "AI stream terminal identity mismatch.",
            retryable: true
          },
          input.requestId,
          attemptId,
          streamRequest.conversationId,
          dependencies
        );
      }
      if (event.eventKind === "completed") {
        return settleStreamingSuccess(
          event,
          input.purpose,
          attemptId,
          streamRequest.conversationId,
          input.trace,
          input.promptEnvelope,
          configuration.configurationRevision,
          input.parseMechanicalRetry,
          input.parseSemanticCorrection,
          dependencies
        );
      }
      const failure = terminalErrorInfo(event);
      if (isNonSettlingStartIdentityLoss(failure.code)) {
        throw failure;
      }
      return settleStreamingFailure(
        failure,
        input.requestId,
        attemptId,
        streamRequest.conversationId,
        dependencies
      );
    },
    async (transportError) => {
      const normalized = dependencies.normalizeProviderError(transportError);
      const safeError: AIErrorInfo = {
        code: normalized.code === "unknown_error" ? "transport_error" : normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        status: normalized.status
      };
      if (isNonSettlingStartIdentityLoss(safeError.code)) {
        throw safeError;
      }
      void transport.cancel().catch(() => undefined);
      return settleStreamingFailure(
        safeError,
        input.requestId,
        attemptId,
        streamRequest.conversationId,
        dependencies
      );
    }
  );

  const cancel = async (): Promise<DurableAIStreamingCancelResult> => {
    const acknowledgment = await transport.cancel();
    if (acknowledgment.status !== "ACTIVE_REQUEST_NOT_FOUND") {
      await completion.catch(() => undefined);
    }
    return {
      ...acknowledgment,
      outcome: await readCancellationOutcome(
        dependencies,
        streamRequest.conversationId,
        input.requestId
      )
    };
  };

  return {
    requestId: input.requestId,
    callAttemptId: attemptId,
    conversationId: streamRequest.conversationId,
    triggerMessageId: streamRequest.triggerMessageId,
    preparedReadback: prepared.readback,
    completion,
    cancel
  };
}

export function createDurableAIStreamingInvocationRunner(
  dependencies: DurableAIStreamingInvocationDependencies
) {
  const requests = new Map<
    string,
    Promise<DurableAIStreamingInvocationHandle>
  >();
  const start = function start(
    input: InternalStartDurableAIStreamingInvocationInput
  ): Promise<DurableAIStreamingInvocationHandle> {
    const requestId = requireText(input.requestId, "requestId");
    const existing = requests.get(requestId);
    if (existing) {
      return existing;
    }
    const frozenParseMechanicalRetryBase =
      input.purpose === "parse_draft" &&
      input.actionIntent === undefined &&
      !input.parseMechanicalRetry &&
      !input.parseSemanticCorrection &&
      !input.parseSupplementalContextContinuation
        ? {
            conversationId: input.conversationId,
            promptText: input.promptText,
            promptEnvelope: structuredClone(input.promptEnvelope),
            triggerMessageId: input.triggerMessageId,
            authorizedFileRefIds: [...(input.authorizedFileRefIds ?? [])],
            validateAuthorizedFileRefSelection: input.validateAuthorizedFileRefSelection,
            onAuthorizationCommitted: input.onAuthorizationCommitted,
            onEvent: input.onEvent,
            onParseMechanicalRetryPrepared: input.onParseMechanicalRetryPrepared,
            trace: structuredClone(input.trace)
          }
        : undefined;
    const startingOnce = startDurableAIStreamingInvocationWithDependencies(
      input,
      dependencies
    );
    const starting = input.purpose !== "parse_draft" ||
      input.parseMechanicalRetry ||
      input.parseSemanticCorrection ||
      input.parseSupplementalContextContinuation
      ? startingOnce
      : startingOnce.then((firstHandle) => {
          let activeHandle = firstHandle;
          let logicalCancellationRequested = false;
          const completion = firstHandle.completion.catch(async (error) => {
            if (error instanceof AIParseMechanicalRetryCandidateError) {
              if (!frozenParseMechanicalRetryBase) {
                throw {
                  code: "invalid_request" as const,
                  message: "Parse mechanical retry was not sent because the logical action was not an ordinary first Parse attempt.",
                  retryable: false
                };
              }
              if (logicalCancellationRequested) {
                throw {
                  code: "cancelled" as const,
                  message: "Parse Draft was cancelled before its bounded mechanical retry started.",
                  retryable: true
                };
              }
              const retryPrompt = buildAIParseMechanicalRetryPrompt({
                promptText: frozenParseMechanicalRetryBase.promptText,
                promptEnvelope: frozenParseMechanicalRetryBase.promptEnvelope,
                failureCode: error.mechanicalFailureCode
              });
              const retryRequestId = createDurableAIInvocationRequestId();
              const retryInput: InternalStartDurableAIStreamingInvocationInput = {
                conversationId: frozenParseMechanicalRetryBase.conversationId,
                purpose: "parse_draft",
                requestId: retryRequestId,
                promptText: retryPrompt.promptText,
                promptEnvelope: retryPrompt.promptEnvelope,
                triggerMessageId: frozenParseMechanicalRetryBase.triggerMessageId,
                triggerCallAttemptId: error.firstAttemptId,
                authorizedFileRefIds:
                  frozenParseMechanicalRetryBase.authorizedFileRefIds,
                validateAuthorizedFileRefSelection:
                  frozenParseMechanicalRetryBase.validateAuthorizedFileRefSelection,
                onAuthorizationCommitted:
                  frozenParseMechanicalRetryBase.onAuthorizationCommitted,
                onEvent: frozenParseMechanicalRetryBase.onEvent,
                onParseMechanicalRetryPrepared:
                  frozenParseMechanicalRetryBase.onParseMechanicalRetryPrepared,
                trace: {
                  ...structuredClone(frozenParseMechanicalRetryBase.trace),
                  prompt: {
                    id: createRepositoryEntityId("ai-prompt"),
                    createdAt: dependencies.now()
                  }
                },
                parseMechanicalRetry: {
                  sourceCallAttemptId: error.firstAttemptId,
                  mechanicalFailureCode: error.mechanicalFailureCode,
                  expectedProvider: error.provider,
                  expectedModel: error.model,
                  expectedConfigurationRevision: error.configurationRevision
                }
              };
              const retryHandle = await start(retryInput);
              activeHandle = retryHandle;
              if (logicalCancellationRequested) {
                await retryHandle.cancel();
              }
              return retryHandle.completion;
            }
            if (error instanceof AIParseSupplementalContextCandidateError) {
              const continuation = await prepareAIParseSupplementalContextContinuation({
                conversationId: input.conversationId,
                logicalAttemptId: error.sourceCallAttemptId,
                sourceCallAttemptId: error.sourceCallAttemptId,
                baseContextPackage: error.baseContextPackage,
                baseSource: error.baseSource,
                resolution: error.resolution,
                readback: error.firstTerminalReadback,
                outputDetailPreference: input.promptEnvelope.outputDetailPreference,
                technicalCapacityChars: input.promptEnvelope.finalPromptHardBudget
              });
              const continuationRequestId = createDurableAIInvocationRequestId();
              const continuationInput: InternalStartDurableAIStreamingInvocationInput = {
                conversationId: input.conversationId,
                purpose: "parse_draft",
                requestId: continuationRequestId,
                promptText: continuation.promptPackage.finalPrompt,
                promptEnvelope: continuation.promptPackage.providerPromptEnvelope,
                triggerMessageId: continuation.source.triggerMessageId,
                triggerCallAttemptId: error.sourceCallAttemptId,
                authorizedFileRefIds: continuation.authorizedBodyFileRefIds,
                onEvent: input.onEvent,
                onParseSupplementalContextContinuationPrepared:
                  input.onParseSupplementalContextContinuationPrepared,
                trace: buildDurableAIInvocationTrace(
                  continuation.contextPackage,
                  {
                    id: continuation.promptPackage.id,
                    createdAt: continuation.promptPackage.createdAt
                  },
                  {
                    sourceRefs: continuation.promptPackage.sourceRefs,
                    warnings: continuation.promptPackage.warnings,
                    budgetSummary: continuation.promptPackage.budgetSummary,
                    parseDraftSource: continuation.source
                  }
                ),
                parseSupplementalContextContinuation: {
                  sourceCallAttemptId: error.sourceCallAttemptId,
                  expectedProvider: error.provider,
                  expectedModel: error.model
                }
              };
              const continuationHandle = await start(continuationInput);
              activeHandle = continuationHandle;
              return continuationHandle.completion;
            }
            if (!(error instanceof AIParseSemanticCorrectionCandidateError)) {
              throw error;
            }
            const correctionPrompt = buildAIParseSemanticCorrectionPromptPackage({
              contextPackage: input.trace.contextPackage,
              originalSourceRefs: error.firstTerminalReadback.callAttempts.find((attempt) =>
                attempt.id === error.firstAttemptId)?.contextSourceRefs ?? input.trace.sourceRefs,
              originalPromptEnvelope: input.promptEnvelope,
              firstAttemptId: error.firstAttemptId,
              firstProposalText: error.firstProposalText
            });
            if (correctionPrompt.warnings?.some((warning) => warning.severity === "error")) {
              throw {
                code: "invalid_request" as const,
                message: "Parse semantic correction was not sent because the canonical prompt exceeds the current technical capacity.",
                retryable: false
              };
            }
            const correctionRequestId = createDurableAIInvocationRequestId();
            const correctionInput: InternalStartDurableAIStreamingInvocationInput = {
              conversationId: input.conversationId,
              purpose: "parse_draft",
              requestId: correctionRequestId,
              promptText: correctionPrompt.finalPrompt,
              promptEnvelope: correctionPrompt.providerPromptEnvelope,
              triggerMessageId: input.trace.parseDraftSource!.triggerMessageId,
              triggerCallAttemptId: error.firstAttemptId,
              authorizedFileRefIds: [],
              trace: buildDurableAIInvocationTrace(
                input.trace.contextPackage,
                {
                  id: correctionPrompt.id,
                  createdAt: correctionPrompt.createdAt
                },
                {
                  sourceRefs: correctionPrompt.sourceRefs,
                  warnings: correctionPrompt.warnings,
                  budgetSummary: correctionPrompt.budgetSummary,
                  parseDraftSource: input.trace.parseDraftSource
                }
              ),
              parseSemanticCorrection: {
                sourceCallAttemptId: error.firstAttemptId,
                firstProposalText: error.firstProposalText,
                expectedProvider: error.provider,
                expectedModel: error.model
              }
            };
            const correctionHandle = await start(correctionInput);
            activeHandle = correctionHandle;
            input.onParseSemanticCorrectionPrepared?.(correctionHandle.callAttemptId);
            return correctionHandle.completion;
          });
          return {
            ...firstHandle,
            completion,
            cancel: () => {
              logicalCancellationRequested = true;
              return activeHandle.cancel();
            }
          };
        });
    trackAIProviderExecution(
      `stream:${requestId}`,
      starting.then((handle) => handle.completion)
    );
    requests.set(requestId, starting);
    void starting.then(
      (handle) => {
        void handle.completion.then(
          () => {
            if (requests.get(requestId) === starting) requests.delete(requestId);
          },
          () => {
            if (requests.get(requestId) === starting) requests.delete(requestId);
          }
        );
      },
      () => {
        if (requests.get(requestId) === starting) requests.delete(requestId);
      }
    );
    return starting;
  };
  return start;
}

export const startDurableAIStreamingInvocation =
  createDurableAIStreamingInvocationRunner({
    repository: aiConversationRepository,
    getProviderConfigurationStatus: getAIProviderConfigurationStatus,
    startProvider: startAITextStream,
    normalizeProviderError: normalizeAIError,
    validatePromptText: validatePrompt,
    awaitProviderAdmission: awaitAIProviderAdmission,
    now: () => new Date().toISOString()
  });

export const AI_NEW_CONVERSATION_STRATEGY = "EAGER_CANONICAL_CREATE" as const;

export async function createCanonicalAIConversation(): Promise<AIConversation> {
  const id = createRepositoryEntityId("ai-conversation");
  const createdAt = new Date().toISOString();
  return aiConversationRepository.createConversation({
    id,
    stableKey: `global-ai-chat/${id}`,
    createdAt
  });
}

export type BuildConversationPromptPackageInput = {
  conversationId: string;
  contextPackage: AIContextPackage;
  userQuestion: string;
  historyBeforeMessageId?: string;
  constraintRequest: AIConstraintResolutionRequest;
  /** Exact Quick target used only for bounded-policy selection/fail-closed validation. */
  quickAnalysisTarget?: { ownerType: string; channel: string };
  /** Quick body-only mode disables machine Context Request selection for this call only. */
  machineContextRequestMode?: "enabled" | "disabled";
  options?: Partial<Omit<
    AIPromptPackageBuildOptions,
    "constraintDescriptor" | "legacySourceMarker"
  >>;
};

export async function buildConversationPromptPackage(
  input: BuildConversationPromptPackageInput
): Promise<{ promptPackage: AIPromptPackage; readback: AIConversationReadback }> {
  const conversationId = requireText(input.conversationId, "conversationId");
  const readback = await aiConversationRepository.readConversation(conversationId);
  if (readback.conversation.id !== conversationId) {
    throw new AIDurablePersistenceError("pre_provider");
  }
  const candidateResponseContract = input.machineContextRequestMode === "disabled"
    ? undefined
    : createAIContextRequestResponseContract(input.contextPackage);
  const contextRequestExhausted = Boolean(input.options?.contextRequestFollowupState) ||
    input.options?.quickAnalysisContextCapability?.state === "CONTEXT_EXHAUSTED";
  const responseContract = contextRequestExhausted ? undefined : candidateResponseContract;
  const frozenSelectsContextRequest = input.constraintRequest.kind === "frozen" &&
    (input.constraintRequest.descriptor.executableBoundedPolicies?.some((identity) =>
      identity.documentId === AI_CONTEXT_REQUEST_BOUNDED_POLICY.documentId &&
      identity.semanticVersion === AI_CONTEXT_REQUEST_BOUNDED_POLICY.semanticVersion
    ) ?? false);
  const contextRequestCapabilityEligible = input.constraintRequest.kind === "current"
    ? Boolean(responseContract)
    : frozenSelectsContextRequest && Boolean(responseContract);
  const constraint = resolveAIActiveConstraintRequest({
    request: input.constraintRequest,
    purpose: "chat_response",
    contextRequestCapabilityEligible,
    quickAnalysisTarget: input.quickAnalysisTarget
  });
  return {
    promptPackage: buildAIPromptPackage(input.contextPackage, input.userQuestion, {
      ...input.options,
      constraintDescriptor: constraint.descriptor,
      legacySourceMarker: constraint.legacySourceMarker,
      ...(contextRequestCapabilityEligible && responseContract
        ? { contextRequestResponseContract: responseContract }
        : {}),
      conversationMessages: selectCanonicalPromptHistory(readback, {
        beforeMessageId: input.historyBeforeMessageId
      })
    }),
    readback
  };
}

export function buildDurableAIInvocationTrace(
  contextPackage: AIContextPackage,
  prompt: DurablePromptIdentity,
  options: {
    sourceRefs: AIContextSourceRef[];
    warnings?: AIContextWarning[];
    budgetSummary?: AIContextBudgetSummary;
    parseDraftSource?: AIParseDraftSourceSnapshot;
  }
): DurableAIInvocationTrace {
  return {
    contextPackage,
    prompt,
    sourceRefs: options.sourceRefs,
    warnings: options.warnings ?? [],
    budgetSummary: options.budgetSummary,
    ...(options.parseDraftSource
      ? { parseDraftSource: structuredClone(options.parseDraftSource) }
      : {})
  };
}

export const aiConversationApplicationService = {
  createConversation: createCanonicalAIConversation,
  runInvocation: runDurableAIInvocation,
  startStreamingInvocation: startDurableAIStreamingInvocation,
  readConversation: aiConversationRepository.readConversation,
  listConversations: aiConversationRepository.listConversations,
  listAttachmentFileRefs: aiConversationRepository.listAttachmentFileRefs,
  buildPromptPackage: buildConversationPromptPackage
};

export function isMountedAICallPurpose(value: string): value is AICallAttemptPurpose {
  return value === "chat_response" || value === "action_draft_generation" || value === "parse_draft";
}
