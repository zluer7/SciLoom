import { useEffect } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type {
  OperationCenterReviewPermanentDeleteImpactPlan,
  OperationCenterReviewPermanentDeletePreview,
  ReviewPermanentDeleteContinuation
} from "../../services/reviewPermanentDeleteOperationCenterService";

export type ReviewPermanentDeleteDialogState =
  | {
      mode: "preview";
      rowKey: string;
      preview: OperationCenterReviewPermanentDeletePreview;
    }
  | {
      mode: "continuation";
      rowKey: string;
      continuation: ReviewPermanentDeleteContinuation;
    };

interface ReviewPermanentDeleteDialogProps {
  state: ReviewPermanentDeleteDialogState | null;
  isSubmitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function countDisposition(
  plan: OperationCenterReviewPermanentDeleteImpactPlan,
  disposition: string
) {
  return plan.changeLogTargets.filter((target) => target.disposition === disposition).length;
}

export function ReviewPermanentDeleteDialog({
  state,
  isSubmitting,
  onConfirm,
  onCancel
}: ReviewPermanentDeleteDialogProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!state || isSubmitting || typeof window === "undefined") return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onCancel, state]);

  if (!state) return null;

  const isContinuation = state.mode === "continuation";
  const plan = isContinuation ? state.continuation.plan : state.preview.plan;
  const digest = isContinuation
    ? state.continuation.impactDigest
    : state.preview.impactDigest;
  const reviewTitle = isContinuation
    ? state.continuation.reviewTitle
    : state.preview.review.title;
  const stage = isContinuation
    ? state.continuation.actionReadback.action.currentStage
    : null;

  return (
    <div className="modal-backdrop operation-confirm-backdrop" role="presentation">
      <section
        className="operation-confirm-dialog review-permanent-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="review-permanent-delete-title"
        aria-describedby="review-permanent-delete-warning"
        data-review-permanent-delete-dialog={state.rowKey}
      >
        <header className="operation-confirm-header">
          <div>
            <span className="operation-risk-badge is-critical">
              {t("operationRiskCritical")}
            </span>
            <h2 id="review-permanent-delete-title">
              {isContinuation
                ? t("operationCenterContinuePermanentDeleteTitle")
                : t("operationCenterPermanentDeletePreviewTitle")}
            </h2>
          </div>
        </header>

        <p>{t("operationCenterPermanentDeleteCoreWarning")}</p>
        <p className="operation-center-warning">
          {t("operationCenterPermanentDeletePhysicalFilesPreserved")}
        </p>
        <p id="review-permanent-delete-warning" className="operation-center-error">
          {t("operationCenterPermanentDeleteIrreversible")}
        </p>

        <dl className="review-permanent-delete-identities">
          <div>
            <dt>{t("operationCenterPermanentDeleteReview")}</dt>
            <dd>{reviewTitle || t("operationCenterUnnamedReview")} / {plan.reviewId}</dd>
          </div>
          <div><dt>{t("operationCenterPermanentDeleteProject")}</dt><dd>{plan.projectId}</dd></div>
          <div>
            <dt>{t("operationCenterPermanentDeleteRecycleEntry")}</dt>
            <dd>{plan.exactRecycleEntryId} / r{plan.expectedRecycleEntryRevision}</dd>
          </div>
          <div><dt>{t("operationCenterPermanentDeleteSourceAction")}</dt><dd>{plan.sourceDeleteActionId}</dd></div>
          {stage ? (
            <div>
              <dt>{t("operationCenterPermanentDeleteCurrentStage")}</dt>
              <dd>{stage === "prepared"
                ? t("operationCenterPermanentDeleteStagePrepared")
                : t("operationCenterPermanentDeleteStagePlanningCommitted")}</dd>
            </div>
          ) : null}
        </dl>

        <section className="operation-impact-section">
          <h3>{t("operationCenterPermanentDeleteMetadataImpact")}</h3>
          <ul>
            <li data-impact-kind="binding">{t("operationCenterPermanentDeleteBindingCount")} <strong>{plan.bindingTargets.length}</strong></li>
            <li data-impact-kind="file-ref">{t("operationCenterPermanentDeleteFileRefCount")} <strong>{plan.fileRefTargets.length}</strong></li>
            <li data-impact-kind="entity-link">{t("operationCenterPermanentDeleteEntityLinkCount")} <strong>{plan.entityLinkTargets.length}</strong></li>
            <li data-impact-kind="change-log-delete">{t("operationCenterPermanentDeleteChangeLogDeleteCount")} <strong>{countDisposition(plan, "DELETE")}</strong></li>
            <li data-impact-kind="change-log-sanitize">{t("operationCenterPermanentDeleteChangeLogSanitizeCount")} <strong>{countDisposition(plan, "SANITIZE")}</strong></li>
            <li data-impact-kind="change-log-keep">{t("operationCenterPermanentDeleteChangeLogKeepCount")} <strong>{countDisposition(plan, "KEEP_AUDIT_ONLY")}</strong></li>
          </ul>
        </section>

        <details className="review-permanent-delete-diagnostics">
          <summary>{t("operationCenterPermanentDeleteDiagnostics")}</summary>
          <dl>
            <div><dt>{t("operationCenterPermanentDeletePlanVersion")}</dt><dd>{plan.impactPlanVersion}</dd></div>
            <div>
              <dt>{t("operationCenterPermanentDeletePlanningIdentity")}</dt>
              <dd>{plan.expectedPlanningEpoch} / r{plan.expectedPlanningRevision}</dd>
            </div>
            <div><dt>{t("operationCenterPermanentDeleteDigest")}</dt><dd>{digest}</dd></div>
          </dl>
        </details>

        {isContinuation ? (
          <p className="operation-scan-note">
            {t("operationCenterPermanentDeletePersistedPlanNotice")}
          </p>
        ) : null}

        <footer className="operation-confirm-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            {t("operationCancel")}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={isSubmitting}
            onClick={onConfirm}
          >
            {isSubmitting
              ? t("operationCenterPermanentDeleteSubmitting")
              : isContinuation
                ? t("operationCenterContinuePermanentDelete")
                : t("operationCenterPermanentDeleteConfirm")}
          </button>
        </footer>
      </section>
    </div>
  );
}
