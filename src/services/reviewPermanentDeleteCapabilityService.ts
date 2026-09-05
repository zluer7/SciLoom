import { isTauriRuntime, resolveDataSourceMode } from "../repositories/dataSourceMode";
import type { DeletedEntitySummary } from "../types/recycleBin";
import { evaluateReviewPermanentDeleteRuntimeAdmission } from "./reviewPermanentDeleteFoundation";
import type {
  ReviewLifecycleActionRecord,
  ReviewLifecycleStage
} from "./reviewLifecycleActionService";

export type ReviewPermanentDeleteCapabilityReason =
  | "ready"
  | "pending_action_ready"
  | "durable_store_required"
  | "exact_recycle_entry_unavailable"
  | "legacy_unbound"
  | "identity_source_mismatch"
  | "already_permanently_deleted"
  | "entry_not_restorable"
  | "review_not_soft_deleted"
  | "project_identity_unavailable"
  | "pending_action_conflict"
  | "pending_stage_unsupported";

export interface ReviewPermanentDeleteCapability {
  canPreviewPermanentDelete: boolean;
  canContinuePermanentDelete: boolean;
  lifecycleActionId: string | null;
  reviewId: string;
  projectId: string | null;
  exactRecycleEntryId: string | null;
  sourceDeleteActionId: string | null;
  expectedRecycleEntryRevision: number | null;
  currentStage: ReviewLifecycleStage | null;
  reasonCode: ReviewPermanentDeleteCapabilityReason;
  userMessage: string;
}

export interface ResolveReviewPermanentDeleteCapabilityInput {
  reviewId: string;
  projectId: string | null;
  reviewDeletedAt: string | null;
  recycleEntry?: DeletedEntitySummary;
  pendingAction?: ReviewLifecycleActionRecord;
  runtimeAdmission?: "allowed" | "unavailable";
}

function result(
  input: ResolveReviewPermanentDeleteCapabilityInput,
  values: Pick<
    ReviewPermanentDeleteCapability,
    | "canPreviewPermanentDelete"
    | "canContinuePermanentDelete"
    | "reasonCode"
    | "userMessage"
  >
): ReviewPermanentDeleteCapability {
  const entry = input.recycleEntry;
  const pending = input.pendingAction;
  return {
    ...values,
    lifecycleActionId: pending?.operationType === "review_permanent_delete"
      ? pending.lifecycleActionId
      : null,
    reviewId: input.reviewId,
    projectId: pending?.operationType === "review_permanent_delete"
      ? pending.projectId
      : input.projectId,
    exactRecycleEntryId: entry?.recycleEntryId ?? pending?.exactRecycleEntryId ?? null,
    sourceDeleteActionId: entry?.createdByLifecycleActionId
      ?? pending?.sourceDeleteActionId
      ?? null,
    expectedRecycleEntryRevision: Number.isSafeInteger(entry?.revision)
      ? entry?.revision ?? null
      : null,
    currentStage: pending?.operationType === "review_permanent_delete"
      ? pending.currentStage
      : null
  };
}

function runtimeAllowed(input: ResolveReviewPermanentDeleteCapabilityInput) {
  if (input.runtimeAdmission) return input.runtimeAdmission === "allowed";
  return evaluateReviewPermanentDeleteRuntimeAdmission({
    tauriRuntime: isTauriRuntime(),
    dataSourceMode: resolveDataSourceMode()
  }).status === "Allowed";
}

export function resolveReviewPermanentDeleteCapability(
  input: ResolveReviewPermanentDeleteCapabilityInput
): ReviewPermanentDeleteCapability {
  if (!runtimeAllowed(input)) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "durable_store_required",
      userMessage: "Review permanent delete requires the desktop SQLite durable store."
    });
  }

  const entry = input.recycleEntry;
  if (!entry?.recycleEntryId || entry.entityType !== "review" || entry.entityId !== input.reviewId) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "exact_recycle_entry_unavailable",
      userMessage: "The exact Review recycle entry is unavailable."
    });
  }
  if (!entry.createdByLifecycleActionId) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "legacy_unbound",
      userMessage: "This legacy recycle entry is not bound to an exact Review delete action."
    });
  }
  if (entry.restoreStatus === "permanently_deleted") {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "already_permanently_deleted",
      userMessage: "This exact recycle entry is already permanently terminal."
    });
  }
  if (entry.restoreStatus === "restored" || entry.terminalLifecycleActionId) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "entry_not_restorable",
      userMessage: "This exact recycle entry is already terminal and is not deletable."
    });
  }

  const pending = input.pendingAction;
  if (pending) {
    if (pending.operationType !== "review_permanent_delete") {
      return result(input, {
        canPreviewPermanentDelete: false,
        canContinuePermanentDelete: false,
        reasonCode: "pending_action_conflict",
        userMessage: "Another Review lifecycle action must finish before permanent delete."
      });
    }
    if (
      pending.reviewId !== input.reviewId
      || pending.exactRecycleEntryId !== entry.recycleEntryId
      || pending.sourceDeleteActionId !== entry.createdByLifecycleActionId
    ) {
      return result(input, {
        canPreviewPermanentDelete: false,
        canContinuePermanentDelete: false,
        reasonCode: "identity_source_mismatch",
        userMessage: "The pending permanent-delete action does not match this exact recycle entry."
      });
    }
    if (pending.currentStage !== "prepared" && pending.currentStage !== "planning_committed") {
      return result(input, {
        canPreviewPermanentDelete: false,
        canContinuePermanentDelete: false,
        reasonCode: "pending_stage_unsupported",
        userMessage: "The pending permanent-delete action is not at a continuable stage."
      });
    }
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: true,
      reasonCode: "pending_action_ready",
      userMessage: "The exact pending permanent-delete action can be continued explicitly."
    });
  }

  if (entry.canRestore !== true || entry.restoreStatus !== "not_started") {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "entry_not_restorable",
      userMessage: "This exact recycle entry is not in the restorable deleted state."
    });
  }
  if (!input.reviewDeletedAt) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "review_not_soft_deleted",
      userMessage: "The Review is not currently soft-deleted."
    });
  }
  if (!input.projectId) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "project_identity_unavailable",
      userMessage: "The Review Project identity is unavailable."
    });
  }
  if (!Number.isSafeInteger(entry.revision) || (entry.revision ?? -1) < 0) {
    return result(input, {
      canPreviewPermanentDelete: false,
      canContinuePermanentDelete: false,
      reasonCode: "identity_source_mismatch",
      userMessage: "The exact recycle entry revision is unavailable."
    });
  }
  return result(input, {
    canPreviewPermanentDelete: true,
    canContinuePermanentDelete: false,
    reasonCode: "ready",
    userMessage: "An authoritative permanent-delete preview is available."
  });
}
