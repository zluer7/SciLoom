import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { experimentRunPickerWorkspaceResolver } from "./experimentRunPickerWorkspaceResolver";
import { listReferenceOwnerFormalSwitchRecoveries } from "./referenceOwnerFormalSwitchProductionBridge";
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
  experimentRunManuscriptSaveAsPresentationAdapter
} from "./experimentRunManuscriptSaveAsPresentationAdapter";
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

export interface ExperimentRunCanonicalPrepareTargetAcceptanceRequest {
  runId: string;
  sourceSessionKey: string;
  sourceMode: "current" | "independent";
  pickerTitle: string;
  operationRequestKey: string;
  requireManagedTarget: true;
}

export type ExperimentRunCanonicalSaveAsRecovery = SaveAsOperationRecord & {
  phase: SaveAsOperationRecord["stage"] | "prepared";
  targetFileName: string;
};

type ExperimentRunRecoveryResult =
  | { status: "success"; operationId: string; sessionKey: string }
  | {
      status: "error" | "recovery-required" | "blocked";
      operationId?: string;
      errorCode: string;
    }
  | WindowPContainedProductionRecoveryResult;

export interface ExperimentRunManuscriptSaveAsAdapterDependencies {
  ownerWritable(runId: string): Promise<boolean>;
  listSwitchRecoveries(runId: string): Promise<Array<{ phase: string }>>;
  selectTarget(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    dialogRequestGeneration: number;
    ownerFallbackFilename: string;
    title: string;
  }): Promise<Selection>;
  classifyTarget(runId: string, targetPath: string): Promise<Classification>;
  freezeSource?: typeof manuscriptSaveAsSourceSnapshot.freeze;
  validateFrozenSourceIdentity?: typeof manuscriptSaveAsSourceSnapshot.validateStableIdentity;
  createTargetAcceptanceId?: () => string;
  invoke(
    input: SharedManuscriptSaveAsInvocationInput
  ): Promise<SharedManuscriptSaveAsInvocationResult>;
  present(input: {
    runId: string;
    consumerId: string;
    result: SharedSaveAsEngineResult;
    acknowledgePresentation: SaveAsPresentationAcknowledger;
    frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
  }): Promise<
    | { status: "success"; sessionHandle: string; operation: SaveAsOperationRecord }
    | { status: "recovery-required"; failure?: unknown }
  >;
  listReconcilable(): Promise<SaveAsOperationRecord[]>;
  recoverOperation(
    input: ManuscriptSaveAsProductionRecoveryInput<"experimentRun">
  ): Promise<ManuscriptSaveAsProductionRecoveryResult<"experimentRun">>;
  resolveConfiguredRoot(runId: string): Promise<string | undefined>;
  readCustody(operationId: string): Promise<CandidateCustodyRecord | null>;
  finalization: ManuscriptSaveAsFinalizationCoordinator;
  lifecycle: ManuscriptSaveAsLifecycleRegistry;
}

function adapterError(code: string) {
  return {
    stage: "inspection",
    code,
    recoverability: "none",
    writeApplied: false as const
  };
}

type PreparedTargetAcceptance = {
  runId: string;
  operationRequestKey: string;
  sourceMode: "current" | "independent";
  sourceSessionKey: string;
  sourceFileRefId: string;
  sourcePathIdentityKey: string;
  sourceRuntimeGeneration: number;
  snapshotSha256: string;
  targetPath: string;
};

function fileNameFromPath(path: string) {
  return path.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "experiment-run.md";
}

function unresolvedSwitch(records: Array<{ phase: string }>) {
  return records.some(
    ({ phase }) => phase !== "resolved" && phase !== "cancelled_safe"
  );
}

export function createExperimentRunManuscriptSaveAsAdapter(
  dependencies: ExperimentRunManuscriptSaveAsAdapterDependencies
) {
  const preparedTargetAcceptances = new Map<string, PreparedTargetAcceptance>();
  let targetDialogGeneration = 0;

  function preparedTargetMatches(
    prepared: PreparedTargetAcceptance,
    frozen: FrozenSaveAsSourceEvidence,
    input: {
      runId: string;
      sourceSessionKey: string;
      sourceMode: "current" | "independent";
      operationRequestKey?: string;
    }
  ) {
    return prepared.runId === input.runId &&
      prepared.operationRequestKey === input.operationRequestKey &&
      prepared.sourceMode === input.sourceMode &&
      prepared.sourceSessionKey === frozen.sourceSessionKey &&
      prepared.sourceFileRefId === frozen.sourceFileRefId &&
      prepared.sourcePathIdentityKey === frozen.sourcePathIdentityKey &&
      prepared.sourceRuntimeGeneration === frozen.sourceRuntimeGeneration &&
      prepared.snapshotSha256 === frozen.snapshotSha256 &&
      frozen.operationId === prepared.operationRequestKey;
  }

  async function prepareTargetAcceptance(
    input: ExperimentRunCanonicalPrepareTargetAcceptanceRequest
  ) {
    if (
      !dependencies.freezeSource || !dependencies.validateFrozenSourceIdentity ||
      !input.operationRequestKey.trim() || input.operationRequestKey !== input.operationRequestKey.trim() ||
      Array.from(input.operationRequestKey).length > 200 || /[\0-\x1F\x7F]/u.test(input.operationRequestKey)
    ) {
      return { status: "error" as const, error: adapterError("SAVE_AS_SOURCE_SNAPSHOT_INVALID") };
    }
    if (!(await dependencies.ownerWritable(input.runId))) {
      return { status: "blocked" as const, error: adapterError("SAVE_AS_SOURCE_SNAPSHOT_INVALID") };
    }
    const frozen = await dependencies.freezeSource({
      owner: { ownerType: "experimentRun", ownerId: input.runId, channel: "primary" },
      sourceWindowRole: input.sourceMode,
      sourceRuntimeHandle: input.sourceSessionKey,
      operationRequestKey: input.operationRequestKey
    });
    if (!frozen.ok) {
      return { status: "error" as const, error: adapterError(frozen.failure.code) };
    }
    const selected = await dependencies.selectTarget({
      frozenSource: frozen.value,
      dialogRequestGeneration: ++targetDialogGeneration,
      ownerFallbackFilename: "experiment-run.md",
      title: input.pickerTitle
    });
    if (selected.status === "canceled") return { status: "canceled" as const };
    if (selected.status === "error") {
      return { status: "error" as const, error: adapterError(selected.errorCode) };
    }
    const classified = await dependencies.classifyTarget(input.runId, selected.path);
    if (
      classified.status === "error" ||
      (input.requireManagedTarget && classified.locationMode !== "managed")
    ) {
      return {
        status: "error" as const,
        error: adapterError(classified.status === "error"
          ? classified.errorCode
          : "SAVE_AS_TARGET_CANDIDATE_INVALID")
      };
    }
    if (!dependencies.validateFrozenSourceIdentity(frozen.value)) {
      return { status: "error" as const, error: adapterError("SAVE_AS_OPERATION_STALE") };
    }
    if (preparedTargetAcceptances.size >= 32) {
      return { status: "blocked" as const, error: adapterError("SAVE_AS_GUARD_CONFLICT") };
    }
    const targetAcceptanceId = dependencies.createTargetAcceptanceId?.() ??
      globalThis.crypto.randomUUID();
    if (
      !targetAcceptanceId.trim() || targetAcceptanceId !== targetAcceptanceId.trim() ||
      Array.from(targetAcceptanceId).length > 200 || /[\0-\x1F\x7F]/u.test(targetAcceptanceId) ||
      preparedTargetAcceptances.has(targetAcceptanceId)
    ) {
      return { status: "error" as const, error: adapterError("SAVE_AS_GUARD_CONFLICT") };
    }
    preparedTargetAcceptances.set(targetAcceptanceId, {
      runId: input.runId,
      operationRequestKey: input.operationRequestKey,
      sourceMode: input.sourceMode,
      sourceSessionKey: frozen.value.sourceSessionKey,
      sourceFileRefId: frozen.value.sourceFileRefId,
      sourcePathIdentityKey: frozen.value.sourcePathIdentityKey,
      sourceRuntimeGeneration: frozen.value.sourceRuntimeGeneration,
      snapshotSha256: frozen.value.snapshotSha256,
      targetPath: selected.path
    });
    return {
      status: "accepted" as const,
      targetAcceptanceId,
      operationId: input.operationRequestKey,
      targetFileName: fileNameFromPath(selected.path),
      targetIdentityDigest: createPathIdentityKey(selected.path),
      locationMode: "managed" as const
    };
  }

  async function finalizePresented(input: {
    trigger: SaveAsFinalizationTrigger;
    runId: string;
    operationId: string;
    fileRefId: string;
    independentSessionKey: string;
    consumerId: string;
    producer: "save-as" | "recovery";
  }) {
    const custody = await dependencies.readCustody(input.operationId);
    if (
      !custody || custody.operationId !== input.operationId ||
      custody.ownerType !== "experimentRun" || custody.ownerId !== input.runId ||
      custody.channel !== "primary" || custody.candidateFileRefId !== input.fileRefId ||
      custody.runtimeHandle !== input.independentSessionKey ||
      custody.runtimeConsumerId !== input.consumerId || custody.runtimeGeneration === undefined
    ) {
      return { status: "blocked" as const };
    }
    const lease = dependencies.lifecycle.mountOwner(
      "experimentRun",
      input.runId,
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
          ownerType: "experimentRun" as const,
          ownerId: input.runId,
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

  async function saveAs(input: {
    runId: string;
    sourceSessionKey: string;
    sourceMode: "current" | "independent";
    acknowledgePresentation: SaveAsPresentationAcknowledger;
    frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
    pickerTitle?: string;
    operationRequestKey?: string;
    targetAcceptanceId?: string;
    requireManagedTarget?: boolean;
  }) {
    const recoveries = await dependencies.listSwitchRecoveries(input.runId);
    if (unresolvedSwitch(recoveries)) {
      return {
        status: "error" as const,
        errorCode: "SAVE_AS_SOURCE_SNAPSHOT_INVALID"
      };
    }
    let acceptedConsumerId: string | undefined;
    const invoked = await dependencies.invoke({
      owner: {
        ownerType: "experimentRun",
        ownerId: input.runId,
        channel: "primary"
      },
      sourceWindowRole: input.sourceMode,
      sourceRuntimeHandle: input.sourceSessionKey,
      frozenDraftSnapshot: input.frozenDraftSnapshot,
      operationRequestKey: input.operationRequestKey,
      ownerWritable: () => dependencies.ownerWritable(input.runId),
      selectTarget: async (frozenSource, dialogRequestGeneration) => {
        if (!input.targetAcceptanceId) {
          return dependencies.selectTarget({
            frozenSource,
            dialogRequestGeneration,
            ownerFallbackFilename: "experiment-run.md",
            title: input.pickerTitle ?? "另存为"
          });
        }
        const prepared = preparedTargetAcceptances.get(input.targetAcceptanceId);
        preparedTargetAcceptances.delete(input.targetAcceptanceId);
        return prepared && preparedTargetMatches(prepared, frozenSource, input)
          ? { status: "selected" as const, path: prepared.targetPath }
          : { status: "error" as const, errorCode: "SAVE_AS_OPERATION_STALE" as const };
      },
      classifyTarget: async (targetPath) => {
        const classified = await dependencies.classifyTarget(input.runId, targetPath);
        return classified.status === "allowed" && input.requireManagedTarget &&
          classified.locationMode !== "managed"
          ? { status: "error" as const, errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID" as const }
          : classified;
      },
      createConsumerId: (snapshotId) =>
        `experimentRun:${input.runId}:save-as:${snapshotId}`,
      present: async ({ consumerId, result }) => {
        acceptedConsumerId = consumerId;
        return dependencies.present({
          runId: input.runId,
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
        errorCode: invoked.failure.code
      };
    }
    if (invoked.status === "presentation-recovery-required") {
      return {
        status: "recovery-required" as const,
        operationId: invoked.operationId,
        errorCode: "SAVE_AS_OPERATION_STALE"
      };
    }
    if (invoked.presentation.status !== "success" || !acceptedConsumerId) {
      return {
        status: "recovery-required" as const,
        operationId: invoked.result.operation.operationId,
        errorCode: "SAVE_AS_OPERATION_STALE"
      };
    }
    const finalization = await finalizePresented({
      trigger: "IMMEDIATE_RECEIPT",
      runId: input.runId,
      operationId: invoked.presentation.operation.operationId,
      fileRefId: invoked.result.d2.fileRef.id,
      independentSessionKey: invoked.presentation.sessionHandle,
      consumerId: acceptedConsumerId,
      producer: "save-as"
    });
    if (finalization.status !== "finalized") {
      return {
        status: finalization.status === "blocked" ? "blocked" : "recovery-required",
        operationId: invoked.presentation.operation.operationId,
        errorCode: "SAVE_AS_OPERATION_STALE"
      };
    }
    return {
      status: "success" as const,
      operationId: invoked.presentation.operation.operationId,
      sessionKey: invoked.presentation.sessionHandle,
      targetFileName: invoked.result.target.file.fileName,
      targetIdentityDigest: invoked.result.target.file.pathIdentity,
      targetRevision:
        invoked.result.r3.runtime.session.currentRevision ??
        invoked.result.r3.runtime.session.openedRevision ??
        invoked.result.operation.d1ReadbackRevision ??
        "",
      byteLength: invoked.result.operation.d1ByteLength ?? 0,
      fileRefId: invoked.result.d2.fileRef.id
    };
  }

  return Object.freeze({
    prepareTargetAcceptance,
    discardTargetAcceptance(targetAcceptanceId: string) {
      return preparedTargetAcceptances.delete(targetAcceptanceId);
    },
    saveAs,
    async listUnresolved(runId: string) {
      return (await dependencies.listReconcilable())
        .filter(
          (record) =>
            record.ownerType === "experimentRun" &&
            record.ownerId === runId &&
            record.channel === "primary"
        )
        .map((record): ExperimentRunCanonicalSaveAsRecovery => ({
          ...record,
          phase:
            record.stage === "pre_d1_claimed" ? "prepared" : record.stage,
          targetFileName: record.targetDisplayPath.replace(/^.*[\\/]/u, "")
        }));
    },
    async recover(
      operationId: string,
      runId: string,
      acknowledgePresentation: SaveAsPresentationAcknowledger
    ): Promise<ExperimentRunRecoveryResult> {
      const record = (await dependencies.listReconcilable()).find(
        (candidate) =>
          candidate.operationId === operationId &&
          candidate.ownerType === "experimentRun" &&
          candidate.ownerId === runId &&
          candidate.channel === "primary"
      );
      if (!record) {
        return { status: "error", errorCode: "SAVE_AS_OPERATION_STALE" };
      }
      let acceptedConsumerId: string | undefined;
      const recovered = await dependencies.recoverOperation({
        operationId,
        expectedOwner: {
          ownerType: "experimentRun",
          ownerId: runId,
          channel: "primary"
        },
        windowPMissingBindingContainment: {
          policyId: "window_p_fail_closed_v1"
        },
        configuredRoot:
          record.targetLocationMode === "managed"
            ? await dependencies.resolveConfiguredRoot(runId)
            : undefined,
        ownerWritable: () => dependencies.ownerWritable(runId),
        present: async ({ consumerId, result }) => {
          acceptedConsumerId = consumerId;
          return dependencies.present({
            runId,
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
            errorCode: "SAVE_AS_OPERATION_STALE"
          };
        }
        const finalization = await finalizePresented({
          trigger: "EXPLICIT_RETRY",
          runId,
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
            errorCode: "SAVE_AS_OPERATION_STALE"
          };
        }
        return {
          status: "success",
          operationId: recovered.operationId,
          sessionKey: recovered.sessionHandle
        };
      }
      if (recovered.status === "success") {
        return {
          status: "recovery-required",
          operationId: recovered.operationId,
          errorCode: "SAVE_AS_OPERATION_STALE"
        };
      }
      return {
        status: recovered.status,
        operationId: recovered.operationId,
        errorCode: recovered.errorCode
      };
    },
    async safeCancelRecovery(
      _operationId: string
    ): Promise<
      | { status: "canceled" }
      | { status: "blocked"; errorCode: string }
    > {
      return { status: "blocked", errorCode: "SAVE_AS_CANCELLED_PRE_D1" };
    }
  });
}

async function classifyRunTarget(
  runId: string,
  targetPath: string
): Promise<Classification> {
  if (targetPath.length > MANAGED_PATH_LIMITS.maximumAbsolutePath) {
    return { status: "error", errorCode: "SAVE_AS_PATH_INVALID" };
  }
  const [workspace, root] = await Promise.all([
    experimentRunPickerWorkspaceResolver.resolve(runId),
    managedRootConfigService.getStatus()
  ]);
  if (
    workspace.runWorkspace &&
    isPathWithinDirectory(workspace.runWorkspace.path, targetPath)
  ) {
    const conflicts =
      await fileRefService.getActiveManagedManuscriptPathConflicts(
        "experimentRun",
        runId,
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
            root.status === "configured"
              ? root.managedRoot
              : workspace.runWorkspace.path
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

export const experimentRunManuscriptSaveAsAdapter =
  createExperimentRunManuscriptSaveAsAdapter({
    async ownerWritable(runId) {
      try {
        return (await resolveMountedManuscriptLifecycleDecision({
          ownerType: "experimentRun",
          ownerId: runId,
          manuscriptChannel: "primary"
        })).canSaveAs;
      } catch {
        return false;
      }
    },
    listSwitchRecoveries: (runId) =>
      listReferenceOwnerFormalSwitchRecoveries("experimentRun", runId, "primary"),
    selectTarget: (input) => manuscriptSaveAsPlacementService.selectTarget({
      frozenSource: input.frozenSource,
      dialogRequestGeneration: input.dialogRequestGeneration,
      pickerTitle: input.title,
      ownerFallbackFilename: input.ownerFallbackFilename
    }),
    classifyTarget: classifyRunTarget,
    freezeSource: (input) => manuscriptSaveAsSourceSnapshot.freeze(input),
    validateFrozenSourceIdentity: (evidence) =>
      manuscriptSaveAsSourceSnapshot.validateStableIdentity(evidence),
    createTargetAcceptanceId: () => globalThis.crypto.randomUUID(),
    invoke: (input) =>
      sharedManuscriptSaveAsInvocationComposition.invoke(input),
    present: (input) =>
      experimentRunManuscriptSaveAsPresentationAdapter.present(input),
    listReconcilable: () => manuscriptSaveAsOperationPort.listReconcilable(),
    recoverOperation: (input) =>
      manuscriptSaveAsProductionRecoveryComposition.recover(input),
    async resolveConfiguredRoot(runId) {
      try {
        const root = await managedRootConfigService.getStatus();
        if (root.status === "configured") return root.managedRoot;
        return (await experimentRunPickerWorkspaceResolver.resolve(runId))
          .runWorkspace?.path;
      } catch {
        return undefined;
      }
    },
    readCustody: (operationId) =>
      manuscriptSaveAsCandidateCustodyPort.readback(operationId),
    finalization: manuscriptSaveAsFinalizationCoordinator,
    lifecycle: createManuscriptSaveAsLifecycleRegistry()
  });
