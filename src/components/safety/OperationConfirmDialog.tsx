import { useEffect, useRef } from "react";
import { ModalPortal } from "../common/ModalPortal";
import { useI18n } from "../../i18n/I18nProvider";
import type { OperationImpactPreview } from "../../types/operationSafety";

interface OperationConfirmDialogProps {
  preview: OperationImpactPreview | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function OperationConfirmDialog({
  preview,
  onConfirm,
  onCancel
}: OperationConfirmDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!preview) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
    }
    window.addEventListener("keydown", handleKeyDown, true);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel, preview]);

  if (!preview) return null;

  const isDelete = preview.operation === "delete";
  const riskNotices = preview.warnings.length > 0
    ? preview.warnings
    : [t("operationRiskReviewNotice")];

  return (
    <ModalPortal>
      <div
        className="modal-backdrop operation-confirm-backdrop"
        role="presentation"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <section
          ref={dialogRef}
          className="operation-confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="operation-confirm-title"
          aria-describedby="operation-confirm-impact operation-confirm-risk"
          tabIndex={-1}
        >
          <header className="operation-confirm-header">
            <h2 id="operation-confirm-title">
              {isDelete ? t("operationDeleteConfirmTitle") : t("operationConfirmTitle")}
            </h2>
          </header>

          <section
            className="operation-confirm-target"
            aria-label={isDelete ? t("operationDeleteTarget") : t("operationTarget")}
          >
            <h3>{isDelete ? t("operationDeleteTarget") : t("operationTarget")}</h3>
            <strong>{preview.target.title}</strong>
          </section>

          <section className="operation-impact-section" id="operation-confirm-impact">
            <h3>
              {t("operationKnownImpact")}
              {preview.affectedEntityCount > 0 ? ` (${preview.affectedEntityCount})` : ""}
            </h3>
            <p>{preview.summary}</p>
            {preview.affectedItems.length > 0 ? (
              <ul>
                {preview.affectedItems.map((item) => (
                  <li className={`is-${item.severity}`} key={`${item.entityType}:${item.entityId ?? item.title}`}>
                    <strong>{item.title}</strong>
                    {item.description ? <span>{item.description}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="operation-risk-section" id="operation-confirm-risk">
            <h3>{t("operationWarnings")}</h3>
            <ul>
              {riskNotices.map((warning) => <li key={warning}>{warning}</li>)}
              {preview.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </section>

          <footer className="operation-confirm-actions">
            <button
              type="button"
              className="danger-button"
              disabled={!preview.canProceed}
              onClick={onConfirm}
            >
              {isDelete ? t("operationKindDelete") : preview.confirmLabel ?? t("operationConfirm")}
            </button>
            <button type="button" className="secondary-button" onClick={onCancel}>
              {isDelete ? t("operationCancel") : preview.cancelLabel ?? t("operationCancel")}
            </button>
          </footer>
        </section>
      </div>
    </ModalPortal>
  );
}
