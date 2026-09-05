import type {
  ManuscriptChannel
} from "../types";
import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  getManagedPathParent,
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
  type WindowPContainedProductionRecoveryResult
} from "./manuscriptSaveAsProductionRecoveryComposition";
import {
  literatureManuscriptSaveAsPresentationAdapter
} from "./literatureManuscriptSaveAsPresentationAdapter";
import {
  resolveLiteratureWorkspaceFolder
} from "./literatureManuscriptService";
import {
  literatureRawManuscriptService
} from "./literatureRawManuscriptService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import type {
  LiteratureManuscriptCandidateCustodyReceipt,
  LiteratureManuscriptCandidateCustodyRequest
} from "./literatureManuscriptHandleProtectionRegistry";
import {
  sharedManuscriptSaveAsInvocationComposition,
  type SharedManuscriptSaveAsInvocationInput,
  type SharedManuscriptSaveAsInvocationResult
} from "./sharedManuscriptSaveAsCoreComposition";
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

export type LiteratureSaveAsChannel =
  | "literature_outline"
  | "dedicated_notes";

type LiteratureSaveAsPresentationInput = Parameters<
  typeof literatureManuscriptSaveAsPresentationAdapter.present
>[0];

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

export interface LiteratureCanonicalSaveAsRequest {
  literatureId: string;
  manuscriptChannel: LiteratureSaveAsChannel;
  sourceSessionKey: string;
  sourceWindowRole: "current" | "independent";
  pickerTitle: string;
  candidateCustody:
    LiteratureManuscriptCandidateCustodyRequest;
  frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
}

export interface LiteratureCanonicalAcceptedTargetSaveAsRequest {
  literatureId: string;
  manuscriptChannel: LiteratureSaveAsChannel;
  sourceSessionKey: string;
  sourceWindowRole: "independent";
  pickerTitle: string;
  operationRequestKey: string;
  targetAcceptanceId: string;
  requireManagedTarget: true;
}

export interface LiteratureCanonicalPrepareTargetAcceptanceRequest {
  literatureId: string;
  manuscriptChannel: LiteratureSaveAsChannel;
  sourceSessionKey: string;
  sourceWindowRole: "current" | "independent";
  pickerTitle: string;
  operationRequestKey: string;
  requireManagedTarget: true;
  /** Application-owned formal-operation target; when present no OS picker is invoked. */
  preselectedManagedTargetPath?: string;
}

export interface LiteratureManuscriptSaveAsAdapterDependencies {
  ownerWritable(
    literatureId: string,
    manuscriptChannel: LiteratureSaveAsChannel
  ): Promise<boolean>;
  selectTarget(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    dialogRequestGeneration: number;
    ownerFallbackFilename: string;
    title: string;
  }): Promise<Selection>;
  classifyTarget(
    literatureId: string,
    manuscriptChannel: LiteratureSaveAsChannel,
    targetPath: string
  ): Promise<Classification>;
  freezeSource?: typeof manuscriptSaveAsSourceSnapshot.freeze;
  validateFrozenSourceIdentity?: typeof manuscriptSaveAsSourceSnapshot.validateStableIdentity;
  createTargetAcceptanceId?: () => string;
  invoke(
    input: SharedManuscriptSaveAsInvocationInput
  ): Promise<SharedManuscriptSaveAsInvocationResult>;
  present(input: {
    literatureId: string;
    manuscriptChannel: LiteratureSaveAsChannel;
    consumerId: string;
    result: LiteratureSaveAsPresentationInput["result"];
  }): Promise<
    | {
        status: "success";
        sessionHandle: string;
        operation: SaveAsOperationRecord;
      }
    | { status: "recovery-required"; failure?: unknown }
  >;
  listReconcilable(): Promise<SaveAsOperationRecord[]>;
  recoverOperation(
    input: ManuscriptSaveAsProductionRecoveryInput
  ): ReturnType<
    typeof manuscriptSaveAsProductionRecoveryComposition.recover
  >;
  resolveConfiguredRoot(
    literatureId: string,
    manuscriptChannel: LiteratureSaveAsChannel
  ): Promise<string | undefined>;
  readCustody(
    operationId: string
  ): Promise<CandidateCustodyRecord | null>;
  finalization: ManuscriptSaveAsFinalizationCoordinator;
  lifecycle: ManuscriptSaveAsLifecycleRegistry;
}

function isLiteratureChannel(
  channel: ManuscriptChannel
): channel is LiteratureSaveAsChannel {
  return (
    channel === "literature_outline" ||
    channel === "dedicated_notes"
  );
}

function error(code: SaveAsFailureCode) {
  return {
    stage: "inspection",
    code,
    recoverability: "none",
    writeApplied: false as const
  };
}

type AdapterError = ReturnType<typeof error>;

type PreparedTargetAcceptance = {
  literatureId: string;
  manuscriptChannel: LiteratureSaveAsChannel;
  operationRequestKey: string;
  sourceWindowRole: "current" | "independent";
  sourceSessionKey: string;
  sourceFileRefId: string;
  sourcePathIdentityKey: string;
  sourceRuntimeGeneration: number;
  snapshotSha256: string;
  targetPath: string;
};

type LiteratureSaveAsInternalRequest =
  | LiteratureCanonicalSaveAsRequest
  | LiteratureCanonicalAcceptedTargetSaveAsRequest;

function fileNameFromPath(path: string) {
  return path.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "literature-outline.md";
}

type LiteratureCanonicalSaveAsResult =
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
      candidateCustody?:
        LiteratureManuscriptCandidateCustodyReceipt;
    }
  | {
      status:
        | "stale"
        | "conflict"
        | "error"
        | "recovery-required"
        | "blocked";
      operationId?: string;
      error: AdapterError;
    };

type LiteratureCanonicalRecoveryResult =
  | {
      status: "success";
      operationId: string;
      independentSessionKey: string;
      targetFileName: string;
      candidateCustody?:
        LiteratureManuscriptCandidateCustodyReceipt;
    }
  | {
      status: "error" | "recovery-required" | "blocked";
      operationId?: string;
      error: AdapterError;
    }
  | WindowPContainedProductionRecoveryResult;

export function createLiteratureManuscriptSaveAsAdapter(
  dependencies: LiteratureManuscriptSaveAsAdapterDependencies
) {
  const preparedTargetAcceptances = new Map<string, PreparedTargetAcceptance>();
  let targetDialogGeneration = 0;

  function preparedTargetMatches(
    prepared: PreparedTargetAcceptance,
    frozen: FrozenSaveAsSourceEvidence,
    input: LiteratureSaveAsInternalRequest
  ) {
    if (!("operationRequestKey" in input)) return false;
    return prepared.literatureId === input.literatureId &&
      prepared.manuscriptChannel === input.manuscriptChannel &&
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
    input: LiteratureCanonicalPrepareTargetAcceptanceRequest
  ) {
    if (
      !isLiteratureChannel(input.manuscriptChannel) ||
      !dependencies.freezeSource || !dependencies.validateFrozenSourceIdentity ||
      !input.operationRequestKey.trim() || input.operationRequestKey !== input.operationRequestKey.trim() ||
      Array.from(input.operationRequestKey).length > 200 || /[\0-\x1F\x7F]/u.test(input.operationRequestKey)
    ) {
      return { status: "error" as const, error: error("SAVE_AS_SOURCE_SNAPSHOT_INVALID") };
    }
    if (!(await dependencies.ownerWritable(input.literatureId, input.manuscriptChannel))) {
      return { status: "blocked" as const, error: error("SAVE_AS_SOURCE_SNAPSHOT_INVALID") };
    }
    const frozen = await dependencies.freezeSource({
      owner: {
        ownerType: "literature",
        ownerId: input.literatureId,
        channel: input.manuscriptChannel
      },
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceSessionKey,
      operationRequestKey: input.operationRequestKey
    });
    if (!frozen.ok) {
      return { status: "error" as const, error: error(frozen.failure.code) };
    }
    const selected = input.preselectedManagedTargetPath
      ? { status: "selected" as const, path: input.preselectedManagedTargetPath }
      : await dependencies.selectTarget({
          frozenSource: frozen.value,
          dialogRequestGeneration: ++targetDialogGeneration,
          ownerFallbackFilename: input.manuscriptChannel === "literature_outline"
            ? "literature-outline.md"
            : "literature-notes.md",
          title: input.pickerTitle
        });
    if (selected.status === "canceled") return { status: "canceled" as const };
    if (selected.status === "error") {
      return { status: "error" as const, error: error(selected.errorCode) };
    }
    const classified = await dependencies.classifyTarget(
      input.literatureId,
      input.manuscriptChannel,
      selected.path
    );
    if (
      classified.status === "error" ||
      input.requireManagedTarget && classified.locationMode !== "managed"
    ) {
      return {
        status: "error" as const,
        error: error(classified.status === "error"
          ? classified.errorCode
          : "SAVE_AS_TARGET_CANDIDATE_INVALID")
      };
    }
    if (!dependencies.validateFrozenSourceIdentity(frozen.value)) {
      return { status: "error" as const, error: error("SAVE_AS_OPERATION_STALE") };
    }
    if (preparedTargetAcceptances.size >= 32) {
      return { status: "blocked" as const, error: error("SAVE_AS_GUARD_CONFLICT") };
    }
    const targetAcceptanceId = dependencies.createTargetAcceptanceId?.() ??
      globalThis.crypto.randomUUID();
    if (
      !targetAcceptanceId.trim() || targetAcceptanceId !== targetAcceptanceId.trim() ||
      Array.from(targetAcceptanceId).length > 200 || /[\0-\x1F\x7F]/u.test(targetAcceptanceId) ||
      preparedTargetAcceptances.has(targetAcceptanceId)
    ) {
      return { status: "error" as const, error: error("SAVE_AS_GUARD_CONFLICT") };
    }
    preparedTargetAcceptances.set(targetAcceptanceId, {
      literatureId: input.literatureId,
      manuscriptChannel: input.manuscriptChannel,
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
    literatureId: string;
    manuscriptChannel: LiteratureSaveAsChannel;
    operationId: string;
    fileRefId: string;
    independentSessionKey: string;
    consumerId: string;
    producer: "save-as" | "recovery";
  }) {
    const custody = await dependencies.readCustody(
      input.operationId
    );
    if (
      !custody ||
      custody.operationId !== input.operationId ||
      custody.ownerType !== "literature" ||
      custody.ownerId !== input.literatureId ||
      custody.channel !== input.manuscriptChannel ||
      custody.candidateFileRefId !== input.fileRefId ||
      custody.runtimeHandle !== input.independentSessionKey ||
      custody.runtimeConsumerId !== input.consumerId ||
      custody.runtimeGeneration === undefined
    ) {
      return { status: "blocked" as const };
    }
    const lease = dependencies.lifecycle.mountOwner(
      "literature",
      input.literatureId,
      input.manuscriptChannel
    );
    const request = dependencies.lifecycle.beginCandidate({
      ownerLease: lease,
      producer: input.producer
    });
    if (!request) return { status: "blocked" as const };
    const presented = {
      operationId: input.operationId,
      fileRefId: input.fileRefId,
      independentSessionKey: input.independentSessionKey,
      candidateCustody: Object.freeze({
        request,
        handle: input.independentSessionKey,
        ownerType: "literature" as const,
        ownerId: input.literatureId,
        channel: input.manuscriptChannel,
        producer: input.producer,
        operationId: input.operationId,
        consumerId: input.consumerId,
        fileRefId: input.fileRefId,
        receiptId: custody.receiptId,
        receiptVersion: 1 as const,
        processGeneration: custody.processGeneration,
        runtimeGeneration: custody.runtimeGeneration,
        currentCustodyAuthority:
          custody.currentCustodyAuthority === "installed_session"
            ? "installed_session" as const
            : "outputs_adapter" as const
      })
    };
    return dependencies.finalization.finalize({
      trigger: input.trigger,
      presented,
      lifecycle: dependencies.lifecycle,
      sourceDisposition: "release"
    });
  }

  async function saveAs(
    input: LiteratureCanonicalSaveAsRequest
  ): Promise<LiteratureCanonicalSaveAsResult>;
  async function saveAs(
    input: LiteratureCanonicalAcceptedTargetSaveAsRequest
  ): Promise<LiteratureCanonicalSaveAsResult>;
  async function saveAs(
    input: LiteratureSaveAsInternalRequest
  ): Promise<LiteratureCanonicalSaveAsResult> {
    if (!isLiteratureChannel(input.manuscriptChannel)) {
      return {
        status: "error",
        error: error("SAVE_AS_SOURCE_SNAPSHOT_INVALID")
      };
    }
    const acceptedTargetRequest = "targetAcceptanceId" in input ? input : undefined;
    const ordinaryRequest = "candidateCustody" in input ? input : undefined;
    let acceptedConsumerId: string | undefined;
    const invoked = await dependencies.invoke({
      owner: {
        ownerType: "literature",
        ownerId: input.literatureId,
        channel: input.manuscriptChannel
      },
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceSessionKey,
      frozenDraftSnapshot: ordinaryRequest?.frozenDraftSnapshot,
      operationRequestKey: acceptedTargetRequest?.operationRequestKey,
      ownerWritable: () =>
        dependencies.ownerWritable(
          input.literatureId,
          input.manuscriptChannel
        ),
      selectTarget: async (frozenSource, dialogRequestGeneration) => {
        if (!acceptedTargetRequest) {
          return dependencies.selectTarget({
            frozenSource,
            dialogRequestGeneration,
            ownerFallbackFilename:
              input.manuscriptChannel === "literature_outline"
                ? "literature-outline.md"
                : "literature-notes.md",
            title: input.pickerTitle
          });
        }
        const prepared = preparedTargetAcceptances.get(acceptedTargetRequest.targetAcceptanceId);
        preparedTargetAcceptances.delete(acceptedTargetRequest.targetAcceptanceId);
        return prepared && preparedTargetMatches(prepared, frozenSource, input)
          ? { status: "selected" as const, path: prepared.targetPath }
          : { status: "error" as const, errorCode: "SAVE_AS_OPERATION_STALE" as const };
      },
      classifyTarget: async (targetPath) => {
        const classified = await dependencies.classifyTarget(
          input.literatureId,
          input.manuscriptChannel,
          targetPath
        );
        return classified.status === "allowed" && acceptedTargetRequest?.requireManagedTarget &&
          classified.locationMode !== "managed"
          ? { status: "error" as const, errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID" as const }
          : classified;
      },
      createConsumerId: (snapshotId) =>
        `literature:${input.literatureId}:${input.manuscriptChannel}:save-as:${snapshotId}`,
      present: async ({ consumerId, result }) => {
        acceptedConsumerId = consumerId;
        return dependencies.present({
          literatureId: input.literatureId,
          manuscriptChannel: input.manuscriptChannel,
          consumerId,
          result
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
    if (
      invoked.status ===
      "presentation-recovery-required"
    ) {
      return {
        status: "recovery-required",
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
      literatureId: input.literatureId,
      manuscriptChannel: input.manuscriptChannel,
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
      status: "success",
      operationId: presented.operation.operationId,
      targetFileName: executed.target.file.fileName,
      targetIdentityDigest:
        executed.target.file.pathIdentity,
      targetRevision:
        executed.r3.runtime.session.currentRevision ??
        executed.r3.runtime.session.openedRevision ??
        executed.operation.d1ReadbackRevision ??
        "",
      byteLength: executed.operation.d1ByteLength ?? 0,
      fileRefId: executed.d2.fileRef.id,
      independentSessionKey: presented.sessionHandle,
      ...(ordinaryRequest ? {
            candidateCustody: {
              request: ordinaryRequest.candidateCustody,
              handle: presented.sessionHandle,
              literatureId: input.literatureId,
              channel: input.manuscriptChannel,
              producer: "save-as" as const,
              operationId:
                presented.operation.operationId,
              consumerId: acceptedConsumerId,
              fileRefId: executed.d2.fileRef.id
            }
          } : {})
    };
  }

  async function recoverInternal(
    operationId: string,
    literatureId: string,
    manuscriptChannel: LiteratureSaveAsChannel,
    candidateCustody?: LiteratureManuscriptCandidateCustodyRequest
  ): Promise<LiteratureCanonicalRecoveryResult> {
    if (!isLiteratureChannel(manuscriptChannel)) {
      return { status: "error", error: error("SAVE_AS_OPERATION_STALE") };
    }
    const record = (await dependencies.listReconcilable()).find(
      (candidate) =>
        candidate.operationId === operationId &&
        candidate.ownerType === "literature" &&
        candidate.ownerId === literatureId &&
        candidate.channel === manuscriptChannel
    );
    if (!record) {
      return { status: "error", error: error("SAVE_AS_OPERATION_STALE") };
    }
    let acceptedConsumerId: string | undefined;
    const recovered = await dependencies.recoverOperation({
      operationId,
      expectedOwner: { ownerType: "literature", ownerId: literatureId, channel: manuscriptChannel },
      windowPMissingBindingContainment: { policyId: "window_p_fail_closed_v1" },
      configuredRoot: record.targetLocationMode === "managed"
        ? await dependencies.resolveConfiguredRoot(literatureId, manuscriptChannel)
        : undefined,
      ownerWritable: () => dependencies.ownerWritable(literatureId, manuscriptChannel),
      present: async ({ consumerId, result }) => {
        acceptedConsumerId = consumerId;
        return dependencies.present({ literatureId, manuscriptChannel, consumerId, result });
      }
    });
    if (recovered.status === "contained") return recovered;
    if (recovered.status === "success" && acceptedConsumerId) {
      const custody = await dependencies.readCustody(operationId);
      const fileRefId = custody?.candidateFileRefId;
      if (!fileRefId) {
        return { status: "recovery-required", operationId, error: error("SAVE_AS_OPERATION_STALE") };
      }
      const finalization = await finalizePresented({
        trigger: "EXPLICIT_RETRY",
        literatureId,
        manuscriptChannel,
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
        targetFileName: recovered.targetFileName,
        ...(candidateCustody
          ? {
              candidateCustody: {
                request: candidateCustody,
                handle: recovered.sessionHandle,
                literatureId,
                channel: manuscriptChannel,
                producer: "recovery" as const,
                operationId: recovered.operationId,
                consumerId: acceptedConsumerId
              }
            }
          : {})
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
    } as LiteratureCanonicalRecoveryResult;
  }

  return Object.freeze({
    prepareTargetAcceptance,
    discardTargetAcceptance(targetAcceptanceId: string) {
      return preparedTargetAcceptances.delete(targetAcceptanceId);
    },
    saveAs,
    async listUnresolved(
      literatureId: string,
      manuscriptChannel: LiteratureSaveAsChannel
    ) {
      if (!isLiteratureChannel(manuscriptChannel)) return [];
      return (await dependencies.listReconcilable()).filter(
        (record) =>
          record.ownerType === "literature" &&
          record.ownerId === literatureId &&
          record.channel === manuscriptChannel
      );
    },
    recover(
      operationId: string,
      literatureId: string,
      manuscriptChannel: LiteratureSaveAsChannel,
      candidateCustody: LiteratureManuscriptCandidateCustodyRequest
    ) {
      return recoverInternal(operationId, literatureId, manuscriptChannel, candidateCustody);
    },
    recoverAcceptedTarget(
      operationId: string,
      literatureId: string,
      manuscriptChannel: LiteratureSaveAsChannel
    ) {
      return recoverInternal(operationId, literatureId, manuscriptChannel);
    },
    async safeCancelRecovery() {
      return {
        status: "blocked" as const,
        error: error("SAVE_AS_CANCELLED_PRE_D1")
      };
    }
  });
}

async function literatureOwnerWritable(
  literatureId: string,
  manuscriptChannel: LiteratureSaveAsChannel
) {
  try {
    const lifecycle = await resolveMountedManuscriptLifecycleDecision({
      ownerType: "literature",
      ownerId: literatureId,
      manuscriptChannel
    });
    if (!lifecycle.canSaveAs) return false;
    const current =
      await literatureRawManuscriptService.resolveCurrentDescriptor(
        literatureId,
        manuscriptChannel
      );
    return current.status === "success";
  } catch {
    return false;
  }
}

async function classifyLiteratureTarget(
  literatureId: string,
  manuscriptChannel: LiteratureSaveAsChannel,
  targetPath: string
): Promise<Classification> {
  if (
    !isLiteratureChannel(manuscriptChannel) ||
    targetPath.length >
      MANAGED_PATH_LIMITS.maximumAbsolutePath
  ) {
    return {
      status: "error",
      errorCode: "SAVE_AS_PATH_INVALID"
    };
  }
  let workspace: Awaited<
    ReturnType<typeof resolveLiteratureWorkspaceFolder>
  >;
  let targetIdentity: string;
  try {
    workspace = await resolveLiteratureWorkspaceFolder(
      literatureId
    );
    targetIdentity = createPathIdentityKey(targetPath);
    const [ownerFileRefs, otherOwnerConflicts] =
      await Promise.all([
        fileRefService.getFileRefsByOwner(
          "literature",
          literatureId
        ),
        fileRefService.getActiveManuscriptPathConflicts(
          "literature",
          literatureId,
          targetIdentity
        )
      ]);
    const ownerConflict = ownerFileRefs.some(
      (fileRef) =>
        !fileRef.deletedAt &&
        fileRef.resourceKind === "file" &&
        fileRef.fileRole === "manuscript" &&
        fileRef.pathIdentityKey === targetIdentity &&
        createPathIdentityKey(fileRef.path) ===
          targetIdentity
    );
    if (ownerConflict || otherOwnerConflicts.length > 0) {
      return {
        status: "error",
        errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
      };
    }
  } catch {
    return {
      status: "error",
      errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }
  if (isPathWithinDirectory(workspace.path, targetPath)) {
    if (
      createPathIdentityKey(
        getManagedPathParent(targetPath)
      ) !== createPathIdentityKey(workspace.path)
    ) {
      return {
        status: "error",
        errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
      };
    }
    return {
      status: "allowed",
      locationMode: "managed",
      configuredRoot: workspace.managedRoot
    };
  }
  if (
    isPathWithinDirectory(workspace.managedRoot, targetPath)
  ) {
    return {
      status: "error",
      errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }
  return { status: "allowed", locationMode: "external" };
}

export const literatureManuscriptSaveAsAdapter =
  createLiteratureManuscriptSaveAsAdapter({
    ownerWritable: literatureOwnerWritable,
    selectTarget: (input) => manuscriptSaveAsPlacementService.selectTarget({
      frozenSource: input.frozenSource,
      dialogRequestGeneration: input.dialogRequestGeneration,
      pickerTitle: input.title,
      ownerFallbackFilename: input.ownerFallbackFilename
    }),
    classifyTarget: classifyLiteratureTarget,
    freezeSource: (input) => manuscriptSaveAsSourceSnapshot.freeze(input),
    validateFrozenSourceIdentity: (input) =>
      manuscriptSaveAsSourceSnapshot.validateStableIdentity(input),
    createTargetAcceptanceId: () => globalThis.crypto.randomUUID(),
    invoke: (input) =>
      sharedManuscriptSaveAsInvocationComposition.invoke(input),
    present: (input) =>
      literatureManuscriptSaveAsPresentationAdapter.present(input),
    listReconcilable: () =>
      manuscriptSaveAsOperationPort.listReconcilable(),
    recoverOperation: (input) =>
      manuscriptSaveAsProductionRecoveryComposition.recover(input),
    readCustody: (operationId) =>
      manuscriptSaveAsCandidateCustodyPort.readback(operationId),
    finalization: manuscriptSaveAsFinalizationCoordinator,
    lifecycle: createManuscriptSaveAsLifecycleRegistry(),
    async resolveConfiguredRoot(literatureId) {
      try {
        return (
          await resolveLiteratureWorkspaceFolder(
            literatureId
          )
        ).managedRoot;
      } catch {
        const root = await managedRootConfigService.getStatus();
        return root.status === "configured"
          ? root.managedRoot
          : undefined;
      }
    }
  });
