import type { OperationLogEntry } from "../types/operationLog";
import type { OperationImpactPreview } from "../types/operationSafety";
import type { DeletedEntitySummary } from "../types/recycleBin";
import type { RestoreDeletedEntityInput } from "../types/recycleBin";
import type { ReviewRestoreCapability } from "./reviewDeleteSafetyService";
import {
  resolveReviewPermanentDeleteCapability,
  type ReviewPermanentDeleteCapability,
  type ResolveReviewPermanentDeleteCapabilityInput
} from "./reviewPermanentDeleteCapabilityService";
import type {
  ReviewLifecycleActionRecord,
  ReviewLifecycleOperationType,
  ReviewLifecycleStage
} from "./reviewLifecycleActionService";

export interface ReviewOperationCenterMetadata {
  id: string;
  projectId: string;
  title?: string;
  summary?: string;
  deletedAt?: string | null;
  updatedAt: string;
}

export type OperationCenterItem =
  | {
      kind: "generic_deleted_entity";
      rowKey: string;
      item: DeletedEntitySummary;
    }
  | {
      kind: "review_recycle_entry";
      rowKey: string;
      recycleEntryId: string;
      reviewId: string;
      sourceDeleteActionId: string | null;
      pendingLifecycleActionId: string | null;
      pendingLifecycleOperation: ReviewLifecycleOperationType | null;
      pendingLifecycleStage: ReviewLifecycleStage | null;
      permanentDeleteCapability: ReviewPermanentDeleteCapability;
      canContinue: boolean;
      continueActionType: ReviewLifecycleOperationType | null;
      reasonCode: string;
      userMessage: string;
      item: DeletedEntitySummary;
    }
  | {
      kind: "review_pending_lifecycle_action";
      rowKey: string;
      lifecycleActionId: string;
      operationType: ReviewLifecycleOperationType;
      reviewId: string;
      projectId: string;
      exactRecycleEntryId: string | null;
      stage: ReviewLifecycleStage;
      terminalResult: null;
      title: string;
      summary: string;
      occurredAt: string;
      canContinue: boolean;
      continueActionType: ReviewLifecycleOperationType;
      reasonCode: string;
      userMessage: string;
      degradedReasonCode: string | null;
      sourceDeleteActionId: string | null;
      permanentDeleteCapability: ReviewPermanentDeleteCapability;
    };

interface ComposeOperationCenterItemsInput {
  genericDeletedItems: DeletedEntitySummary[];
  reviewRecycleEntries: DeletedEntitySummary[];
  pendingReviewActions: ReviewLifecycleActionRecord[];
  reviewMetadata: ReviewOperationCenterMetadata[];
  limit?: number;
}

interface RestorePreviewCopy {
  summary: string;
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ReviewRestoreDispatchInput {
  reviewId: string;
  confirmedByUser: boolean;
  operationLogId?: string;
  recycleEntryId?: string;
  lifecycleActionId?: string;
  sourceDeleteActionId?: string;
}

export interface OperationCenterRestoreDispatchInput {
  item: DeletedEntitySummary;
  confirmedByUser: boolean;
}

export interface OperationCenterRestoreDispatchDependencies<TReview, TGeneric> {
  restoreReview(input: ReviewRestoreDispatchInput): Promise<TReview>;
  restoreGeneric(input: RestoreDeletedEntityInput): Promise<TGeneric>;
}

export async function dispatchOperationCenterRestore<TReview, TGeneric>(
  input: OperationCenterRestoreDispatchInput,
  dependencies: OperationCenterRestoreDispatchDependencies<TReview, TGeneric>
): Promise<TReview | TGeneric> {
  if (input.item.entityType === "review") {
    return dependencies.restoreReview({
      reviewId: input.item.entityId,
      confirmedByUser: input.confirmedByUser,
      operationLogId: input.item.operationLogId,
      recycleEntryId: input.item.recycleEntryId,
      lifecycleActionId: input.item.lifecycleActionId,
      sourceDeleteActionId: input.item.createdByLifecycleActionId ?? undefined
    });
  }
  return dependencies.restoreGeneric({
    entityType: input.item.entityType,
    entityId: input.item.entityId,
    confirmedByUser: input.confirmedByUser,
    operationLogId: input.item.operationLogId,
    recycleEntryId: input.item.recycleEntryId,
    lifecycleActionId: input.item.lifecycleActionId,
    sourceDeleteActionId: input.item.createdByLifecycleActionId ?? undefined
  });
}

export async function resolveOperationCenterRestoreCapabilities(
  items: DeletedEntitySummary[],
  resolveReviewCapability: (
    reviewId: string,
    item: DeletedEntitySummary
  ) => Promise<ReviewRestoreCapability>
): Promise<DeletedEntitySummary[]> {
  return Promise.all(items.map(async (item) => {
    if (item.entityType !== "review") return item;
    const capability = await resolveReviewCapability(item.entityId, item);
    return {
      ...item,
      canRestore: capability.canRestore,
      cannotRestoreReason: capability.canRestore ? undefined : capability.userMessage
    };
  }));
}

function compareStableText(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function effectiveOccurredAt(item: OperationCenterItem) {
  return item.kind === "review_pending_lifecycle_action"
    ? item.occurredAt
    : item.item.deletedAt;
}

function stableOperationCenterSort(left: OperationCenterItem, right: OperationCenterItem) {
  const byTime = compareStableText(effectiveOccurredAt(right), effectiveOccurredAt(left));
  if (byTime !== 0) return byTime;
  const byKind = compareStableText(left.kind, right.kind);
  return byKind !== 0 ? byKind : compareStableText(left.rowKey, right.rowKey);
}

export async function composeOperationCenterItems(
  input: ComposeOperationCenterItemsInput,
  resolveReviewCapability: (
    reviewId: string,
    item: DeletedEntitySummary
  ) => Promise<ReviewRestoreCapability>,
  resolvePermanentDeleteCapability: (
    input: ResolveReviewPermanentDeleteCapabilityInput
  ) => ReviewPermanentDeleteCapability = resolveReviewPermanentDeleteCapability
): Promise<OperationCenterItem[]> {
  const pendingByEntryId = new Map<string, ReviewLifecycleActionRecord>();
  const pendingByReviewId = new Map<string, ReviewLifecycleActionRecord>();
  for (const action of input.pendingReviewActions) {
    pendingByReviewId.set(action.reviewId, action);
    if (action.exactRecycleEntryId) {
      pendingByEntryId.set(action.exactRecycleEntryId, action);
    }
  }
  const attachedActionIds = new Set<string>();
  const conflictingActionIds = new Set<string>();
  const metadataByReviewId = new Map(input.reviewMetadata.map((item) => [item.id, item]));
  const exactReviewRows = await Promise.all(input.reviewRecycleEntries.map(async (item) => {
    if (!item.recycleEntryId) {
      throw new Error("review_recycle_entry_identity_missing");
    }
    const capability = await resolveReviewCapability(item.entityId, item);
    const pending = pendingByEntryId.get(item.recycleEntryId);
    const pendingTargetsReview = pending?.reviewId === item.entityId;
    const pendingIdentityMatches = pending?.operationType === "review_soft_delete"
      ? item.createdByLifecycleActionId === pending.lifecycleActionId
      : pending?.operationType === "review_restore"
        ? Boolean(pending.sourceDeleteActionId)
          && item.createdByLifecycleActionId === pending.sourceDeleteActionId
        : pending?.operationType === "review_permanent_delete"
          ? Boolean(pending.sourceDeleteActionId)
            && item.createdByLifecycleActionId === pending.sourceDeleteActionId
          : false;
    const exactPending = pendingTargetsReview && pendingIdentityMatches ? pending : undefined;
    if (pendingTargetsReview && !pendingIdentityMatches && pending) {
      conflictingActionIds.add(pending.lifecycleActionId);
    }
    if (exactPending) attachedActionIds.add(exactPending.lifecycleActionId);
    const metadata = metadataByReviewId.get(item.entityId);
    const capabilityPending = exactPending ?? pendingByReviewId.get(item.entityId);
    const permanentDeleteCapability = resolvePermanentDeleteCapability({
      reviewId: item.entityId,
      projectId: exactPending?.operationType === "review_permanent_delete"
        ? exactPending.projectId
        : metadata?.projectId ?? null,
      reviewDeletedAt: metadata?.deletedAt ?? null,
      recycleEntry: item,
      pendingAction: capabilityPending
    });
    return {
      kind: "review_recycle_entry",
      rowKey: `review-recycle-entry:${item.recycleEntryId}`,
      recycleEntryId: item.recycleEntryId,
      reviewId: item.entityId,
      sourceDeleteActionId: item.createdByLifecycleActionId ?? null,
      pendingLifecycleActionId: exactPending?.lifecycleActionId ?? null,
      pendingLifecycleOperation: exactPending?.operationType ?? null,
      pendingLifecycleStage: exactPending?.currentStage ?? null,
      permanentDeleteCapability,
      canContinue: Boolean(exactPending),
      continueActionType: exactPending?.operationType ?? null,
      reasonCode: exactPending ? "pending_action_ready" : capability.reasonCode,
      userMessage: exactPending
        ? "The pending Review lifecycle action can be continued explicitly."
        : capability.userMessage,
      item: {
        ...item,
        canRestore: capability.canRestore,
        cannotRestoreReason: capability.canRestore ? undefined : capability.userMessage
      }
    } satisfies OperationCenterItem;
  }));

  const pendingOnlyRows: OperationCenterItem[] = input.pendingReviewActions
    .filter((action) => !attachedActionIds.has(action.lifecycleActionId))
    .map((action) => {
      const metadata = metadataByReviewId.get(action.reviewId);
      const requiresExactEntry = action.operationType === "review_restore"
        || action.operationType === "review_permanent_delete";
      const hasExactIdentityConflict = conflictingActionIds.has(action.lifecycleActionId);
      const permanentDeleteCapability = resolvePermanentDeleteCapability({
        reviewId: action.reviewId,
        projectId: action.projectId,
        reviewDeletedAt: metadata?.deletedAt ?? null,
        pendingAction: action
      });
      return {
        kind: "review_pending_lifecycle_action",
        rowKey: `review-lifecycle-action:${action.lifecycleActionId}`,
        lifecycleActionId: action.lifecycleActionId,
        operationType: action.operationType,
        reviewId: action.reviewId,
        projectId: action.projectId,
        exactRecycleEntryId: requiresExactEntry ? action.exactRecycleEntryId : null,
        stage: action.currentStage,
        terminalResult: null,
        title: metadata?.title?.trim() || "Unnamed Review",
        summary: action.operationType === "review_soft_delete"
          ? "The Review delete action is incomplete and can be continued."
          : action.operationType === "review_restore"
            ? "The Review restore action is incomplete, but its exact recycle entry is unavailable."
            : "The Review permanent-delete action is incomplete, but its exact recycle entry is unavailable.",
        occurredAt: action.updatedAt || action.createdAt,
        canContinue: action.operationType === "review_permanent_delete"
          ? permanentDeleteCapability.canContinuePermanentDelete
          : !requiresExactEntry && !hasExactIdentityConflict,
        continueActionType: action.operationType,
        reasonCode: hasExactIdentityConflict
          ? "pending_action_exact_entry_conflict"
          : requiresExactEntry
            ? action.operationType === "review_permanent_delete"
              ? permanentDeleteCapability.reasonCode
              : "pending_restore_exact_entry_unavailable"
          : "pending_action_ready",
        userMessage: hasExactIdentityConflict
          ? "The exact recycle entry identity conflicts with this pending Review action."
          : requiresExactEntry
            ? action.operationType === "review_permanent_delete"
              ? permanentDeleteCapability.userMessage
              : "The exact recycle entry for this pending restore action is unavailable."
          : "The pending Review delete action can be continued explicitly.",
        degradedReasonCode: metadata ? null : "review_metadata_unavailable",
        sourceDeleteActionId: action.sourceDeleteActionId,
        permanentDeleteCapability
      };
    });

  const genericRows: OperationCenterItem[] = input.genericDeletedItems
    .filter((item) => item.entityType !== "review")
    .map((item) => ({
      kind: "generic_deleted_entity",
      rowKey: `generic-deleted:${item.entityType}:${item.entityId}`,
      item
    }));
  const rows = [...genericRows, ...exactReviewRows, ...pendingOnlyRows]
    .sort(stableOperationCenterSort);
  return typeof input.limit === "number" ? rows.slice(0, input.limit) : rows;
}

export function summarizeOperationLogMessage(entry: OperationLogEntry): string {
  if (entry.feedback?.message) {
    return entry.feedback.message;
  }

  if (entry.errors.length > 0) {
    return entry.errors[0];
  }

  if (entry.warnings.length > 0) {
    return entry.warnings[0];
  }

  if (entry.skipped.length > 0) {
    return entry.skipped[0];
  }

  return entry.summary;
}

export function summarizeDeletedEntityImpact(
  item: DeletedEntitySummary,
  emptyMessage: string
): string {
  const impact = item.knownImpactSummary;
  if (!impact) {
    return emptyMessage;
  }

  const parts: string[] = [];
  if (impact.affectedEntityCount > 0) {
    parts.push(String(impact.affectedEntityCount));
  }
  if (impact.blockingReasons.length > 0) {
    parts.push(impact.blockingReasons[0]);
  }
  if (impact.warnings.length > 0) {
    parts.push(impact.warnings[0]);
  }

  return parts.length > 0 ? parts.join(" · ") : emptyMessage;
}

export function createRestoreDeletedEntityPreview(
  item: DeletedEntitySummary,
  copy: RestorePreviewCopy
): OperationImpactPreview {
  const impact = item.knownImpactSummary;
  const cannotRestoreReason = item.canRestore ? undefined : item.cannotRestoreReason;
  const warnings = [
    ...(copy.warning ? [copy.warning] : []),
    ...(impact?.warnings ?? [])
  ];
  const blockingReasons = [
    ...(cannotRestoreReason ? [cannotRestoreReason] : []),
    ...(impact?.blockingReasons ?? [])
  ];

  return {
    operationId: `restore-${item.entityType}-${item.entityId}`,
    operation: "restore",
    target: {
      type: item.entityType,
      id: item.entityId,
      title: item.title
    },
    summary: copy.summary,
    riskLevel: blockingReasons.length > 0 ? "high" : "medium",
    executionKind: "other",
    isRecoverable: true,
    hasRestoreEntry: true,
    requiresUserConfirmation: true,
    canProceed: item.canRestore && blockingReasons.length === 0,
    affectedEntityCount: impact?.affectedEntityCount ?? 1,
    affectedItems: impact?.affectedItems ?? [
      {
        entityType: item.entityType,
        entityId: item.entityId,
        title: item.title,
        severity: "info"
      }
    ],
    warnings,
    blockingReasons,
    deepScanPerformed: impact?.deepScanPerformed ?? false,
    confirmLabel: copy.confirmLabel,
    cancelLabel: copy.cancelLabel
  };
}
