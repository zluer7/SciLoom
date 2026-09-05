import type { FileRef, FileRefOwnerType } from "../types/experiment";
import {
  MANUSCRIPT_OPERATION_ERROR_CODES,
  type OwnerIdentity,
  type RawManuscriptGateway
} from "../types/manuscriptOperation";
import type {
  SaveAsClaimIdentity,
  SaveAsD1Proof,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import type {
  DurableSharedTargetSnapshot,
  SharedSaveAsCandidateRuntimeBinding,
  SharedSessionHandleResult
} from "../types/sharedManuscriptSession";
import { fileRefService } from "./fileRefService";
import {
  manuscriptSaveAsD2Adapter,
  type SaveAsD2Input,
  type SaveAsD2Result,
  type SharedSaveAsCoreOutcome
} from "./manuscriptSaveAsD2Adapter";
import {
  manuscriptSaveAsOperationPort,
  saveAsOperationExpectation,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import {
  createManuscriptSaveAsRecoveryCoordinator,
  type SaveAsD1PhysicalObservation,
  type SaveAsRecoveryContinuations
} from "./manuscriptSaveAsRecoveryCoordinator";
import {
  durableTargetFromFileRef,
  manuscriptSaveAsRuntimeActivation,
  type SaveAsRuntimeActivationResult
} from "./manuscriptSaveAsRuntimeActivation";
import { rawManuscriptGateway } from "./rawManuscriptGateway";
import { manuscriptSaveAsPhysicalObservationPort } from "./manuscriptSaveAsPhysicalObservationPort";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import type { SharedSaveAsEngineResult } from "./sharedManuscriptSaveAsEngine";
import {
  manuscriptSaveAsCandidateCustodyPort,
  type CandidateDisposition,
  type CandidateCustodyRecord
} from "./manuscriptSaveAsCandidateCustody";
import {
  buildManuscriptSaveAsRecoveryConsumerId
} from "./manuscriptSaveAsRecoveryConsumerIdentity";
import {
  manuscriptSaveAsWindowPContainment,
  type ManuscriptSaveAsWindowPContainment,
  type WindowPContainmentRecord,
  type WindowPMissingBindingContainmentDescriptor
} from "./manuscriptSaveAsWindowPContainment";

type RecoveryOwner<TOwnerType extends FileRefOwnerType = FileRefOwnerType> = {
  ownerType: TOwnerType;
  ownerId: string;
  channel: "primary" | "literature_outline" | "dedicated_notes";
};

export interface ManuscriptSaveAsProductionRecoveryInput<
  TOwnerType extends FileRefOwnerType = FileRefOwnerType
> {
  operationId: string;
  expectedOwner: RecoveryOwner<TOwnerType>;
  configuredRoot?: string;
  windowPMissingBindingContainment?: WindowPMissingBindingContainmentDescriptor;
  ownerWritable(): Promise<boolean>;
  present(input: {
    consumerId: string;
    result: SharedSaveAsEngineResult;
  }): Promise<
    | {
        status: "success";
        sessionHandle: string;
        operation: SaveAsOperationRecord;
      }
    | { status: "recovery-required"; failure?: unknown }
  >;
}

type SuccessfulCandidateDisposition<
  TOwnerType extends FileRefOwnerType
> = TOwnerType extends "experiment" | "experimentRun"
  ? Extract<CandidateDisposition, { kind: "TRANSFERRED" | "CLOSED" }>
  : Extract<CandidateDisposition, { kind: "TRANSFERRED" }>;

export interface WindowPContainedProductionRecoveryResult {
  readonly status: "contained";
  readonly containmentKind: "window_p_fail_closed";
  readonly policyId: "window_p_fail_closed_v1";
  readonly operationId: string;
  readonly operation: Readonly<SaveAsOperationRecord>;
  readonly custody: Readonly<CandidateCustodyRecord>;
  readonly blockingCode: WindowPContainmentRecord["blockingCode"];
  readonly sourceProofComplete: boolean;
}

export type ManuscriptSaveAsProductionRecoveryResult<
  TOwnerType extends FileRefOwnerType = FileRefOwnerType
> =
  | {
      status: "success";
      operationId: string;
      sessionHandle: string;
      targetFileName: string;
      candidateDisposition: SuccessfulCandidateDisposition<TOwnerType>;
    }
  | {
      status: "error" | "recovery-required" | "blocked";
      operationId?: string;
      errorCode: SaveAsFailureCode;
      candidateDisposition: CandidateDisposition;
    }
  | WindowPContainedProductionRecoveryResult;

function containedRecoveryResult(
  contained: WindowPContainmentRecord
): WindowPContainedProductionRecoveryResult {
  return Object.freeze({
    status: "contained",
    containmentKind: "window_p_fail_closed",
    policyId: contained.policyId,
    operationId: contained.operation.operationId,
    operation: Object.freeze({ ...contained.operation }),
    custody: Object.freeze({ ...contained.custody }),
    blockingCode: contained.blockingCode,
    sourceProofComplete: contained.sourceProofComplete
  });
}

interface ProductionRecoveryDependencies {
  operations: typeof manuscriptSaveAsOperationPort;
  d2: typeof manuscriptSaveAsD2Adapter;
  activation: typeof manuscriptSaveAsRuntimeActivation;
  gateway: RawManuscriptGateway;
  physicalObservation: typeof manuscriptSaveAsPhysicalObservationPort;
  getFileRef(id: string): Promise<FileRef | undefined>;
  listSessionConsumers(): Array<{
    handle: string;
    consumerId?: string;
    session: SharedSessionHandleResult["session"];
  }>;
  readCustody(operationId: string): Promise<CandidateCustodyRecord | null>;
  readRuntimeBinding(
    receiptId: string
  ): SharedSaveAsCandidateRuntimeBinding | undefined;
  transferCustody(input: {
    operationId: string;
    expectedCustodyRevision: number;
    receiptId: string;
    nextAuthority: "outputs_adapter";
  }): Promise<CandidateCustodyRecord>;
  containWindowP: ManuscriptSaveAsWindowPContainment["contain"];
  nextObservationGeneration(record: SaveAsOperationRecord): number;
}

function ownerMatches(record: SaveAsOperationRecord, owner: RecoveryOwner) {
  return (
    record.ownerType === owner.ownerType &&
    record.ownerId === owner.ownerId &&
    record.channel === owner.channel
  );
}

function claimIdentity(
  record: SaveAsOperationRecord
): SaveAsClaimIdentity | undefined {
  if (
    !record.claimToken ||
    record.claimRevision === undefined ||
    !record.claimProcessGeneration ||
    record.observationGeneration === undefined ||
    record.observationRevision === undefined
  ) {
    return undefined;
  }
  return {
    claimToken: record.claimToken,
    claimRevision: record.claimRevision,
    claimProcessGeneration: record.claimProcessGeneration,
    observationGeneration: record.observationGeneration,
    observationRevision: record.observationRevision
  };
}

function d1Proof(record: SaveAsOperationRecord): SaveAsD1Proof | undefined {
  if (
    !record.d1PhysicalIdentityHash ||
    !record.d1ReadbackSha256 ||
    !record.d1ReadbackRevision ||
    record.d1ByteLength === undefined ||
    record.d1ProofGeneration === undefined
  ) {
    return undefined;
  }
  return {
    normalizedTargetIdentity: record.targetPathIdentityKey,
    physicalTargetIdentityHash: record.d1PhysicalIdentityHash,
    d1ReadbackSha256: record.d1ReadbackSha256,
    d1ReadbackRevision: record.d1ReadbackRevision,
    byteLength: record.d1ByteLength,
    encodingContractVersion: record.encodingContractVersion,
    newlineContractVersion: record.newlineContractVersion,
    proofGeneration: record.d1ProofGeneration
  };
}

function targetFileName(record: SaveAsOperationRecord) {
  return record.targetDisplayPath.replace(/^.*[\\/]/u, "");
}

function targetFrom(
  record: SaveAsOperationRecord,
  fileRefId: string,
  configuredRoot?: string
): DurableSharedTargetSnapshot {
  return durableTargetFromFileRef({
    fileRefId,
    absolutePath: record.targetDisplayPath,
    pathIdentity: record.targetPathIdentityKey,
    fileName: targetFileName(record),
    locationMode: record.targetLocationMode,
    configuredRoot:
      record.targetLocationMode === "managed" ? configuredRoot : undefined
  });
}

function d2Input(
  record: SaveAsOperationRecord
): SaveAsD2Input | undefined {
  const claim = claimIdentity(record);
  if (
    !claim ||
    !record.d1PhysicalIdentityHash ||
    !record.d1ReadbackSha256 ||
    record.d1ByteLength === undefined
  ) {
    return undefined;
  }
  return {
    operationId: record.operationId,
    operationGeneration: record.operationGeneration,
    j0Revision: record.revision,
    claimIdentity: claim,
    ownerType: record.ownerType as FileRefOwnerType,
    ownerId: record.ownerId,
    channel: record.channel,
    locationMode: record.targetLocationMode,
    targetDisplayPath: record.targetDisplayPath,
    targetPathIdentityKey: record.targetPathIdentityKey,
    d1PhysicalIdentityHash: record.d1PhysicalIdentityHash,
    d1ReadbackSha256: record.d1ReadbackSha256,
    d1ByteLength: record.d1ByteLength,
    encodingContractVersion: record.encodingContractVersion,
    newlineContractVersion: record.newlineContractVersion
  };
}

function exactFileRef(record: SaveAsOperationRecord, fileRef: FileRef) {
  return (
    !fileRef.deletedAt &&
    fileRef.id === record.targetFileRefId &&
    fileRef.ownerType === record.ownerType &&
    fileRef.ownerId === record.ownerId &&
    fileRef.manuscriptChannel === record.channel &&
    fileRef.resourceKind === "file" &&
    fileRef.fileRole === "manuscript" &&
    fileRef.locationMode === record.targetLocationMode &&
    fileRef.pathIdentityKey === record.targetPathIdentityKey
  );
}

async function sha256Utf8(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function failed(
  record: SaveAsOperationRecord,
  code: SaveAsFailureCode,
  continuation: "await_recovery" | "hard_block" = "hard_block"
): SharedSaveAsCoreOutcome<never> {
  return {
    ok: false,
    failure: {
      code,
      stage: record.stage,
      continuation,
      writeApplied:
        record.d1CommitState === "not_started" ? false : "unknown"
    },
    internalReason:
      continuation === "await_recovery"
        ? "stale_operation"
        : "proof_mismatch"
  };
}

export function createManuscriptSaveAsProductionRecoveryComposition(
  dependencies: ProductionRecoveryDependencies
) {
  async function candidateDisposition(
    operationId?: string
  ): Promise<CandidateDisposition> {
    if (!operationId) return { kind: "NOT_ACTIVATED" };
    const custody = await dependencies.readCustody(operationId);
    if (!custody || custody.custodyState === "activation_planned") {
      return { kind: "NOT_ACTIVATED" };
    }
    if (
      custody.custodyState === "cleanup_resolved" ||
      custody.custodyState === "process_generation_retired"
    ) {
      return custody.custodyState === "process_generation_retired"
        ? {
            kind: "CLOSED",
            receiptId: custody.receiptId,
            reason: "PROCESS_GENERATION_RETIRED"
          }
        : { kind: "CLOSED", receiptId: custody.receiptId };
    }
    if (
      [
        "shared_recovery",
        "outputs_adapter",
        "outputs_lifecycle",
        "installed_session"
      ].includes(custody.currentCustodyAuthority)
    ) {
      return { kind: "TRANSFERRED", receiptId: custody.receiptId };
    }
    return {
      kind: "RESIDUAL",
      receiptId: custody.receiptId,
      operationId: custody.operationId,
      cleanupState:
        custody.custodyState === "cleanup_retryable"
          ? "cleanup_retryable"
          : "cleanup_blocked"
    };
  }
  return Object.freeze({
    async recover<TOwnerType extends FileRefOwnerType>(
      input: ManuscriptSaveAsProductionRecoveryInput<TOwnerType>
    ): Promise<ManuscriptSaveAsProductionRecoveryResult<TOwnerType>> {
      const initial = await dependencies.operations.readback(input.operationId);
      if (!initial || !ownerMatches(initial, input.expectedOwner)) {
        return {
          status: "error",
          errorCode: "SAVE_AS_OPERATION_STALE",
          candidateDisposition: { kind: "NOT_ACTIVATED" }
        };
      }

      let acceptedSessionHandle: string | undefined;
      let windowPContainment: WindowPContainmentRecord | undefined;
      let recovery: ReturnType<
        typeof createManuscriptSaveAsRecoveryCoordinator
      >;

      async function block(
        record: SaveAsOperationRecord,
        code: SaveAsFailureCode
      ): Promise<SaveAsOperationRecord> {
        if (record.stage === "reconciliation_blocked") return record;
        try {
          return await dependencies.operations.transition({
            operationId: record.operationId,
            expected: saveAsOperationExpectation(record),
            mutation: { intent: "block_reconciliation", blockingCode: code }
          });
        } catch {
          return (
            (await dependencies.operations.readback(record.operationId)) ??
            record
          );
        }
      }

      async function inspectD1(
        record: SaveAsOperationRecord
      ): Promise<SaveAsD1PhysicalObservation> {
        const target = targetFrom(
          record,
          `save-as-pending:${record.operationId}`,
          input.configuredRoot
        );
        const [readback, physical] = await Promise.all([
          dependencies.gateway.read({ file: target.file }),
          dependencies.physicalObservation.observeExistingSaveAsTarget({
            targetPath: record.targetDisplayPath,
            expectedPathIdentity: record.targetPathIdentityKey
          })
        ]);
        if (readback.status !== "success" || !readback.data) {
          return readback.error?.code ===
            MANUSCRIPT_OPERATION_ERROR_CODES.fileNotFound
            ? { state: "absent" }
            : { state: "unavailable" };
        }
        if (!physical.ok) {
          return physical.failure.code === "SAVE_AS_D1_READBACK_FAILED"
            ? { state: "unavailable" }
            : { state: "mismatch" };
        }
        const byteLength = new TextEncoder().encode(
          readback.data.rawText
        ).byteLength;
        const hash = await sha256Utf8(readback.data.rawText);
        if (
          !physical.value.targetPhysicalIdentityHash ||
          hash !== record.snapshotSha256 ||
          byteLength !== record.snapshotByteLength ||
          readback.data.encoding !== "utf-8" ||
          `${readback.data.newline}-v1` !== record.newlineContractVersion
        ) {
          return { state: "mismatch" };
        }
        return {
          state: "exact",
          proof: {
            normalizedTargetIdentity: record.targetPathIdentityKey,
            physicalTargetIdentityHash:
              physical.value.targetPhysicalIdentityHash,
            d1ReadbackSha256: hash,
            d1ReadbackRevision: readback.data.revision,
            byteLength,
            encodingContractVersion: record.encodingContractVersion,
            newlineContractVersion: record.newlineContractVersion,
            proofGeneration: record.operationGeneration
          },
          readbackRevision: readback.data.revision
        };
      }

      async function present(
        record: SaveAsOperationRecord,
        d2: SaveAsD2Result,
        r3: SaveAsRuntimeActivationResult,
        target: DurableSharedTargetSnapshot,
        consumerId: string
      ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
        const proof = d1Proof(record);
        if (!proof) return failed(record, "SAVE_AS_OPERATION_STALE");
        const presented = await input.present({
          consumerId,
          result: {
            operation: r3.operation,
            d1: {
              proof,
              readbackText: r3.runtime.session.draftRawText,
              writeApplied: true
            },
            d2,
            r3,
            target
          }
        });
        if (presented.status !== "success") {
          return failed(
            r3.operation,
            "SAVE_AS_OPERATION_STALE",
            "await_recovery"
          );
        }
        try {
          await dependencies.transferCustody({
            operationId: r3.custody.operationId,
            expectedCustodyRevision: r3.custody.revision,
            receiptId: r3.custody.receiptId,
            nextAuthority: "outputs_adapter"
          });
        } catch {
          const readback = await dependencies.readCustody(
            r3.custody.operationId
          );
          if (
            !readback ||
            readback.receiptId !== r3.custody.receiptId ||
            readback.currentCustodyAuthority !== "outputs_adapter"
          ) {
            return failed(
              r3.operation,
              "SAVE_AS_J0_RESPONSE_LOSS",
              "await_recovery"
            );
          }
        }
        acceptedSessionHandle = presented.sessionHandle;
        return {
          ok: true,
          continuation: "close",
          value: presented.operation
        };
      }

      async function activateAndPresent(
        record: SaveAsOperationRecord,
        d2: SaveAsD2Result
      ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
        const physical =
          await dependencies.physicalObservation.observeExistingSaveAsTarget({
            targetPath: record.targetDisplayPath,
            expectedPathIdentity: record.targetPathIdentityKey
          });
        const physicalTargetIdentityHash = physical.ok
          ? physical.value.targetPhysicalIdentityHash
          : undefined;
        if (
          !physicalTargetIdentityHash ||
          physicalTargetIdentityHash !== record.d1PhysicalIdentityHash
        ) {
          return failed(record, "SAVE_AS_D1_READBACK_MISMATCH", "hard_block");
        }
        if (!(await input.ownerWritable())) {
          return {
            ok: true,
            continuation: "close",
            value: await block(record, "SAVE_AS_PERMISSION_DENIED")
          };
        }
        const claim = claimIdentity(record);
        if (!claim || !exactFileRef(record, d2.fileRef)) {
          return failed(record, "SAVE_AS_OPERATION_STALE");
        }
        const target = targetFrom(
          record,
          d2.fileRef.id,
          input.configuredRoot
        );
        const cleanup = await recovery.cleanup({
          operationId: record.operationId,
          operationGeneration: record.operationGeneration
        });
        if (
          cleanup.status !== "completed" ||
          cleanup.guard === "release_unknown" ||
          cleanup.j0 === "terminalize_unknown"
        ) {
          return failed(
            record,
            "SAVE_AS_OPERATION_STALE",
            "await_recovery"
          );
        }
        const expectedCustody = await dependencies.readCustody(
          record.operationId
        );
        if (
          !expectedCustody ||
          expectedCustody.ownerType !== record.ownerType ||
          expectedCustody.ownerId !== record.ownerId ||
          expectedCustody.channel !== record.channel ||
          expectedCustody.candidateFileRefId !== d2.fileRef.id
        ) {
          return failed(record, "SAVE_AS_OPERATION_STALE");
        }
        const recoveryOwner = {
          ownerType: record.ownerType,
          ownerId: record.ownerId,
          channel: record.channel
        } satisfies OwnerIdentity;
        const consumerId = buildManuscriptSaveAsRecoveryConsumerId({
          operationId: record.operationId,
          receiptId: expectedCustody.receiptId,
          expectedCustodyRevision: expectedCustody.revision,
          owner: recoveryOwner,
          candidateFileRefId: d2.fileRef.id,
          recoveryGeneration:
            record.observationGeneration ?? record.operationGeneration
        });
        const activated = await dependencies.activation.activate({
          operationId: record.operationId,
          operationGeneration: record.operationGeneration,
          j0Revision: record.revision,
          claimIdentity: claim,
          owner: recoveryOwner,
          target,
          consumerId,
          sourceRuntimeGeneration: record.sourceRuntimeGeneration,
          handoff: {
            kind: "handoff_unavailable",
            evidence: {
              kind: "formal_cleanup",
              operationId: record.operationId,
              operationGeneration: record.operationGeneration,
              j0Revision: record.revision,
              cleanupGeneration:
                record.observationGeneration ?? record.operationGeneration,
              physicalTargetIdentityHash
            }
          },
          recovery: { expectedCustody }
        });
        if (!activated.ok) return activated;
        return present(
          activated.value.operation,
          {
            ...d2,
            operation: activated.value.operation
          },
          activated.value,
          target,
          consumerId
        );
      }

      async function resumeP4(
        record: SaveAsOperationRecord
      ): Promise<SharedSaveAsCoreOutcome<SaveAsOperationRecord>> {
        if (!record.targetFileRefId) {
          return failed(record, "SAVE_AS_OPERATION_STALE");
        }
        const fileRef = await dependencies.getFileRef(record.targetFileRefId);
        if (!fileRef || !exactFileRef(record, fileRef)) {
          return {
            ok: true,
            continuation: "close",
            value: await block(record, "SAVE_AS_D1_READBACK_MISMATCH")
          };
        }
        const custody = await dependencies.readCustody(record.operationId);
        const binding = custody
          ? dependencies.readRuntimeBinding(custody.receiptId)
          : undefined;
        if (!custody) {
          return {
            ok: true,
            continuation: "close",
            value: await block(record, "SAVE_AS_OPERATION_STALE")
          };
        }
        if (
          binding &&
          (binding.operationId !== record.operationId ||
          binding.processGeneration !== custody.processGeneration ||
          binding.owner.ownerType !== record.ownerType ||
          binding.owner.ownerId !== record.ownerId ||
          binding.owner.channel !== record.channel ||
          binding.candidateFileRefId !== record.targetFileRefId ||
          custody.runtimeHandle !== binding.runtimeHandle ||
          custody.runtimeConsumerId !== binding.runtimeConsumerId ||
          custody.runtimeGeneration !== binding.runtimeGeneration ||
          custody.candidateFileRefId !== record.targetFileRefId)
        ) {
          return {
            ok: true,
            continuation: "close",
            value: await block(record, "SAVE_AS_OPERATION_STALE")
          };
        }
        const mounted = binding
          ? dependencies.listSessionConsumers().find(
              (candidate) =>
                candidate.handle === binding.runtimeHandle &&
                candidate.consumerId === binding.runtimeConsumerId
            )
          : undefined;
        if (binding && !mounted) {
          return {
            ok: true,
            continuation: "close",
            value: await block(record, "SAVE_AS_OPERATION_STALE")
          };
        }
        const target = targetFrom(
          record,
          fileRef.id,
          input.configuredRoot
        );
        if (!binding) {
          if (
            input.windowPMissingBindingContainment?.policyId !==
            "window_p_fail_closed_v1"
          ) {
            return failed(record, "SAVE_AS_OPERATION_STALE");
          }
          try {
            const contained = await dependencies.containWindowP({
              operation: record,
              expectedCustody: custody
            });
            windowPContainment = contained;
            return {
              ok: true,
              continuation: "close",
              value: contained.operation
            };
          } catch {
            return failed(
              record,
              "SAVE_AS_OPERATION_STALE",
              "await_recovery"
            );
          }
        }
        if (!(await input.ownerWritable())) {
          return {
            ok: true,
            continuation: "close",
            value: await block(record, "SAVE_AS_PERMISSION_DENIED")
          };
        }
        if (!mounted) {
          return failed(record, "SAVE_AS_OPERATION_STALE");
        }
        const r3: SaveAsRuntimeActivationResult = {
          operation: record,
          runtime: {
            handle: binding.runtimeHandle,
            session: mounted.session
          },
          rawSource: "handoff",
          gatewayRereadCount: 0,
          custody
        };
        return present(
          record,
          {
            fileRef,
            operation: record,
            state: "reconciled"
          },
          r3,
          target,
          binding.runtimeConsumerId
        );
      }

      const continuations: SaveAsRecoveryContinuations = {
        inspectD1,
        async continueD2(record) {
          const request = d2Input(record);
          if (!request) return failed(record, "SAVE_AS_OPERATION_STALE");
          const d2 = await dependencies.d2.commit(request);
          if (!d2.ok) return d2;
          return activateAndPresent(d2.value.operation, d2.value);
        },
        async continueR3(record) {
          if (!record.targetFileRefId) {
            return failed(record, "SAVE_AS_OPERATION_STALE");
          }
          const fileRef = await dependencies.getFileRef(
            record.targetFileRefId
          );
          if (!fileRef || !exactFileRef(record, fileRef)) {
            return {
              ok: true,
              continuation: "close",
              value: await block(record, "SAVE_AS_D1_READBACK_MISMATCH")
            };
          }
          return activateAndPresent(record, {
            fileRef,
            operation: record,
            state: "reconciled"
          });
        },
        continueP4: resumeP4
      };

      recovery = createManuscriptSaveAsRecoveryCoordinator({
        operations: dependencies.operations,
        continuations
      });
      const observationGeneration =
        dependencies.nextObservationGeneration(initial);
      const first = await recovery.observe({
        operationId: initial.operationId,
        operationGeneration: initial.operationGeneration,
        observationGeneration
      });
      if (!first.ok || first.value.status !== "first_observation") {
        return {
          status: "recovery-required",
          operationId: initial.operationId,
          errorCode: first.ok
            ? "SAVE_AS_OPERATION_STALE"
            : first.failure.code,
          candidateDisposition: await candidateDisposition(
            initial.operationId
          )
        };
      }
      const second = await recovery.observe({
        operationId: initial.operationId,
        operationGeneration: initial.operationGeneration,
        observationGeneration: observationGeneration + 1,
        previous: first.value.witness
      });
      if (!second.ok || second.value.status !== "claimed") {
        return {
          status: "recovery-required",
          operationId: initial.operationId,
          errorCode: second.ok
            ? "SAVE_AS_OPERATION_STALE"
            : second.failure.code,
          candidateDisposition: await candidateDisposition(
            initial.operationId
          )
        };
      }
      if (
        second.value.record.stage !== "pre_d1_claimed" &&
        second.value.record.stage !== "p4_presentation_pending" &&
        !(await input.ownerWritable())
      ) {
        const blocked = await block(
          second.value.record,
          "SAVE_AS_PERMISSION_DENIED"
        );
        return {
          status: "blocked",
          operationId: blocked.operationId,
          errorCode:
            blocked.blockingCode ?? "SAVE_AS_PERMISSION_DENIED",
          candidateDisposition: await candidateDisposition(
            blocked.operationId
          )
        };
      }
      const reconciled = await recovery.reconcile(second.value);
      if (windowPContainment) {
        return containedRecoveryResult(windowPContainment);
      }
      if (!reconciled.ok) {
        return {
          status:
            reconciled.failure.continuation === "hard_block"
              ? "blocked"
              : "recovery-required",
          operationId: initial.operationId,
          errorCode: reconciled.failure.code,
          candidateDisposition: await candidateDisposition(
            initial.operationId
          )
        };
      }
      if (
        acceptedSessionHandle &&
        reconciled.value.stage === "p4_presentation_pending"
      ) {
        return {
          status: "success",
          operationId: reconciled.value.operationId,
          sessionHandle: acceptedSessionHandle,
          targetFileName: targetFileName(reconciled.value),
          candidateDisposition: await candidateDisposition(
            reconciled.value.operationId
          ) as SuccessfulCandidateDisposition<TOwnerType>
        };
      }
      return {
        status:
          reconciled.value.stage === "reconciliation_blocked" ||
          reconciled.value.stage === "d2_reconciliation_conflict" ||
          reconciled.value.stage === "d2_reconciled_terminal"
            ? "blocked"
            : "recovery-required",
        operationId: initial.operationId,
        errorCode:
          reconciled.value.blockingCode ?? "SAVE_AS_OPERATION_STALE",
        candidateDisposition: await candidateDisposition(
          initial.operationId
        )
      };
    }
  });
}

const nextObservationGeneration = (() => {
  let generation = Date.now();
  return (record: SaveAsOperationRecord) => {
    generation = Math.max(
      generation + 2,
      (record.observationGeneration ?? 0) + 2
    );
    return generation;
  };
})();

export const manuscriptSaveAsProductionRecoveryComposition =
  createManuscriptSaveAsProductionRecoveryComposition({
    operations: manuscriptSaveAsOperationPort,
    d2: manuscriptSaveAsD2Adapter,
    activation: manuscriptSaveAsRuntimeActivation,
    gateway: rawManuscriptGateway,
    physicalObservation: manuscriptSaveAsPhysicalObservationPort,
    getFileRef: (id) => fileRefService.getById(id),
    listSessionConsumers: () =>
      sharedManuscriptSessionRuntime.listSessionConsumers(),
    readCustody: (operationId) =>
      manuscriptSaveAsCandidateCustodyPort.readback(operationId),
    readRuntimeBinding: (receiptId) =>
      sharedManuscriptSessionRuntime.readSaveAsCandidateBinding(receiptId),
    transferCustody: (input) =>
      manuscriptSaveAsCandidateCustodyPort.transfer(input),
    containWindowP: (input) =>
      manuscriptSaveAsWindowPContainment.contain(input),
    nextObservationGeneration
  });
