use super::audit_scheduler::{AuditBatchItemFinalStatus, AuditBatchItemResult, AuditBatchSummary};
use super::feedback::RuntimeSafeErrorCode;
use super::runtime_issue::RuntimeIssueSummary;
use super::schema_capability::SchemaCapability;
use super::startup_scanner::{StartupScanResult, StartupScannerState};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ActivationStatus {
    Uninitialized,
    WaitingForMainWindow,
    Activating,
    Active,
    Inactive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CapabilityStatus {
    Unchecked,
    Available,
    UnavailableNotMigrated,
    UnavailableInvalidSchema,
    ReadFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AuditActivationStatus {
    NotStarted,
    Running,
    Completed,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ShutdownStatus {
    Running,
    ShuttingDown,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSafeTimestamps {
    pub initialized_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductionRuntimeSnapshot {
    pub activation_status: ActivationStatus,
    pub capability_status: CapabilityStatus,
    pub startup_scan_status: StartupScannerState,
    pub audit_status: AuditActivationStatus,
    pub shutdown_status: ShutdownStatus,
    pub main_window_ready: bool,
    pub startup_task_generation: u64,
    pub startup_retry_consumed: bool,
    pub issue_summary: RuntimeIssueSummary,
    pub audit_summary: Option<AuditBatchSummary>,
    pub heartbeat_registry_count: usize,
    pub abandoned_execution_count: usize,
    pub safe_timestamps: RuntimeSafeTimestamps,
    pub safe_error_code: Option<RuntimeSafeErrorCode>,
    pub markdown_bytes_read: u64,
    pub revision: u64,
}

#[derive(Debug, Clone)]
struct ActivationInner {
    activation_status: ActivationStatus,
    capability_status: CapabilityStatus,
    startup_scan_status: StartupScannerState,
    audit_status: AuditActivationStatus,
    shutdown_status: ShutdownStatus,
    main_window_ready: bool,
    startup_task_generation: u64,
    startup_task_running: bool,
    startup_retry_consumed: bool,
    audit_retry_generation: u64,
    audit_retry_running: bool,
    issue_summary: RuntimeIssueSummary,
    audit_summary: Option<AuditBatchSummary>,
    safe_timestamps: RuntimeSafeTimestamps,
    safe_error_code: Option<RuntimeSafeErrorCode>,
    markdown_bytes_read: u64,
    revision: u64,
}

pub(crate) struct ProductionActivationState {
    inner: Mutex<ActivationInner>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

impl ProductionActivationState {
    pub(crate) fn new(capability: SchemaCapability) -> Self {
        let initialized_at_ms = now_ms();
        let capability_status = match capability {
            SchemaCapability::Available => CapabilityStatus::Available,
            SchemaCapability::UnavailableNotMigrated => CapabilityStatus::UnavailableNotMigrated,
            SchemaCapability::UnavailableInvalidSchema => {
                CapabilityStatus::UnavailableInvalidSchema
            }
            SchemaCapability::ReadFailed => CapabilityStatus::ReadFailed,
        };
        let safe_error_code = match capability {
            SchemaCapability::Available => None,
            SchemaCapability::ReadFailed => {
                Some(RuntimeSafeErrorCode::RuntimeDatabaseProviderFailed)
            }
            _ => Some(RuntimeSafeErrorCode::RuntimeCapabilityUnavailable),
        };
        Self {
            inner: Mutex::new(ActivationInner {
                activation_status: if capability == SchemaCapability::Available {
                    ActivationStatus::WaitingForMainWindow
                } else {
                    ActivationStatus::Inactive
                },
                capability_status,
                startup_scan_status: StartupScannerState::NotStarted,
                audit_status: AuditActivationStatus::NotStarted,
                shutdown_status: ShutdownStatus::Running,
                main_window_ready: false,
                startup_task_generation: 0,
                startup_task_running: false,
                startup_retry_consumed: false,
                audit_retry_generation: 0,
                audit_retry_running: false,
                issue_summary: RuntimeIssueSummary::default(),
                audit_summary: None,
                safe_timestamps: RuntimeSafeTimestamps {
                    initialized_at_ms,
                    updated_at_ms: initialized_at_ms,
                },
                safe_error_code,
                markdown_bytes_read: 0,
                revision: 1,
            }),
        }
    }

    pub(crate) fn mark_main_window_ready(
        &self,
        window_label: &str,
    ) -> Result<Option<u64>, RuntimeSafeErrorCode> {
        if window_label != "main" {
            return Err(RuntimeSafeErrorCode::RuntimeInvalidReadyWindow);
        }
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running {
            return Err(RuntimeSafeErrorCode::RuntimeShutdownInProgress);
        }
        if inner.main_window_ready {
            return Ok(None);
        }
        inner.main_window_ready = true;
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        if inner.capability_status != CapabilityStatus::Available {
            return Ok(None);
        }
        inner.activation_status = ActivationStatus::Activating;
        inner.startup_scan_status = StartupScannerState::Running;
        inner.audit_status = AuditActivationStatus::Running;
        inner.startup_task_generation += 1;
        inner.startup_task_running = true;
        Ok(Some(inner.startup_task_generation))
    }

    pub(crate) fn begin_startup_retry(&self) -> Result<u64, RuntimeSafeErrorCode> {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running {
            return Err(RuntimeSafeErrorCode::RuntimeShutdownInProgress);
        }
        if inner.capability_status != CapabilityStatus::Available {
            return Err(RuntimeSafeErrorCode::RuntimeCapabilityUnavailable);
        }
        if inner.startup_task_running {
            return Err(RuntimeSafeErrorCode::StartupScanAlreadyRunning);
        }
        if inner.audit_retry_running {
            return Err(RuntimeSafeErrorCode::AuditRetryFailed);
        }
        if inner.startup_scan_status != StartupScannerState::FailedRetryAvailable
            || inner.startup_retry_consumed
        {
            return Err(RuntimeSafeErrorCode::StartupScanRetryExhausted);
        }
        inner.startup_task_generation += 1;
        inner.startup_task_running = true;
        inner.startup_retry_consumed = true;
        inner.startup_scan_status = StartupScannerState::RunningRetry;
        inner.audit_status = AuditActivationStatus::Running;
        inner.safe_error_code = None;
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        Ok(inner.startup_task_generation)
    }

    pub(crate) fn complete_startup_task(&self, generation: u64, result: StartupScanResult) -> bool {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running
            || inner.startup_task_generation != generation
            || !inner.startup_task_running
        {
            return false;
        }
        inner.startup_task_running = false;
        inner.startup_scan_status = result.state;
        inner.activation_status = ActivationStatus::Active;
        inner.safe_error_code = result.safe_error_code;
        if let Some(payload) = result.payload {
            inner.issue_summary = payload.issues;
            inner.markdown_bytes_read = payload.markdown_bytes_read;
            inner.audit_status = payload
                .audit
                .as_ref()
                .map(audit_status)
                .unwrap_or(AuditActivationStatus::NotStarted);
            inner.audit_summary = payload.audit;
        } else {
            inner.audit_status = AuditActivationStatus::NotStarted;
        }
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        true
    }

    pub(crate) fn abort_startup_task(&self, generation: u64, retry: bool) -> bool {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running
            || inner.startup_task_generation != generation
            || !inner.startup_task_running
        {
            return false;
        }
        inner.startup_task_running = false;
        inner.startup_scan_status = if retry {
            StartupScannerState::FailedRetryExhausted
        } else {
            StartupScannerState::FailedRetryAvailable
        };
        inner.audit_status = AuditActivationStatus::NotStarted;
        inner.activation_status = ActivationStatus::Active;
        inner.safe_error_code = Some(RuntimeSafeErrorCode::RuntimeStartupTaskFailed);
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        true
    }

    pub(crate) fn begin_audit_retry(&self) -> Result<u64, RuntimeSafeErrorCode> {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running {
            return Err(RuntimeSafeErrorCode::RuntimeShutdownInProgress);
        }
        if inner.capability_status != CapabilityStatus::Available {
            return Err(RuntimeSafeErrorCode::RuntimeCapabilityUnavailable);
        }
        if !inner.main_window_ready {
            return Err(RuntimeSafeErrorCode::RuntimeMainWindowNotReady);
        }
        if inner.activation_status != ActivationStatus::Active
            || inner.startup_task_running
            || inner.audit_retry_running
            || inner.audit_status == AuditActivationStatus::Running
        {
            return Err(RuntimeSafeErrorCode::AuditRetryFailed);
        }
        inner.audit_retry_generation += 1;
        inner.audit_retry_running = true;
        inner.audit_status = AuditActivationStatus::Running;
        inner.safe_error_code = None;
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        Ok(inner.audit_retry_generation)
    }

    pub(crate) fn complete_audit_retry(
        &self,
        generation: u64,
        item: AuditBatchItemResult,
        remaining: usize,
        issues: RuntimeIssueSummary,
    ) -> Result<(), RuntimeSafeErrorCode> {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running {
            return Err(RuntimeSafeErrorCode::RuntimeShutdownInProgress);
        }
        if !inner.audit_retry_running || inner.audit_retry_generation != generation {
            return Err(RuntimeSafeErrorCode::AuditRetryFailed);
        }
        inner.audit_retry_running = false;
        let mut summary = AuditBatchSummary {
            selected: 1,
            remaining,
            items: vec![item.clone()],
            ..AuditBatchSummary::default()
        };
        match item.final_status {
            AuditBatchItemFinalStatus::Delivered => summary.delivered = 1,
            AuditBatchItemFinalStatus::AlreadyDelivered => summary.already_delivered = 1,
            AuditBatchItemFinalStatus::Conflicted => summary.conflicted = 1,
            AuditBatchItemFinalStatus::Failed => summary.failed = 1,
        }
        summary.safe_error_code = item.safe_error_code;
        inner.audit_status = audit_status(&summary);
        inner.safe_error_code = summary.safe_error_code;
        inner.audit_summary = Some(summary);
        inner.issue_summary = issues;
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        Ok(())
    }

    pub(crate) fn abort_audit_retry(
        &self,
        generation: u64,
        safe_error_code: RuntimeSafeErrorCode,
    ) -> bool {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running
            || !inner.audit_retry_running
            || inner.audit_retry_generation != generation
        {
            return false;
        }
        inner.audit_retry_running = false;
        inner.audit_status = AuditActivationStatus::Failed;
        inner.safe_error_code = Some(safe_error_code);
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        true
    }

    pub(crate) fn begin_shutdown(&self) -> bool {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status != ShutdownStatus::Running {
            return false;
        }
        inner.shutdown_status = ShutdownStatus::ShuttingDown;
        inner.startup_task_generation += 1;
        inner.startup_task_running = false;
        inner.audit_retry_generation += 1;
        inner.audit_retry_running = false;
        inner.safe_error_code = Some(RuntimeSafeErrorCode::RuntimeShutdownInProgress);
        inner.revision += 1;
        inner.safe_timestamps.updated_at_ms = now_ms();
        true
    }

    pub(crate) fn finish_shutdown(&self) {
        let mut inner = self.inner.lock().expect("production activation lock");
        if inner.shutdown_status == ShutdownStatus::ShuttingDown {
            inner.shutdown_status = ShutdownStatus::Stopped;
            inner.revision += 1;
            inner.safe_timestamps.updated_at_ms = now_ms();
        }
    }

    pub(crate) fn snapshot(
        &self,
        heartbeat_registry_count: usize,
        abandoned_execution_count: usize,
    ) -> ProductionRuntimeSnapshot {
        let inner = self.inner.lock().expect("production activation lock");
        ProductionRuntimeSnapshot {
            activation_status: inner.activation_status,
            capability_status: inner.capability_status,
            startup_scan_status: inner.startup_scan_status,
            audit_status: inner.audit_status,
            shutdown_status: inner.shutdown_status,
            main_window_ready: inner.main_window_ready,
            startup_task_generation: inner.startup_task_generation,
            startup_retry_consumed: inner.startup_retry_consumed,
            issue_summary: inner.issue_summary.clone(),
            audit_summary: inner.audit_summary.clone(),
            heartbeat_registry_count,
            abandoned_execution_count,
            safe_timestamps: inner.safe_timestamps,
            safe_error_code: inner.safe_error_code,
            markdown_bytes_read: inner.markdown_bytes_read,
            revision: inner.revision,
        }
    }
}

fn audit_status(summary: &AuditBatchSummary) -> AuditActivationStatus {
    if summary.safe_error_code.is_none() && summary.failed == 0 && summary.conflicted == 0 {
        AuditActivationStatus::Completed
    } else if summary.selected == 0 || summary.failed == summary.selected {
        AuditActivationStatus::Failed
    } else {
        AuditActivationStatus::Partial
    }
}
