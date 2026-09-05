import { useCallback, useEffect, useRef, useState } from "react";
import { OperationConfirmDialog } from "../safety/OperationConfirmDialog";
import {
  ReviewPermanentDeleteDialog,
  type ReviewPermanentDeleteDialogState
} from "./ReviewPermanentDeleteDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useI18n } from "../../i18n/I18nProvider";
import { createOperationCancelledFeedback } from "../../services/operationImpactPreviewService";
import {
  createRestoreDeletedEntityPreview,
  composeOperationCenterItems,
  dispatchOperationCenterRestore,
  summarizeDeletedEntityImpact,
  summarizeOperationLogMessage,
  type OperationCenterItem
} from "../../services/operationCenterService";
import { listOperationLogs } from "../../services/operationLogService";
import {
  confirmOutputDeleteImpactPreview,
  getOutputDeleteImpactPreview,
  restoreOutputEntity,
  toOperationImpactPreview
} from "../../services/outputDeleteSafetyService";
import {
  getRecycleEntry,
  getLatestRecycleEntryForEntity,
  listRecentlyDeleted,
  restoreDeletedEntity
} from "../../services/recycleBinService";
import type { NormalizeWriteFeedbackOptions } from "../../services/writeFeedbackService";
import type { OperationLogEntry } from "../../types/operationLog";
import type { OutputEntityLayer } from "../../types/outputSelector";
import type { RefreshEvent, RefreshKeyPattern } from "../../types/refresh";
import type { WriteFeedbackResult } from "../../types/writeFeedback";
import { outputLayerFromBusinessAlias } from "../../services/outputResearchOutputAliasAdapter";
import {
  classifyReviewLifecycleError,
  queryDeletedReviews,
  queryReviewRecycleEntries,
  resolveExactReviewRestoreCapability,
  restoreDeletedReview,
  softDeleteReview,
  type ReviewRestoreCapability
} from "../../services/reviewDeleteSafetyService";
import { reviewLifecycleActionPort } from "../../services/reviewLifecycleActionService";
import {
  resolveReviewPermanentDeleteCapability,
  type ReviewPermanentDeleteCapability,
  type ReviewPermanentDeleteCapabilityReason
} from "../../services/reviewPermanentDeleteCapabilityService";
import {
  classifyReviewPermanentDeleteOperationCenterError,
  continueOperationCenterReviewPermanentDelete,
  executeOperationCenterReviewPermanentDeletePreview,
  loadOperationCenterReviewPermanentDeleteContinuation,
  previewOperationCenterReviewPermanentDelete,
  reviewPermanentDeleteErrorRequiresNewPreview,
  type ReviewPermanentDeleteFeedbackReason
} from "../../services/reviewPermanentDeleteOperationCenterService";

const OPERATION_CENTER_REFRESH_KEYS: RefreshKeyPattern[] = [
  "operationLog.changed",
  "recycleBin.changed"
];

const OUTPUT_LAYER_BY_RECYCLE_ENTITY_TYPE: Partial<Record<string, OutputEntityLayer>> = {
  resultItem: "resultItem",
  finding: "finding",
  outputCandidate: "outputCandidate",
  outputGap: "outputGap",
  output: outputLayerFromBusinessAlias("output")
};

interface OperationCenterPanelProps {
  onWriteResult: <T,>(
    result: T | WriteFeedbackResult<T>,
    options: NormalizeWriteFeedbackOptions<T>
  ) => WriteFeedbackResult<T>;
  onWriteError: (error: unknown, operation: string) => WriteFeedbackResult;
  onRefreshEvent: (event: RefreshEvent) => void;
  onReloadError: (error: unknown, event: RefreshEvent, pageName: string) => void;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function permanentDeleteStageMessage(
  stage: string | null,
  t: ReturnType<typeof useI18n>["t"]
) {
  return stage === "planning_committed"
    ? t("operationCenterPermanentDeleteStagePlanningCommitted")
    : t("operationCenterPermanentDeleteStagePrepared");
}

export function OperationCenterPanel({
  onWriteResult,
  onWriteError,
  onRefreshEvent,
  onReloadError
}: OperationCenterPanelProps) {
  const { t } = useI18n();
  const confirmRestore = useOperationConfirm();
  const [logs, setLogs] = useState<OperationLogEntry[]>([]);
  const [deletedItems, setDeletedItems] = useState<OperationCenterItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permanentDeleteDialog, setPermanentDeleteDialog] =
    useState<ReviewPermanentDeleteDialogState | null>(null);
  const [permanentDeleteLoadingRow, setPermanentDeleteLoadingRow] = useState<string | null>(null);
  const [isPermanentDeleteSubmitting, setIsPermanentDeleteSubmitting] = useState(false);
  const permanentDeleteRequestFence = useRef(0);
  const permanentDeleteSubmission = useRef<string | null>(null);

  const permanentDeleteCapabilityCopy = useCallback(
    (capability: ReviewPermanentDeleteCapability): ReviewPermanentDeleteCapability => {
      const messages: Record<ReviewPermanentDeleteCapabilityReason, string> = {
        ready: t("operationCenterPermanentDeleteReady"),
        pending_action_ready: t("operationCenterPermanentDeletePendingReady"),
        durable_store_required: t("operationCenterPermanentDeleteDurableStoreRequired"),
        exact_recycle_entry_unavailable: t("operationCenterPermanentDeleteEntryUnavailable"),
        legacy_unbound: t("operationCenterPermanentDeleteLegacyUnbound"),
        identity_source_mismatch: t("operationCenterPermanentDeleteIdentityMismatch"),
        already_permanently_deleted: t("operationCenterPermanentDeleteAlreadyCompleted"),
        entry_not_restorable: t("operationCenterPermanentDeleteEntryNotRestorable"),
        review_not_soft_deleted: t("operationCenterPermanentDeleteReviewNotDeleted"),
        project_identity_unavailable: t("operationCenterPermanentDeleteProjectUnavailable"),
        pending_action_conflict: t("operationCenterPermanentDeletePendingConflict"),
        pending_stage_unsupported: t("operationCenterPermanentDeleteStageUnsupported")
      };
      return { ...capability, userMessage: messages[capability.reasonCode] };
    },
    [t]
  );

  const permanentDeleteErrorMessage = useCallback(
    (reason: ReviewPermanentDeleteFeedbackReason) => {
      const messages: Record<ReviewPermanentDeleteFeedbackReason, string> = {
        impact_plan_stale: t("operationCenterPermanentDeleteImpactStale"),
        planning_conflict: t("operationCenterPermanentDeletePlanningConflict"),
        metadata_plan_conflict: t("operationCenterPermanentDeleteMetadataConflict"),
        recycle_entry_conflict: t("operationCenterPermanentDeleteRecycleConflict"),
        identity_conflict: t("operationCenterPermanentDeleteIdentityConflict"),
        source_state_conflict: t("operationCenterPermanentDeleteSourceConflict"),
        legacy_unbound: t("operationCenterPermanentDeleteLegacyUnbound"),
        already_permanently_deleted: t("operationCenterPermanentDeleteAlreadyCompleted"),
        durable_store_required: t("operationCenterPermanentDeleteDurableStoreRequired"),
        retryable_infrastructure_failure: t("operationCenterPermanentDeleteRetryableFailure"),
        non_retryable_failure: t("operationCenterPermanentDeleteNonRetryableFailure")
      };
      return messages[reason];
    },
    [t]
  );

  const reportPermanentDeleteError = useCallback(
    (error: unknown) => {
      const reason = classifyReviewPermanentDeleteOperationCenterError(error);
      const displayError = new Error(permanentDeleteErrorMessage(reason));
      Object.defineProperty(displayError, "code", { value: reason });
      Object.defineProperty(displayError, "cause", { value: error });
      onWriteError(displayError, "review.permanentDelete");
      return reason;
    },
    [onWriteError, permanentDeleteErrorMessage]
  );

  const closePermanentDeleteDialog = useCallback(() => {
    permanentDeleteRequestFence.current += 1;
    setPermanentDeleteDialog(null);
    setPermanentDeleteLoadingRow(null);
  }, []);

  const reviewCapabilityCopy = useCallback(
    (capability: ReviewRestoreCapability): ReviewRestoreCapability => {
      if (capability.canRestore) return capability;
      const userMessage = capability.reasonCode === "parent_project_unavailable"
        ? t("reviewRestoreParentUnavailable")
        : capability.reasonCode === "already_restored"
          ? t("reviewRestoreAlreadyRestored")
          : capability.reasonCode === "planning_unavailable"
            ? t("reviewLifecyclePlanningUnavailable")
            : t("reviewRestoreEntryUnavailable");
      return { ...capability, userMessage };
    },
    [t]
  );

  const statusLabel = useCallback(
    (status: OperationLogEntry["status"]) => {
      switch (status) {
        case "success":
          return t("operationLogStatusSuccess");
        case "partial":
          return t("operationLogStatusPartial");
        case "skipped":
          return t("operationLogStatusSkipped");
        case "error":
          return t("operationLogStatusError");
        default:
          return status;
      }
    },
    [t]
  );

  const riskLabel = useCallback(
    (risk: OperationLogEntry["riskLevel"]) => {
      switch (risk) {
        case "low":
          return t("operationRiskLow");
        case "medium":
          return t("operationRiskMedium");
        case "high":
          return t("operationRiskHigh");
        case "critical":
          return t("operationRiskCritical");
        default:
          return risk;
      }
    },
    [t]
  );

  const reloadOperationCenter = useCallback(async () => {
    permanentDeleteRequestFence.current += 1;
    setPermanentDeleteDialog(null);
    setPermanentDeleteLoadingRow(null);
    setIsLoading(true);
    setLoadError(null);
    try {
      const [nextLogs, rawDeletedItems, reviewRecycleEntries, pendingReviewActions, deletedReviews] = await Promise.all([
        listOperationLogs({ limit: 12 }),
        listRecentlyDeleted(),
        queryReviewRecycleEntries(),
        reviewLifecycleActionPort.listPending(),
        queryDeletedReviews()
      ]);
      const nextDeletedItems = await composeOperationCenterItems(
        {
          genericDeletedItems: rawDeletedItems,
          reviewRecycleEntries,
          pendingReviewActions,
          reviewMetadata: deletedReviews,
          limit: 12
        },
        async (reviewId, item) => reviewCapabilityCopy(
          await resolveExactReviewRestoreCapability(reviewId, item.recycleEntryId)
        ),
        (input) => permanentDeleteCapabilityCopy(
          resolveReviewPermanentDeleteCapability(input)
        )
      );
      setLogs(nextLogs);
      setDeletedItems(nextDeletedItems);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [permanentDeleteCapabilityCopy, reviewCapabilityCopy]);

  useEffect(() => {
    void reloadOperationCenter();
  }, [reloadOperationCenter]);

  useRefreshEventReload({
    pageName: "Settings Operation Center",
    watchedKeys: OPERATION_CENTER_REFRESH_KEYS,
    reload: reloadOperationCenter,
    onRefreshFeedback: onRefreshEvent,
    onReloadError: (error, event) =>
      onReloadError(error, event, "Settings Operation Center")
  });

  const handleRestore = useCallback(
    async (operationItem: OperationCenterItem) => {
      try {
        if (operationItem.kind === "review_pending_lifecycle_action") {
          if (!operationItem.canContinue || operationItem.operationType !== "review_soft_delete") {
            throw new Error(operationItem.reasonCode);
          }
          const result = await softDeleteReview(operationItem.reviewId, {
            confirmedByUser: true,
            lifecycleActionId: operationItem.lifecycleActionId
          });
          onWriteResult<unknown>(result as WriteFeedbackResult<unknown>, {
            operation: "review.softDelete",
            successMessage: t("reviewSoftDeleteSuccess")
          });
          await reloadOperationCenter();
          return;
        }
        const item = operationItem.item;
        if (
          operationItem.kind === "review_recycle_entry"
          && operationItem.pendingLifecycleOperation === "review_soft_delete"
          && operationItem.pendingLifecycleActionId
        ) {
          const result = await softDeleteReview(operationItem.reviewId, {
            confirmedByUser: true,
            lifecycleActionId: operationItem.pendingLifecycleActionId
          });
          onWriteResult<unknown>(result as WriteFeedbackResult<unknown>, {
            operation: "review.softDelete",
            successMessage: t("reviewSoftDeleteSuccess")
          });
          await reloadOperationCenter();
          return;
        }
        const outputLayer = OUTPUT_LAYER_BY_RECYCLE_ENTITY_TYPE[item.entityType];
        const recycleEntry = outputLayer && item.recycleEntryId
          ? await getRecycleEntry(item.recycleEntryId)
          : outputLayer
            ? await getLatestRecycleEntryForEntity(item.entityType, item.entityId)
            : undefined;
        const outputPreview = outputLayer
          ? await getOutputDeleteImpactPreview({
              layer: outputLayer,
              id: item.entityId,
              mode: "restore",
              recycleBinId: recycleEntry?.id
            })
          : undefined;
        const previewItem = operationItem.kind === "review_recycle_entry"
          && operationItem.pendingLifecycleOperation === "review_restore"
          && operationItem.canContinue
          ? { ...item, canRestore: true, cannotRestoreReason: undefined }
          : item;
        const preview = outputPreview
          ? toOperationImpactPreview(outputPreview)
          : createRestoreDeletedEntityPreview(previewItem, {
              summary: t("operationCenterRestoreSummary"),
              warning: t("operationCenterRestoreWarning"),
              confirmLabel: t("operationCenterRestore"),
              cancelLabel: t("operationCancel")
            });
        const confirmed = await confirmRestore.requestConfirmation(preview);
        if (!confirmed) {
          const cancelled = createOperationCancelledFeedback(
            preview,
            t("operationCenterRestoreCancelled")
          );
          onWriteResult(cancelled, { operation: cancelled.operation });
          return;
        }

        if (outputPreview) {
          const result = await restoreOutputEntity({
            confirmation: confirmOutputDeleteImpactPreview(outputPreview)
          });
          onWriteResult(result, {
            operation: "recycleBin.restore",
            successMessage: t("operationCenterRestoreSuccess")
          });
        } else {
          const dispatchItem = operationItem.kind === "review_recycle_entry"
            ? {
                ...item,
                lifecycleActionId: operationItem.pendingLifecycleActionId ?? undefined,
                pendingLifecycleOperation: operationItem.pendingLifecycleOperation ?? undefined
              }
            : item;
          const result = await dispatchOperationCenterRestore(
            { item: dispatchItem, confirmedByUser: true },
            {
              restoreReview: (input) =>
                restoreDeletedReview(input.reviewId, input),
              restoreGeneric: restoreDeletedEntity
            }
          );
          onWriteResult<unknown>(result as WriteFeedbackResult<unknown>, {
            operation: "recycleBin.restore",
            successMessage: t("operationCenterRestoreSuccess")
          });
        }
        await reloadOperationCenter();
      } catch (error) {
        console.warn("Failed to restore deleted entity.", error);
        if (operationItem.kind !== "generic_deleted_entity") {
          const reason = classifyReviewLifecycleError(error);
          const message = reason === "planning_unavailable"
            ? t("reviewLifecyclePlanningUnavailable")
            : reason === "state_changed"
              ? t("reviewLifecycleStateChanged")
              : t("reviewLifecycleAuthorityUnavailable");
          const displayError = new Error(message);
          Object.defineProperty(displayError, "cause", { value: error });
          onWriteError(displayError, "recycleBin.restore");
        } else {
          onWriteError(error, "recycleBin.restore");
        }
      }
    },
    [confirmRestore, onWriteError, onWriteResult, reloadOperationCenter, t]
  );

  const handlePermanentDelete = useCallback(
    async (operationItem: OperationCenterItem) => {
      if (operationItem.kind === "generic_deleted_entity") return;
      const capability = operationItem.permanentDeleteCapability;
      if (
        !capability.canPreviewPermanentDelete
        && !capability.canContinuePermanentDelete
      ) {
        reportPermanentDeleteError(new Error(capability.reasonCode));
        return;
      }
      const requestId = permanentDeleteRequestFence.current + 1;
      permanentDeleteRequestFence.current = requestId;
      setPermanentDeleteDialog(null);
      setPermanentDeleteLoadingRow(operationItem.rowKey);
      try {
        if (capability.canContinuePermanentDelete) {
          const title = operationItem.kind === "review_pending_lifecycle_action"
            ? operationItem.title
            : operationItem.item.title;
          const continuation = await loadOperationCenterReviewPermanentDeleteContinuation(
            capability,
            title
          );
          if (permanentDeleteRequestFence.current !== requestId) return;
          setPermanentDeleteDialog({
            mode: "continuation",
            rowKey: operationItem.rowKey,
            continuation
          });
        } else {
          const preview = await previewOperationCenterReviewPermanentDelete(capability);
          if (permanentDeleteRequestFence.current !== requestId) return;
          setPermanentDeleteDialog({
            mode: "preview",
            rowKey: operationItem.rowKey,
            preview
          });
        }
      } catch (error) {
        if (permanentDeleteRequestFence.current === requestId) {
          reportPermanentDeleteError(error);
        }
      } finally {
        if (permanentDeleteRequestFence.current === requestId) {
          setPermanentDeleteLoadingRow(null);
        }
      }
    },
    [reportPermanentDeleteError]
  );

  const handleConfirmPermanentDelete = useCallback(async () => {
    const state = permanentDeleteDialog;
    if (!state || permanentDeleteSubmission.current) return;
    const submissionIdentity = state.mode === "preview"
      ? `${state.preview.lifecycleActionId}:${state.preview.impactDigest}`
      : `${state.continuation.actionReadback.action.lifecycleActionId}:${state.continuation.impactDigest}`;
    permanentDeleteSubmission.current = submissionIdentity;
    setIsPermanentDeleteSubmitting(true);
    try {
      const result = state.mode === "preview"
        ? await executeOperationCenterReviewPermanentDeletePreview(state.preview)
        : await continueOperationCenterReviewPermanentDelete(state.continuation);
      onWriteResult(result, {
        operation: "review.permanentDelete",
        successMessage: result.priorSuccess
          ? t("operationCenterPermanentDeletePriorSuccess")
          : t("operationCenterPermanentDeleteSuccess")
      });
      closePermanentDeleteDialog();
      await reloadOperationCenter();
    } catch (error) {
      const reason = reportPermanentDeleteError(error);
      if (reviewPermanentDeleteErrorRequiresNewPreview(reason)) {
        closePermanentDeleteDialog();
        await reloadOperationCenter();
      }
    } finally {
      if (permanentDeleteSubmission.current === submissionIdentity) {
        permanentDeleteSubmission.current = null;
        setIsPermanentDeleteSubmitting(false);
      }
    }
  }, [
    closePermanentDeleteDialog,
    onWriteResult,
    permanentDeleteDialog,
    reloadOperationCenter,
    reportPermanentDeleteError,
    t
  ]);

  return (
    <section
      className="settings-panel settings-operation-center"
      aria-labelledby="operation-center-title"
    >
      <div className="operation-center-heading">
        <div>
          <h2 id="operation-center-title">{t("operationCenter")}</h2>
          <p>{t("operationCenterDescription")}</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void reloadOperationCenter()}
          disabled={isLoading}
        >
          {t("operationCenterRefresh")}
        </button>
      </div>

      {loadError ? (
        <p className="operation-center-error">
          {t("operationCenterLoadFailed")} {loadError}
        </p>
      ) : null}

      <div className="operation-center-grid">
        <section aria-labelledby="operation-log-title">
          <h3 id="operation-log-title">{t("operationCenterLogsTitle")}</h3>
          {isLoading ? <p className="operation-center-empty">{t("operationCenterLoading")}</p> : null}
          {!isLoading && logs.length === 0 ? (
            <p className="operation-center-empty">{t("operationCenterNoLogs")}</p>
          ) : null}
          <div className="operation-center-list">
            {logs.map((entry) => (
              <article className="operation-log-item" key={entry.id}>
                <div className="operation-center-item-head">
                  <strong>{entry.summary}</strong>
                  <span className={`operation-status-badge operation-status-${entry.status}`}>
                    {statusLabel(entry.status)}
                  </span>
                </div>
                <p>{summarizeOperationLogMessage(entry)}</p>
                <div className="operation-center-meta">
                  <span>{formatDate(entry.createdAt)}</span>
                  <span>{entry.operationType}</span>
                  <span>{entry.source}</span>
                  <span>{riskLabel(entry.riskLevel)}</span>
                  <span>
                    {t("operationCenterTarget")}{" "}
                    {entry.target.title ?? entry.target.entityId}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="recently-deleted-title">
          <h3 id="recently-deleted-title">{t("operationCenterRecycleTitle")}</h3>
          {isLoading ? <p className="operation-center-empty">{t("operationCenterLoading")}</p> : null}
          {!isLoading && deletedItems.length === 0 ? (
            <p className="operation-center-empty">{t("operationCenterNoDeleted")}</p>
          ) : null}
          <div className="operation-center-list">
            {deletedItems.map((operationItem) => {
              const item = operationItem.kind === "review_pending_lifecycle_action"
                ? null
                : operationItem.item;
              const title = operationItem.kind === "review_pending_lifecycle_action"
                ? operationItem.title
                : operationItem.item.title;
              const summary = operationItem.kind === "review_pending_lifecycle_action"
                ? operationItem.operationType === "review_soft_delete"
                  ? t("operationCenterPendingReviewDeleteSummary")
                  : operationItem.operationType === "review_restore"
                    ? t("operationCenterPendingReviewRestoreMissingEntrySummary")
                    : permanentDeleteStageMessage(operationItem.stage, t)
                : operationItem.item.summary;
              const entityType = item?.entityType ?? "review";
              const module = item?.module ?? "review";
              const occurredAt = operationItem.kind === "review_pending_lifecycle_action"
                ? operationItem.occurredAt
                : operationItem.item.deletedAt;
              const canContinue = operationItem.kind === "review_pending_lifecycle_action"
                ? operationItem.canContinue
                : operationItem.kind === "review_recycle_entry"
                  ? operationItem.canContinue
                  : false;
              const canRestore = item?.canRestore ?? false;
              const warning = operationItem.kind === "review_pending_lifecycle_action"
                ? operationItem.operationType === "review_permanent_delete"
                  ? operationItem.permanentDeleteCapability.userMessage
                  : operationItem.canContinue
                  ? t("operationCenterPendingReviewDeleteReady")
                  : operationItem.reasonCode === "pending_action_exact_entry_conflict"
                    ? t("operationCenterPendingReviewEntryConflict")
                    : t("operationCenterPendingReviewRestoreEntryMissing")
                : operationItem.kind === "review_recycle_entry" && operationItem.pendingLifecycleActionId
                  ? operationItem.pendingLifecycleOperation === "review_soft_delete"
                    ? t("operationCenterPendingReviewDeleteReady")
                    : operationItem.pendingLifecycleOperation === "review_restore"
                      ? t("operationCenterPendingReviewRestoreReady")
                      : permanentDeleteStageMessage(operationItem.pendingLifecycleStage, t)
                  : item?.cannotRestoreReason;
              const pendingOperation = operationItem.kind === "review_pending_lifecycle_action"
                ? operationItem.operationType
                : operationItem.kind === "review_recycle_entry"
                  ? operationItem.pendingLifecycleOperation
                  : null;
              const permanentDeleteCapability = operationItem.kind === "generic_deleted_entity"
                ? null
                : operationItem.permanentDeleteCapability;
              const isPermanentDeletePending = pendingOperation === "review_permanent_delete";
              const canUseRestoreButton = !isPermanentDeletePending && (canRestore || canContinue);
              const showPermanentDeleteButton = operationItem.kind === "review_recycle_entry"
                || (operationItem.kind === "review_pending_lifecycle_action"
                  && operationItem.operationType === "review_permanent_delete");
              const canUsePermanentDeleteButton = Boolean(
                permanentDeleteCapability?.canPreviewPermanentDelete
                || permanentDeleteCapability?.canContinuePermanentDelete
              );
              return (
              <article
                className="operation-deleted-item"
                key={operationItem.rowKey}
              >
                <div className="operation-center-item-head">
                  <strong>{title}</strong>
                  <span>{entityType}</span>
                </div>
                {summary ? <p>{summary}</p> : null}
                {operationItem.kind === "review_recycle_entry" ? (
                  <p>{t("operationCenterReviewRecycleEntryStatus")}</p>
                ) : null}
                <div className="operation-center-meta">
                  <span>{formatDate(occurredAt)}</span>
                  <span>{module}</span>
                  {item ? <span>
                    {t("operationCenterKnownImpact")}{" "}
                    {summarizeDeletedEntityImpact(
                      item,
                      t("operationCenterNoKnownImpact")
                    )}
                  </span> : null}
                </div>
                {warning ? (
                  <p className="operation-center-warning">
                    {!canRestore && !canContinue && !isPermanentDeletePending
                      ? `${t("operationCenterCannotRestore")} `
                      : ""}
                    {warning}
                  </p>
                ) : null}
                {showPermanentDeleteButton
                  && permanentDeleteCapability
                  && !canUsePermanentDeleteButton
                  && warning !== permanentDeleteCapability.userMessage ? (
                    <p className="operation-center-warning">
                      {permanentDeleteCapability.userMessage}
                    </p>
                  ) : null}
                <div className="operation-center-actions">
                  {operationItem.kind !== "review_pending_lifecycle_action"
                    || operationItem.operationType !== "review_permanent_delete" ? (
                      <button
                        type="button"
                        onClick={() => void handleRestore(operationItem)}
                        disabled={!canUseRestoreButton}
                      >
                        {pendingOperation === "review_soft_delete"
                          ? t("operationCenterContinuePendingReviewDelete")
                          : pendingOperation === "review_restore"
                            ? t("operationCenterContinuePendingReviewRestore")
                            : t("operationCenterRestore")}
                      </button>
                    ) : null}
                  {showPermanentDeleteButton && permanentDeleteCapability ? (
                    <button
                      type="button"
                      className="danger-button"
                      disabled={
                        !canUsePermanentDeleteButton
                        || permanentDeleteLoadingRow === operationItem.rowKey
                        || isPermanentDeleteSubmitting
                      }
                      title={!canUsePermanentDeleteButton
                        ? permanentDeleteCapability.userMessage
                        : undefined}
                      onClick={() => void handlePermanentDelete(operationItem)}
                    >
                      {permanentDeleteLoadingRow === operationItem.rowKey
                        ? t("operationCenterPermanentDeletePreviewLoading")
                        : permanentDeleteCapability.canContinuePermanentDelete
                          ? t("operationCenterContinuePermanentDelete")
                          : t("operationCenterPermanentDelete")}
                    </button>
                  ) : null}
                </div>
              </article>
              );
            })}
          </div>
        </section>
      </div>

      <OperationConfirmDialog
        preview={confirmRestore.preview}
        onCancel={confirmRestore.cancel}
        onConfirm={confirmRestore.confirm}
      />
      <ReviewPermanentDeleteDialog
        state={permanentDeleteDialog}
        isSubmitting={isPermanentDeleteSubmitting}
        onCancel={closePermanentDeleteDialog}
        onConfirm={() => void handleConfirmPermanentDelete()}
      />
    </section>
  );
}
