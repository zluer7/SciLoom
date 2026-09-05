import { isTauriRuntime, resolveDataSourceMode } from "../repositories/dataSourceMode";

export type DesktopSQLiteProvisioningAdmission =
  | { status: "Allowed" }
  | {
      status: "DataSourceUnsupported";
      code:
        | "PROVISIONING_DESKTOP_RUNTIME_REQUIRED"
        | "PROVISIONING_SQLITE_DATA_SOURCE_REQUIRED";
    };

export function evaluateDesktopSQLiteProvisioningAdmission(input: {
  tauriRuntime: boolean;
  dataSourceMode: "sqlite" | "localStorage";
}): DesktopSQLiteProvisioningAdmission {
  if (!input.tauriRuntime) {
    return {
      status: "DataSourceUnsupported",
      code: "PROVISIONING_DESKTOP_RUNTIME_REQUIRED"
    };
  }
  if (input.dataSourceMode !== "sqlite") {
    return {
      status: "DataSourceUnsupported",
      code: "PROVISIONING_SQLITE_DATA_SOURCE_REQUIRED"
    };
  }
  return { status: "Allowed" };
}

export function assertDesktopSQLiteProvisioningAdmission() {
  const admission = evaluateDesktopSQLiteProvisioningAdmission({
    tauriRuntime: isTauriRuntime(),
    dataSourceMode: resolveDataSourceMode()
  });
  if (admission.status !== "Allowed") {
    throw new Error(admission.code);
  }
  return admission;
}
