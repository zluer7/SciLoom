use super::audit_scheduler::{AuditBatchSummary, AuditScheduler, AuditStore, SqliteAuditStore};
use super::feedback::RuntimeSafeErrorCode;
use super::runtime_issue::{
    normalize_runtime_issues, LiteratureChildIssueSummary, RuntimeIssueCandidate, RuntimeIssueKind,
    RuntimeIssueSummary,
};
use super::schema_capability::{check_sqlite_schema_capability, SchemaCapability};
use crate::db::manuscript_provisioning_operation_state::{
    list_audit_delivery_candidates, list_runtime_issue_candidate_attempts,
    list_stale_or_crash_claim_candidates, read_literature_child_projections,
    read_operation_attempt, read_startup_progress_projection, ProvisioningOperationAttempt,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StartupScannerState {
    NotStarted,
    Running,
    Completed,
    FailedRetryAvailable,
    RunningRetry,
    FailedRetryExhausted,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupScanPayload {
    pub issues: RuntimeIssueSummary,
    pub audit: Option<AuditBatchSummary>,
    pub markdown_bytes_read: u64,
}

impl StartupScanPayload {
    pub(crate) fn empty() -> Self {
        Self {
            issues: RuntimeIssueSummary::default(),
            audit: None,
            markdown_bytes_read: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupScanResult {
    pub state: StartupScannerState,
    pub generation: u64,
    pub payload: Option<StartupScanPayload>,
    pub safe_error_code: Option<RuntimeSafeErrorCode>,
}

#[derive(Debug)]
struct StartupScannerInner {
    state: StartupScannerState,
    generation: u64,
    payload: Option<StartupScanPayload>,
    safe_error_code: Option<RuntimeSafeErrorCode>,
    shutting_down: bool,
}

impl Default for StartupScannerInner {
    fn default() -> Self {
        Self {
            state: StartupScannerState::NotStarted,
            generation: 0,
            payload: None,
            safe_error_code: None,
            shutting_down: false,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct StartupScanner {
    inner: Mutex<StartupScannerInner>,
}

impl StartupScanner {
    pub(crate) fn run_initial(
        &self,
        scan: impl FnOnce() -> Result<StartupScanPayload, RuntimeSafeErrorCode>,
    ) -> StartupScanResult {
        self.run(false, scan)
    }

    pub(crate) fn run_retry(
        &self,
        scan: impl FnOnce() -> Result<StartupScanPayload, RuntimeSafeErrorCode>,
    ) -> StartupScanResult {
        self.run(true, scan)
    }

    pub(crate) fn run_initial_orchestrated(
        &self,
        source: &dyn StartupOrchestrationSource,
        audit_scheduler: &AuditScheduler,
        current_app_instance_token: &str,
        observed_at: &str,
        audit_occurred_at: &str,
    ) -> StartupScanResult {
        self.run_orchestrated(
            false,
            source,
            audit_scheduler,
            current_app_instance_token,
            observed_at,
            audit_occurred_at,
        )
    }

    pub(crate) fn run_retry_orchestrated(
        &self,
        source: &dyn StartupOrchestrationSource,
        audit_scheduler: &AuditScheduler,
        current_app_instance_token: &str,
        observed_at: &str,
        audit_occurred_at: &str,
    ) -> StartupScanResult {
        self.run_orchestrated(
            true,
            source,
            audit_scheduler,
            current_app_instance_token,
            observed_at,
            audit_occurred_at,
        )
    }

    fn run_orchestrated(
        &self,
        retry: bool,
        source: &dyn StartupOrchestrationSource,
        audit_scheduler: &AuditScheduler,
        current_app_instance_token: &str,
        observed_at: &str,
        audit_occurred_at: &str,
    ) -> StartupScanResult {
        let scan = || {
            let mut candidates =
                source.scan_business_candidates(current_app_instance_token, observed_at)?;
            let mut audit = audit_scheduler.run_startup_batch(source, audit_occurred_at);
            match source.scan_final_audit_candidates() {
                Ok(mut audit_candidates) => candidates.append(&mut audit_candidates),
                Err(_) => {
                    audit.safe_error_code = Some(RuntimeSafeErrorCode::AuditBatchFailed);
                }
            }
            Ok(StartupScanPayload {
                issues: normalize_runtime_issues(candidates),
                audit: Some(audit),
                markdown_bytes_read: 0,
            })
        };
        if retry {
            self.run_retry(scan)
        } else {
            self.run_initial(scan)
        }
    }

    pub(crate) fn unavailable(safe_error_code: RuntimeSafeErrorCode) -> StartupScanResult {
        StartupScanResult {
            state: StartupScannerState::NotStarted,
            generation: 0,
            payload: None,
            safe_error_code: Some(safe_error_code),
        }
    }

    fn run(
        &self,
        retry: bool,
        scan: impl FnOnce() -> Result<StartupScanPayload, RuntimeSafeErrorCode>,
    ) -> StartupScanResult {
        let generation = {
            let mut inner = self.inner.lock().expect("startup scanner lock");
            if inner.shutting_down {
                inner.safe_error_code = Some(RuntimeSafeErrorCode::RuntimeShuttingDown);
                return snapshot(&inner);
            }
            let allowed = if retry {
                inner.state == StartupScannerState::FailedRetryAvailable
            } else {
                inner.state == StartupScannerState::NotStarted
            };
            if !allowed {
                return snapshot(&inner);
            }
            inner.generation += 1;
            inner.state = if retry {
                StartupScannerState::RunningRetry
            } else {
                StartupScannerState::Running
            };
            inner.payload = None;
            inner.safe_error_code = None;
            inner.generation
        };

        let outcome = catch_unwind(AssertUnwindSafe(scan))
            .unwrap_or(Err(RuntimeSafeErrorCode::RuntimeStartupTaskFailed));
        let mut inner = self.inner.lock().expect("startup scanner lock");
        if inner.generation != generation || inner.shutting_down {
            inner.safe_error_code = Some(RuntimeSafeErrorCode::RuntimeShuttingDown);
            return snapshot(&inner);
        }
        match outcome {
            Ok(payload) => {
                inner.state = StartupScannerState::Completed;
                inner.payload = Some(payload);
                inner.safe_error_code = None;
            }
            Err(error) => {
                inner.state = if retry {
                    StartupScannerState::FailedRetryExhausted
                } else {
                    StartupScannerState::FailedRetryAvailable
                };
                inner.payload = None;
                inner.safe_error_code = Some(error);
            }
        }
        snapshot(&inner)
    }

    pub(crate) fn shutdown(&self) {
        self.inner
            .lock()
            .expect("startup scanner lock")
            .shutting_down = true;
    }

    pub(crate) fn state(&self) -> StartupScanResult {
        snapshot(&self.inner.lock().expect("startup scanner lock"))
    }
}

pub(crate) trait StartupOrchestrationSource: AuditStore {
    fn scan_business_candidates(
        &self,
        current_app_instance_token: &str,
        observed_at: &str,
    ) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode>;

    fn scan_final_audit_candidates(
        &self,
    ) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode>;
}

#[derive(Debug, Clone)]
pub(crate) struct SqliteStartupOrchestrationStore {
    connection: Arc<Mutex<Connection>>,
    audit: SqliteAuditStore,
}

impl SqliteStartupOrchestrationStore {
    pub(crate) fn new(connection: Arc<Mutex<Connection>>) -> Self {
        Self {
            audit: SqliteAuditStore::new(connection.clone()),
            connection,
        }
    }
}

impl AuditStore for SqliteStartupOrchestrationStore {
    fn list_candidates(
        &self,
        limit: usize,
    ) -> Result<
        Vec<super::audit_scheduler::AuditStoreOutbox>,
        super::audit_scheduler::AuditStoreError,
    > {
        self.audit.list_candidates(limit)
    }

    fn count_candidates(&self) -> Result<usize, super::audit_scheduler::AuditStoreError> {
        self.audit.count_candidates()
    }

    fn read_outbox(
        &self,
        operation_id: &str,
    ) -> Result<
        Option<super::audit_scheduler::AuditStoreOutbox>,
        super::audit_scheduler::AuditStoreError,
    > {
        self.audit.read_outbox(operation_id)
    }

    fn deliver_pending(
        &self,
        selected: &super::audit_scheduler::AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), super::audit_scheduler::AuditStoreError> {
        self.audit.deliver_pending(selected, occurred_at)
    }

    fn retry_failed(
        &self,
        selected: &super::audit_scheduler::AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), super::audit_scheduler::AuditStoreError> {
        self.audit.retry_failed(selected, occurred_at)
    }
}

impl StartupOrchestrationSource for SqliteStartupOrchestrationStore {
    fn scan_business_candidates(
        &self,
        current_app_instance_token: &str,
        observed_at: &str,
    ) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode> {
        let connection = self.connection.lock().expect("SQLite startup store lock");
        scan_sqlite_runtime_candidates(&connection, current_app_instance_token, observed_at)
    }

    fn scan_final_audit_candidates(
        &self,
    ) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode> {
        let connection = self.connection.lock().expect("SQLite startup store lock");
        scan_sqlite_audit_candidates(&connection)
    }
}

pub(crate) fn scan_sqlite_runtime_candidates(
    connection: &Connection,
    current_app_instance_token: &str,
    observed_at: &str,
) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode> {
    let durable_progress_available = match check_sqlite_schema_capability(connection) {
        SchemaCapability::Available => true,
        _ => return Err(RuntimeSafeErrorCode::StartupScanFailed),
    };
    let attempts = list_runtime_issue_candidate_attempts(connection)
        .map_err(|_| RuntimeSafeErrorCode::StartupScanFailed)?;
    let stale =
        list_stale_or_crash_claim_candidates(connection, current_app_instance_token, observed_at)
            .map_err(|_| RuntimeSafeErrorCode::StartupScanFailed)?
            .into_iter()
            .map(|candidate| {
                (
                    candidate.attempt.operation_id,
                    if candidate.kind == "crash" {
                        RuntimeIssueKind::CrashCandidate
                    } else {
                        RuntimeIssueKind::StaleCandidate
                    },
                )
            })
            .collect::<HashMap<_, _>>();
    attempts
        .into_iter()
        .map(|attempt| {
            let stale_kind = stale.get(&attempt.operation_id).copied();
            let literature_children = if attempt.scope_kind == "literature-aggregate" {
                if durable_progress_available {
                    read_literature_child_projections(connection, &attempt.operation_id)
                        .map_err(|_| RuntimeSafeErrorCode::StartupScanFailed)?
                        .into_iter()
                        .map(|child| LiteratureChildIssueSummary {
                            manuscript_channel: child.manuscript_channel.as_str().to_string(),
                            operation_id: Some(child.current_operation_id),
                            revision: child.revision,
                            phase: Some(
                                match child.child_summary_status.as_str() {
                                    "terminal-completed" => "completed",
                                    "terminal-unresolved" => "failed",
                                    _ => "preflight",
                                }
                                .to_string(),
                            ),
                            operation_status: Some(
                                match child.child_summary_status.as_str() {
                                    "terminal-completed" => "terminal-completed",
                                    "terminal-unresolved" => "terminal-failed",
                                    _ => "active",
                                }
                                .to_string(),
                            ),
                            result_classification: child
                                .result_classification
                                .map(|value| value.as_str().to_string()),
                            updated_at: child.updated_at,
                        })
                        .collect()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
            let mut candidate =
                candidate_from_attempt(attempt, true, stale_kind, literature_children, None);
            if durable_progress_available {
                let progress =
                    read_startup_progress_projection(connection, &candidate.operation_id)
                        .map_err(|_| RuntimeSafeErrorCode::StartupScanFailed)?;
                if let Some(structural_error) = progress.structural_error {
                    candidate.result_classification = Some("blocked".to_string());
                    candidate.next_action = Some("stop".to_string());
                    candidate.safe_error_code = Some(structural_error.to_string());
                } else if candidate.operation_status == "active" {
                    match progress.boundary.map(|value| value.as_str()) {
                        Some("started" | "effect-observed" | "readback-verified") => {
                            candidate.result_classification =
                                Some("provisioning-recovery-required".to_string());
                            candidate.next_action = Some("recover".to_string());
                            candidate.safe_error_code =
                                Some("durable-progress-recovery-required".to_string());
                        }
                        Some("converged")
                            if progress.converged_count == progress.required_count =>
                        {
                            candidate.result_classification =
                                Some("provisioning-recovery-required".to_string());
                            candidate.next_action = Some("recover".to_string());
                            candidate.safe_error_code =
                                Some("durable-progress-recovery-required".to_string());
                        }
                        _ => {}
                    }
                } else if candidate.operation_status == "terminal-completed"
                    && progress.converged_count != progress.required_count
                {
                    candidate.result_classification = Some("blocked".to_string());
                    candidate.next_action = Some("stop".to_string());
                    candidate.safe_error_code = Some("terminal-progress-incomplete".to_string());
                }
            }
            Ok(candidate)
        })
        .collect()
}

pub(crate) fn scan_sqlite_audit_candidates(
    connection: &Connection,
) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode> {
    let candidates = list_audit_delivery_candidates(connection, usize::MAX)
        .map_err(|_| RuntimeSafeErrorCode::StartupScanFailed)?
        .into_iter()
        .filter_map(|outbox| {
            let attempt = read_operation_attempt(connection, &outbox.operation_id)
                .ok()
                .flatten()?;
            Some(candidate_from_attempt(
                attempt,
                false,
                None,
                Vec::new(),
                Some(outbox.delivery_status),
            ))
        })
        .collect::<Vec<_>>();
    Ok(candidates)
}

fn candidate_from_attempt(
    attempt: ProvisioningOperationAttempt,
    business_issue: bool,
    stale_kind: Option<RuntimeIssueKind>,
    literature_children: Vec<LiteratureChildIssueSummary>,
    audit_status: Option<String>,
) -> RuntimeIssueCandidate {
    RuntimeIssueCandidate {
        business_issue,
        operation_id: attempt.operation_id,
        scope_kind: attempt.scope_kind,
        owner_type: attempt.owner_type,
        owner_id: attempt.owner_id,
        manuscript_channel: attempt.manuscript_channel,
        phase: attempt.phase,
        operation_status: attempt.operation_status,
        result_classification: attempt.result_classification,
        next_action: attempt.next_action,
        updated_at: attempt.updated_at,
        stale_kind,
        literature_children,
        audit_status,
        safe_error_code: None,
    }
}

fn snapshot(inner: &StartupScannerInner) -> StartupScanResult {
    StartupScanResult {
        state: inner.state,
        generation: inner.generation,
        payload: inner.payload.clone(),
        safe_error_code: inner.safe_error_code,
    }
}
