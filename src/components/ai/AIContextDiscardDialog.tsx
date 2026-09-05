type AIContextDiscardDialogProps = {
  open: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AIContextDiscardDialog({
  open,
  confirmLabel,
  onCancel,
  onConfirm
}: AIContextDiscardDialogProps) {
  if (!open) return null;

  return (
    <div className="ai-context-discard-dialog__backdrop">
      <section
        aria-labelledby="ai-context-discard-dialog-title"
        aria-modal="true"
        className="ai-context-discard-dialog"
        role="alertdialog"
      >
        <h2 id="ai-context-discard-dialog-title">有未保存的上下文编辑</h2>
        <p>离开后，本次尚未保存的上下文内容修改将被丢弃；业务数据不会改变。</p>
        <div className="ai-context-discard-dialog__actions">
          <button autoFocus onClick={onCancel} type="button">继续编辑</button>
          <button className="is-danger" onClick={onConfirm} type="button">{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
