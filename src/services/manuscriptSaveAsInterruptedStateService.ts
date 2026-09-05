import { fileRefService } from "./fileRefService";
import {
  manuscriptSaveAsCandidateCustodyPort,
  type CandidateCustodyRecord
} from "./manuscriptSaveAsCandidateCustody";
import {
  manuscriptSaveAsFinalizationPort,
  type SaveAsFinalizationRecord
} from "./manuscriptSaveAsFinalizationPort";
import {
  manuscriptSaveAsOperationPort,
  type SaveAsOperationRecord
} from "./manuscriptSaveAsOperationPort";
import { manuscriptSaveAsPhysicalObservationPort } from "./manuscriptSaveAsPhysicalObservationPort";
import { manuscriptSaveAsTargetGuardPort } from "./manuscriptSaveAsTargetGuardPort";
import { operationLogService } from "./operationLogService";

export type InterruptedSaveAsTrigger = "startup" | "pending_scan" | "explicit_retry";

export interface InterruptedSaveAsIncident {
  operation: SaveAsOperationRecord;
  finalization: SaveAsFinalizationRecord;
  custody: CandidateCustodyRecord;
  detectedAt: string;
  detectedProcessGeneration: string;
  physicalTargetVerified: boolean;
  verificationError?: string;
}

export interface InterruptedSaveAsSnapshot {
  incidents: readonly InterruptedSaveAsIncident[];
  scanning: boolean;
  lastError?: string;
}

const listeners = new Set<() => void>();
let snapshot: InterruptedSaveAsSnapshot = Object.freeze({
  incidents: Object.freeze([]),
  scanning: false
});
let scanPromise: Promise<InterruptedSaveAsSnapshot> | undefined;
const appSessionId = `save-as-session-${
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}`;

function publish(next: InterruptedSaveAsSnapshot) {
  snapshot = Object.freeze({
    ...next,
    incidents: Object.freeze([...next.incidents])
  });
  listeners.forEach((listener) => listener());
}

function moduleFor(ownerType: string) {
  if (ownerType === "literature") return "literature" as const;
  if (ownerType === "researchOutput") return "output" as const;
  if (["resultItem", "finding", "outputCandidate", "outputGap"].includes(ownerType)) {
    return "outputConversion" as const;
  }
  if (ownerType === "review") return "review" as const;
  return "experiment" as const;
}

async function recordAudit(
  incident: InterruptedSaveAsIncident,
  selectedAction: "detected" | "confirm_preserve_existing_target" | "cancel",
  trigger: InterruptedSaveAsTrigger,
  confirmedByUser: boolean
) {
  const id = selectedAction === "detected"
    ? `save-as-interrupted-${incident.operation.operationId}`
    : `save-as-reconcile-${selectedAction}-${appSessionId}-${incident.operation.operationId}`;
  if (await operationLogService.getOperationLog(id)) return id;
  await operationLogService.createOperationLog({
    id,
    operationType: "custom",
    source: selectedAction === "detected" ? "system" : "user",
    module: moduleFor(incident.operation.ownerType),
    status: selectedAction === "cancel"
      ? "skipped"
      : selectedAction === "confirm_preserve_existing_target"
        ? "partial"
        : "success",
    riskLevel: "high",
    target: {
      entityType: "manuscriptSaveAsOperation",
      entityId: incident.operation.operationId,
      title: "Interrupted Save As reconciliation"
    },
    summary: selectedAction === "detected"
      ? "Cross-process Save As interruption was contained for explicit reconciliation."
      : selectedAction === "cancel"
        ? "Interrupted Save As reconciliation was canceled without durable mutation."
        : "User confirmed preservation of the existing Save As target; controlled reconciliation is pending.",
    confirmation: {
      required: selectedAction !== "detected",
      confirmedByUser,
      confirmedAt: confirmedByUser ? new Date().toISOString() : undefined,
      cancelledByUser: selectedAction === "cancel"
    },
    feedback: {
      status: selectedAction === "cancel"
        ? "skipped"
        : selectedAction === "confirm_preserve_existing_target"
          ? "partial"
          : "success",
      message: "Save As interruption audit recorded.",
      warnings: [],
      errors: [],
      skipped: selectedAction === "cancel" ? ["reconciliation_cancelled"] : [],
      affectedEntities: [],
      refreshKeys: ["operationLog.changed"],
      details: {
        confirmationSource: selectedAction === "detected" ? "startup_or_pending_scan" : "owner_local_reconciliation_ui",
        appSessionId,
        processGeneration: incident.detectedProcessGeneration,
        selectedAction,
        trigger,
        operationId: incident.operation.operationId,
        receiptId: incident.finalization.receiptId,
        ownerType: incident.operation.ownerType,
        ownerId: incident.operation.ownerId,
        channel: incident.operation.channel,
        sourceFileRefId: incident.operation.sourceFileRefId,
        targetFileRefId: incident.operation.targetFileRefId,
        result: selectedAction === "detected"
          ? "INTERRUPTED_MANUAL_RECONCILIATION_REQUIRED"
          : selectedAction === "cancel"
            ? "NO_EFFECT"
            : "CONFIRMATION_RECORDED_RECONCILIATION_PENDING"
      }
    },
    isRecoverable: selectedAction !== "confirm_preserve_existing_target",
    actorId: selectedAction === "detected" ? "local_system" : "local_user",
    actorLabel: selectedAction === "detected" ? "Local system" : "Local user"
  });
  return id;
}

async function loadIncident(
  finalization: SaveAsFinalizationRecord,
  detectedAt: string,
  processGeneration: string
): Promise<InterruptedSaveAsIncident | undefined> {
  const [operation, custody] = await Promise.all([
    manuscriptSaveAsOperationPort.readback(finalization.operationId),
    manuscriptSaveAsCandidateCustodyPort.readback(finalization.operationId)
  ]);
  if (
    !operation || !custody ||
    operation.stage !== "reconciliation_blocked" ||
    operation.reconciliationState !== "blocked" ||
    operation.blockingCode !== "SAVE_AS_OPERATION_STALE" ||
    finalization.finalizationState !== "presentation_completed" ||
    custody.custodyState !== "process_generation_retired" ||
    custody.currentCustodyAuthority !== "resolved" ||
    !operation.sourceFileRefId || !operation.targetFileRefId ||
    operation.targetFileRefId !== finalization.candidateFileRefId ||
    operation.targetFileRefId !== custody.candidateFileRefId ||
    operation.ownerType !== finalization.ownerType ||
    operation.ownerId !== finalization.ownerId ||
    operation.channel !== finalization.channel ||
    custody.receiptId !== finalization.receiptId
  ) return undefined;

  let physicalTargetVerified = false;
  let verificationError: string | undefined;
  try {
    const targetFileRef = await fileRefService.getById(operation.targetFileRefId);
    if (
      !targetFileRef || targetFileRef.deletedAt ||
      targetFileRef.ownerType !== operation.ownerType ||
      targetFileRef.ownerId !== operation.ownerId ||
      targetFileRef.manuscriptChannel !== operation.channel ||
      targetFileRef.pathIdentityKey !== operation.targetPathIdentityKey
    ) {
      verificationError = "SAVE_AS_INTERRUPTED_TARGET_FILE_REF_MISMATCH";
    } else {
      const observed = await manuscriptSaveAsPhysicalObservationPort.observeExistingSaveAsTarget({
        targetPath: targetFileRef.path,
        expectedPathIdentity: operation.targetPathIdentityKey
      });
      physicalTargetVerified = observed.ok &&
        observed.value.targetPhysicalIdentityHash === operation.d1PhysicalIdentityHash;
      if (!physicalTargetVerified) {
        verificationError = "SAVE_AS_INTERRUPTED_TARGET_PHYSICAL_IDENTITY_MISMATCH";
      }
    }
  } catch {
    verificationError = "SAVE_AS_INTERRUPTED_TARGET_VERIFICATION_FAILED";
  }
  return {
    operation,
    finalization,
    custody,
    detectedAt,
    detectedProcessGeneration: processGeneration,
    physicalTargetVerified,
    verificationError
  };
}

async function executeScan(trigger: InterruptedSaveAsTrigger) {
  publish({ ...snapshot, scanning: true, lastError: undefined });
  try {
    const observedProcess = await manuscriptSaveAsTargetGuardPort.observeCurrentProcessGeneration();
    const pending = await manuscriptSaveAsFinalizationPort.listPending(100);
    for (const finalization of pending) {
      if (finalization.finalizationState !== "presentation_completed") continue;
      const [operation, custody] = await Promise.all([
        manuscriptSaveAsOperationPort.readback(finalization.operationId),
        manuscriptSaveAsCandidateCustodyPort.readback(finalization.operationId)
      ]);
      if (!operation || !custody || operation.stage !== "p4_presentation_pending") continue;
      if (operation.producerProcessGeneration === observedProcess.processGeneration) continue;
      await manuscriptSaveAsFinalizationPort.containInterrupted({
        operationId: operation.operationId,
        expectedOperationRevision: operation.revision,
        expectedFinalizationRevision: finalization.revision,
        expectedCustodyRevision: custody.revision,
        receiptId: finalization.receiptId
      });
    }
    const interrupted = await manuscriptSaveAsFinalizationPort.listInterrupted(100);
    const detectedAt = new Date().toISOString();
    const incidents = (await Promise.all(interrupted.map((record) =>
      loadIncident(record, detectedAt, observedProcess.processGeneration)
    ))).filter((value): value is InterruptedSaveAsIncident => Boolean(value));
    publish({ incidents, scanning: false });
    await Promise.all(incidents.map((incident) =>
      recordAudit(incident, "detected", trigger, false).catch(() => undefined)
    ));
    return snapshot;
  } catch (cause) {
    const lastError = cause instanceof Error ? cause.message : String(cause);
    publish({ ...snapshot, scanning: false, lastError });
    throw cause;
  }
}

export const manuscriptSaveAsInterruptedStateService = Object.freeze({
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot() {
    return snapshot;
  },
  scan(trigger: InterruptedSaveAsTrigger = "pending_scan") {
    if (!scanPromise) {
      scanPromise = executeScan(trigger).finally(() => { scanPromise = undefined; });
    }
    return scanPromise;
  },
  async reconcilePreservingTarget(incident: InterruptedSaveAsIncident) {
    if (!incident.physicalTargetVerified) {
      throw new Error(incident.verificationError ?? "SAVE_AS_INTERRUPTED_TARGET_NOT_VERIFIED");
    }
    const auditId = await recordAudit(
      incident,
      "confirm_preserve_existing_target",
      "explicit_retry",
      true
    );
    try {
      await manuscriptSaveAsFinalizationPort.reconcileInterruptedPreservingTarget({
        operationId: incident.operation.operationId,
        expectedOperationRevision: incident.operation.revision,
        expectedFinalizationRevision: incident.finalization.revision,
        expectedCustodyRevision: incident.custody.revision,
        receiptId: incident.finalization.receiptId,
        ownerType: incident.operation.ownerType,
        ownerId: incident.operation.ownerId,
        channel: incident.operation.channel,
        sourceFileRefId: incident.operation.sourceFileRefId!,
        targetFileRefId: incident.operation.targetFileRefId!,
        targetPathIdentityKey: incident.operation.targetPathIdentityKey
      });
    } catch (cause) {
      await operationLogService.updateOperationLog(auditId, {
        status: "error",
        summary: "Controlled reconciliation failed after explicit preserve-target confirmation.",
        errors: [cause instanceof Error ? cause.message : String(cause)]
      }).catch(() => undefined);
      throw cause;
    }
    await operationLogService.updateOperationLog(auditId, {
      status: "success",
      summary: "User confirmed preservation of the existing Save As target; the old operation was compensated without installation.",
      feedback: {
        status: "success",
        message: "Interrupted Save As operation compensated; existing target preserved.",
        warnings: [],
        errors: [],
        skipped: [],
        affectedEntities: [],
        refreshKeys: ["operationLog.changed"],
        details: {
          confirmationSource: "owner_local_reconciliation_ui",
          appSessionId,
          processGeneration: incident.detectedProcessGeneration,
          selectedAction: "confirm_preserve_existing_target",
          operationId: incident.operation.operationId,
          receiptId: incident.finalization.receiptId,
          ownerType: incident.operation.ownerType,
          ownerId: incident.operation.ownerId,
          channel: incident.operation.channel,
          sourceFileRefId: incident.operation.sourceFileRefId,
          targetFileRefId: incident.operation.targetFileRefId,
          result: "COMPENSATED_TARGET_PRESERVED"
        }
      },
      isRecoverable: false
    }).catch(() => undefined);
    return executeScan("explicit_retry");
  },
  recordCancel(incident: InterruptedSaveAsIncident) {
    return recordAudit(incident, "cancel", "explicit_retry", false);
  }
});
