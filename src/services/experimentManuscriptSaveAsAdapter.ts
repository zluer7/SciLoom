import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { experimentManuscriptSelectionService } from "./experimentManuscriptSelectionService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  isPathWithinDirectory,
  MANAGED_PATH_LIMITS
} from "./managedPathService";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import { manuscriptSaveAsSourceSnapshot } from "./manuscriptSaveAsSourceSnapshot";
import {
  manuscriptSaveAsProductionRecoveryComposition,
  type ManuscriptSaveAsProductionRecoveryInput,
  type ManuscriptSaveAsProductionRecoveryResult,
  type WindowPContainedProductionRecoveryResult
} from "./manuscriptSaveAsProductionRecoveryComposition";
import {
  experimentManuscriptSaveAsPresentationAdapter
} from "./experimentManuscriptSaveAsPresentationAdapter";
import {
  sharedManuscriptSaveAsInvocationComposition,
  type SharedManuscriptSaveAsInvocationInput,
  type SharedManuscriptSaveAsInvocationResult
} from "./sharedManuscriptSaveAsCoreComposition";
import type { SharedSaveAsEngineResult } from "./sharedManuscriptSaveAsEngine";
import type { SaveAsPresentationAcknowledger } from "./manuscriptSaveAsPresentationProtocol";
import { manuscriptSaveAsPlacementService } from "./manuscriptSaveAsPlacementService";
import {
  manuscriptSaveAsCandidateCustodyPort,
  type CandidateCustodyRecord
} from "./manuscriptSaveAsCandidateCustody";
import {
  manuscriptSaveAsFinalizationCoordinator,
  type ManuscriptSaveAsFinalizationCoordinator,
  type SaveAsFinalizationTrigger
} from "./manuscriptSaveAsFinalizationCoordinator";
import {
  createManuscriptSaveAsLifecycleRegistry,
  type ManuscriptSaveAsLifecycleRegistry
} from "./manuscriptSaveAsLifecycleRegistry";

type Selection =
  | { status: "selected"; path: string }
  | { status: "canceled" }
  | { status: "error"; errorCode: SaveAsFailureCode };

type Classification =
  | {
      status: "allowed";
      locationMode: "managed" | "external";
      configuredRoot?: string;
    }
  | { status: "error"; errorCode: SaveAsFailureCode };

export interface ExperimentCanonicalSaveAsRequest {
  experimentId: string;
  sourceSessionKey: string;
  sourceWindowRole: "current" | "independent";
  pickerTitle: string;
  acknowledgePresentation: SaveAsPresentationAcknowledger;
  frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
  operationRequestKey?: string;
  targetAcceptanceId?: string;
  requireManagedTarget?: boolean;
}

export interface ExperimentCanonicalPrepareTargetAcceptanceRequest {
  experimentId: string;
  sourceSessionKey: string;
  sourceWindowRole: "current" | "independent";
  pickerTitle: string;
  operationRequestKey: string;
  requireManagedTarget: true;
}

export interface ExperimentManuscriptSaveAsAdapterDependencies {
  ownerWritable(experimentId: string): Promise<boolean>;
  selectTarget(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    dialogRequestGeneration: number;
    ownerFallbackFilename: string;
    title: string;
  }): Promise<Selection>;
  classifyTarget(experimentId: string, targetPath: string): Promise<Classification>;
  freezeSource?: typeof manuscriptSaveAsSourceSnapshot.freeze;
  validateFrozenSourceIdentity?: typeof manuscriptSaveAsSourceSnapshot.validateStableIdentity;
  createTargetAcceptanceId?: () => string;
  invoke(
    input: SharedManuscriptSaveAsInvocationInput
  ): Promise<SharedManuscriptSaveAsInvocationResult>;
  present(input: {
    experimentId: string;
    consumerId: string;
    result: SharedSaveAsEngineResult;
    acknowledgePresentation: SaveAsPresentationAcknowledger;
  }): Promise<
    | { status: "success"; sessionHandle: string; operation: SaveAsOperationRecord }
    | { status: "recovery-required"; failure?: unknown }
  >;
  listReconcilable(): Promise<SaveAsOperationRecord[]>;
  recoverOperation(
    input: ManuscriptSaveAsProductionRecoveryInput<"experiment">
  ): Promise<ManuscriptSaveAsProductionRecoveryResult<"experiment">>;
  resolveConfiguredRoot(experimentId: string): Promise<string | undefined>;
  readCustody(operationId: string): Promise<CandidateCustodyRecord | null>;
  finalization: ManuscriptSaveAsFinalizationCoordinator;
  lifecycle: ManuscriptSaveAsLifecycleRegistry;
}

function error(code: string) {
  return {
    stage: "inspection",
    code,
    recoverability: "none",
    writeApplied: false as const
  };
}

type AdapterError = ReturnType<typeof error>;

type ExperimentCanonicalSaveAsResult =
  | { status: "canceled" }
  | {
      status: "success";
      operationId: string;
      targetFileName: string;
      targetIdentityDigest: string;
      targetRevision: string;
      byteLength: number;
      fileRefId: string;
      independentSessionKey: string;
    }
  | {
      status: "stale" | "conflict" | "error" | "recovery-required" | "blocked";
      operationId?: string;
      error: AdapterError;
    };

type ExperimentCanonicalRecoveryResult =
  | {
      status: "success";
      operationId: string;
      independentSessionKey: string;
      targetFileName: string;
    }
  | {
      status: "error" | "recovery-required" | "blocked";
      operationId?: string;
      error: AdapterError;
    }
  | WindowPContainedProductionRecoveryResult;

type ExperimentCanonicalTargetAcceptanceResult =
  | { status: "canceled" }
  | {
      status: "accepted";
      targetAcceptanceId: string;
      operationId: string;
      targetFileName: string;
      locationMode: "managed";
    }
  | { status: "error" | "blocked"; error: AdapterError };

type PreparedTargetAcceptance = {
  experimentId: string;
  operationRequestKey: string;
  sourceWindowRole: "current" | "independent";
  sourceSessionKey: string;
  sourceFileRefId: string;
  sourcePathIdentityKey: string;
  sourceRuntimeGeneration: number;
  snapshotSha256: string;
  targetPath: string;
};

function fileNameFromPath(path: string) {
  return path.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "experiment.md";
}

export function createExperimentManuscriptSaveAsAdapter(
  dependencies: ExperimentManuscriptSaveAsAdapterDependencies
) {
  const preparedTargetAcceptances = new Map<string, PreparedTargetAcceptance>();
  let targetDialogGeneration = 0;

  function preparedTargetMatches(
    prepared: PreparedTargetAcceptance,
    frozen: FrozenSaveAsSourceEvidence,
    input: ExperimentCanonicalSaveAsRequest
  ) {
    return prepared.experimentId === input.experimentId &&
      prepared.operationRequestKey === input.operationRequestKey &&
      prepared.sourceWindowRole === input.sourceWindowRole &&
      prepared.sourceSessionKey === frozen.sourceSessionKey &&
      prepared.sourceFileRefId === frozen.sourceFileRefId &&
      prepared.sourcePathIdentityKey === frozen.sourcePathIdentityKey &&
      prepared.sourceRuntimeGeneration === frozen.sourceRuntimeGeneration &&
      prepared.snapshotSha256 === frozen.snapshotSha256 &&
      frozen.operationId === prepared.operationRequestKey;
  }

  async function prepareTargetAcceptance(
    input: ExperimentCanonicalPrepareTargetAcceptanceRequest
  ): Promise<ExperimentCanonicalTargetAcceptanceResult> {
    if (
      !dependencies.freezeSource || !dependencies.validateFrozenSourceIdentity ||
      !input.operationRequestKey.trim() || input.operationRequestKey !== input.operationRequestKey.trim() ||
      Array.from(input.operationRequestKey).length > 200 || /[\0-\x1F\x7F]/u.test(input.operationRequestKey)
    ) {
      return { status: "error", error: error("SAVE_AS_SOURCE_SNAPSHOT_INVALID") };
    }
    if (!(await dependencies.ownerWritable(input.experimentId))) {
      return { status: "blocked", error: error("SAVE_AS_SOURCE_SNAPSHOT_INVALID") };
    }
    const frozen = await dependencies.freezeSource({
      owner: {
        ownerType: "experiment",
        ownerId: input.experimentId,
        channel: "primary"
      },
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceSessionKey,
      operationRequestKey: input.operationRequestKey
    });
    if (!frozen.ok) return { status: "error", error: error(frozen.failure.code) };
    const selected = await dependencies.selectTarget({
      frozenSource: frozen.value,
      dialogRequestGeneration: ++targetDialogGeneration,
      ownerFallbackFilename: "experiment.md",
      title: input.pickerTitle
    });
    if (selected.status === "canceled") return { status: "canceled" };
    if (selected.status === "error") {
      return { status: "error", error: error(selected.errorCode) };
    }
    const classified = await dependencies.classifyTarget(input.experimentId, selected.path);
    if (
      classified.status === "error" ||
      (input.requireManagedTarget && classified.locationMode !== "managed")
    ) {
      return {
        status: "error",
        error: error(classified.status === "error"
          ? classified.errorCode
          : "SAVE_AS_TARGET_CANDIDATE_INVALID")
      };
    }
    if (!dependencies.validateFrozenSourceIdentity(frozen.value)) {
      return { status: "error", error: error("SAVE_AS_OPERATION_STALE") };
    }
    if (preparedTargetAcceptances.size >= 32) {
      return { status: "blocked", error: error("SAVE_AS_GUARD_CONFLICT") };
    }
    const targetAcceptanceId = dependencies.createTargetAcceptanceId?.() ??
      globalThis.crypto.randomUUID();
    if (
      !targetAcceptanceId.trim() || targetAcceptanceId !== targetAcceptanceId.trim() ||
      Array.from(targetAcceptanceId).length > 200 || /[\0-\x1F\x7F]/u.test(targetAcceptanceId) ||
      preparedTargetAcceptances.has(targetAcceptanceId)
    ) {
      return { status: "error", error: error("SAVE_AS_GUARD_CONFLICT") };
    }
    preparedTargetAcceptances.set(targetAcceptanceId, {
      experimentId: input.experimentId,
      operationRequestKey: input.operationRequestKey,
      sourceWindowRole: input.sourceWindowRole,
      sourceSessionKey: frozen.value.sourceSessionKey,
      sourceFileRefId: frozen.value.sourceFileRefId,
      sourcePathIdentityKey: frozen.value.sourcePathIdentityKey,
      sourceRuntimeGeneration: frozen.value.sourceRuntimeGeneration,
      snapshotSha256: frozen.value.snapshotSha256,
      targetPath: selected.path
    });
    return {
      status: "accepted",
      targetAcceptanceId,
      operationId: input.operationRequestKey,
      targetFileName: fileNameFromPath(selected.path),
      locationMode: "managed"
    };
  }

  async function finalizePresented(input: {
    trigger: SaveAsFinalizationTrigger;
    experimentId: string;
    operationId: string;
    fileRefId: string;
    independentSessionKey: string;
    consumerId: string;
    producer: "save-as" | "recovery";
  }) {
    const custody = await dependencies.readCustody(input.operationId);
    if (
      !custody || custody.operationId !== input.operationId ||
      custody.ownerType !== "experiment" || custody.ownerId !== input.experimentId ||
      custody.channel !== "primary" || custody.candidateFileRefId !== input.fileRefId ||
      custody.runtimeHandle !== input.independentSessionKey ||
      custody.runtimeConsumerId !== input.consumerId || custody.runtimeGeneration === undefined
    ) {
      return { status: "blocked" as const };
    }
    const lease = dependencies.lifecycle.mountOwner(
      "experiment",
      input.experimentId,
      "primary"
    );
    const request = dependencies.lifecycle.beginCandidate({
      ownerLease: lease,
      producer: input.producer
    });
    if (!request) return { status: "blocked" as const };
    return dependencies.finalization.finalize({
      trigger: input.trigger,
      presented: {
        operationId: input.operationId,
        fileRefId: input.fileRefId,
        independentSessionKey: input.independentSessionKey,
        candidateCustody: Object.freeze({
          request,
          handle: input.independentSessionKey,
          ownerType: "experiment" as const,
          ownerId: input.experimentId,
          channel: "primary" as const,
          producer: input.producer,
          operationId: input.operationId,
          consumerId: input.consumerId,
          fileRefId: input.fileRefId,
          receiptId: custody.receiptId,
          receiptVersion: 1 as const,
          processGeneration: custody.processGeneration,
          runtimeGeneration: custody.runtimeGeneration,
          currentCustodyAuthority: custody.currentCustodyAuthority === "installed_session"
            ? "installed_session" as const
            : "outputs_adapter" as const
        })
      },
      lifecycle: dependencies.lifecycle,
      sourceDisposition: "release"
    });
  }

  async function saveAs(
    input: ExperimentCanonicalSaveAsRequest
  ): Promise<ExperimentCanonicalSaveAsResult> {
    let acceptedConsumerId: string | undefined;
    const invoked = await dependencies.invoke({
      owner: {
        ownerType: "experiment",
        ownerId: input.experimentId,
        channel: "primary"
      },
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceSessionKey,
      frozenDraftSnapshot: input.frozenDraftSnapshot,
      operationRequestKey: input.operationRequestKey,
      ownerWritable: () =>
        dependencies.ownerWritable(input.experimentId),
      selectTarget: async (frozenSource, dialogRequestGeneration) => {
        if (!input.targetAcceptanceId) {
          return dependencies.selectTarget({
            frozenSource,
            dialogRequestGeneration,
            ownerFallbackFilename: "experiment.md",
            title: input.pickerTitle
          });
        }
        const prepared = preparedTargetAcceptances.get(input.targetAcceptanceId);
        preparedTargetAcceptances.delete(input.targetAcceptanceId);
        return prepared && preparedTargetMatches(prepared, frozenSource, input)
          ? { status: "selected" as const, path: prepared.targetPath }
          : { status: "error" as const, errorCode: "SAVE_AS_OPERATION_STALE" as const };
      },
      classifyTarget: async (targetPath) => {
        const classified = await dependencies.classifyTarget(input.experimentId, targetPath);
        return classified.status === "allowed" && input.requireManagedTarget &&
          classified.locationMode !== "managed"
          ? { status: "error" as const, errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID" as const }
          : classified;
      },
      createConsumerId: (snapshotId) =>
        `experiment:${input.experimentId}:save-as:${snapshotId}`,
      present: async ({ consumerId, result }) => {
        acceptedConsumerId = consumerId;
        return dependencies.present({
          experimentId: input.experimentId,
          consumerId,
          result,
          acknowledgePresentation: input.acknowledgePresentation
        });
      }
    });
    if (invoked.status === "canceled") return invoked;
    if (invoked.status === "failed") {
      return {
        status:
          invoked.failure.writeApplied === false
            ? "error"
            : "recovery-required",
        operationId: invoked.operationId,
        error: error(invoked.failure.code)
      };
    }
    if (invoked.status === "presentation-recovery-required") {
      return {
        status: "recovery-required" as const,
        operationId: invoked.operationId,
        error: error("SAVE_AS_OPERATION_STALE")
      };
    }
    const executed = invoked.result;
    const presented = invoked.presentation;
    if (!acceptedConsumerId) {
      return {
        status: "recovery-required",
        operationId: presented.operation.operationId,
        error: error("SAVE_AS_OPERATION_STALE")
      };
    }
    const finalization = await finalizePresented({
      trigger: "IMMEDIATE_RECEIPT",
      experimentId: input.experimentId,
      operationId: presented.operation.operationId,
      fileRefId: executed.d2.fileRef.id,
      independentSessionKey: presented.sessionHandle,
      consumerId: acceptedConsumerId,
      producer: "save-as"
    });
    if (finalization.status !== "finalized") {
      return {
        status: finalization.status === "blocked" ? "blocked" : "recovery-required",
        operationId: presented.operation.operationId,
        error: error("SAVE_AS_OPERATION_STALE")
      };
    }
    return {
      status: "success" as const,
      operationId: presented.operation.operationId,
      targetFileName: executed.target.file.fileName,
      targetIdentityDigest: executed.target.file.pathIdentity,
      targetRevision:
        executed.r3.runtime.session.currentRevision ??
        executed.r3.runtime.session.openedRevision ??
        executed.operation.d1ReadbackRevision ??
        "",
      byteLength: executed.operation.d1ByteLength ?? 0,
      fileRefId: executed.d2.fileRef.id,
      independentSessionKey: presented.sessionHandle
    };
  }

  return Object.freeze({
    prepareTargetAcceptance,
    discardTargetAcceptance(targetAcceptanceId: string) {
      return preparedTargetAcceptances.delete(targetAcceptanceId);
    },
    saveAs,
    async listUnresolved(experimentId: string) {
      return (await dependencies.listReconcilable()).filter(
        (record) =>
          record.ownerType === "experiment" &&
          record.ownerId === experimentId &&
          record.channel === "primary"
      );
    },
    async recover(
      operationId: string,
      experimentId: string,
      acknowledgePresentation: SaveAsPresentationAcknowledger
    ): Promise<ExperimentCanonicalRecoveryResult> {
      const record = (await dependencies.listReconcilable()).find(
        (candidate) =>
          candidate.operationId === operationId &&
          candidate.ownerType === "experiment" &&
          candidate.ownerId === experimentId &&
          candidate.channel === "primary"
      );
      if (!record) {
        return { status: "error", error: error("SAVE_AS_OPERATION_STALE") };
      }
      let acceptedConsumerId: string | undefined;
      const recovered = await dependencies.recoverOperation({
        operationId,
        expectedOwner: {
          ownerType: "experiment",
          ownerId: experimentId,
          channel: "primary"
        },
        windowPMissingBindingContainment: {
          policyId: "window_p_fail_closed_v1"
        },
        configuredRoot:
          record.targetLocationMode === "managed"
            ? await dependencies.resolveConfiguredRoot(experimentId)
            : undefined,
        ownerWritable: () => dependencies.ownerWritable(experimentId),
        present: async ({ consumerId, result }) => {
          acceptedConsumerId = consumerId;
          return dependencies.present({
            experimentId,
            consumerId,
            result,
            acknowledgePresentation
          });
        }
      });
      if (recovered.status === "contained") return recovered;
      if (recovered.status === "success" && acceptedConsumerId) {
        const custody = await dependencies.readCustody(operationId);
        const fileRefId = custody?.candidateFileRefId;
        if (!fileRefId) {
          return {
            status: "recovery-required",
            operationId,
            error: error("SAVE_AS_OPERATION_STALE")
          };
        }
        const finalization = await finalizePresented({
          trigger: "EXPLICIT_RETRY",
          experimentId,
          operationId,
          fileRefId,
          independentSessionKey: recovered.sessionHandle,
          consumerId: acceptedConsumerId,
          producer: "recovery"
        });
        if (finalization.status !== "finalized") {
          return {
            status: finalization.status === "blocked" ? "blocked" : "recovery-required",
            operationId,
            error: error("SAVE_AS_OPERATION_STALE")
          };
        }
        return {
          status: "success",
          operationId: recovered.operationId,
          independentSessionKey: recovered.sessionHandle,
          targetFileName: recovered.targetFileName
        };
      }
      if (recovered.status === "success") {
        return {
          status: "recovery-required",
          operationId: recovered.operationId,
          error: error("SAVE_AS_OPERATION_STALE")
        };
      }
      return {
        status: recovered.status,
        operationId: recovered.operationId,
        error: error(recovered.errorCode)
      };
    },
    async safeCancelRecovery() {
      return {
        status: "blocked" as const,
        error: error("SAVE_AS_CANCELLED_PRE_D1")
      };
    }
  });
}

export async function classifyExperimentTarget(
  experimentId: string,
  targetPath: string
): Promise<Classification> {
  if (targetPath.length > MANAGED_PATH_LIMITS.maximumAbsolutePath) {
    return { status: "error", errorCode: "SAVE_AS_PATH_INVALID" };
  }
  const [workspace, root] = await Promise.all([
    experimentManuscriptSelectionService.resolveWorkspace(experimentId),
    managedRootConfigService.getStatus()
  ]);
  if (isPathWithinDirectory(workspace.path, targetPath)) {
    const conflicts =
      await fileRefService.getActiveManagedManuscriptPathConflicts(
        "experiment",
        experimentId,
        createPathIdentityKey(targetPath)
      );
    return conflicts.length
      ? {
          status: "error",
          errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
        }
      : {
          status: "allowed",
          locationMode: "managed",
          configuredRoot:
            root.status === "configured" ? root.managedRoot : workspace.path
        };
  }
  if (
    root.status === "configured" &&
    isPathWithinDirectory(root.managedRoot, targetPath)
  ) {
    return {
      status: "error",
      errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }
  return { status: "allowed", locationMode: "external" };
}

export const experimentManuscriptSaveAsAdapter =
  createExperimentManuscriptSaveAsAdapter({
    async ownerWritable(experimentId) {
      try {
        return (await resolveMountedManuscriptLifecycleDecision({
          ownerType: "experiment",
          ownerId: experimentId,
          manuscriptChannel: "primary"
        })).canSaveAs;
      } catch {
        return false;
      }
    },
    selectTarget: (input) => manuscriptSaveAsPlacementService.selectTarget({
      frozenSource: input.frozenSource,
      dialogRequestGeneration: input.dialogRequestGeneration,
      pickerTitle: input.title,
      ownerFallbackFilename: input.ownerFallbackFilename
    }),
    classifyTarget: classifyExperimentTarget,
    freezeSource: (input) => manuscriptSaveAsSourceSnapshot.freeze(input),
    validateFrozenSourceIdentity: (evidence) =>
      manuscriptSaveAsSourceSnapshot.validateStableIdentity(evidence),
    createTargetAcceptanceId: () => globalThis.crypto.randomUUID(),
    invoke: (input) =>
      sharedManuscriptSaveAsInvocationComposition.invoke(input),
    present: (input) =>
      experimentManuscriptSaveAsPresentationAdapter.present(input),
    listReconcilable: () => manuscriptSaveAsOperationPort.listReconcilable(),
    recoverOperation: (input) =>
      manuscriptSaveAsProductionRecoveryComposition.recover(input),
    async resolveConfiguredRoot(experimentId) {
      try {
        const root = await managedRootConfigService.getStatus();
        if (root.status === "configured") return root.managedRoot;
        return (
          await experimentManuscriptSelectionService.resolveWorkspace(
            experimentId
          )
        ).path;
      } catch {
        return undefined;
      }
    },
    readCustody: (operationId) =>
      manuscriptSaveAsCandidateCustodyPort.readback(operationId),
    finalization: manuscriptSaveAsFinalizationCoordinator,
    lifecycle: createManuscriptSaveAsLifecycleRegistry()
  });
