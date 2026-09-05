import type {
  FrozenSaveAsSourceEvidence,
  SaveAsFailureCode
} from "../types/manuscriptSaveAs";
import type { ManuscriptSegmentDraftSnapshot } from "../types/manuscriptSegmentProjection";
import { createPathIdentityKey } from "./fileRefIdentity";
import { fileRefService } from "./fileRefService";
import { managedRootConfigService } from "./managedRootConfigService";
import { isPathWithinDirectory } from "./managedPathService";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import {
  manuscriptSaveAsProductionRecoveryComposition,
  type ManuscriptSaveAsProductionRecoveryInput,
  type WindowPContainedProductionRecoveryResult
} from "./manuscriptSaveAsProductionRecoveryComposition";
import { reviewManuscriptPageStateService } from "./reviewManuscriptPageStateService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { resolveReviewWorkspaceFolder } from "./reviewManuscriptSelectionService";
import {
  reviewManuscriptSaveAsPresentationAdapter
} from "./reviewManuscriptSaveAsPresentationAdapter";
import {
  sharedManuscriptSaveAsInvocationComposition,
  type SharedManuscriptSaveAsInvocationInput,
  type SharedManuscriptSaveAsInvocationResult
} from "./sharedManuscriptSaveAsCoreComposition";
import type { SharedSaveAsEngineResult } from "./sharedManuscriptSaveAsEngine";
import { manuscriptSaveAsPlacementService } from "./manuscriptSaveAsPlacementService";

type Selection =
  | { status: "selected"; path: string }
  | { status: "canceled" }
  | {
      status: "error";
      errorCode: SaveAsFailureCode;
      selectionFailure?: "CAPABILITY_DENIED" | "DIALOG_FAILED" | "PATH_INVALID";
    };

type Classification =
  | {
      status: "allowed";
      locationMode: "managed" | "external";
      configuredRoot?: string;
    }
  | { status: "error"; errorCode: SaveAsFailureCode };

export interface ReviewCanonicalSaveAsRequest {
  reviewId: string;
  sourceSessionKey: string;
  sourceWindowRole: "current" | "independent";
  pickerTitle: string;
  frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot;
}

export interface ReviewManuscriptSaveAsAdapterDependencies {
  ownerWritable(reviewId: string): Promise<boolean>;
  selectTarget(input: {
    frozenSource: FrozenSaveAsSourceEvidence;
    dialogRequestGeneration: number;
    ownerFallbackFilename: string;
    title: string;
  }): Promise<Selection>;
  classifyTarget(
    reviewId: string,
    targetPath: string
  ): Promise<Classification>;
  invoke(
    input: SharedManuscriptSaveAsInvocationInput
  ): Promise<SharedManuscriptSaveAsInvocationResult>;
  present(input: {
    reviewId: string;
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
  listReconcilable(): Promise<SaveAsOperationRecord[]>;
  recoverOperation(
    input: ManuscriptSaveAsProductionRecoveryInput
  ): ReturnType<
    typeof manuscriptSaveAsProductionRecoveryComposition.recover
  >;
  resolveConfiguredRoot(reviewId: string): Promise<string | undefined>;
}

function error(
  code: SaveAsFailureCode,
  selectionFailure?: "CAPABILITY_DENIED" | "DIALOG_FAILED" | "PATH_INVALID"
) {
  return {
    stage: "inspection",
    code,
    selectionFailure,
    recoverability: "none",
    writeApplied: false as const
  };
}

type AdapterError = ReturnType<typeof error>;

type ReviewCanonicalSaveAsResult =
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
      status:
        | "stale"
        | "conflict"
        | "error"
        | "recovery-required"
        | "blocked";
      operationId?: string;
      error: AdapterError;
    };

type ReviewCanonicalRecoveryResult =
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

export function createReviewManuscriptSaveAsAdapter(
  dependencies: ReviewManuscriptSaveAsAdapterDependencies
) {
  async function saveAs(
    input: ReviewCanonicalSaveAsRequest
  ): Promise<ReviewCanonicalSaveAsResult> {
    let selectionFailure:
      | "CAPABILITY_DENIED"
      | "DIALOG_FAILED"
      | "PATH_INVALID"
      | undefined;
    const invoked = await dependencies.invoke({
      owner: {
        ownerType: "review",
        ownerId: input.reviewId,
        channel: "primary"
      },
      sourceWindowRole: input.sourceWindowRole,
      sourceRuntimeHandle: input.sourceSessionKey,
      frozenDraftSnapshot: input.frozenDraftSnapshot,
      ownerWritable: () =>
        dependencies.ownerWritable(input.reviewId),
      selectTarget: async (frozenSource, dialogRequestGeneration) => {
        const selection = await dependencies.selectTarget({
          frozenSource,
          dialogRequestGeneration,
          ownerFallbackFilename: "review.md",
          title: input.pickerTitle
        });
        selectionFailure =
          selection.status === "error" ? selection.selectionFailure : undefined;
        return selection;
      },
      classifyTarget: (targetPath) =>
        dependencies.classifyTarget(input.reviewId, targetPath),
      createConsumerId: (snapshotId) =>
        `review:${input.reviewId}:save-as:${snapshotId}`,
      present: ({ consumerId, result }) =>
        dependencies.present({
          reviewId: input.reviewId,
          consumerId,
          result
        })
    });
    if (invoked.status === "canceled") return invoked;
    if (invoked.status === "failed") {
      return {
        status:
          invoked.failure.writeApplied === false
            ? "error"
            : "recovery-required",
        operationId: invoked.operationId,
        error: error(invoked.failure.code, selectionFailure)
      };
    }
    if (invoked.status === "presentation-recovery-required") {
      return {
        status: "recovery-required",
        operationId: invoked.operationId,
        error: error("SAVE_AS_OPERATION_STALE")
      };
    }
    const executed = invoked.result;
    const presented = invoked.presentation;
    return {
      status: "success",
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
    saveAs,
    async listUnresolved(reviewId: string) {
      return (await dependencies.listReconcilable()).filter(
        (record) =>
          record.ownerType === "review" &&
          record.ownerId === reviewId &&
          record.channel === "primary"
      );
    },
    async recover(
      operationId: string,
      reviewId: string
    ): Promise<ReviewCanonicalRecoveryResult> {
      const record = (await dependencies.listReconcilable()).find(
        (candidate) =>
          candidate.operationId === operationId &&
          candidate.ownerType === "review" &&
          candidate.ownerId === reviewId &&
          candidate.channel === "primary"
      );
      if (!record) {
        return {
          status: "error",
          error: error("SAVE_AS_OPERATION_STALE")
        };
      }
      const recovered = await dependencies.recoverOperation({
        operationId,
        expectedOwner: {
          ownerType: "review",
          ownerId: reviewId,
          channel: "primary"
        },
        configuredRoot:
          record.targetLocationMode === "managed"
            ? await dependencies.resolveConfiguredRoot(reviewId)
            : undefined,
        ownerWritable: () => dependencies.ownerWritable(reviewId),
        windowPMissingBindingContainment: {
          policyId: "window_p_fail_closed_v1"
        },
        present: ({ consumerId, result }) =>
          dependencies.present({ reviewId, consumerId, result })
      });
      if (recovered.status === "contained") return recovered;
      return recovered.status === "success"
        ? {
            status: "success",
            operationId: recovered.operationId,
            independentSessionKey: recovered.sessionHandle,
            targetFileName: recovered.targetFileName
          }
        : {
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

async function classifyReviewTarget(
  reviewId: string,
  targetPath: string
): Promise<Classification> {
  let workspace: Awaited<ReturnType<typeof resolveReviewWorkspaceFolder>>;
  try {
    workspace = await resolveReviewWorkspaceFolder(reviewId);
  } catch {
    return {
      status: "error",
      errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }
  if (isPathWithinDirectory(workspace.path, targetPath)) {
    let conflicts: Awaited<
      ReturnType<
        typeof fileRefService.getActiveManagedManuscriptPathConflicts
      >
    >;
    try {
      conflicts =
        await fileRefService.getActiveManagedManuscriptPathConflicts(
          "review",
          reviewId,
          createPathIdentityKey(targetPath)
        );
    } catch {
      return {
        status: "error",
        errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
      };
    }
    return conflicts.length
      ? {
          status: "error",
          errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
        }
      : {
          status: "allowed",
          locationMode: "managed",
          configuredRoot: workspace.managedRoot
        };
  }
  if (isPathWithinDirectory(workspace.managedRoot, targetPath)) {
    return {
      status: "error",
      errorCode: "SAVE_AS_TARGET_CANDIDATE_INVALID"
    };
  }
  return { status: "allowed", locationMode: "external" };
}

async function reviewOwnerWritable(reviewId: string) {
  try {
    const [lifecycle, pageState] = await Promise.all([
      resolveMountedManuscriptLifecycleDecision({
        ownerType: "review",
        ownerId: reviewId,
        manuscriptChannel: "primary"
      }),
      reviewManuscriptPageStateService.get(reviewId)
    ]);
    return Boolean(
      lifecycle.canSaveAs &&
        pageState.workspaceStatus === "ready" &&
        pageState.currentStatus === "ready"
    );
  } catch {
    return false;
  }
}

export const reviewManuscriptSaveAsAdapter =
  createReviewManuscriptSaveAsAdapter({
    ownerWritable: reviewOwnerWritable,
    selectTarget: (input) => manuscriptSaveAsPlacementService.selectTarget({
      frozenSource: input.frozenSource,
      dialogRequestGeneration: input.dialogRequestGeneration,
      pickerTitle: input.title,
      ownerFallbackFilename: input.ownerFallbackFilename
    }),
    classifyTarget: classifyReviewTarget,
    invoke: (input) =>
      sharedManuscriptSaveAsInvocationComposition.invoke(input),
    present: (input) =>
      reviewManuscriptSaveAsPresentationAdapter.present(input),
    listReconcilable: () =>
      manuscriptSaveAsOperationPort.listReconcilable(),
    recoverOperation: (input) =>
      manuscriptSaveAsProductionRecoveryComposition.recover(input),
    async resolveConfiguredRoot(reviewId) {
      try {
        return (await resolveReviewWorkspaceFolder(reviewId)).managedRoot;
      } catch {
        const root = await managedRootConfigService.getStatus();
        return root.status === "configured"
          ? root.managedRoot
          : undefined;
      }
    }
  });
