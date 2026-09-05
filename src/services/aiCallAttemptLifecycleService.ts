import { aiConversationRepository } from "../repositories/aiConversationRepository";
import type {
  AICallAttempt,
  AIConversationReadback
} from "../types";
import {
  AICallAttemptTerminalConflictError,
  terminalizeAICallAttempt,
  type AICallAttemptTerminalizationRepository
} from "./aiCallAttemptTerminalizationService";
import { manuscriptSaveAsTargetGuardPort } from "./manuscriptSaveAsTargetGuardPort";

export const AI_CALL_ATTEMPT_EXECUTION_ORPHANED =
  "call_attempt_execution_orphaned" as const;
export const AI_CALL_ATTEMPT_LIFECYCLE_STORAGE_KEY =
  "labpod.ai.call-attempt-lifecycle.completed-process-generation.v1";

const ORPHAN_MESSAGE =
  "The prior application runtime ended before this AI execution reached durable terminal settlement. The Provider outcome is unknown; the system did not retry or create a business effect.";

type LifecycleStorage = Pick<Storage, "getItem" | "setItem">;

export type AICallAttemptLifecycleRepository = Pick<
  typeof aiConversationRepository,
  "listConversations" | "readConversation"
> & AICallAttemptTerminalizationRepository;

export interface AICallAttemptLifecycleDependencies {
  repository: AICallAttemptLifecycleRepository;
  observeProcessGeneration: () => Promise<{ processGeneration: string }>;
  storage: LifecycleStorage;
  now: () => string;
}

export interface AIStartedAttemptSnapshotMember {
  conversationId: string;
  attempt: AICallAttempt;
  preRecoveryStandardResultCount: number;
}

export interface AICallAttemptLifecycleSummary {
  status: "RECONCILED_PREVIOUS_RUNTIME" | "ALREADY_RECONCILED_CURRENT_RUNTIME";
  processGeneration: string;
  priorCompletedProcessGeneration?: string;
  frozenAt: string;
  completedAt: string;
  snapshotAttemptIds: string[];
  eligibleAttemptIds: string[];
  ineligibleAttemptIds: string[];
  orphanTerminalizedAttemptIds: string[];
  firstTerminalRaceAttemptIds: string[];
  recoveredStandardResultCount: 0;
  recoveredCandidateCount: 0;
  recoveredFormalEffectCount: 0;
  recoveredProviderRetryCount: 0;
  recoveredProviderReplayCount: 0;
  recoveredAssistantCompletedMessageFabricationCount: 0;
}

type StoredLifecycleMarker = {
  processGeneration: string;
  completedAt: string;
};

function parseMarker(value: string | null): StoredLifecycleMarker | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredLifecycleMarker>;
    if (
      typeof parsed.processGeneration === "string" &&
      parsed.processGeneration.trim() &&
      typeof parsed.completedAt === "string" &&
      parsed.completedAt.trim()
    ) {
      return {
        processGeneration: parsed.processGeneration,
        completedAt: parsed.completedAt
      };
    }
  } catch {
    // A malformed advisory marker cannot create terminal truth. The startup
    // snapshot and durable CAS remain the only mutation authorities.
  }
  return undefined;
}

function isEligiblePreviousRuntimeMember(
  member: AIStartedAttemptSnapshotMember
): boolean {
  const attempt = member.attempt;
  return (
    attempt.status === "started" &&
    Boolean(attempt.id.trim()) &&
    Boolean(attempt.requestId.trim()) &&
    attempt.conversationId === member.conversationId &&
    Boolean(attempt.startedAt.trim()) &&
    Boolean(attempt.provider.trim()) &&
    Boolean(attempt.model.trim()) &&
    member.preRecoveryStandardResultCount === 0 &&
    !attempt.resultMessageId &&
    !attempt.settledAt
  );
}

async function freezeStartedSnapshot(
  repository: AICallAttemptLifecycleRepository
): Promise<AIStartedAttemptSnapshotMember[]> {
  const conversations = await repository.listConversations();
  const readbacks = await Promise.all(
    conversations.map((conversation) => repository.readConversation(conversation.id))
  );
  const byAttemptId = new Map<string, AIStartedAttemptSnapshotMember>();
  for (const readback of readbacks) {
    if (!readback.conversation?.id) {
      throw new Error("AI_CALL_ATTEMPT_STARTUP_SNAPSHOT_READBACK_INVALID");
    }
    for (const attempt of readback.callAttempts ?? []) {
      if (attempt.status !== "started") continue;
      if (byAttemptId.has(attempt.id)) {
        throw new Error("AI_CALL_ATTEMPT_STARTUP_SNAPSHOT_IDENTITY_CONFLICT");
      }
      byAttemptId.set(attempt.id, {
        conversationId: readback.conversation.id,
        attempt: {
          ...attempt,
          contextSourceRefs: [...(attempt.contextSourceRefs ?? [])],
          warnings: [...(attempt.warnings ?? [])],
          authorizedFileRefs: [...(attempt.authorizedFileRefs ?? [])]
        },
        preRecoveryStandardResultCount: (readback.standardResults ?? [])
          .filter((result) => result.parseCallAttemptId === attempt.id)
          .length
      });
    }
  }
  return [...byAttemptId.values()].sort((left, right) => (
    left.attempt.startedAt.localeCompare(right.attempt.startedAt) ||
    left.attempt.id.localeCompare(right.attempt.id)
  ));
}

function readAttempt(
  readback: AIConversationReadback,
  member: AIStartedAttemptSnapshotMember
): AICallAttempt | undefined {
  if (readback.conversation?.id !== member.conversationId) return undefined;
  return (readback.callAttempts ?? []).find((attempt) => (
    attempt.id === member.attempt.id &&
    attempt.requestId === member.attempt.requestId &&
    attempt.conversationId === member.conversationId
  ));
}

function assertRecoveryCreatedNoEffect(
  readback: AIConversationReadback,
  member: AIStartedAttemptSnapshotMember
) {
  const attempt = readAttempt(readback, member);
  if (!attempt || attempt.status === "started") {
    throw new Error("AI_CALL_ATTEMPT_ORPHAN_READBACK_NOT_TERMINAL");
  }
  if (
    attempt.status === "failed" &&
    attempt.errorCode === AI_CALL_ATTEMPT_EXECUTION_ORPHANED
  ) {
    if (
      attempt.resultMessageId ||
      (readback.standardResults ?? []).some(
        (result) => result.parseCallAttemptId === attempt.id
      )
    ) {
      throw new Error("AI_CALL_ATTEMPT_ORPHAN_RECOVERY_CREATED_EFFECT");
    }
  }
}

export function createAICallAttemptLifecycleController(
  dependencies: AICallAttemptLifecycleDependencies
) {
  let admission: Promise<AICallAttemptLifecycleSummary> | undefined;
  let summary: AICallAttemptLifecycleSummary | undefined;
  let failure: unknown;

  async function reconcile(): Promise<AICallAttemptLifecycleSummary> {
    const observed = await dependencies.observeProcessGeneration();
    const processGeneration = observed.processGeneration.trim();
    if (!processGeneration) {
      throw new Error("AI_CALL_ATTEMPT_PROCESS_GENERATION_UNAVAILABLE");
    }
    const marker = parseMarker(
      dependencies.storage.getItem(AI_CALL_ATTEMPT_LIFECYCLE_STORAGE_KEY)
    );
    const frozenAt = dependencies.now();
    if (marker?.processGeneration === processGeneration) {
      return {
        status: "ALREADY_RECONCILED_CURRENT_RUNTIME",
        processGeneration,
        priorCompletedProcessGeneration: marker.processGeneration,
        frozenAt,
        completedAt: marker.completedAt,
        snapshotAttemptIds: [],
        eligibleAttemptIds: [],
        ineligibleAttemptIds: [],
        orphanTerminalizedAttemptIds: [],
        firstTerminalRaceAttemptIds: [],
        recoveredStandardResultCount: 0,
        recoveredCandidateCount: 0,
        recoveredFormalEffectCount: 0,
        recoveredProviderRetryCount: 0,
        recoveredProviderReplayCount: 0,
        recoveredAssistantCompletedMessageFabricationCount: 0
      };
    }

    // The process generation changes only with a Tauri runtime restart. The
    // caller must establish current runtime exclusivity before invoking prime;
    // no age/timeout inference is used for snapshot eligibility.
    const snapshot = await freezeStartedSnapshot(dependencies.repository);
    const eligible = snapshot.filter(isEligiblePreviousRuntimeMember);
    const ineligible = snapshot.filter((member) => !isEligiblePreviousRuntimeMember(member));
    const orphanTerminalizedAttemptIds: string[] = [];
    const firstTerminalRaceAttemptIds: string[] = [];

    for (const member of eligible) {
      let readback: AIConversationReadback;
      try {
        readback = await terminalizeAICallAttempt(dependencies.repository, {
          kind: "failure",
          conversationId: member.conversationId,
          input: {
            attemptId: member.attempt.id,
            errorCode: AI_CALL_ATTEMPT_EXECUTION_ORPHANED,
            errorMessage: ORPHAN_MESSAGE,
            errorRetryable: true,
            settledAt: dependencies.now()
          }
        });
        orphanTerminalizedAttemptIds.push(member.attempt.id);
      } catch (error) {
        if (!(error instanceof AICallAttemptTerminalConflictError)) throw error;
        readback = error.readback;
        firstTerminalRaceAttemptIds.push(member.attempt.id);
      }
      assertRecoveryCreatedNoEffect(readback, member);
    }

    const completedAt = dependencies.now();
    const completed: AICallAttemptLifecycleSummary = {
      status: "RECONCILED_PREVIOUS_RUNTIME",
      processGeneration,
      ...(marker?.processGeneration
        ? { priorCompletedProcessGeneration: marker.processGeneration }
        : {}),
      frozenAt,
      completedAt,
      snapshotAttemptIds: snapshot.map((member) => member.attempt.id),
      eligibleAttemptIds: eligible.map((member) => member.attempt.id),
      ineligibleAttemptIds: ineligible.map((member) => member.attempt.id),
      orphanTerminalizedAttemptIds,
      firstTerminalRaceAttemptIds,
      recoveredStandardResultCount: 0,
      recoveredCandidateCount: 0,
      recoveredFormalEffectCount: 0,
      recoveredProviderRetryCount: 0,
      recoveredProviderReplayCount: 0,
      recoveredAssistantCompletedMessageFabricationCount: 0
    };
    dependencies.storage.setItem(
      AI_CALL_ATTEMPT_LIFECYCLE_STORAGE_KEY,
      JSON.stringify({ processGeneration, completedAt } satisfies StoredLifecycleMarker)
    );
    return completed;
  }

  return Object.freeze({
    prime(): Promise<AICallAttemptLifecycleSummary> {
      if (!admission) {
        admission = reconcile().then(
          (value) => {
            summary = value;
            return value;
          },
          (error) => {
            failure = error;
            throw error;
          }
        );
      }
      return admission;
    },
    async awaitProviderAdmission(): Promise<void> {
      await this.prime();
    },
    getSummary() {
      return summary;
    },
    getFailure() {
      return failure;
    },
    isProviderAdmissionReady() {
      return Boolean(summary) && !failure;
    }
  });
}

type TrackedExecution = {
  completion: Promise<unknown>;
};

type GlobalAILifecycleState = {
  controller?: ReturnType<typeof createAICallAttemptLifecycleController>;
  activeExecutions: Map<string, TrackedExecution>;
};

const globalLifecycleKey = "__LABPOD_AI_CALL_ATTEMPT_LIFECYCLE_V1__";
const globalScope = globalThis as typeof globalThis & {
  [globalLifecycleKey]?: GlobalAILifecycleState;
};
const globalState = globalScope[globalLifecycleKey] ??= {
  activeExecutions: new Map<string, TrackedExecution>()
};

function productionController() {
  if (!globalState.controller) {
    globalState.controller = createAICallAttemptLifecycleController({
      repository: aiConversationRepository,
      observeProcessGeneration: () =>
        manuscriptSaveAsTargetGuardPort.observeCurrentProcessGeneration(),
      storage: window.localStorage,
      now: () => new Date().toISOString()
    });
  }
  return globalState.controller;
}

export function primeAICallAttemptLifecycle() {
  if (typeof window === "undefined") {
    throw new Error("AI_CALL_ATTEMPT_LIFECYCLE_REQUIRES_BROWSER_RUNTIME");
  }
  return productionController().prime();
}

export async function awaitAIProviderAdmission(): Promise<void> {
  if (typeof window === "undefined") return;
  await productionController().awaitProviderAdmission();
}

export function assertAIProviderAdmissionReady(): void {
  if (typeof window === "undefined") return;
  if (!productionController().isProviderAdmissionReady()) {
    throw new Error("AI_PROVIDER_ADMISSION_BLOCKED_PENDING_CALL_ATTEMPT_RECONCILIATION");
  }
}

export function getAICallAttemptLifecycleSummary() {
  return productionController().getSummary();
}

export function trackAIProviderExecution(
  executionId: string,
  completion: Promise<unknown>
): () => void {
  const tracked: TrackedExecution = { completion };
  globalState.activeExecutions.set(executionId, tracked);
  const release = () => {
    if (globalState.activeExecutions.get(executionId) === tracked) {
      globalState.activeExecutions.delete(executionId);
    }
  };
  void completion.then(release, release);
  return release;
}

export function hasActiveAIProviderExecution(): boolean {
  return globalState.activeExecutions.size > 0;
}

/** Waits for existing canonical execution owners; it never cancels or settles them. */
export async function waitForActiveAIProviderExecutions(): Promise<void> {
  while (globalState.activeExecutions.size > 0) {
    const active = [...globalState.activeExecutions.values()]
      .map((entry) => entry.completion);
    await Promise.allSettled(active);
  }
}
