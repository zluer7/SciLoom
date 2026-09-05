import type { FileRefOwnerType } from "../types/experiment";
import type { OwnerIdentity } from "../types/manuscriptOperation";
import type { DurableSharedTargetSnapshot } from "../types/sharedManuscriptSession";
import type {
  SaveAsClaimIdentity,
  SaveAsFailureCode,
  SaveAsHandoffProof,
  SaveAsSourceSnapshotProof,
  SaveAsTargetCandidate
} from "../types/manuscriptSaveAs";
import {
  isSaveAsD1Failure,
  manuscriptSaveAsD1Port,
  type ManuscriptSaveAsD1Port,
  type SaveAsD1Result
} from "./manuscriptSaveAsD1Port";
import {
  manuscriptSaveAsD2Adapter,
  type SaveAsD2Input,
  type SaveAsD2Result,
  type SharedSaveAsCoreOutcome
} from "./manuscriptSaveAsD2Adapter";
import {
  manuscriptSaveAsHandoffPort,
  type SaveAsHandoffExpectation
} from "./manuscriptSaveAsHandoffPort";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import {
  manuscriptSaveAsRuntimeActivation,
  durableTargetFromFileRef,
  type SaveAsRuntimeActivationResult
} from "./manuscriptSaveAsRuntimeActivation";
import {
  manuscriptSaveAsTargetGuardPort,
  type SaveAsTargetGuardGrant,
  type SaveAsTargetGuardRelease
} from "./manuscriptSaveAsTargetGuardPort";
import { sha256SaveAsRaw } from "./manuscriptSaveAsSourceSnapshot";

export interface SharedSaveAsF0 {
  source: SaveAsSourceSnapshotProof;
  frozenRawText: string;
  owner: OwnerIdentity & { ownerType: FileRefOwnerType };
  sourceWindowRole: "current" | "independent";
  target: SaveAsTargetCandidate;
  targetObservation: {
    generation: string;
    proof: string;
  };
  configuredRoot?: string;
  sourcePhysicalIdentityHash?: string;
  consumerId: string;
  cancelledPreD1?: boolean;
}

export interface SharedSaveAsEngineResult {
  operation: SaveAsOperationRecord;
  d1: SaveAsD1Result;
  d2: SaveAsD2Result;
  r3: SaveAsRuntimeActivationResult;
  target: DurableSharedTargetSnapshot;
}

interface GuardAuthority {
  acquire(input: {
    operationId: string;
    operationGeneration: number;
    target: SaveAsTargetCandidate;
  }): Promise<SaveAsTargetGuardGrant>;
  release(proof: string): Promise<SaveAsTargetGuardRelease>;
}

interface OperationAuthority {
  create(record: SaveAsOperationRecord): Promise<SaveAsOperationRecord>;
  readback(operationId: string): Promise<SaveAsOperationRecord | null>;
}

interface HandoffAuthority {
  issueSaveAsHandoff(
    proof: SaveAsHandoffProof,
    readbackText: string
  ): Promise<SaveAsHandoffProof>;
}

function failed<T>(
  code: SaveAsFailureCode,
  stage: SaveAsOperationRecord["stage"],
  continuation:
    | "close"
    | "reselect_target"
    | "retry_same_operation"
    | "readback_reconcile"
    | "await_recovery"
    | "start_new_operation"
    | "decision_escalation"
    | "hard_block",
  writeApplied: false | true | "unknown",
  internalReason:
    | "stale_operation"
    | "proof_mismatch"
    | "d2_effect_unknown"
    | "runtime_activation_failed"
    | "j0_cas_conflict"
): SharedSaveAsCoreOutcome<T> {
  return {
    ok: false,
    failure: { code, stage, continuation, writeApplied },
    internalReason
  };
}

function validTarget(source: SaveAsSourceSnapshotProof, target: SaveAsTargetCandidate) {
  return (
    Boolean(target.displayPath.trim()) &&
    Boolean(target.normalizedPath.trim()) &&
    Boolean(target.pathIdentityKey.trim()) &&
    Boolean(target.parentPathIdentityKey.trim()) &&
    /^[0-9a-f]{64}$/u.test(target.parentPhysicalIdentityHash) &&
    Boolean(target.normalizedFinalFilename.trim()) &&
    target.pathIdentityKey !== source.sourcePathIdentityKey
  );
}

function validTargetObservation(
  observation: SharedSaveAsF0["targetObservation"]
) {
  return (
    Boolean(observation.generation.trim()) &&
    /^[0-9a-f]{64}$/u.test(observation.proof)
  );
}

function claimFromRecord(record: SaveAsOperationRecord): SaveAsClaimIdentity {
  return {
    claimToken: record.claimToken ?? "",
    claimRevision: record.claimRevision ?? 0,
    claimProcessGeneration: record.claimProcessGeneration ?? "",
    observationGeneration: record.observationGeneration ?? 0,
    observationRevision: record.observationRevision ?? 0
  };
}

function confirmedD1FromRecord(
  record: SaveAsOperationRecord,
  input: SharedSaveAsF0
): SaveAsD1Result | undefined {
  if (
    record.d1CommitState !== "confirmed" ||
    !record.d1PhysicalIdentityHash ||
    !/^[0-9a-f]{64}$/u.test(record.d1PhysicalIdentityHash) ||
    !record.d1ReadbackSha256 ||
    !/^[0-9a-f]{64}$/u.test(record.d1ReadbackSha256) ||
    !record.d1ReadbackRevision ||
    record.d1ReadbackSha256 !== input.source.snapshotSha256 ||
    record.d1ByteLength !== input.source.snapshotByteLength ||
    record.d1ProofGeneration === undefined ||
    record.d1ProofGeneration <= 0 ||
    record.targetPathIdentityKey !== input.target.pathIdentityKey ||
    record.encodingContractVersion !==
      input.source.encodingContractVersion ||
    record.newlineContractVersion !==
      input.source.newlineContractVersion
  ) {
    return undefined;
  }
  return {
    proof: {
      normalizedTargetIdentity: record.targetPathIdentityKey,
      physicalTargetIdentityHash: record.d1PhysicalIdentityHash,
      d1ReadbackSha256: record.d1ReadbackSha256,
      d1ReadbackRevision: record.d1ReadbackRevision,
      byteLength: record.d1ByteLength,
      encodingContractVersion: record.encodingContractVersion,
      newlineContractVersion: record.newlineContractVersion,
      proofGeneration: record.d1ProofGeneration
    },
    readbackText: input.frozenRawText,
    writeApplied: true
  };
}

type D1PostCatchDecision =
  | { kind: "resume"; d1: SaveAsD1Result }
  | {
      kind: "fail";
      result: SharedSaveAsCoreOutcome<never>;
    };

function decideD1PostCatch(
  caught: unknown,
  record: SaveAsOperationRecord | null,
  input: SharedSaveAsF0
): D1PostCatchDecision {
  if (record?.d1CommitState === "confirmed") {
    const d1 = confirmedD1FromRecord(record, input);
    return d1
      ? { kind: "resume", d1 }
      : {
          kind: "fail",
          result: failed(
            "SAVE_AS_D1_READBACK_MISMATCH",
            record.stage,
            "hard_block",
            true,
            "proof_mismatch"
          )
        };
  }

  if (
    !record ||
    record.stage === "d1_commit_unknown" ||
    record.d1CommitState === "unknown"
  ) {
    return {
      kind: "fail",
      result: failed(
        "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN",
        record?.stage ?? "d1_commit_unknown",
        "await_recovery",
        "unknown",
        "d2_effect_unknown"
      )
    };
  }

  const noNewPhysicalEffect =
    record.stage === "pre_d1_closed" &&
    record.d1CommitState === "not_started" &&
    record.d2CommitState === "not_started" &&
    record.reconciliationState === "not_required";
  if (noNewPhysicalEffect) {
    if (
      isSaveAsD1Failure(caught) &&
      record.blockingCode === caught.code
    ) {
      return {
        kind: "fail",
        result: failed(
          caught.code,
          record.stage,
          "reselect_target",
          false,
          "stale_operation"
        )
      };
    }
    return {
      kind: "fail",
      result: failed(
        "SAVE_AS_D1_WRITE_FAILED",
        record.stage,
        "start_new_operation",
        false,
        "proof_mismatch"
      )
    };
  }

  return {
    kind: "fail",
    result: failed(
      "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN",
      record.stage,
      "await_recovery",
      "unknown",
      "d2_effect_unknown"
    )
  };
}

function handoffExpectation(
  proof: SaveAsHandoffProof
): SaveAsHandoffExpectation {
  return {
    operationId: proof.operationId,
    operationGeneration: proof.operationGeneration,
    normalizedTargetIdentity: proof.normalizedTargetIdentity,
    physicalTargetIdentityHash: proof.physicalTargetIdentityHash,
    d1ReadbackSha256: proof.d1ReadbackSha256,
    byteLength: proof.byteLength,
    encodingContractVersion: proof.encodingContractVersion,
    newlineContractVersion: proof.newlineContractVersion,
    sourceSnapshotSha256: proof.sourceSnapshotSha256,
    sourceRevision: proof.sourceRevision,
    sourceRuntimeGeneration: proof.sourceRuntimeGeneration,
    j0Revision: proof.j0Revision,
    claimIdentity: proof.claimIdentity,
    proofIssuanceGeneration: proof.proofIssuanceGeneration
  };
}

export function createSharedManuscriptSaveAsEngine(dependencies: {
  guard: GuardAuthority;
  operations: OperationAuthority;
  d1: ManuscriptSaveAsD1Port;
  handoff: HandoffAuthority;
  d2: { commit(input: SaveAsD2Input): Promise<SharedSaveAsCoreOutcome<SaveAsD2Result>> };
  activation: {
    activate(input: Parameters<typeof manuscriptSaveAsRuntimeActivation.activate>[0]):
      Promise<SharedSaveAsCoreOutcome<SaveAsRuntimeActivationResult>>;
  };
  now?: () => string;
  createToken?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const createToken =
    dependencies.createToken ??
    (() => globalThis.crypto.randomUUID());
  async function releaseGuard(proof: string) {
    try {
      await dependencies.guard.release(proof);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    async execute(
      input: SharedSaveAsF0
    ): Promise<SharedSaveAsCoreOutcome<SharedSaveAsEngineResult>> {
      if (input.cancelledPreD1) {
        return failed(
          "SAVE_AS_CANCELLED_PRE_D1",
          "pre_d1_closed",
          "close",
          false,
          "stale_operation"
        );
      }
      if (
        !validTarget(input.source, input.target) ||
        !validTargetObservation(input.targetObservation) ||
        input.source.operationId.trim() === "" ||
        input.source.operationGeneration <= 0 ||
        !input.source.sourceFileRefId?.trim() ||
        input.source.sourceRuntimeGeneration < 0 ||
        (await sha256SaveAsRaw(input.frozenRawText)) !==
          input.source.snapshotSha256 ||
        new TextEncoder().encode(input.frozenRawText).byteLength !==
          input.source.snapshotByteLength
      ) {
        return failed(
          "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
          "pre_d1_closed",
          "start_new_operation",
          false,
          "proof_mismatch"
        );
      }

      let guard: SaveAsTargetGuardGrant;
      try {
        guard = await dependencies.guard.acquire({
          operationId: input.source.operationId,
          operationGeneration: input.source.operationGeneration,
          target: input.target
        });
      } catch {
        return failed(
          "SAVE_AS_GUARD_CONFLICT",
          "pre_d1_closed",
          "reselect_target",
          false,
          "stale_operation"
        );
      }
      if (guard.processGeneration !== input.source.processGeneration) {
        await releaseGuard(guard.proof);
        return failed(
          "SAVE_AS_RUNTIME_GENERATION_STALE",
          "pre_d1_closed",
          "start_new_operation",
          false,
          "stale_operation"
        );
      }

      const timestamp = now();
      const initialClaim: SaveAsClaimIdentity = {
        claimToken: createToken(),
        claimRevision: 0,
        claimProcessGeneration: guard.processGeneration,
        observationGeneration: 0,
        observationRevision: 0
      };
      const initial: SaveAsOperationRecord = {
        operationId: input.source.operationId,
        revision: 0,
        commitFenceRevision: 0,
        operationGeneration: input.source.operationGeneration,
        producerProcessGeneration: guard.processGeneration,
        ownerType: input.owner.ownerType,
        ownerId: input.owner.ownerId,
        channel: input.owner.channel as SaveAsOperationRecord["channel"],
        sourceWindowRole: input.sourceWindowRole,
        sourceFileRefId: input.source.sourceFileRefId,
        sourcePathIdentityKey: input.source.sourcePathIdentityKey,
        sourceRevision: input.source.sourceRevision,
        sourceRuntimeGeneration: input.source.sourceRuntimeGeneration,
        snapshotSha256: input.source.snapshotSha256,
        snapshotByteLength: input.source.snapshotByteLength,
        encodingContractVersion: input.source.encodingContractVersion,
        newlineContractVersion: input.source.newlineContractVersion,
        targetDisplayPath: input.target.displayPath,
        targetPathIdentityKey: input.target.pathIdentityKey,
        targetLocationMode: input.target.locationMode,
        targetParentPathIdentityKey: input.target.parentPathIdentityKey,
        targetParentPhysicalIdentityHash:
          input.target.parentPhysicalIdentityHash,
        stage: "pre_d1_claimed",
        d1CommitState: "not_started",
        d2CommitState: "not_started",
        reconciliationState: "not_required",
        claimToken: initialClaim.claimToken,
        claimRevision: initialClaim.claimRevision,
        claimProcessGeneration: initialClaim.claimProcessGeneration,
        observationGeneration: initialClaim.observationGeneration,
        observationRevision: initialClaim.observationRevision,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      let j0: SaveAsOperationRecord;
      try {
        j0 = await dependencies.operations.create(initial);
      } catch {
        await releaseGuard(guard.proof);
        return failed(
          "SAVE_AS_J0_CLAIM_CONFLICT",
          "pre_d1_claimed",
          "await_recovery",
          false,
          "j0_cas_conflict"
        );
      }

      let d1: SaveAsD1Result;
      try {
        d1 = await dependencies.d1.createNewWithReadback({
          source: input.source,
          target: input.target,
          j0Revision: j0.revision,
          claimIdentity: claimFromRecord(j0),
          guardProof: guard.proof,
          frozenRawText: input.frozenRawText,
          sourcePhysicalIdentityHash: input.sourcePhysicalIdentityHash
        });
      } catch (caught) {
        const readback = await dependencies.operations.readback(
          input.source.operationId
        );
        const decision = decideD1PostCatch(
          caught,
          readback,
          input
        );
        if (decision.kind === "fail") {
          if (
            !decision.result.ok &&
            decision.result.failure.writeApplied === false
          ) {
            await releaseGuard(guard.proof);
          }
          return decision.result;
        }
        d1 = decision.d1;
      }
      const d1Record = await dependencies.operations.readback(
        input.source.operationId
      );
      if (
        !d1Record ||
        d1Record.d1CommitState !== "confirmed" ||
        d1Record.d1ReadbackSha256 !== d1.proof.d1ReadbackSha256 ||
        d1Record.d1ReadbackRevision !== d1.proof.d1ReadbackRevision ||
        d1Record.d1PhysicalIdentityHash !==
          d1.proof.physicalTargetIdentityHash
      ) {
        return failed(
          "SAVE_AS_D1_READBACK_MISMATCH",
          d1Record?.stage ?? "d1_commit_unknown",
          "await_recovery",
          true,
          "proof_mismatch"
        );
      }

      const claim = claimFromRecord(d1Record);
      const issuedHandoff: SaveAsHandoffProof = {
        operationId: input.source.operationId,
        operationGeneration: input.source.operationGeneration,
        normalizedTargetIdentity: d1.proof.normalizedTargetIdentity,
        physicalTargetIdentityHash:
          d1.proof.physicalTargetIdentityHash,
        d1ReadbackSha256: d1.proof.d1ReadbackSha256,
        byteLength: d1.proof.byteLength,
        encodingContractVersion: d1.proof.encodingContractVersion,
        newlineContractVersion: d1.proof.newlineContractVersion,
        sourceSnapshotSha256: input.source.snapshotSha256,
        sourceRevision: input.source.sourceRevision,
        sourceRuntimeGeneration: input.source.sourceRuntimeGeneration,
        j0Revision: d1Record.revision,
        claimIdentity: claim,
        proofIssuanceGeneration: d1.proof.proofGeneration,
        singleUseToken: createToken()
      };
      try {
        await dependencies.handoff.issueSaveAsHandoff(
          issuedHandoff,
          d1.readbackText
        );
      } catch {
        return failed(
          "SAVE_AS_HANDOFF_MISMATCH",
          d1Record.stage,
          "hard_block",
          true,
          "proof_mismatch"
        );
      }

      const d2 = await dependencies.d2.commit({
        operationId: input.source.operationId,
        operationGeneration: input.source.operationGeneration,
        j0Revision: d1Record.revision,
        claimIdentity: claim,
        ownerType: input.owner.ownerType,
        ownerId: input.owner.ownerId,
        channel: input.owner.channel as SaveAsD2Input["channel"],
        locationMode: input.target.locationMode,
        targetDisplayPath: input.target.displayPath,
        targetPathIdentityKey: input.target.pathIdentityKey,
        d1PhysicalIdentityHash: d1.proof.physicalTargetIdentityHash,
        d1ReadbackSha256: d1.proof.d1ReadbackSha256,
        d1ByteLength: d1.proof.byteLength,
        encodingContractVersion: d1.proof.encodingContractVersion,
        newlineContractVersion: d1.proof.newlineContractVersion
      });
      if (!d2.ok) {
        return d2;
      }

      const target = durableTargetFromFileRef({
        fileRefId: d2.value.fileRef.id,
        absolutePath: d2.value.fileRef.path,
        pathIdentity: d2.value.fileRef.pathIdentityKey,
        fileName:
          input.target.normalizedFinalFilename,
        locationMode: input.target.locationMode,
        configuredRoot: input.configuredRoot
      });
      const r3 = await dependencies.activation.activate({
        operationId: input.source.operationId,
        operationGeneration: input.source.operationGeneration,
        j0Revision: d2.value.operation.revision,
        claimIdentity: claimFromRecord(d2.value.operation),
        owner: input.owner,
        target,
        consumerId: input.consumerId,
        sourceRuntimeGeneration: input.source.sourceRuntimeGeneration,
        handoff: {
          kind: "handoff",
          singleUseToken: issuedHandoff.singleUseToken,
          expectation: handoffExpectation(issuedHandoff)
        }
      });
      if (!r3.ok) return r3;
      return {
        ok: true,
        continuation: "close",
        value: {
          operation: r3.value.operation,
          d1,
          d2: d2.value,
          r3: r3.value,
          target
        }
      };
    }
  });
}

export const sharedManuscriptSaveAsEngine =
  createSharedManuscriptSaveAsEngine({
    guard: manuscriptSaveAsTargetGuardPort,
    operations: manuscriptSaveAsOperationPort,
    d1: manuscriptSaveAsD1Port,
    handoff: manuscriptSaveAsHandoffPort,
    d2: manuscriptSaveAsD2Adapter,
    activation: manuscriptSaveAsRuntimeActivation
  });
