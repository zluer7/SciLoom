import { invoke } from "@tauri-apps/api/core";
import type {
  SharedSaveAsCandidateRuntimeBinding
} from "../types/sharedManuscriptSession";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import { manuscriptSaveAsTargetGuardPort } from "./manuscriptSaveAsTargetGuardPort";

export type CandidateCustodyAuthority =
  | "r3_authority"
  | "shared_recovery"
  | "outputs_adapter"
  | "outputs_lifecycle"
  | "installed_session"
  | "durable_cleanup"
  | "resolved";

export type CandidateCustodyState =
  | "activation_planned"
  | "activated_held"
  | "transfer_pending"
  | "transferred"
  | "close_pending"
  | "residual_unclaimed"
  | "cleanup_claimed"
  | "cleanup_retryable"
  | "cleanup_blocked"
  | "cleanup_resolved"
  | "process_generation_retired";

export interface CandidateCustodyRecord {
  operationId: string;
  revision: number;
  receiptVersion: 1;
  receiptId: string;
  operationGeneration: number;
  processGeneration: string;
  ownerType: string;
  ownerId: string;
  channel: "primary" | "literature_outline" | "dedicated_notes";
  candidateFileRefId: string;
  candidateRole: "save_as_target";
  runtimeHandle?: string;
  runtimeConsumerId: string;
  runtimeGeneration?: number;
  activationAuthority: "r3_authority";
  currentCustodyAuthority: CandidateCustodyAuthority;
  custodyState: CandidateCustodyState;
  cleanupClaimToken?: string;
  initialAutomaticAttemptCount: number;
  explicitCleanupCycleCount: number;
  totalCloseAttemptCount: number;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  finalCloseResult?: string;
  resolvedReason?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface RecoveryCandidateActivationInput {
  operationId: string;
  receiptId: string;
  expectedCustodyRevision: number;
  ownerType: string;
  ownerId: string;
  channel: "primary" | "literature_outline" | "dedicated_notes";
  candidateFileRefId: string;
  expectedRuntimeHandle?: string;
  expectedRuntimeConsumerId: string;
  expectedRuntimeGeneration?: number;
  runtimeHandle: string;
  runtimeConsumerId: string;
  runtimeGeneration: number;
}

function runtimeBinding(
  record: CandidateCustodyRecord
): SharedSaveAsCandidateRuntimeBinding | undefined {
  if (!record.runtimeHandle || record.runtimeGeneration === undefined) {
    return undefined;
  }
  return {
    receiptId: record.receiptId,
    operationId: record.operationId,
    processGeneration: record.processGeneration,
    owner: {
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      channel: record.channel
    },
    candidateFileRefId: record.candidateFileRefId,
    runtimeHandle: record.runtimeHandle,
    runtimeConsumerId: record.runtimeConsumerId,
    runtimeGeneration: record.runtimeGeneration
  };
}

export const manuscriptSaveAsCandidateCustodyPort = Object.freeze({
  plan(input: {
    operationId: string;
    expectedOperationRevision: number;
    candidateFileRefId: string;
    runtimeConsumerId: string;
  }) {
    return invoke<CandidateCustodyRecord>(
      "plan_save_as_candidate_custody",
      { input }
    );
  },
  readback(operationId: string) {
    return invoke<CandidateCustodyRecord | null>(
      "readback_save_as_candidate_custody",
      { operationId }
    );
  },
  recordActivation(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    runtimeHandle: string;
    runtimeGeneration: number;
  }) {
    return invoke<CandidateCustodyRecord>(
      "record_save_as_candidate_activation",
      { input }
    );
  },
  recordRecoveryActivation(input: RecoveryCandidateActivationInput) {
    return invoke<CandidateCustodyRecord>(
      "record_save_as_candidate_recovery_activation",
      { input }
    );
  },
  transfer(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    nextAuthority: Exclude<
      CandidateCustodyAuthority,
      "r3_authority" | "resolved"
    >;
  }) {
    return invoke<CandidateCustodyRecord>(
      "transfer_save_as_candidate_custody",
      { input }
    );
  },
  claimCleanup(input: {
    operationId: string;
    expectedCustodyRevision: number;
  }) {
    return invoke<CandidateCustodyRecord>(
      "claim_save_as_candidate_cleanup",
      { input }
    );
  },
  recordCleanup(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    cleanupClaimToken?: string;
    cycle: "automatic" | "explicit";
    result:
      | "closed"
      | "already_absent"
      | "not_activated"
      | "retryable_failure"
      | "cleanup_blocked"
      | "process_generation_retired";
    errorCode?: string;
  }) {
    return invoke<CandidateCustodyRecord>(
      "record_save_as_candidate_cleanup",
      { input }
    );
  }
});

export type CandidateDisposition =
  | { kind: "NOT_ACTIVATED" }
  | { kind: "TRANSFERRED"; receiptId: string }
  | { kind: "CLOSED"; receiptId: string }
  | { kind: "CLOSED"; receiptId: string; reason: "PROCESS_GENERATION_RETIRED" }
  | {
      kind: "RESIDUAL";
      receiptId: string;
      operationId: string;
      cleanupState: "cleanup_retryable" | "cleanup_blocked";
    };

export function createManuscriptSaveAsCandidateCleanupCoordinator(
  dependencies: {
    custody: Pick<
      typeof manuscriptSaveAsCandidateCustodyPort,
      "readback" | "claimCleanup" | "recordCleanup"
    >;
    runtime: Pick<
      typeof sharedManuscriptSessionRuntime,
      "readSaveAsCandidateBinding" | "closeSaveAsCandidate"
    >;
    processLifecycle: Pick<
      typeof manuscriptSaveAsTargetGuardPort,
      "observeCurrentProcessGeneration"
    >;
  } = {
    custody: manuscriptSaveAsCandidateCustodyPort,
    runtime: sharedManuscriptSessionRuntime,
    processLifecycle: manuscriptSaveAsTargetGuardPort
  }
) {
  async function persistCleanup(
    record: CandidateCustodyRecord,
    input: Parameters<
      typeof manuscriptSaveAsCandidateCustodyPort.recordCleanup
    >[0]
  ) {
    try {
      return await dependencies.custody.recordCleanup(input);
    } catch (cause) {
      const readback = await dependencies.custody.readback(
        record.operationId
      );
      if (
        readback?.receiptId === record.receiptId &&
        readback.revision > record.revision
      ) {
        return readback;
      }
      throw cause;
    }
  }

  async function oneAttempt(
    record: CandidateCustodyRecord,
    cycle: "automatic" | "explicit",
    finalAutomaticAttempt = false
  ) {
    const currentProcess =
      await dependencies.processLifecycle.observeCurrentProcessGeneration();
    if (currentProcess.processGeneration !== record.processGeneration) {
      return persistCleanup(record, {
        operationId: record.operationId,
        expectedCustodyRevision: record.revision,
        receiptId: record.receiptId,
        cleanupClaimToken: record.cleanupClaimToken,
        cycle,
        result: "process_generation_retired"
      });
    }
    const binding =
      runtimeBinding(record) ??
      dependencies.runtime.readSaveAsCandidateBinding(record.receiptId);
    if (!binding) {
      return persistCleanup(record, {
        operationId: record.operationId,
        expectedCustodyRevision: record.revision,
        receiptId: record.receiptId,
        cleanupClaimToken: record.cleanupClaimToken,
        cycle,
        result: "cleanup_blocked",
        errorCode: "SAVE_AS_CUSTODY_RUNTIME_BINDING_MISSING"
      });
    }
    const result = await dependencies.runtime.closeSaveAsCandidate(binding);
    return persistCleanup(record, {
      operationId: record.operationId,
      expectedCustodyRevision: record.revision,
      receiptId: record.receiptId,
      cleanupClaimToken: record.cleanupClaimToken,
      cycle,
      result:
        result.status === "closed"
          ? "closed"
          : result.status === "already-absent"
            ? "already_absent"
            : result.status === "retryable-failure"
            ? finalAutomaticAttempt
              ? "cleanup_blocked"
              : "retryable_failure"
              : "cleanup_blocked",
      errorCode:
        "errorCode" in result ? result.errorCode : undefined
    });
  }

  return Object.freeze({
    async automatic(operationId: string): Promise<CandidateDisposition> {
      let record = await dependencies.custody.readback(operationId);
      if (!record) return { kind: "NOT_ACTIVATED" };
      if (
        record.custodyState === "activation_planned" &&
        !dependencies.runtime.readSaveAsCandidateBinding(record.receiptId)
      ) {
        const currentProcess =
          await dependencies.processLifecycle.observeCurrentProcessGeneration();
        if (currentProcess.processGeneration === record.processGeneration) {
          try {
            await persistCleanup(record, {
              operationId: record.operationId,
              expectedCustodyRevision: record.revision,
              receiptId: record.receiptId,
              cycle: "automatic",
              result: "not_activated"
            });
          } catch {
            return {
              kind: "RESIDUAL",
              receiptId: record.receiptId,
              operationId: record.operationId,
              cleanupState: "cleanup_blocked"
            };
          }
          return { kind: "NOT_ACTIVATED" };
        }
      }
      for (
        let attempt = record.initialAutomaticAttemptCount;
        attempt < 2;
        attempt += 1
      ) {
        try {
          record = await oneAttempt(
            record,
            "automatic",
            attempt === 1
          );
        } catch {
          return {
            kind: "RESIDUAL",
            receiptId: record.receiptId,
            operationId: record.operationId,
            cleanupState: "cleanup_blocked"
          };
        }
        if (
          record.custodyState === "cleanup_resolved" ||
          record.custodyState === "process_generation_retired"
        ) {
          return record.custodyState === "process_generation_retired"
            ? {
                kind: "CLOSED",
                receiptId: record.receiptId,
                reason: "PROCESS_GENERATION_RETIRED"
              }
            : { kind: "CLOSED", receiptId: record.receiptId };
        }
        if (record.custodyState !== "cleanup_retryable") break;
      }
      return {
        kind: "RESIDUAL",
        receiptId: record.receiptId,
        operationId: record.operationId,
        cleanupState:
          record.custodyState === "cleanup_retryable"
            ? "cleanup_retryable"
            : "cleanup_blocked"
      };
    },
    async explicit(input: {
      operationId: string;
      expectedRevision: number;
    }): Promise<CandidateDisposition> {
      let claimed: CandidateCustodyRecord;
      try {
        claimed = await dependencies.custody.claimCleanup({
          operationId: input.operationId,
          expectedCustodyRevision: input.expectedRevision
        });
      } catch (cause) {
        const readback = await dependencies.custody.readback(
          input.operationId
        );
        if (
          !readback ||
          readback.revision <= input.expectedRevision ||
          readback.custodyState !== "cleanup_claimed" ||
          !readback.cleanupClaimToken
        ) {
          throw cause;
        }
        claimed = readback;
      }
      let record: CandidateCustodyRecord;
      try {
        record = await oneAttempt(claimed, "explicit");
      } catch {
        return {
          kind: "RESIDUAL",
          receiptId: claimed.receiptId,
          operationId: claimed.operationId,
          cleanupState: "cleanup_blocked"
        };
      }
      return record.custodyState === "cleanup_resolved"
        ? { kind: "CLOSED", receiptId: record.receiptId }
        : {
            kind: "RESIDUAL",
            receiptId: record.receiptId,
            operationId: record.operationId,
            cleanupState:
              record.custodyState === "cleanup_retryable"
                ? "cleanup_retryable"
                : "cleanup_blocked"
          };
    }
  });
}

export const manuscriptSaveAsCandidateCleanupCoordinator =
  createManuscriptSaveAsCandidateCleanupCoordinator();
