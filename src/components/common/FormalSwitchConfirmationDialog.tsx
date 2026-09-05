import { ModalPortal } from "./ModalPortal";

type FormalSwitchConfirmationDialogProps = {
  dialogId: string;
  title: string;
  message?: string;
  semanticBlocks?: readonly string[];
  confirmLabel: string;
  cancelLabel: string;
  onConfirm(): void;
  onCancel(): void;
  backdropClassName?: string;
  dialogClassName?: string;
};

export function FormalSwitchConfirmationDialog({
  dialogId,
  title,
  message,
  semanticBlocks,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  backdropClassName = "review-manuscript-choice-backdrop",
  dialogClassName = "review-manuscript-choice-dialog"
}: FormalSwitchConfirmationDialogProps) {
  const blocks = semanticBlocks ?? message?.split("\n\n") ?? [];

  return (
    <ModalPortal>
      <div className={`modal-backdrop ${backdropClassName}`} role="presentation">
        <section
          className={`operation-confirm-dialog ${dialogClassName}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogId}
        >
          <h2 id={dialogId}>{title}</h2>
          {blocks.map((block, index) => (
            <p key={`${index}:${block}`}>{block}</p>
          ))}
          <div className="button-row">
            <button type="button" className="primary-button" onClick={onConfirm}>
              {confirmLabel}
            </button>
            <button type="button" className="secondary-button" onClick={onCancel}>
              {cancelLabel}
            </button>
          </div>
        </section>
      </div>
    </ModalPortal>
  );
}
