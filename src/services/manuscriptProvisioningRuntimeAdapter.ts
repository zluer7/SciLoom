import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ManuscriptProvisioningProductionRuntimeSnapshot,
  ManuscriptProvisioningRuntimeAuditActivationSummary,
  ManuscriptProvisioningRuntimeIssueSummary,
  ManuscriptProvisioningRuntimeStateNotification
} from "../types/manuscriptProvisioningRuntime";

const STATE_CHANGED_EVENT = "provisioning-runtime-state-changed";

const getSnapshot =
  (): Promise<ManuscriptProvisioningProductionRuntimeSnapshot> =>
    invoke("provisioning_runtime_get_snapshot");

export const manuscriptProvisioningRuntimeAdapter = Object.freeze({
  markMainWindowReady:
    (): Promise<ManuscriptProvisioningProductionRuntimeSnapshot> =>
      invoke("provisioning_runtime_mark_main_window_ready"),

  getSnapshot,

  getStartupIssues: (): Promise<ManuscriptProvisioningRuntimeIssueSummary> =>
    invoke("provisioning_runtime_get_startup_issues"),

  retryStartupScan:
    (): Promise<ManuscriptProvisioningProductionRuntimeSnapshot> =>
      invoke("provisioning_runtime_retry_startup_scan"),

  getAuditSummary:
    (): Promise<ManuscriptProvisioningRuntimeAuditActivationSummary> =>
      invoke("provisioning_runtime_get_audit_summary"),

  retryAuditOne: (
    operationId: string
  ): Promise<ManuscriptProvisioningProductionRuntimeSnapshot> =>
    invoke("provisioning_runtime_retry_audit_one", { operationId }),

  subscribe: async (
    observer: (
      snapshot: ManuscriptProvisioningProductionRuntimeSnapshot
    ) => void
  ): Promise<UnlistenFn> =>
    listen<ManuscriptProvisioningRuntimeStateNotification>(
      STATE_CHANGED_EVENT,
      async () => {
        observer(await getSnapshot());
      }
    )
});
