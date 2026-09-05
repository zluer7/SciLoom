import type {
  SettleAICallAttemptFailureInput,
  SettleAICallAttemptSuccessInput
} from "../repositories/aiConversationRepository";
import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AICallAttempt,
  AIContextRequest,
  AIConversationReadback,
  AIStandardResult
} from "../types";

export type AICallAttemptTerminalizationRepository = Pick<
  typeof aiConversationRepository,
  "settleCallAttemptSuccess" | "settleCallAttemptFailure" | "readConversation"
>;

export type AICallAttemptTerminalSettlement =
  | {
      kind: "success";
      conversationId: string;
      input: SettleAICallAttemptSuccessInput;
    }
  | {
      kind: "failure";
      conversationId: string;
      input: SettleAICallAttemptFailureInput;
    };

export class AICallAttemptTerminalConflictError extends Error {
  readonly code = "AI_CALL_ATTEMPT_TERMINAL_CONFLICT" as const;

  constructor(
    readonly attemptId: string,
    readonly readback: AIConversationReadback
  ) {
    super("The first authoritative CallAttempt terminal outcome was preserved.");
    this.name = "AICallAttemptTerminalConflictError";
  }
}

export class AICallAttemptTerminalizationReadbackError extends Error {
  readonly code = "AI_CALL_ATTEMPT_TERMINAL_READBACK_FAILED" as const;

  constructor(
    readonly attemptId: string,
    readonly terminalizationCause?: unknown
  ) {
    super("The CallAttempt terminal transition could not be verified by durable readback.");
    this.name = "AICallAttemptTerminalizationReadbackError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalOptionalScalar<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function attemptFromReadback(
  readback: AIConversationReadback,
  conversationId: string,
  attemptId: string
): AICallAttempt | undefined {
  if (readback.conversation?.id !== conversationId) return undefined;
  return (readback.callAttempts ?? []).find((attempt) => (
    attempt.id === attemptId && attempt.conversationId === conversationId
  ));
}

function contextRequestMatches(
  readback: AIConversationReadback,
  attempt: AICallAttempt,
  input: SettleAICallAttemptSuccessInput
): boolean {
  const durable = (readback.contextRequests ?? []).filter(
    (request) => request.sourceCallAttemptId === attempt.id
  );
  const proposed = input.contextRequest;
  if (!proposed) return durable.length === 0;
  if (durable.length !== 1) return false;
  const actual: AIContextRequest = durable[0];
  return (
    actual.id === proposed.id &&
    actual.conversationId === attempt.conversationId &&
    actual.sourceCallAttemptId === attempt.id &&
    actual.sourceMessageId === input.assistantMessage?.id &&
    actual.reason === proposed.reason &&
    actual.state === proposed.initialState &&
    equivalent(actual.source, proposed.source) &&
    equivalent(actual.requestedRefs, proposed.requestedRefs) &&
    equivalent(actual.reviewedCandidates, proposed.reviewedCandidates)
  );
}

function standardResultMatches(
  actual: AIStandardResult,
  proposed: NonNullable<SettleAICallAttemptSuccessInput["standardResultBatch"]>["results"][number],
  batchId: string,
  _createdAt: string
): boolean {
  return (
    actual.id === proposed.id &&
    actual.batchId === batchId &&
    actual.ordinal === proposed.ordinal &&
    actual.category === proposed.category &&
    actual.action === proposed.action &&
    actual.targetSnapshotFingerprint === proposed.targetSnapshotFingerprint &&
    equivalent(actual.target, proposed.target) &&
    equivalent(actual.source, proposed.source) &&
    equivalent(actual.originalPayload, proposed.originalPayload)
  );
}

function standardResultBatchMatches(
  readback: AIConversationReadback,
  attempt: AICallAttempt,
  input: SettleAICallAttemptSuccessInput
): boolean {
  const durable = (readback.standardResults ?? [])
    .filter((result) => result.parseCallAttemptId === attempt.id)
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const proposed = input.standardResultBatch;
  if (!proposed) return durable.length === 0;
  const expected = [...proposed.results]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  return durable.length === expected.length && durable.every((actual, index) => (
    standardResultMatches(actual, expected[index], proposed.id, proposed.createdAt)
  ));
}

function successMatches(
  readback: AIConversationReadback,
  attempt: AICallAttempt,
  input: SettleAICallAttemptSuccessInput
): boolean {
  if (
    attempt.status !== "succeeded" ||
    attempt.provider !== input.provider ||
    attempt.model !== input.model ||
    canonicalOptionalScalar(attempt.responseTruncated) !==
      canonicalOptionalScalar(input.responseTruncated) ||
    canonicalOptionalScalar(attempt.usageInputTokens) !==
      canonicalOptionalScalar(input.usage?.inputTokens) ||
    canonicalOptionalScalar(attempt.usageOutputTokens) !==
      canonicalOptionalScalar(input.usage?.outputTokens) ||
    canonicalOptionalScalar(attempt.usageTotalTokens) !==
      canonicalOptionalScalar(input.usage?.totalTokens) ||
    canonicalOptionalScalar(attempt.resultMessageId) !==
      canonicalOptionalScalar(input.assistantMessage?.id)
  ) return false;

  if (input.assistantMessage) {
    const message = (readback.messages ?? []).find(
      (candidate) => candidate.id === input.assistantMessage?.id
    );
    if (
      !message ||
      message.conversationId !== attempt.conversationId ||
      message.role !== "assistant" ||
      message.content !== input.assistantMessage.content
    ) return false;
  }

  return contextRequestMatches(readback, attempt, input) &&
    standardResultBatchMatches(readback, attempt, input);
}

function failureMatches(
  attempt: AICallAttempt,
  input: SettleAICallAttemptFailureInput
): boolean {
  return (
    attempt.status === "failed" &&
    attempt.errorCode === input.errorCode &&
    attempt.errorMessage === input.errorMessage &&
    attempt.errorRetryable === input.errorRetryable &&
    attempt.providerStatus === input.providerStatus
  );
}

function terminalMatches(
  readback: AIConversationReadback,
  settlement: AICallAttemptTerminalSettlement
): boolean {
  const attempt = attemptFromReadback(
    readback,
    settlement.conversationId,
    settlement.input.attemptId
  );
  if (!attempt) return false;
  return settlement.kind === "success"
    ? successMatches(readback, attempt, settlement.input)
    : failureMatches(attempt, settlement.input);
}

async function readAfterUncertainTerminalization(
  repository: AICallAttemptTerminalizationRepository,
  settlement: AICallAttemptTerminalSettlement,
  cause: unknown
): Promise<AIConversationReadback> {
  let readback: AIConversationReadback;
  try {
    readback = await repository.readConversation(settlement.conversationId);
  } catch (readError) {
    throw new AICallAttemptTerminalizationReadbackError(
      settlement.input.attemptId,
      readError ?? cause
    );
  }
  const attempt = attemptFromReadback(
    readback,
    settlement.conversationId,
    settlement.input.attemptId
  );
  if (!attempt || attempt.status === "started") {
    throw new AICallAttemptTerminalizationReadbackError(
      settlement.input.attemptId,
      cause
    );
  }
  if (!terminalMatches(readback, settlement)) {
    throw new AICallAttemptTerminalConflictError(settlement.input.attemptId, readback);
  }
  return readback;
}

/**
 * The sole production CallAttempt terminalization seam. Repository methods own
 * the conditional STARTED -> terminal transaction; this seam owns uncertain
 * write readback, material idempotency, and first-terminal conflict handling.
 */
export async function terminalizeAICallAttempt(
  repository: AICallAttemptTerminalizationRepository,
  settlement: AICallAttemptTerminalSettlement
): Promise<AIConversationReadback> {
  let readback: AIConversationReadback;
  try {
    readback = settlement.kind === "success"
      ? await repository.settleCallAttemptSuccess(settlement.input)
      : await repository.settleCallAttemptFailure(settlement.input);
  } catch (cause) {
    return readAfterUncertainTerminalization(repository, settlement, cause);
  }

  if (!terminalMatches(readback, settlement)) {
    return readAfterUncertainTerminalization(
      repository,
      settlement,
      new Error("The settlement command returned a non-authoritative terminal projection.")
    );
  }
  return readback;
}
