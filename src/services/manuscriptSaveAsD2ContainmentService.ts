import {
  manuscriptSaveAsOperationPort,
  saveAsOperationExpectation,
  type SaveAsD2AuthorityResult,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";

export interface SaveAsD2ContainmentSnapshot {
  incidents: readonly SaveAsOperationRecord[];
  integrityIncidentOperationIds: readonly string[];
  scanning: boolean;
  error?: string;
}

type Listener = () => void;

function sameObservation(
  first: SaveAsOperationRecord,
  second: SaveAsOperationRecord
) {
  return (
    first.operationId === second.operationId &&
    first.revision === second.revision &&
    first.commitFenceRevision === second.commitFenceRevision &&
    first.stage === second.stage &&
    first.updatedAt === second.updatedAt &&
    first.producerProcessGeneration === second.producerProcessGeneration
  );
}

class ManuscriptSaveAsD2ContainmentService {
  private listeners = new Set<Listener>();
  private snapshot: SaveAsD2ContainmentSnapshot = {
    incidents: [],
    integrityIncidentOperationIds: [],
    scanning: false
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private publish(next: SaveAsD2ContainmentSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  async scan() {
    if (this.snapshot.scanning) return this.snapshot;
    this.publish({ ...this.snapshot, scanning: true, error: undefined });
    try {
      const candidates = await manuscriptSaveAsOperationPort.listReconcilable(250);
      for (const candidate of candidates) {
        if (candidate.stage !== "d2_commit_unknown") continue;
        const first = await manuscriptSaveAsOperationPort.readback(candidate.operationId);
        const second = await manuscriptSaveAsOperationPort.readback(candidate.operationId);
        if (
          !first ||
          !second ||
          first.stage !== "d2_commit_unknown" ||
          !sameObservation(first, second)
        ) {
          continue;
        }
        try {
          await manuscriptSaveAsOperationPort.containUnknownD2({
            operationId: second.operationId,
            expected: saveAsOperationExpectation(second),
            actionId: `contain:${second.operationId}:${second.revision}:${second.commitFenceRevision}`
          });
        } catch {
          // A concurrent authority won the fence; authoritative readback below decides visibility.
        }
      }
      const incidents = await manuscriptSaveAsOperationPort.listVisibleD2Containment(250);
      const terminalOperations = await manuscriptSaveAsOperationPort.listReconciledTerminalD2(250);
      const integrityIncidents: SaveAsOperationRecord[] = [];
      for (const operation of terminalOperations) {
        const integrity = await manuscriptSaveAsOperationPort.auditTerminalD2Integrity({
          operationId: operation.operationId
        });
        if (!integrity.fileUseAllowed) {
          integrityIncidents.push(integrity.operation);
        }
      }
      this.publish({
        incidents: [...incidents, ...integrityIncidents],
        integrityIncidentOperationIds: integrityIncidents.map(
          (operation) => operation.operationId
        ),
        scanning: false
      });
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        scanning: false,
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
    return this.snapshot;
  }

  async confirm(operation: SaveAsOperationRecord): Promise<SaveAsD2AuthorityResult> {
    if (
      operation.stage !== "d2_reconciliation_contained" ||
      !operation.containmentFenceToken
    ) {
      throw new Error("D2_UNKNOWN_STALE_PERMIT");
    }
    const result = await manuscriptSaveAsOperationPort.confirmContainedD2({
      operationId: operation.operationId,
      expected: saveAsOperationExpectation(operation),
      containmentFenceToken: operation.containmentFenceToken,
      actionId: `confirm:${operation.operationId}:${operation.containmentFenceToken}`
    });
    await this.scan();
    return result;
  }

  async dismiss(operation: SaveAsOperationRecord): Promise<SaveAsD2AuthorityResult> {
    if (!operation.containmentFenceToken) {
      throw new Error("D2_UNKNOWN_STALE_PERMIT");
    }
    const result = await manuscriptSaveAsOperationPort.dismissContainedD2Notice({
      operationId: operation.operationId,
      expectedOperationRevision: operation.revision,
      expectedFenceRevision: operation.commitFenceRevision,
      containmentFenceToken: operation.containmentFenceToken,
      actionId: `dismiss:${operation.operationId}:${operation.containmentFenceToken}`
    });
    await this.scan();
    return result;
  }
}

export const manuscriptSaveAsD2ContainmentService =
  new ManuscriptSaveAsD2ContainmentService();
