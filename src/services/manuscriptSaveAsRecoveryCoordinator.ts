import type {
  SaveAsD1Proof,
  SaveAsFailureCode,
  SaveAsOperationStage
} from "../types/manuscriptSaveAs";
import { manuscriptSaveAsHandoffPort } from "./manuscriptSaveAsHandoffPort";
import {
  manuscriptSaveAsOperationPort,
  saveAsOperationExpectation,
  type SaveAsOperationTransitionInput,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import { manuscriptSaveAsTargetGuardPort } from "./manuscriptSaveAsTargetGuardPort";
import type { SharedSaveAsCoreOutcome } from "./manuscriptSaveAsD2Adapter";

export interface SaveAsRecoveryWitness {
  operationId: string;
  operationGeneration: number;
  revision: number;
  stage: SaveAsOperationStage;
  observationGeneration: number;
  updatedAt: string;
}

export type SaveAsRecoveryObservation =
  | {
      status: "first_observation";
      witness: SaveAsRecoveryWitness;
      record: SaveAsOperationRecord;
    }
  | {
      status: "claimed";
      witness: SaveAsRecoveryWitness;
      record: SaveAsOperationRecord;
      claimMode: "j0_observation_claim" | "stable_confirmed_continuation";
    };

export interface SaveAsD1PhysicalObservation {
  state: "absent" | "partial" | "exact" | "mismatch" | "unavailable";
  proof?: SaveAsD1Proof;
  readbackRevision?: string;
}

interface OperationAuthority {
  readback(operationId: string): Promise<SaveAsOperationRecord | null>;
  transition(input: SaveAsOperationTransitionInput): Promise<SaveAsOperationRecord>;
  claimObservation(input: {
    operationId: string;
    expected: ReturnType<typeof saveAsOperationExpectation>;
    observationGeneration: number;
  }): Promise<SaveAsOperationRecord>;
  containUnknownD2(input: {
    operationId: string;
    expected: ReturnType<typeof saveAsOperationExpectation>;
    actionId: string;
  }): Promise<{ operation: SaveAsOperationRecord }>;
}

export interface SaveAsRecoveryContinuations {
  inspectD1(record: SaveAsOperationRecord): Promise<SaveAsD1PhysicalObservation>;
  continueD2(
    record: SaveAsOperationRecord
  ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>>;
  continueR3(
    record: SaveAsOperationRecord
  ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>>;
  continueP4(
    record: SaveAsOperationRecord
  ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>>;
}

function failed(
  record: SaveAsOperationRecord | null,
  code: SaveAsFailureCode,
  writeApplied: false | true | "unknown" = false
): SharedSaveAsCoreOutcome<never> {
  return {
    ok: false,
    failure: {
      code,
      stage: record?.stage ?? "reconciliation_blocked",
      continuation:
        code === "SAVE_AS_OPERATION_STALE"
          ? "await_recovery"
          : "hard_block",
      writeApplied
    },
    internalReason:
      code === "SAVE_AS_J0_CAS_CONFLICT"
        ? "j0_cas_conflict"
        : code === "SAVE_AS_OPERATION_STALE"
          ? "two_observation_required"
          : "proof_mismatch"
  };
}

function sameWitness(
  witness: SaveAsRecoveryWitness,
  record: SaveAsOperationRecord,
  observationGeneration: number
) {
  return (
    witness.operationId === record.operationId &&
    witness.operationGeneration === record.operationGeneration &&
    witness.revision === record.revision &&
    witness.stage === record.stage &&
    witness.updatedAt === record.updatedAt &&
    witness.observationGeneration < observationGeneration
  );
}

function witness(
  record: SaveAsOperationRecord,
  observationGeneration: number
): SaveAsRecoveryWitness {
  return {
    operationId: record.operationId,
    operationGeneration: record.operationGeneration,
    revision: record.revision,
    stage: record.stage,
    observationGeneration,
    updatedAt: record.updatedAt
  };
}

export function createManuscriptSaveAsRecoveryCoordinator(dependencies: {
  operations: OperationAuthority;
  continuations: SaveAsRecoveryContinuations;
  releaseGuard?: (proof: string) => Promise<unknown>;
  invalidateHandoff?: (singleUseToken: string) => boolean;
}) {
  return Object.freeze({
    async observe(
      input: {
        operationId: string;
        operationGeneration: number;
        observationGeneration: number;
        previous?: SaveAsRecoveryWitness;
      }
    ): Promise<SharedSaveAsCoreOutcome<SaveAsRecoveryObservation>> {
      const record = await dependencies.operations.readback(input.operationId);
      if (
        !record ||
        record.operationGeneration !== input.operationGeneration ||
        input.observationGeneration <= 0
      ) {
        return failed(record, "SAVE_AS_OPERATION_STALE");
      }
      const nextWitness = witness(record, input.observationGeneration);
      if (!input.previous) {
        return {
          ok: true,
          continuation: "close",
          value: {
            status: "first_observation",
            witness: nextWitness,
            record
          }
        };
      }
      if (
        !sameWitness(input.previous, record, input.observationGeneration)
      ) {
        return failed(record, "SAVE_AS_OPERATION_STALE");
      }
      if (
        record.reconciliationState === "pending" ||
        record.reconciliationState === "claimed"
      ) {
        try {
          const claimed = await dependencies.operations.claimObservation({
            operationId: record.operationId,
            expected: saveAsOperationExpectation(record),
            observationGeneration: input.observationGeneration
          });
          return {
            ok: true,
            continuation: "close",
            value: {
              status: "claimed",
              witness: witness(claimed, input.observationGeneration),
              record: claimed,
              claimMode: "j0_observation_claim"
            }
          };
        } catch {
          return failed(record, "SAVE_AS_J0_CLAIM_CONFLICT");
        }
      }
      return {
        ok: true,
        continuation: "close",
        value: {
          status: "claimed",
          witness: nextWitness,
          record,
          claimMode: "stable_confirmed_continuation"
        }
      };
    },

    async reconcile(
      observation: Extract<SaveAsRecoveryObservation, { status: "claimed" }>
    ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
      const authoritative = await dependencies.operations.readback(
        observation.record.operationId
      );
      if (
        !authoritative ||
        authoritative.revision !== observation.record.revision ||
        authoritative.stage !== observation.record.stage
      ) {
        return failed(authoritative, "SAVE_AS_OPERATION_STALE");
      }
      switch (authoritative.stage) {
        case "pre_d1_claimed": {
          try {
            const closed = await dependencies.operations.transition({
              operationId: authoritative.operationId,
              expected: saveAsOperationExpectation(authoritative),
              mutation: {
                intent: "close_pre_d1",
                blockingCode: "SAVE_AS_CANCELLED_PRE_D1"
              }
            });
            return { ok: true, continuation: "close", value: closed };
          } catch {
            return failed(authoritative, "SAVE_AS_J0_CAS_CONFLICT");
          }
        }
        case "d1_commit_unknown": {
          const physical =
            await dependencies.continuations.inspectD1(authoritative);
          if (physical.state !== "exact" || !physical.proof) {
            if (physical.state === "absent") {
              return failed(
                authoritative,
                "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN",
                "unknown"
              );
            }
            try {
              await dependencies.operations.transition({
                operationId: authoritative.operationId,
                expected: saveAsOperationExpectation(authoritative),
                mutation: {
                  intent: "block_reconciliation",
                  blockingCode: "SAVE_AS_D1_READBACK_MISMATCH"
                }
              });
            } catch {
              return failed(authoritative, "SAVE_AS_J0_CAS_CONFLICT");
            }
            return failed(
              authoritative,
              "SAVE_AS_D1_READBACK_MISMATCH",
              "unknown"
            );
          }
          if (!physical.readbackRevision) {
            return failed(
              authoritative,
              "SAVE_AS_D1_READBACK_MISMATCH",
              "unknown"
            );
          }
          try {
            const confirmed = await dependencies.operations.transition({
              operationId: authoritative.operationId,
              expected: saveAsOperationExpectation(authoritative),
              mutation: {
                intent: "confirm_d1",
                d1PhysicalIdentityHash:
                  physical.proof.physicalTargetIdentityHash,
                d1ReadbackSha256: physical.proof.d1ReadbackSha256,
                d1ReadbackRevision: physical.readbackRevision,
                d1ByteLength: physical.proof.byteLength,
                d1ProofGeneration: physical.proof.proofGeneration
              }
            });
            return dependencies.continuations.continueD2(confirmed);
          } catch {
            return failed(authoritative, "SAVE_AS_J0_CAS_CONFLICT");
          }
        }
        case "d1_confirmed":
          return dependencies.continuations.continueD2(authoritative);
        case "d2_commit_unknown": {
          try {
            const contained = await dependencies.operations.containUnknownD2({
              operationId: authoritative.operationId,
              expected: saveAsOperationExpectation(authoritative),
              actionId: `contain:${authoritative.operationId}:${authoritative.revision}:${observation.witness.observationGeneration}`
            });
            return {
              ok: true,
              continuation: "close",
              value: contained.operation
            };
          } catch {
            return failed(authoritative, "SAVE_AS_J0_CAS_CONFLICT");
          }
        }
        case "d2_confirmed":
        case "r3_activation_pending":
          return dependencies.continuations.continueR3(authoritative);
        case "p4_presentation_pending":
          return dependencies.continuations.continueP4(authoritative);
        case "completed":
        case "finalization_compensated":
        case "pre_d1_closed":
        case "reconciliation_blocked":
        case "d2_reconciliation_contained":
        case "d2_reconciliation_conflict":
        case "d2_reconciled_terminal":
          return { ok: true, continuation: "close", value: authoritative };
      }
    },

    async cleanup(input: {
      operationId: string;
      operationGeneration: number;
      guardProof?: string;
      handoffToken?: string;
    }) {
      const record = await dependencies.operations.readback(input.operationId);
      if (
        !record ||
        record.operationGeneration !== input.operationGeneration
      ) {
        return {
          status: "stale" as const,
          guard: "not_touched" as const,
          handoff: "not_touched" as const,
          j0: "not_touched" as const,
          physicalTarget: "retained" as const,
          fileRef: "retained" as const
        };
      }
      let guard: "released" | "not_present" | "release_unknown" =
        "not_present";
      if (input.guardProof && dependencies.releaseGuard) {
        try {
          await dependencies.releaseGuard(input.guardProof);
          guard = "released";
        } catch {
          guard = "release_unknown";
        }
      }
      const handoff =
        input.handoffToken && dependencies.invalidateHandoff
          ? dependencies.invalidateHandoff(input.handoffToken)
            ? "invalidated"
            : "already_absent"
          : "not_present";
      let j0: "terminalized" | "retained" | "terminalize_unknown" =
        "retained";
      if (
        record.stage === "pre_d1_claimed" &&
        record.d1CommitState === "not_started"
      ) {
        try {
          await dependencies.operations.transition({
            operationId: record.operationId,
            expected: saveAsOperationExpectation(record),
            mutation: {
              intent: "close_pre_d1",
              blockingCode: "SAVE_AS_CANCELLED_PRE_D1"
            }
          });
          j0 = "terminalized";
        } catch {
          j0 = "terminalize_unknown";
        }
      }
      return {
        status: "completed" as const,
        guard,
        handoff,
        j0,
        physicalTarget: "retained" as const,
        fileRef: "retained" as const
      };
    }
  });
}

const unmountedContinuations: SaveAsRecoveryContinuations = {
  async inspectD1() {
    return { state: "unavailable" };
  },
  async continueD2(record) {
    return failed(record, "SAVE_AS_OPERATION_STALE");
  },
  async continueR3(record) {
    return failed(record, "SAVE_AS_OPERATION_STALE");
  },
  async continueP4(record) {
    return failed(record, "SAVE_AS_OPERATION_STALE");
  }
};

export const manuscriptSaveAsRecoveryCoordinator =
  createManuscriptSaveAsRecoveryCoordinator({
    operations: manuscriptSaveAsOperationPort,
    continuations: unmountedContinuations,
    releaseGuard: (proof) =>
      manuscriptSaveAsTargetGuardPort.release(proof),
    invalidateHandoff: (token) =>
      manuscriptSaveAsHandoffPort.invalidateSaveAsHandoff(token)
  });
