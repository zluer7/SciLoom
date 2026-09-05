use super::activation::{
    ActivationStatus, CapabilityStatus, ProductionActivationState, ProductionRuntimeSnapshot,
    ShutdownStatus,
};
use super::audit_scheduler::{AuditScheduler, AuditStore};
use super::cancellation::CancellationToken;
use super::database_provider::{
    is_safe_operation_id, ProviderSchemaCapability, ProviderStartupOrchestrationSource,
    RuntimeDatabaseProvider,
};
use super::feedback::{
    ActiveOperationSummary, FeedbackAuthority, RuntimeFeedback, RuntimeNextAction,
    RuntimeSafeErrorCode,
};
use super::heartbeat_scheduler::{
    HeartbeatCallback, HeartbeatRegistration, HeartbeatScheduler, HeartbeatTickReport,
    MonotonicClock, SchedulerTicker,
};
use super::lifecycle::{RuntimeEventSink, RuntimeStateNotification, RuntimeTaskSpawner};
use super::literature_gate::LiteratureScope;
use super::ownership_supervisor::RetainedOwnershipSupervisor;
use super::recovery_decision::{
    blocked, busy, compare_recovery_decision, AuthoritativeRecoveryState, RecoveryDecisionGuard,
    RecoveryDecisionInput, RecoveryDecisionResult,
};
use super::runtime_issue::normalize_runtime_issues;
use super::schema_capability::{SchemaCapability, SchemaCapabilityProvider};
use super::slot::{ResourceKey, SlotCoordinator, SlotLease};
use super::startup_scanner::{
    StartupOrchestrationSource, StartupScanResult, StartupScanner, StartupScannerState,
};
use crate::db::manuscript_provisioning_operation_state::claim_ownership::ClaimOwnershipRepositoryContext;
#[cfg(test)]
use crate::db::manuscript_provisioning_operation_state::claim_ownership::SystemRepositoryUtcClock;
#[cfg(test)]
use crate::provisioning_runtime_foundation::ProcessGeneration;
use chrono::{SecondsFormat, Utc};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeResource {
    Ordinary(ResourceKey),
    Literature {
        owner_id: String,
        scope: LiteratureScope,
    },
}

impl RuntimeResource {
    pub(crate) fn safe_resource_key(&self) -> ResourceKey {
        match self {
            Self::Ordinary(key) => key.clone(),
            Self::Literature { owner_id, scope } => ResourceKey::new(
                "literature",
                owner_id,
                match scope {
                    LiteratureScope::Aggregate => "aggregate",
                    LiteratureScope::Outline => "outline",
                    LiteratureScope::Notes => "notes",
                },
            ),
        }
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::Ordinary(key) => key.is_valid(),
            Self::Literature { owner_id, .. } => !owner_id.trim().is_empty(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SlotRequest {
    pub resource: RuntimeResource,
    pub intent: String,
}

impl SlotRequest {
    fn is_valid(&self) -> bool {
        self.resource.is_valid() && !self.intent.trim().is_empty()
    }
}

pub(crate) struct ClaimedOperation {
    operation_id: String,
    claim_id: String,
    expected_claim_revision: i64,
    phase: String,
    classification: String,
    heartbeat_callback: HeartbeatCallback,
}

impl ClaimedOperation {
    pub(crate) fn new(
        operation_id: &str,
        claim_id: &str,
        expected_claim_revision: i64,
        phase: &str,
        classification: &str,
        heartbeat_callback: HeartbeatCallback,
    ) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            claim_id: claim_id.to_string(),
            expected_claim_revision,
            phase: phase.to_string(),
            classification: classification.to_string(),
            heartbeat_callback,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ClaimCallbackError {
    ActiveClaimConflict {
        operation_summary: Option<ActiveOperationSummary>,
    },
    Internal {
        safe_error_code: RuntimeSafeErrorCode,
    },
}

impl ClaimCallbackError {
    pub(crate) fn active_claim_conflict(operation_summary: Option<ActiveOperationSummary>) -> Self {
        Self::ActiveClaimConflict { operation_summary }
    }

    pub(crate) fn internal(safe_error_code: RuntimeSafeErrorCode) -> Self {
        Self::Internal { safe_error_code }
    }

    fn into_feedback(self) -> RuntimeFeedback {
        match self {
            Self::ActiveClaimConflict { operation_summary } => {
                RuntimeFeedback::ActiveClaimConflict {
                    authority: FeedbackAuthority::DurableOperationState,
                    next_action: RuntimeNextAction::InspectActiveOperation,
                    safe_error_code: RuntimeSafeErrorCode::ActiveClaimConflict,
                    operation_summary,
                }
            }
            Self::Internal { safe_error_code } => RuntimeFeedback::InternalFailure {
                authority: FeedbackAuthority::None,
                next_action: RuntimeNextAction::Stop,
                safe_error_code,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalOperationSummary {
    pub operation_id: String,
    pub phase: String,
}

impl TerminalOperationSummary {
    pub(crate) fn completed(operation_id: &str, phase: &str) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            phase: phase.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuntimeSnapshot {
    pub active_slot_count: usize,
    pub ordinary_slot_count: usize,
    pub literature_slot_count: usize,
    pub heartbeat_entry_count: usize,
    pub abandoned_execution_count: usize,
    pub shutting_down: bool,
}

pub(super) struct RuntimeInner {
    capability: Arc<dyn SchemaCapabilityProvider>,
    pub(super) ownership_context: Arc<ClaimOwnershipRepositoryContext>,
    pub(super) slots: Arc<SlotCoordinator>,
    heartbeat: Arc<HeartbeatScheduler>,
    startup_scanner: Arc<StartupScanner>,
    audit_scheduler: Arc<AuditScheduler>,
    pub(super) production: Option<ProductionRuntimeDependencies>,
}

pub(super) struct ProductionRuntimeDependencies {
    pub(super) database_provider: Arc<dyn RuntimeDatabaseProvider>,
    pub(super) ownership_supervisor: Arc<RetainedOwnershipSupervisor>,
    activation: Arc<ProductionActivationState>,
    task_spawner: Arc<dyn RuntimeTaskSpawner>,
    event_sink: Arc<dyn RuntimeEventSink>,
}

pub(crate) trait IntoOwnershipContext {
    fn into_ownership_context(self) -> Arc<ClaimOwnershipRepositoryContext>;
}

impl IntoOwnershipContext for Arc<ClaimOwnershipRepositoryContext> {
    fn into_ownership_context(self) -> Arc<ClaimOwnershipRepositoryContext> {
        self
    }
}

#[cfg(test)]
impl IntoOwnershipContext for Arc<ProcessGeneration> {
    fn into_ownership_context(self) -> Arc<ClaimOwnershipRepositoryContext> {
        Arc::new(ClaimOwnershipRepositoryContext::new(
            self,
            Arc::new(SystemRepositoryUtcClock),
        ))
    }
}

#[derive(Clone)]
pub(crate) struct ProvisioningRuntime {
    pub(super) inner: Arc<RuntimeInner>,
}

impl ProvisioningRuntime {
    pub(crate) fn mainline_ownership_context(&self) -> &Arc<ClaimOwnershipRepositoryContext> {
        &self.inner.ownership_context
    }

    pub(crate) fn open_mainline_connection(
        &self,
    ) -> Result<rusqlite::Connection, RuntimeSafeErrorCode> {
        self.inner
            .production
            .as_ref()
            .ok_or(RuntimeSafeErrorCode::RuntimeDatabaseProviderFailed)?
            .database_provider
            .open_ownership()
            .map_err(|error| error.safe_error_code)
    }

    #[cfg(test)]
    pub(crate) fn new(
        capability: Arc<dyn SchemaCapabilityProvider>,
        process_generation: Arc<ProcessGeneration>,
        clock: Arc<dyn MonotonicClock>,
        ticker: Arc<dyn SchedulerTicker>,
    ) -> Self {
        let ownership_context = Arc::new(ClaimOwnershipRepositoryContext::new(
            process_generation,
            Arc::new(SystemRepositoryUtcClock),
        ));
        Self {
            inner: Arc::new(RuntimeInner {
                capability,
                ownership_context,
                slots: Arc::new(SlotCoordinator::default()),
                heartbeat: Arc::new(HeartbeatScheduler::new(clock, ticker)),
                startup_scanner: Arc::new(StartupScanner::default()),
                audit_scheduler: Arc::new(AuditScheduler::default()),
                production: None,
            }),
        }
    }

    pub(crate) fn new_production<O: IntoOwnershipContext>(
        database_provider: Arc<dyn RuntimeDatabaseProvider>,
        ownership_context: O,
        clock: Arc<dyn MonotonicClock>,
        ticker: Arc<dyn SchedulerTicker>,
        task_spawner: Arc<dyn RuntimeTaskSpawner>,
        event_sink: Arc<dyn RuntimeEventSink>,
    ) -> Self {
        let ownership_context = ownership_context.into_ownership_context();
        let capability_provider =
            Arc::new(ProviderSchemaCapability::new(database_provider.clone()));
        let capability = capability_provider.schema_capability();
        let slots = Arc::new(SlotCoordinator::default());
        let ownership_supervisor = Arc::new(RetainedOwnershipSupervisor::new(
            database_provider.clone(),
            ownership_context.clone(),
            slots.clone(),
            clock.clone(),
        ));
        Self {
            inner: Arc::new(RuntimeInner {
                capability: capability_provider,
                ownership_context,
                slots,
                heartbeat: Arc::new(HeartbeatScheduler::new(clock, ticker)),
                startup_scanner: Arc::new(StartupScanner::default()),
                audit_scheduler: Arc::new(AuditScheduler::default()),
                production: Some(ProductionRuntimeDependencies {
                    database_provider,
                    ownership_supervisor,
                    activation: Arc::new(ProductionActivationState::new(capability)),
                    task_spawner,
                    event_sink,
                }),
            }),
        }
    }

    pub(crate) fn production_snapshot(
        &self,
    ) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
        let production = self
            .inner
            .production
            .as_ref()
            .ok_or(RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?;
        let slots = self.inner.slots.snapshot();
        Ok(production
            .activation
            .snapshot(self.inner.heartbeat.entry_count(), slots.abandoned_count))
    }

    #[cfg(test)]
    pub(crate) fn retained_ownership_supervisor_for_test(
        &self,
    ) -> Option<Arc<RetainedOwnershipSupervisor>> {
        self.inner
            .production
            .as_ref()
            .map(|production| production.ownership_supervisor.clone())
    }

    pub(crate) fn mark_main_window_ready(
        self: &Arc<Self>,
        window_label: &str,
    ) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
        let production = self
            .inner
            .production
            .as_ref()
            .ok_or(RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?;
        if let Some(generation) = production.activation.mark_main_window_ready(window_label)? {
            self.spawn_startup_task(generation, false);
        }
        self.production_snapshot()
    }

    pub(crate) fn retry_production_startup_scan(
        self: &Arc<Self>,
    ) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
        let production = self
            .inner
            .production
            .as_ref()
            .ok_or(RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?;
        let generation = production.activation.begin_startup_retry()?;
        self.spawn_startup_task(generation, true);
        self.production_snapshot()
    }

    fn spawn_startup_task(self: &Arc<Self>, generation: u64, retry: bool) {
        let Some(production) = self.inner.production.as_ref() else {
            return;
        };
        let task_runtime = self.clone();
        let abort_runtime = self.clone();
        production.task_spawner.spawn(
            Box::new(move || {
                let source = ProviderStartupOrchestrationSource::new(
                    task_runtime
                        .inner
                        .production
                        .as_ref()
                        .expect("production runtime dependencies")
                        .database_provider
                        .clone(),
                );
                let observed_at = runtime_timestamp();
                let audit_occurred_at = runtime_timestamp();
                let result = if retry {
                    task_runtime.inner.startup_scanner.run_retry_orchestrated(
                        &source,
                        &task_runtime.inner.audit_scheduler,
                        task_runtime.inner.ownership_context.claim_owner_token(),
                        &observed_at,
                        &audit_occurred_at,
                    )
                } else {
                    task_runtime.inner.startup_scanner.run_initial_orchestrated(
                        &source,
                        &task_runtime.inner.audit_scheduler,
                        task_runtime.inner.ownership_context.claim_owner_token(),
                        &observed_at,
                        &audit_occurred_at,
                    )
                };
                let completed = result.state == StartupScannerState::Completed;
                let production = task_runtime
                    .inner
                    .production
                    .as_ref()
                    .expect("production runtime dependencies");
                if production
                    .activation
                    .complete_startup_task(generation, result)
                {
                    task_runtime.notify_production_state(if completed {
                        "startup-completed"
                    } else {
                        "startup-failed"
                    });
                }
            }),
            Box::new(move || {
                let production = abort_runtime
                    .inner
                    .production
                    .as_ref()
                    .expect("production runtime dependencies");
                if production.activation.abort_startup_task(generation, retry) {
                    abort_runtime.notify_production_state("startup-failed");
                }
            }),
        );
    }

    pub(crate) fn retry_production_audit_one(
        &self,
        operation_id: &str,
    ) -> Result<ProductionRuntimeSnapshot, RuntimeSafeErrorCode> {
        if !is_safe_operation_id(operation_id) {
            return Err(RuntimeSafeErrorCode::RuntimeInvalidResourceKey);
        }
        let production = self
            .inner
            .production
            .as_ref()
            .ok_or(RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?;
        let generation = production.activation.begin_audit_retry()?;
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let source =
                ProviderStartupOrchestrationSource::new(production.database_provider.clone());
            let item =
                self.inner
                    .audit_scheduler
                    .retry_one(&source, operation_id, &runtime_timestamp());
            let mut candidates = source.scan_business_candidates(
                self.inner.ownership_context.claim_owner_token(),
                &runtime_timestamp(),
            )?;
            candidates.extend(source.scan_final_audit_candidates()?);
            let remaining = source
                .count_candidates()
                .map_err(|error| error.safe_error_code)?;
            Ok((item, remaining, normalize_runtime_issues(candidates)))
        }));
        let (item, remaining, issues) = match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                if production.activation.abort_audit_retry(generation, error) {
                    self.notify_production_state("audit-retry-failed");
                }
                return Err(error);
            }
            Err(_) => {
                let error = RuntimeSafeErrorCode::AuditRetryFailed;
                if production.activation.abort_audit_retry(generation, error) {
                    self.notify_production_state("audit-retry-failed");
                }
                return Err(error);
            }
        };
        production
            .activation
            .complete_audit_retry(generation, item, remaining, issues)?;
        self.notify_production_state("audit-retry-completed");
        self.production_snapshot()
    }

    pub(crate) fn shutdown_production(&self) {
        let Some(production) = self.inner.production.as_ref() else {
            self.shutdown();
            return;
        };
        if !production.activation.begin_shutdown() {
            return;
        }
        self.shutdown();
        production.activation.finish_shutdown();
        self.notify_production_state("shutdown-stopped");
    }

    fn notify_production_state(&self, kind: &str) {
        let Some(production) = self.inner.production.as_ref() else {
            return;
        };
        if let Ok(snapshot) = self.production_snapshot() {
            production.event_sink.notify(RuntimeStateNotification {
                revision: snapshot.revision,
                generation: snapshot.startup_task_generation,
                kind: kind.to_string(),
            });
        }
    }

    pub(crate) fn try_acquire_operation_slot(
        &self,
        request: SlotRequest,
        cancellation: CancellationToken,
    ) -> Result<OperationSlotGuard, RuntimeFeedback> {
        if !request.is_valid() {
            return Err(RuntimeFeedback::InvalidResourceKey {
                authority: FeedbackAuthority::None,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::RuntimeInvalidResourceKey,
            });
        }
        if self.inner.production.is_some() {
            let snapshot = self.production_snapshot().map_err(|safe_error_code| {
                RuntimeFeedback::InternalFailure {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::Stop,
                    safe_error_code,
                }
            })?;
            if snapshot.shutdown_status != ShutdownStatus::Running {
                return Err(RuntimeFeedback::ShuttingDown {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::Stop,
                    safe_error_code: RuntimeSafeErrorCode::RuntimeShuttingDown,
                });
            }
            if snapshot.activation_status != ActivationStatus::Active || !snapshot.main_window_ready
            {
                if snapshot.activation_status == ActivationStatus::Inactive {
                    if let Some(capability) =
                        production_capability_label(snapshot.capability_status)
                    {
                        return Err(RuntimeFeedback::OperationStateUnavailable {
                            authority: FeedbackAuthority::None,
                            next_action: RuntimeNextAction::WaitForActivation,
                            safe_error_code: RuntimeSafeErrorCode::OperationStateUnavailable,
                            capability: capability.to_string(),
                        });
                    }
                }
                return Err(RuntimeFeedback::InternalFailure {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::WaitForActivation,
                    safe_error_code: if !snapshot.main_window_ready {
                        RuntimeSafeErrorCode::RuntimeMainWindowNotReady
                    } else {
                        RuntimeSafeErrorCode::RuntimeActivationFailed
                    },
                });
            }
        }
        let capability = self.inner.capability.schema_capability();
        if capability != SchemaCapability::Available {
            return Err(RuntimeFeedback::OperationStateUnavailable {
                authority: FeedbackAuthority::None,
                next_action: RuntimeNextAction::WaitForActivation,
                safe_error_code: RuntimeSafeErrorCode::OperationStateUnavailable,
                capability: match capability {
                    SchemaCapability::Available => unreachable!(),
                    SchemaCapability::UnavailableNotMigrated => {
                        "unavailable-not-migrated".to_string()
                    }
                    SchemaCapability::UnavailableInvalidSchema => {
                        "unavailable-invalid-schema".to_string()
                    }
                    SchemaCapability::ReadFailed => "read-failed".to_string(),
                },
            });
        }
        if cancellation.is_cancelled() {
            return Err(RuntimeFeedback::CallerCancelled {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: None,
            });
        }
        let (lease, generation) = self.inner.slots.try_acquire(
            &request.resource,
            &request.intent,
            self.inner.heartbeat.now_ms(),
        )?;
        Ok(OperationSlotGuard {
            inner: self.inner.clone(),
            request,
            cancellation,
            lease: Some(lease),
            generation,
        })
    }

    pub(crate) fn tick_heartbeats(&self) -> HeartbeatTickReport {
        let report = self.inner.heartbeat.tick();
        for removed in &report.removed {
            self.inner
                .slots
                .release_by_operation(&removed.operation_id, removed.generation);
        }
        report
    }

    pub(crate) fn run_startup_scan(
        &self,
        source: &dyn StartupOrchestrationSource,
        observed_at: &str,
        audit_occurred_at: &str,
    ) -> StartupScanResult {
        if self.inner.capability.schema_capability() != SchemaCapability::Available {
            return StartupScanner::unavailable(RuntimeSafeErrorCode::OperationStateUnavailable);
        }
        self.inner.startup_scanner.run_initial_orchestrated(
            source,
            &self.inner.audit_scheduler,
            self.inner.ownership_context.claim_owner_token(),
            observed_at,
            audit_occurred_at,
        )
    }

    pub(crate) fn retry_startup_scan(
        &self,
        source: &dyn StartupOrchestrationSource,
        observed_at: &str,
        audit_occurred_at: &str,
    ) -> StartupScanResult {
        if self.inner.capability.schema_capability() != SchemaCapability::Available {
            return StartupScanner::unavailable(RuntimeSafeErrorCode::OperationStateUnavailable);
        }
        self.inner.startup_scanner.run_retry_orchestrated(
            source,
            &self.inner.audit_scheduler,
            self.inner.ownership_context.claim_owner_token(),
            observed_at,
            audit_occurred_at,
        )
    }

    pub(crate) fn decide_recovery<F>(
        &self,
        input: RecoveryDecisionInput,
        authoritative_read: F,
    ) -> RecoveryDecisionResult
    where
        F: FnOnce() -> Result<AuthoritativeRecoveryState, RuntimeSafeErrorCode>,
    {
        if self.inner.capability.schema_capability() != SchemaCapability::Available {
            return blocked(RuntimeSafeErrorCode::OperationStateUnavailable);
        }
        if !input.user_confirmed
            || input.confirmed.validate().is_err()
            || input.fresh.validate().is_err()
        {
            return blocked(RuntimeSafeErrorCode::RecoverySnapshotInvalid);
        }
        let resource = recovery_resource(&input.fresh);
        let (lease, generation) = match self
            .inner
            .slots
            .try_acquire_recovery_decision(&resource, self.inner.heartbeat.now_ms())
        {
            Ok(acquired) => acquired,
            Err(_) => return busy(),
        };
        let _guard = RecoveryDecisionGuard::new(self.inner.slots.clone(), lease, generation);
        match authoritative_read() {
            Ok(authority) => compare_recovery_decision(&input, &authority),
            Err(error) => blocked(error),
        }
    }

    pub(crate) fn shutdown(&self) {
        self.inner.slots.begin_shutdown();
        self.inner.heartbeat.shutdown();
        self.inner.startup_scanner.shutdown();
        self.inner.audit_scheduler.shutdown();
    }

    pub(crate) fn snapshot(&self) -> RuntimeSnapshot {
        let slots = self.inner.slots.snapshot();
        RuntimeSnapshot {
            active_slot_count: slots.ordinary_count + slots.literature_count,
            ordinary_slot_count: slots.ordinary_count,
            literature_slot_count: slots.literature_count,
            heartbeat_entry_count: self.inner.heartbeat.entry_count(),
            abandoned_execution_count: slots.abandoned_count,
            shutting_down: slots.shutting_down,
        }
    }

    #[cfg(test)]
    pub(crate) fn heartbeat_scheduler(&self) -> Arc<HeartbeatScheduler> {
        self.inner.heartbeat.clone()
    }

    #[cfg(test)]
    pub(crate) fn test_app_instance_token(&self) -> &str {
        self.inner.ownership_context.claim_owner_token()
    }

    #[cfg(test)]
    pub(crate) fn process_generation_for_test(&self) -> &str {
        self.inner.ownership_context.claim_owner_token()
    }
}

fn runtime_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn production_capability_label(capability: CapabilityStatus) -> Option<&'static str> {
    match capability {
        CapabilityStatus::UnavailableNotMigrated => Some("unavailable-not-migrated"),
        CapabilityStatus::UnavailableInvalidSchema => Some("unavailable-invalid-schema"),
        CapabilityStatus::ReadFailed => Some("read-failed"),
        CapabilityStatus::Unchecked | CapabilityStatus::Available => None,
    }
}

fn recovery_resource(
    snapshot: &super::recovery_snapshot::RecoveryInspectionSnapshot,
) -> RuntimeResource {
    if snapshot.owner_type == "literature" {
        RuntimeResource::Literature {
            owner_id: snapshot.owner_id.clone(),
            scope: match snapshot.manuscript_channel.as_str() {
                "literature_outline" => LiteratureScope::Outline,
                "dedicated_notes" => LiteratureScope::Notes,
                _ => LiteratureScope::Aggregate,
            },
        }
    } else {
        RuntimeResource::Ordinary(ResourceKey::new(
            &snapshot.owner_type,
            &snapshot.owner_id,
            &snapshot.manuscript_channel,
        ))
    }
}

pub(crate) struct OperationSlotGuard {
    inner: Arc<RuntimeInner>,
    request: SlotRequest,
    cancellation: CancellationToken,
    lease: Option<SlotLease>,
    generation: u64,
}

impl std::fmt::Debug for OperationSlotGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OperationSlotGuard")
            .field("request", &self.request)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl OperationSlotGuard {
    pub(crate) fn claim<F>(mut self, callback: F) -> Result<ClaimedExecutionHandle, RuntimeFeedback>
    where
        F: FnOnce(&str) -> Result<ClaimedOperation, ClaimCallbackError>,
    {
        if self.cancellation.is_cancelled() {
            return Err(RuntimeFeedback::CallerCancelled {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: None,
            });
        }
        if self.inner.slots.is_shutting_down() {
            return Err(RuntimeFeedback::ShuttingDown {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::RuntimeShuttingDown,
            });
        }
        let claimed = callback(self.inner.ownership_context.claim_owner_token())
            .map_err(ClaimCallbackError::into_feedback)?;
        let lease = self.lease.as_ref().expect("guard lease");
        let summary = self.inner.slots.promote_claimed(
            lease,
            self.generation,
            &claimed.operation_id,
            &claimed.phase,
            &claimed.classification,
        )?;
        if self.inner.slots.is_shutting_down() {
            self.lease.take();
            return Err(RuntimeFeedback::ShuttingDown {
                authority: FeedbackAuthority::DurableOperationState,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::RuntimeShuttingDown,
            });
        }
        let registration = HeartbeatRegistration {
            operation_id: claimed.operation_id.clone(),
            claim_id: claimed.claim_id,
            expected_claim_revision: claimed.expected_claim_revision,
            resource: self.request.resource.safe_resource_key(),
            generation: self.generation,
            callback: claimed.heartbeat_callback,
        };
        if let Err(error) = self.inner.heartbeat.register(registration) {
            if !self.inner.slots.is_shutting_down() {
                self.inner.slots.release(lease, self.generation);
            }
            self.lease.take();
            return Err(error);
        }
        let lease = self.lease.take().expect("transfer guard lease");
        Ok(ClaimedExecutionHandle {
            inner: self.inner.clone(),
            lease,
            generation: self.generation,
            operation_id: claimed.operation_id,
            summary,
            state: ClaimedHandleState::Active,
        })
    }
}

impl Drop for OperationSlotGuard {
    fn drop(&mut self) {
        if let Some(lease) = &self.lease {
            self.inner.slots.release(lease, self.generation);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimedHandleState {
    Active,
    Detached,
    Completed,
    Abandoned,
}

pub(crate) struct ClaimedExecutionHandle {
    inner: Arc<RuntimeInner>,
    lease: SlotLease,
    generation: u64,
    operation_id: String,
    summary: ActiveOperationSummary,
    state: ClaimedHandleState,
}

impl ClaimedExecutionHandle {
    pub(crate) fn detach_caller(&mut self) -> Result<RuntimeFeedback, RuntimeFeedback> {
        if self.state != ClaimedHandleState::Active {
            return Err(RuntimeFeedback::invalid_lifecycle());
        }
        self.state = ClaimedHandleState::Detached;
        Ok(RuntimeFeedback::CallerDetached {
            authority: FeedbackAuthority::DurableOperationState,
            next_action: RuntimeNextAction::Detach,
            operation_summary: self.summary.clone(),
        })
    }

    pub(crate) fn complete(
        &mut self,
        terminal: TerminalOperationSummary,
    ) -> Result<RuntimeFeedback, RuntimeFeedback> {
        if self.inner.slots.is_shutting_down() {
            self.state = ClaimedHandleState::Abandoned;
            return Err(RuntimeFeedback::invalid_lifecycle());
        }
        if !matches!(
            self.state,
            ClaimedHandleState::Active | ClaimedHandleState::Detached
        ) || terminal.operation_id != self.operation_id
        {
            return Err(RuntimeFeedback::invalid_lifecycle());
        }
        self.inner
            .heartbeat
            .unregister(&self.operation_id, self.generation);
        self.inner.slots.release(&self.lease, self.generation);
        self.state = ClaimedHandleState::Completed;
        Ok(RuntimeFeedback::Completed {
            authority: FeedbackAuthority::DurableOperationState,
            next_action: RuntimeNextAction::None,
            operation_id: terminal.operation_id,
            phase: terminal.phase,
        })
    }
}
