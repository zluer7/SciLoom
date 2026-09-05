use super::audit_scheduler::AuditBatchSummary;
use super::recovery_decision::{RecoveryDecisionKind, RecoveryDecisionResult};
use super::runtime_issue::RuntimeIssueSummary;
use super::slot::ResourceKey;
use super::startup_scanner::{StartupScanResult, StartupScannerState};
use serde::{Deserialize, Serialize};

pub(crate) const PROVISIONING_OPERATION_STATE_UNAVAILABLE: &str =
    crate::manuscript_provisioning_contract::PROVISIONING_OPERATION_STATE_UNAVAILABLE;
pub(crate) const PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE: &str =
    crate::manuscript_provisioning_contract::PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE;
pub(crate) const PROVISIONING_RUNTIME_INTERNAL_FAILURE: &str =
    crate::manuscript_provisioning_contract::PROVISIONING_RUNTIME_INTERNAL_FAILURE;

pub(crate) const PROVISIONING_RUNTIME_BUSY: &str = "PROVISIONING_RUNTIME_BUSY";
pub(crate) const PROVISIONING_RUNTIME_SHUTTING_DOWN: &str = "PROVISIONING_RUNTIME_SHUTTING_DOWN";
pub(crate) const PROVISIONING_RUNTIME_INVALID_RESOURCE_KEY: &str =
    "PROVISIONING_RUNTIME_INVALID_RESOURCE_KEY";
pub(crate) const PROVISIONING_RUNTIME_ENTRY_NOT_FOUND: &str =
    "PROVISIONING_RUNTIME_ENTRY_NOT_FOUND";
pub(crate) const PROVISIONING_RUNTIME_ENTRY_GENERATION_CONFLICT: &str =
    "PROVISIONING_RUNTIME_ENTRY_GENERATION_CONFLICT";
pub(crate) const PROVISIONING_RUNTIME_HEARTBEAT_FAILED: &str =
    "PROVISIONING_RUNTIME_HEARTBEAT_FAILED";
pub(crate) const PROVISIONING_RUNTIME_INVALID_LIFECYCLE_TRANSITION: &str =
    "PROVISIONING_RUNTIME_INVALID_LIFECYCLE_TRANSITION";
pub(crate) const PROVISIONING_STARTUP_SCAN_FAILED: &str = "PROVISIONING_STARTUP_SCAN_FAILED";
pub(crate) const PROVISIONING_STARTUP_SCAN_ALREADY_RUNNING: &str =
    "PROVISIONING_STARTUP_SCAN_ALREADY_RUNNING";
pub(crate) const PROVISIONING_STARTUP_SCAN_RETRY_EXHAUSTED: &str =
    "PROVISIONING_STARTUP_SCAN_RETRY_EXHAUSTED";
pub(crate) const PROVISIONING_RUNTIME_ISSUE_INVALID: &str = "PROVISIONING_RUNTIME_ISSUE_INVALID";
pub(crate) const PROVISIONING_AUDIT_BATCH_FAILED: &str = "PROVISIONING_AUDIT_BATCH_FAILED";
pub(crate) const PROVISIONING_AUDIT_RETRY_FAILED: &str = "PROVISIONING_AUDIT_RETRY_FAILED";
pub(crate) const PROVISIONING_RECOVERY_SNAPSHOT_INVALID: &str =
    "PROVISIONING_RECOVERY_SNAPSHOT_INVALID";
pub(crate) const PROVISIONING_RECOVERY_PRECONDITION_CHANGED: &str =
    "PROVISIONING_RECOVERY_PRECONDITION_CHANGED";
pub(crate) const PROVISIONING_RECOVERY_DECISION_BLOCKED: &str =
    "PROVISIONING_RECOVERY_DECISION_BLOCKED";
pub(crate) const PROVISIONING_RECOVERY_DECISION_BUSY: &str = "PROVISIONING_RECOVERY_DECISION_BUSY";
pub(crate) const PROVISIONING_SCHEMA_CAPABILITY_READ_FAILED: &str =
    "PROVISIONING_SCHEMA_CAPABILITY_READ_FAILED";
pub(crate) const PROVISIONING_SNAPSHOT_CANONICALIZATION_FAILED: &str =
    "PROVISIONING_SNAPSHOT_CANONICALIZATION_FAILED";
pub(crate) const PROVISIONING_RUNTIME_ALREADY_INITIALIZED: &str =
    "PROVISIONING_RUNTIME_ALREADY_INITIALIZED";
pub(crate) const PROVISIONING_RUNTIME_ACTIVATION_FAILED: &str =
    "PROVISIONING_RUNTIME_ACTIVATION_FAILED";
pub(crate) const PROVISIONING_RUNTIME_MAIN_WINDOW_NOT_READY: &str =
    "PROVISIONING_RUNTIME_MAIN_WINDOW_NOT_READY";
pub(crate) const PROVISIONING_RUNTIME_INVALID_READY_WINDOW: &str =
    "PROVISIONING_RUNTIME_INVALID_READY_WINDOW";
pub(crate) const PROVISIONING_RUNTIME_CAPABILITY_UNAVAILABLE: &str =
    "PROVISIONING_RUNTIME_CAPABILITY_UNAVAILABLE";
pub(crate) const PROVISIONING_RUNTIME_SHUTDOWN_IN_PROGRESS: &str =
    "PROVISIONING_RUNTIME_SHUTDOWN_IN_PROGRESS";
pub(crate) const PROVISIONING_RUNTIME_STARTUP_TASK_FAILED: &str =
    "PROVISIONING_RUNTIME_STARTUP_TASK_FAILED";
pub(crate) const PROVISIONING_RUNTIME_ISOLATION_REQUIRED: &str =
    "PROVISIONING_RUNTIME_ISOLATION_REQUIRED";
pub(crate) const PROVISIONING_RUNTIME_DATABASE_PROVIDER_FAILED: &str =
    "PROVISIONING_RUNTIME_DATABASE_PROVIDER_FAILED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RuntimeSafeErrorCode {
    #[serde(rename = "PROVISIONING_RUNTIME_BUSY")]
    RuntimeBusy,
    #[serde(rename = "PROVISIONING_RUNTIME_SHUTTING_DOWN")]
    RuntimeShuttingDown,
    #[serde(rename = "PROVISIONING_RUNTIME_INVALID_RESOURCE_KEY")]
    RuntimeInvalidResourceKey,
    #[serde(rename = "PROVISIONING_RUNTIME_ENTRY_NOT_FOUND")]
    RuntimeEntryNotFound,
    #[serde(rename = "PROVISIONING_RUNTIME_ENTRY_GENERATION_CONFLICT")]
    RuntimeEntryGenerationConflict,
    #[serde(rename = "PROVISIONING_RUNTIME_HEARTBEAT_FAILED")]
    RuntimeHeartbeatFailed,
    #[serde(rename = "PROVISIONING_OPERATION_STATE_UNAVAILABLE")]
    OperationStateUnavailable,
    #[serde(rename = "PROVISIONING_RUNTIME_INVALID_LIFECYCLE_TRANSITION")]
    RuntimeInvalidLifecycleTransition,
    #[serde(rename = "PROVISIONING_ACTIVE_CLAIM_CONFLICT")]
    ActiveClaimConflict,
    #[serde(rename = "PROVISIONING_RUNTIME_INTERNAL_FAILURE")]
    InternalFailure,
    #[serde(rename = "PROVISIONING_STARTUP_SCAN_FAILED")]
    StartupScanFailed,
    #[serde(rename = "PROVISIONING_STARTUP_SCAN_ALREADY_RUNNING")]
    StartupScanAlreadyRunning,
    #[serde(rename = "PROVISIONING_STARTUP_SCAN_RETRY_EXHAUSTED")]
    StartupScanRetryExhausted,
    #[serde(rename = "PROVISIONING_RUNTIME_ISSUE_INVALID")]
    RuntimeIssueInvalid,
    #[serde(rename = "PROVISIONING_AUDIT_BATCH_FAILED")]
    AuditBatchFailed,
    #[serde(rename = "PROVISIONING_AUDIT_RETRY_FAILED")]
    AuditRetryFailed,
    #[serde(rename = "PROVISIONING_RECOVERY_SNAPSHOT_INVALID")]
    RecoverySnapshotInvalid,
    #[serde(rename = "PROVISIONING_RECOVERY_PRECONDITION_CHANGED")]
    RecoveryPreconditionChanged,
    #[serde(rename = "PROVISIONING_RECOVERY_DECISION_BLOCKED")]
    RecoveryDecisionBlocked,
    #[serde(rename = "PROVISIONING_RECOVERY_DECISION_BUSY")]
    RecoveryDecisionBusy,
    #[serde(rename = "PROVISIONING_SCHEMA_CAPABILITY_READ_FAILED")]
    SchemaCapabilityReadFailed,
    #[serde(rename = "PROVISIONING_SNAPSHOT_CANONICALIZATION_FAILED")]
    SnapshotCanonicalizationFailed,
    #[serde(rename = "PROVISIONING_RUNTIME_ALREADY_INITIALIZED")]
    RuntimeAlreadyInitialized,
    #[serde(rename = "PROVISIONING_RUNTIME_ACTIVATION_FAILED")]
    RuntimeActivationFailed,
    #[serde(rename = "PROVISIONING_RUNTIME_MAIN_WINDOW_NOT_READY")]
    RuntimeMainWindowNotReady,
    #[serde(rename = "PROVISIONING_RUNTIME_INVALID_READY_WINDOW")]
    RuntimeInvalidReadyWindow,
    #[serde(rename = "PROVISIONING_RUNTIME_CAPABILITY_UNAVAILABLE")]
    RuntimeCapabilityUnavailable,
    #[serde(rename = "PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE")]
    RuntimeAdapterUnavailable,
    #[serde(rename = "PROVISIONING_RUNTIME_SHUTDOWN_IN_PROGRESS")]
    RuntimeShutdownInProgress,
    #[serde(rename = "PROVISIONING_RUNTIME_STARTUP_TASK_FAILED")]
    RuntimeStartupTaskFailed,
    #[serde(rename = "PROVISIONING_RUNTIME_ISOLATION_REQUIRED")]
    RuntimeIsolationRequired,
    #[serde(rename = "PROVISIONING_RUNTIME_DATABASE_PROVIDER_FAILED")]
    RuntimeDatabaseProviderFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FeedbackAuthority {
    RuntimeLocal,
    DurableOperationState,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeNextAction {
    Stop,
    WaitForActivation,
    InspectActiveOperation,
    ContinueExecution,
    Detach,
    RetryStartupScan,
    InspectRuntimeIssues,
    RetryAudit,
    ReinspectAndConfirm,
    ProceedToRecovery,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ActiveOperationSummary {
    LocalPending {
        authority: FeedbackAuthority,
        resource: ResourceKey,
        intent: String,
        generation: u64,
        started_at_ms: i64,
        operation_id: Option<String>,
    },
    ClaimedActive {
        authority: FeedbackAuthority,
        resource: ResourceKey,
        intent: String,
        generation: u64,
        started_at_ms: i64,
        operation_id: String,
        phase: String,
        classification: String,
    },
}

impl ActiveOperationSummary {
    pub(crate) fn authority(&self) -> FeedbackAuthority {
        match self {
            Self::LocalPending { authority, .. } | Self::ClaimedActive { authority, .. } => {
                *authority
            }
        }
    }

    pub(crate) fn operation_id(&self) -> Option<&str> {
        match self {
            Self::LocalPending { .. } => None,
            Self::ClaimedActive { operation_id, .. } => Some(operation_id),
        }
    }

    pub(crate) fn generation(&self) -> u64 {
        match self {
            Self::LocalPending { generation, .. } | Self::ClaimedActive { generation, .. } => {
                *generation
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum RuntimeFeedback {
    OperationStateUnavailable {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        capability: String,
    },
    LocalPending {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        operation_summary: ActiveOperationSummary,
    },
    Busy {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        operation_summary: ActiveOperationSummary,
    },
    ActiveOperation {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        operation_summary: ActiveOperationSummary,
    },
    ActiveClaimConflict {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        operation_summary: Option<ActiveOperationSummary>,
    },
    CallerCancelled {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: Option<RuntimeSafeErrorCode>,
    },
    CallerDetached {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        operation_summary: ActiveOperationSummary,
    },
    CasConflict {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        operation_id: String,
    },
    Completed {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        operation_id: String,
        phase: String,
    },
    HeartbeatFailed {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        operation_id: String,
    },
    ShuttingDown {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
    InvalidResourceKey {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
    InternalFailure {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
    StartupScanRunning {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: Option<RuntimeSafeErrorCode>,
    },
    StartupScanCompleted {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        issue_summary: RuntimeIssueSummary,
        audit_summary: Option<AuditBatchSummary>,
    },
    StartupScanFailed {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
    StartupScanRetryExhausted {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
    RuntimeIssuesReady {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        issue_summary: RuntimeIssueSummary,
    },
    AuditBatchCompleted {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        audit_summary: AuditBatchSummary,
    },
    AuditBatchPartial {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        audit_summary: AuditBatchSummary,
    },
    AuditDeliveryFailed {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
    RecoveryReady {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        recovery_decision_summary: RecoveryDecisionResult,
    },
    PreconditionChanged {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        recovery_decision_summary: RecoveryDecisionResult,
    },
    RecoveryDecisionBlocked {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
        recovery_decision_summary: RecoveryDecisionResult,
    },
    RecoveryDecisionBusy {
        authority: FeedbackAuthority,
        next_action: RuntimeNextAction,
        safe_error_code: RuntimeSafeErrorCode,
    },
}

impl RuntimeFeedback {
    pub(crate) fn from_startup_scan(result: &StartupScanResult) -> Self {
        match result.state {
            StartupScannerState::Running | StartupScannerState::RunningRetry => {
                Self::StartupScanRunning {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::InspectRuntimeIssues,
                    safe_error_code: Some(RuntimeSafeErrorCode::StartupScanAlreadyRunning),
                }
            }
            StartupScannerState::Completed => {
                let payload = result.payload.clone().unwrap_or_default();
                Self::StartupScanCompleted {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::InspectRuntimeIssues,
                    issue_summary: payload.issues,
                    audit_summary: payload.audit,
                }
            }
            StartupScannerState::FailedRetryAvailable => Self::StartupScanFailed {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::RetryStartupScan,
                safe_error_code: result
                    .safe_error_code
                    .unwrap_or(RuntimeSafeErrorCode::StartupScanFailed),
            },
            StartupScannerState::FailedRetryExhausted => Self::StartupScanRetryExhausted {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::StartupScanRetryExhausted,
            },
            StartupScannerState::NotStarted => Self::OperationStateUnavailable {
                authority: FeedbackAuthority::None,
                next_action: RuntimeNextAction::WaitForActivation,
                safe_error_code: result
                    .safe_error_code
                    .unwrap_or(RuntimeSafeErrorCode::OperationStateUnavailable),
                capability: "unavailable".to_string(),
            },
        }
    }

    pub(crate) fn from_audit_summary(summary: AuditBatchSummary) -> Self {
        if summary.failed == 0 && summary.conflicted == 0 && summary.safe_error_code.is_none() {
            Self::AuditBatchCompleted {
                authority: FeedbackAuthority::DurableOperationState,
                next_action: RuntimeNextAction::None,
                audit_summary: summary,
            }
        } else {
            Self::AuditBatchPartial {
                authority: FeedbackAuthority::DurableOperationState,
                next_action: RuntimeNextAction::RetryAudit,
                safe_error_code: summary
                    .safe_error_code
                    .unwrap_or(RuntimeSafeErrorCode::AuditBatchFailed),
                audit_summary: summary,
            }
        }
    }

    pub(crate) fn from_recovery_decision(summary: RecoveryDecisionResult) -> Self {
        match summary.kind {
            RecoveryDecisionKind::RecoveryReady => Self::RecoveryReady {
                authority: FeedbackAuthority::DurableOperationState,
                next_action: RuntimeNextAction::ProceedToRecovery,
                recovery_decision_summary: summary,
            },
            RecoveryDecisionKind::PreconditionChanged => Self::PreconditionChanged {
                authority: FeedbackAuthority::DurableOperationState,
                next_action: RuntimeNextAction::ReinspectAndConfirm,
                safe_error_code: RuntimeSafeErrorCode::RecoveryPreconditionChanged,
                recovery_decision_summary: summary,
            },
            RecoveryDecisionKind::Blocked => Self::RecoveryDecisionBlocked {
                authority: FeedbackAuthority::DurableOperationState,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: summary
                    .safe_error_code
                    .unwrap_or(RuntimeSafeErrorCode::RecoveryDecisionBlocked),
                recovery_decision_summary: summary,
            },
            RecoveryDecisionKind::Busy => Self::RecoveryDecisionBusy {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::InspectActiveOperation,
                safe_error_code: RuntimeSafeErrorCode::RecoveryDecisionBusy,
            },
        }
    }

    pub(crate) fn busy(summary: ActiveOperationSummary) -> Self {
        Self::Busy {
            authority: summary.authority(),
            next_action: RuntimeNextAction::InspectActiveOperation,
            safe_error_code: RuntimeSafeErrorCode::RuntimeBusy,
            operation_summary: summary,
        }
    }

    pub(crate) fn invalid_lifecycle() -> Self {
        Self::InternalFailure {
            authority: FeedbackAuthority::RuntimeLocal,
            next_action: RuntimeNextAction::Stop,
            safe_error_code: RuntimeSafeErrorCode::RuntimeInvalidLifecycleTransition,
        }
    }
}
