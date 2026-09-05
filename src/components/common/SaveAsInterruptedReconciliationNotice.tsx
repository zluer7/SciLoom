import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  manuscriptSaveAsInterruptedStateService,
  type InterruptedSaveAsIncident
} from "../../services/manuscriptSaveAsInterruptedStateService";
import { ModalPortal } from "./ModalPortal";

export function SaveAsInterruptedReconciliationNotice({
  ownerKeys
}: {
  ownerKeys: readonly string[];
}) {
  const snapshot = useSyncExternalStore(
    manuscriptSaveAsInterruptedStateService.subscribe,
    manuscriptSaveAsInterruptedStateService.getSnapshot,
    manuscriptSaveAsInterruptedStateService.getSnapshot
  );
  const ownerKeySet = useMemo(() => new Set(ownerKeys), [ownerKeys]);
  const incidents = snapshot.incidents.filter((incident) =>
    ownerKeySet.has(`${incident.operation.ownerType}:${incident.operation.ownerId}`)
  );
  const [selected, setSelected] = useState<InterruptedSaveAsIncident | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (ownerKeys.length === 0) return;
    void manuscriptSaveAsInterruptedStateService.scan("pending_scan").catch(() => undefined);
  }, [ownerKeys]);
  if (incidents.length === 0) return null;
  const incident = selected && incidents.some((item) =>
    item.operation.operationId === selected.operation.operationId
  ) ? selected : incidents[0];

  async function confirm() {
    setPending(true);
    setError("");
    try {
      await manuscriptSaveAsInterruptedStateService.reconcilePreservingTarget(incident);
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function cancel() {
    void manuscriptSaveAsInterruptedStateService.recordCancel(incident).catch(() => undefined);
    setSelected(null);
  }

  return (
    <>
      <section className="save-as-interrupted-notice" role="status">
        <div>
          <strong>另存为操作在上次退出时中断</strong>
          <p>现有目标与 FileRef 已保留；该来源的新另存为已冻结，等待你核对并确认。</p>
        </div>
        <button type="button" onClick={() => setSelected(incident)}>核对并处理</button>
      </section>
      {selected ? (
        <ModalPortal>
          <div className="modal-backdrop" role="presentation">
            <section className="save-as-interrupted-dialog" role="dialog" aria-modal="true" aria-labelledby="save-as-interrupted-title">
              <h2 id="save-as-interrupted-title">确认保留现有目标</h2>
              <p>SciLoom 已阻止自动接管或重复另存为。确认后仅结束旧操作的中断状态，不会标记为安装成功，也不会读取或改写文稿正文。</p>
              <dl>
                <dt>Owner</dt><dd>{incident.operation.ownerType} / {incident.operation.ownerId}</dd>
                <dt>Channel</dt><dd>{incident.operation.channel}</dd>
                <dt>Target</dt><dd>{incident.operation.targetDisplayPath}</dd>
                <dt>Receipt</dt><dd>{incident.finalization.receiptId}</dd>
              </dl>
              {!incident.physicalTargetVerified ? (
                <p className="save-as-interrupted-error" role="alert">目标身份未通过核验：{incident.verificationError}</p>
              ) : null}
              {error ? <p className="save-as-interrupted-error" role="alert">{error}</p> : null}
              <div className="save-as-interrupted-actions">
                <button type="button" className="secondary-button" disabled={pending} onClick={cancel}>取消</button>
                <button type="button" disabled={pending || !incident.physicalTargetVerified} onClick={() => void confirm()}>
                  {pending ? "正在确认…" : "确认并保留现有目标"}
                </button>
              </div>
            </section>
          </div>
        </ModalPortal>
      ) : null}
    </>
  );
}
