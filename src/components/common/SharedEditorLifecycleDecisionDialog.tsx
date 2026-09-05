import type { SharedEditorLifecycleRequestSnapshot } from "../../services/sharedEditorLifecycleController";

type SharedEditorLifecycleDecisionDialogProps = {
  request: SharedEditorLifecycleRequestSnapshot;
  title: string;
  message: string;
  saveLabel: string;
  discardLabel: string;
  cancelLabel: string;
  savingLabel: string;
  discardingLabel?: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
};

export function SharedEditorLifecycleDecisionDialog({
  request,
  title,
  message,
  saveLabel,
  discardLabel,
  cancelLabel,
  savingLabel,
  discardingLabel = discardLabel,
  onSave,
  onDiscard,
  onCancel
}: SharedEditorLifecycleDecisionDialogProps) {
  const pending = request.phase === "SAVING" || request.phase === "DISCARDING";
  return (
    <div className="markdown-editor-confirm-backdrop" role="presentation">
      <section
        className="markdown-editor-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`shared-editor-lifecycle-${request.requestGeneration}`}
      >
        <h3 id={`shared-editor-lifecycle-${request.requestGeneration}`}>{title}</h3>
        <p>{message}</p>
        {request.queueLength > 1 ? (
          <p>{request.queuePosition} / {request.queueLength}</p>
        ) : null}
        {request.error ? <p role="alert">{request.error}</p> : null}
        <div className="markdown-editor-confirm-actions">
          <button
            type="button"
            className="markdown-editor-confirm-cancel"
            disabled={pending}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="markdown-editor-confirm-discard"
            disabled={pending}
            onClick={onDiscard}
          >
            {request.phase === "DISCARDING" ? discardingLabel : discardLabel}
          </button>
          <button
            type="button"
            className="markdown-editor-confirm-save"
            disabled={pending}
            onClick={onSave}
          >
            {request.phase === "SAVING" ? savingLabel : saveLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
