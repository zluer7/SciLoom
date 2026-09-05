import { invoke } from "@tauri-apps/api/core";
import type { ManagedRootStatus } from "../types/managedPath";
import type { WriteFeedbackResult } from "../types/writeFeedback";
import { addWriteFeedbackWarning, createErrorWriteFeedback, createSkippedWriteFeedback, createSuccessWriteFeedback } from "./writeFeedbackService";
import { createOperationLog, summarizeFeedbackForOperationLog } from "./operationLogService";
import { runManagedRootAuthorityWrite } from "./metadataAuthorityWriterGuard";

export type DurableManagedRootState = "NOT_CONFIGURED" | "CONFIGURED" | "READ_FAILED";
export type ManagedRootReadinessState =
  | "READY"
  | "UNAVAILABLE"
  | "NOT_WRITABLE"
  | "INVALID_PATH"
  | "READ_FAILED";

export interface ManagedRootConfigurationSnapshot {
  durableState: DurableManagedRootState;
  readinessState: ManagedRootReadinessState;
  configuredPath: string | null;
  normalizedPath: string | null;
  pathIdentityKey: string | null;
  physicalIdentityHash: string | null;
  errorCode: string | null;
  checkedAt: string;
}

export interface ManagedRootConfigurationResult {
  status: "COMPLETED" | "IDEMPOTENT" | "FAILED" | "PERSISTED_REFRESH_FAILED";
  attemptId: string;
  previousDurableState: DurableManagedRootState;
  targetPathIdentity: string | null;
  errorCode: string | null;
  snapshot: ManagedRootConfigurationSnapshot;
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  MANAGED_ROOT_PATH_EMPTY: "Select a managed-root directory.",
  MANAGED_ROOT_NOT_ABSOLUTE: "The managed root must be an absolute directory path.",
  MANAGED_ROOT_NOT_DIRECTORY: "The selected path is not a directory.",
  MANAGED_ROOT_UNAVAILABLE: "The selected directory is unavailable or inaccessible.",
  MANAGED_ROOT_NOT_WRITABLE: "SciLoom cannot write to the selected directory.",
  MANAGED_ROOT_REPARSE_BLOCKED: "The selected directory uses an unsupported redirected path.",
  MANAGED_ROOT_APP_DATA_CONFLICT: "The managed root cannot be inside SciLoom app data or contain it.",
  MANAGED_ROOT_DATABASE_CONFLICT: "The managed root conflicts with the SciLoom database location.",
  MANAGED_ROOT_APP_RESOURCE_CONFLICT: "The managed root conflicts with installed application resources.",
  MANAGED_ROOT_RESERVED_LAYOUT_CONFLICT: "The selected directory conflicts with SciLoom's reserved projects layout.",
  MANAGED_ROOT_RESERVED_LAYOUT_UNAVAILABLE: "SciLoom cannot inspect the reserved projects layout in this directory.",
  MANAGED_ROOT_PROBE_CLEANUP_FAILED: "The write probe could not be cleaned up, so the directory was not saved.",
  MANAGED_ROOT_PROBE_READBACK_MISMATCH: "The write probe could not be verified, so the directory was not saved.",
  MANAGED_ROOT_ALREADY_CONFIGURED: "The managed root is already configured. Changing it requires a separate migration task.",
  MANAGED_ROOT_DURABLE_READ_FAILED: "SciLoom could not read the durable managed-root configuration.",
  MANAGED_ROOT_DURABLE_WRITE_FAILED: "SciLoom could not save the managed-root configuration.",
  MANAGED_ROOT_DURABLE_READBACK_FAILED: "SciLoom could not read back the saved managed-root configuration.",
  MANAGED_ROOT_DURABLE_READBACK_MISMATCH: "The saved managed-root configuration did not match the selected directory.",
  MANAGED_ROOT_DURABLE_COMMIT_FAILED: "SciLoom could not commit the managed-root configuration.",
  MANAGED_ROOT_RUNTIME_REFRESH_FAILED: "The managed root was saved, but runtime readiness could not be refreshed. Retry readiness before continuing."
});

function stableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function operationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `managed-root-${crypto.randomUUID()}`;
  }
  return `managed-root-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function failureMessage(code?: string | null) {
  return code ? FAILURE_MESSAGES[code] ?? "The managed-root configuration failed." : "The managed-root configuration failed.";
}

export function mapManagedRootSnapshot(snapshot: ManagedRootConfigurationSnapshot): ManagedRootStatus {
  if (snapshot.durableState === "NOT_CONFIGURED") {
    return {
      status: "unconfigured",
      configuredRoot: null,
      managedRoot: null,
      access: "unavailable",
      durableState: snapshot.durableState,
      readinessState: "UNAVAILABLE",
      errorCode: snapshot.errorCode ?? "MANAGED_ROOT_UNCONFIGURED"
    };
  }
  if (snapshot.durableState === "CONFIGURED" && snapshot.configuredPath) {
    return {
      status: "configured",
      configuredRoot: snapshot.configuredPath,
      managedRoot: snapshot.normalizedPath ?? snapshot.configuredPath,
      access: snapshot.readinessState === "READY"
        ? "ready"
        : snapshot.readinessState === "NOT_WRITABLE"
          ? "not-writable"
          : snapshot.readinessState === "INVALID_PATH"
            ? "invalid"
            : snapshot.readinessState === "READ_FAILED"
              ? "read-failed"
              : "unavailable",
      durableState: snapshot.durableState,
      readinessState: snapshot.readinessState,
      errorCode: snapshot.errorCode ?? undefined,
      pathIdentityKey: snapshot.pathIdentityKey,
      physicalIdentityHash: snapshot.physicalIdentityHash
    };
  }
  return {
    status: "invalid",
    configuredRoot: snapshot.configuredPath,
    managedRoot: null,
    access: "read-failed",
    durableState: "READ_FAILED",
    readinessState: "READ_FAILED",
    errorCode: snapshot.errorCode ?? "MANAGED_ROOT_DURABLE_READ_FAILED"
  };
}

function feedbackFor(result: ManagedRootConfigurationResult): WriteFeedbackResult<ManagedRootConfigurationResult> {
  if (result.status === "COMPLETED") {
    return createSuccessWriteFeedback({
      operation: "settings.managedRoot.configure",
      data: result,
      affectedEntities: [{ type: "managedRootConfiguration", id: "managed-root", relation: "updated" }],
      refreshKeys: ["global.changed", "experiment.changed"],
      messages: [{ severity: "success", message: "Managed root configured and ready." }]
    });
  }
  if (result.status === "IDEMPOTENT") {
    return createSkippedWriteFeedback({
      operation: "settings.managedRoot.configure",
      data: result,
      skipped: ["The same managed root is already configured."],
      refreshKeys: [],
      messages: [{ severity: "info", message: "The same managed root is already configured." }]
    });
  }
  return createErrorWriteFeedback({
    operation: "settings.managedRoot.configure",
    data: result,
    errors: [failureMessage(result.errorCode)],
    refreshKeys: result.status === "PERSISTED_REFRESH_FAILED" ? ["global.changed"] : [],
    messages: [{
      severity: result.status === "PERSISTED_REFRESH_FAILED" ? "warning" : "error",
      code: result.errorCode ?? undefined,
      message: failureMessage(result.errorCode)
    }]
  });
}

async function appendConfigurationOperationLog(
  result: ManagedRootConfigurationResult,
  feedback: WriteFeedbackResult<ManagedRootConfigurationResult>
) {
  await createOperationLog({
    id: `operation-log-${result.attemptId}`,
    operationType: "settings_change",
    source: "user",
    module: "settings",
    status: feedback.status,
    riskLevel: "medium",
    target: {
      entityType: "managedRootConfiguration",
      entityId: "managed-root",
      title: "Managed root configuration"
    },
    summary: result.status === "COMPLETED"
      ? "Configured the managed root"
      : result.status === "IDEMPOTENT"
        ? "Confirmed the existing managed root"
        : "Managed-root configuration failed",
    feedback: {
      ...summarizeFeedbackForOperationLog(feedback),
      details: {
        attemptId: result.attemptId,
        previousDurableState: result.previousDurableState,
        targetPathIdentity: result.targetPathIdentity,
        resultStatus: result.status,
        typedReason: result.errorCode
      }
    },
    isRecoverable: false,
    refreshKeys: ["operationLog.changed"]
  });
}

export function createManagedRootConfigService(dependencies: {
  readSnapshot(): Promise<ManagedRootConfigurationSnapshot>;
  configure(selectedPath: string): Promise<ManagedRootConfigurationResult>;
  writeOperationLog(
    result: ManagedRootConfigurationResult,
    feedback: WriteFeedbackResult<ManagedRootConfigurationResult>
  ): Promise<void>;
}) {
  return {
    async getConfigurationSnapshot() {
      return dependencies.readSnapshot();
    },
    async getStatus() {
      return mapManagedRootSnapshot(await dependencies.readSnapshot());
    },
    async configureFirstRoot(selectedPath: string) {
      let result: ManagedRootConfigurationResult;
      try {
        result = await runManagedRootAuthorityWrite({
          operation: `managed-root-configure-${operationId()}`,
          write: () => dependencies.configure(selectedPath)
        });
      } catch (error) {
        const code = stableError(error);
        result = {
          status: "FAILED",
          attemptId: operationId(),
          previousDurableState: "READ_FAILED",
          targetPathIdentity: null,
          errorCode: code,
          snapshot: {
            durableState: "READ_FAILED",
            readinessState: "READ_FAILED",
            configuredPath: null,
            normalizedPath: null,
            pathIdentityKey: null,
            physicalIdentityHash: null,
            errorCode: code,
            checkedAt: new Date().toISOString()
          }
        };
      }
      let feedback = feedbackFor(result);
      try {
        await dependencies.writeOperationLog(result, feedback);
      } catch (error) {
        feedback = addWriteFeedbackWarning(
          feedback,
          `Operation log write failed: ${stableError(error)}`,
          "operation_log_write_failed"
        );
      }
      return feedback;
    }
  };
}

export const managedRootConfigService = createManagedRootConfigService({
  readSnapshot: () => invoke("read_managed_root_configuration"),
  configure: (selectedPath) => invoke("configure_managed_root_first_time", { selectedPath }),
  writeOperationLog: appendConfigurationOperationLog
});
