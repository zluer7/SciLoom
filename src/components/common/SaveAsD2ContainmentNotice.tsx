import { useEffect, useState, useSyncExternalStore } from "react";
import {
  manuscriptSaveAsD2ContainmentService
} from "../../services/manuscriptSaveAsD2ContainmentService";
import type { SaveAsOperationRecord } from "../../services/manuscriptSaveAsOperationPort";
import { ModalPortal } from "./ModalPortal";

export function SaveAsD2ContainmentNotice() {
  const snapshot = useSyncExternalStore(
    manuscriptSaveAsD2ContainmentService.subscribe,
    manuscriptSaveAsD2ContainmentService.getSnapshot,
    manuscriptSaveAsD2ContainmentService.getSnapshot
  );
  const [selected, setSelected] = useState<SaveAsOperationRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void manuscriptSaveAsD2ContainmentService.scan();
  }, []);

  const incident = selected ?? snapshot.incidents[0];
  if (!incident) return null;
  const confirmable = incident.stage === "d2_reconciliation_contained";
  const reconciledTerminal = incident.stage === "d2_reconciled_terminal";
  const physicalIntegrityIncident = snapshot.integrityIncidentOperationIds.includes(
    incident.operationId
  );

  async function confirm() {
    setPending(true);
    setError("");
    try {
      const result = await manuscriptSaveAsD2ContainmentService.confirm(incident);
      setSelected(result.operation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function dismiss() {
    setPending(true);
    setError("");
    try {
      await manuscriptSaveAsD2ContainmentService.dismiss(incident);
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section className="save-as-interrupted-notice" role="status">
        <div>
          <strong>
            {physicalIntegrityIncident
              ? "Save As target integrity check failed"
              : reconciledTerminal
              ? "Save As metadata reconciliation closed without success"
              : "Save As metadata reconciliation is contained"}
          </strong>
          <p>
            {physicalIntegrityIncident
              ? "The reconciled terminal operation remains immutable, but the target no longer matches its D1 proof. Related file use is blocked."
              : reconciledTerminal
              ? "The exact target FileRef was reconciled, but no source switch, runtime handoff, or Save As success was applied."
              : "SciLoom fenced an interrupted FileRef registration. No source switch, runtime handoff, or success state was applied."}
          </p>
        </div>
        <button type="button" onClick={() => setSelected(incident)}>
          Review
        </button>
      </section>
      {selected ? (
        <ModalPortal>
          <div className="modal-backdrop" role="presentation">
            <section
              className="save-as-interrupted-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="save-as-d2-containment-title"
            >
              <h2 id="save-as-d2-containment-title">
                Interrupted Save As metadata
              </h2>
              <p>
                {physicalIntegrityIncident
                  ? "A post-reconciliation physical-integrity incident was recorded. The terminal operation is unchanged and the target must not be used through this reconciliation."
                  : "Confirm registers or reuses the exact target FileRef and closes this operation as a reconciled non-success. It does not activate the target or report Save As success."}
              </p>
              <dl>
                <dt>Owner</dt><dd>{incident.ownerType} / {incident.ownerId}</dd>
                <dt>Channel</dt><dd>{incident.channel}</dd>
                <dt>Target</dt><dd>{incident.targetDisplayPath}</dd>
                <dt>Stage</dt><dd>{incident.stage}</dd>
                <dt>Fence</dt><dd>{incident.commitFenceRevision}</dd>
                {incident.blockingCode ? (
                  <><dt>Conflict</dt><dd>{incident.blockingCode}</dd></>
                ) : null}
              </dl>
              {error ? <p className="save-as-interrupted-error" role="alert">{error}</p> : null}
              <div className="save-as-interrupted-actions">
                {reconciledTerminal ? (
                  <button type="button" className="secondary-button" onClick={() => setSelected(null)}>
                    Close
                  </button>
                ) : (
                  <button type="button" className="secondary-button" disabled={pending} onClick={() => void dismiss()}>
                    Dismiss notice
                  </button>
                )}
                {confirmable ? (
                  <button type="button" disabled={pending} onClick={() => void confirm()}>
                    {pending ? "Confirming…" : "Confirm FileRef reconciliation"}
                  </button>
                ) : null}
              </div>
            </section>
          </div>
        </ModalPortal>
      ) : null}
    </>
  );
}
