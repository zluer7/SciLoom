import type { FileRef, FileRefLocationMode, FileRefOwnerType } from "../types/experiment";
import type {
  SaveAsClaimIdentity,
  SaveAsFailure,
  SaveAsFailureCode,
  SaveAsOperationStage
} from "../types/manuscriptSaveAs";
import type { CandidateDisposition } from "./manuscriptSaveAsCandidateCustody";
import {
  manuscriptSaveAsOperationPort,
  saveAsOperationExpectation,
  type SaveAsD2AuthorityResult,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";

export type SaveAsCoreInternalReason =
  | "handoff_unavailable"
  | "proof_mismatch"
  | "already_consumed"
  | "stale_operation"
  | "d2_effect_unknown"
  | "d2_identity_collision"
  | "d2_readback_mismatch"
  | "j0_cas_conflict"
  | "runtime_activation_failed"
  | "presentation_consumer_unavailable"
  | "presentation_response_unknown"
  | "two_observation_required";

export type SharedSaveAsCoreOutcome<T> =
  | { ok: true; value: T; continuation: "close" }
  | {
      ok: false;
      failure: SaveAsFailure;
      internalReason: SaveAsCoreInternalReason;
      candidateDisposition?: CandidateDisposition;
    };

export interface SaveAsD2Input {
  operationId: string;
  operationGeneration: number;
  j0Revision: number;
  claimIdentity: SaveAsClaimIdentity;
  ownerType: FileRefOwnerType;
  ownerId: string;
  channel: "primary" | "literature_outline" | "dedicated_notes";
  locationMode: FileRefLocationMode;
  targetDisplayPath: string;
  targetPathIdentityKey: string;
  d1PhysicalIdentityHash: string;
  d1ReadbackSha256: string;
  d1ByteLength: number;
  encodingContractVersion: string;
  newlineContractVersion: string;
}

export interface SaveAsD2Result {
  fileRef: FileRef;
  operation: SaveAsOperationRecord;
  state: "created" | "reused" | "reconciled";
}

export interface SaveAsD2OperationAuthority {
  readback(operationId: string): Promise<SaveAsOperationRecord | null>;
  atomicCommitD2(input: {
    operationId: string;
    expected: ReturnType<typeof saveAsOperationExpectation>;
  }): Promise<SaveAsD2AuthorityResult>;
}

function failure(
  code: SaveAsFailureCode,
  stage: SaveAsOperationStage,
  internalReason: SaveAsCoreInternalReason,
  writeApplied: SaveAsFailure["writeApplied"] = false
): SharedSaveAsCoreOutcome<never> {
  const continuation =
    internalReason === "d2_effect_unknown"
      ? "readback_reconcile"
      : internalReason === "j0_cas_conflict" ||
          internalReason === "stale_operation"
        ? "await_recovery"
        : "hard_block";
  return {
    ok: false,
    failure: { code, stage, continuation, writeApplied },
    internalReason
  };
}

function sameClaim(
  record: SaveAsOperationRecord,
  claim: SaveAsClaimIdentity
) {
  return (
    record.claimToken === claim.claimToken &&
    record.claimRevision === claim.claimRevision &&
    record.claimProcessGeneration === claim.claimProcessGeneration &&
    (record.observationGeneration ?? 0) === claim.observationGeneration &&
    (record.observationRevision ?? 0) === claim.observationRevision
  );
}

function proofMatches(record: SaveAsOperationRecord, input: SaveAsD2Input) {
  return (
    record.operationId === input.operationId &&
    record.operationGeneration === input.operationGeneration &&
    sameClaim(record, input.claimIdentity) &&
    record.ownerType === input.ownerType &&
    record.ownerId === input.ownerId &&
    record.channel === input.channel &&
    record.targetDisplayPath === input.targetDisplayPath &&
    record.targetPathIdentityKey === input.targetPathIdentityKey &&
    record.targetLocationMode === input.locationMode &&
    record.d1PhysicalIdentityHash === input.d1PhysicalIdentityHash &&
    record.d1ReadbackSha256 === input.d1ReadbackSha256 &&
    record.d1ByteLength === input.d1ByteLength &&
    record.encodingContractVersion === input.encodingContractVersion &&
    record.newlineContractVersion === input.newlineContractVersion
  );
}

export function createManuscriptSaveAsD2Adapter(dependencies: {
  operations: SaveAsD2OperationAuthority;
}) {
  return Object.freeze({
    async commit(
      input: SaveAsD2Input
    ): Promise<SharedSaveAsCoreOutcome<SaveAsD2Result>> {
      const authoritative = await dependencies.operations.readback(
        input.operationId
      );
      if (!authoritative || !proofMatches(authoritative, input)) {
        return failure(
          "SAVE_AS_OPERATION_STALE",
          authoritative?.stage ?? "reconciliation_blocked",
          "proof_mismatch"
        );
      }
      const legalNormalD2 =
        input.j0Revision <= authoritative.revision &&
        ((authoritative.stage === "d1_confirmed" &&
          authoritative.d2CommitState === "not_started") ||
          (authoritative.stage === "d2_confirmed" &&
            authoritative.d2CommitState === "confirmed"));
      if (!legalNormalD2) {
        return failure(
          "SAVE_AS_OPERATION_STALE",
          authoritative.stage,
          "stale_operation"
        );
      }
      let committed: SaveAsD2AuthorityResult;
      try {
        committed = await dependencies.operations.atomicCommitD2({
          operationId: authoritative.operationId,
          expected: saveAsOperationExpectation(authoritative)
        });
      } catch {
        return failure(
          "SAVE_AS_J0_CAS_CONFLICT",
          authoritative.stage,
          "j0_cas_conflict",
          authoritative.stage === "d2_confirmed"
        );
      }
      if (!committed.fileRef || committed.operation.stage !== "d2_confirmed") {
        return failure(
          "SAVE_AS_J0_RESPONSE_LOSS",
          committed.operation.stage,
          "d2_effect_unknown",
          "unknown"
        );
      }
      return {
        ok: true,
        continuation: "close",
        value: {
          fileRef: committed.fileRef,
          operation: committed.operation,
          state:
            committed.state === "created" || committed.state === "reused"
              ? committed.state
              : "reconciled"
        }
      };
    }
  });
}

export const manuscriptSaveAsD2Adapter =
  createManuscriptSaveAsD2Adapter({
    operations: manuscriptSaveAsOperationPort
  });
