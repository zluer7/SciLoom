use super::activation::{AuditActivationStatus, ProductionRuntimeSnapshot};
use super::audit_scheduler::AuditBatchSummary;
use super::core::ProvisioningRuntime;
use super::feedback::RuntimeSafeErrorCode;
use super::runtime_issue::RuntimeIssueSummary;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{State, WebviewWindow};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeAuditSummary {
    pub status: AuditActivationStatus,
    pub summary: Option<AuditBatchSummary>,
}

#[tauri::command]
pub(crate) fn provisioning_runtime_mark_main_window_ready(
    window: WebviewWindow,
    runtime: State<'_, Arc<ProvisioningRuntime>>,
) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
    runtime.inner().mark_main_window_ready(window.label())
}

#[tauri::command]
pub(crate) fn provisioning_runtime_get_snapshot(
    runtime: State<'_, Arc<ProvisioningRuntime>>,
) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
    runtime.production_snapshot()
}

#[tauri::command]
pub(crate) fn provisioning_runtime_get_startup_issues(
    runtime: State<'_, Arc<ProvisioningRuntime>>,
) -> Result<RuntimeIssueSummary, RuntimeSafeErrorCode> {
    Ok(runtime.production_snapshot()?.issue_summary)
}

#[tauri::command]
pub(crate) fn provisioning_runtime_retry_startup_scan(
    runtime: State<'_, Arc<ProvisioningRuntime>>,
) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
    runtime.inner().retry_production_startup_scan()
}

#[tauri::command]
pub(crate) fn provisioning_runtime_get_audit_summary(
    runtime: State<'_, Arc<ProvisioningRuntime>>,
) -> Result<RuntimeAuditSummary, RuntimeSafeErrorCode> {
    let snapshot = runtime.production_snapshot()?;
    Ok(RuntimeAuditSummary {
        status: snapshot.audit_status,
        summary: snapshot.audit_summary,
    })
}

#[tauri::command]
pub(crate) async fn provisioning_runtime_retry_audit_one(
    operation_id: String,
    runtime: State<'_, Arc<ProvisioningRuntime>>,
) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.retry_production_audit_one(&operation_id))
        .await
        .map_err(|_| RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?
}
