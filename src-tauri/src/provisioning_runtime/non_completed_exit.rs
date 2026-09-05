#![allow(dead_code)]

use super::core::{ProvisioningRuntime, RuntimeResource};
use super::literature_gate::LiteratureScope;
pub(crate) use super::slot::RuntimeRegistryLifecycle;
#[cfg(test)]
use super::slot::RuntimeRegistrySnapshot;
use super::slot::{ResourceKey, RuntimeRegistration, SlotCoordinator, SlotLease};
#[cfg(test)]
use crate::db::arm_native_commit_hook_abort;
use crate::db::manuscript_provisioning_operation_state::claim_ownership::ClaimOwnershipSnapshot;
use crate::db::manuscript_provisioning_operation_state::step_progress::{
    is_utc_timestamp, DurableStepProgressRow,
};
use crate::db::manuscript_provisioning_operation_state::{
    read_active_claim_for_operation, read_attempt_plan, read_attempt_step_progress,
    read_operation_attempt, record_claim_heartbeat_with_repository_clock,
    short_revalidate_runtime_boundary, ChainedAtomicInitializationResult,
    ChainedInitializationAuthority, ProvisioningActiveClaim, ProvisioningOperationAttempt,
    RuntimeDurableRevalidation, PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE,
    PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN,
    PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED, PROVISIONING_CLAIM_OWNER_MISMATCH,
    PROVISIONING_OPERATION_CAS_CONFLICT, PROVISIONING_OPERATION_DATABASE_ERROR,
};
use rusqlite::{
    params, Connection, Error as SqliteError, ErrorCode, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
#[cfg(test)]
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use uuid::Uuid;

const PERMIT_NEVER_ISSUED: u8 = 0;
const PERMIT_BOUNDARY_COMMITTED: u8 = 1;
const PERMIT_ISSUED: u8 = 2;
const PERMIT_SEALED_NO_EFFECT: u8 = 3;
const PERMIT_INVOCATION_UNKNOWN: u8 = 4;
const PERMIT_CONSUMED_OUTCOME: u8 = 5;

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermitFault {
    Begin,
    DurableValidation,
    StepUpdate,
    PreCommitReadback,
    CommitKnownNotCommitted,
    CommitOutcomeUnknown,
    PostCommitReadback,
    PermitIssue,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitFault {
    BeginExit,
    AttemptRead,
    ClaimRead,
    StepRead,
    ProjectionRead,
    RiskJoin,
    AttemptUpdate,
    StepUpdate,
    ProjectionSync,
    OutboxInsert,
    ClaimRelease,
    RecoveryUpdate,
    PreCommitReadback,
    CommitKnownNotCommitted,
    CommitOutcomeUnknown,
    PostCommitReadback,
    RegistryTerminalTransition,
    RegistryRetainedTransition,
    RegistryQuarantinedTransition,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeartbeatFoundationFault {
    PostCommitOutcomeUnknown,
    RegistryReplacementConflict,
}

#[cfg(test)]
thread_local! {
    static PERMIT_FAULT: Cell<Option<PermitFault>> = const { Cell::new(None) };
    static EXIT_FAULT: Cell<Option<ExitFault>> = const { Cell::new(None) };
    static HEARTBEAT_FOUNDATION_FAULT: Cell<Option<HeartbeatFoundationFault>> =
        const { Cell::new(None) };
}

#[cfg(test)]
fn permit_fault_is(expected: PermitFault) -> bool {
    PERMIT_FAULT.with(|fault| fault.get() == Some(expected))
}

#[cfg(test)]
fn exit_fault_is(expected: ExitFault) -> bool {
    EXIT_FAULT.with(|fault| fault.get() == Some(expected))
}

#[cfg(test)]
fn heartbeat_foundation_fault_is(expected: HeartbeatFoundationFault) -> bool {
    HEARTBEAT_FOUNDATION_FAULT.with(|fault| fault.get() == Some(expected))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum EffectRisk {
    NoEffectPossible,
    NoEffectProven,
    EffectAppliedComplete,
    EffectAppliedPartial,
    EffectIndeterminate,
}

impl EffectRisk {
    pub(crate) const fn join(self, other: Self) -> Self {
        if self as u8 >= other as u8 {
            self
        } else {
            other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeLifecyclePhase {
    Active,
    PermitBoundaryCommitted,
    PermitIssued,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeState {
    Live {
        phase: RuntimeLifecyclePhase,
        effect: EffectRisk,
    },
    Exiting {
        effect: EffectRisk,
        exit_generation: u64,
    },
    ClosedTerminal,
    ClosedRecoveryRetained,
    CommitOutcomeUnknownQuarantined,
    DroppedUnclosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NonCompletedExitReason {
    ExplicitCancel,
    PlanningStale,
    DurableStale,
    PhysicalVerifierBlocked,
    AdapterUnavailable,
    RuntimeShutdown,
}

impl NonCompletedExitReason {
    const fn cause_code(self) -> &'static str {
        match self {
            Self::ExplicitCancel => "EXPLICIT_CANCEL",
            Self::PlanningStale => "PLANNING_AUTHORITY_STALE",
            Self::DurableStale => "DURABLE_AUTHORITY_STALE",
            Self::PhysicalVerifierBlocked => "PHYSICAL_VERIFIER_BLOCKED",
            Self::AdapterUnavailable => "ADAPTER_UNAVAILABLE",
            Self::RuntimeShutdown => "RUNTIME_SHUTDOWN",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NonCompletedExitResult {
    SafelyTerminalizedAndReleased,
    RecoveryRequiredAndRetained,
    AuthoritativeExistingTerminal,
    RecoveryRequiredExisting,
    CommitOutcomeUnknownQuarantined,
    HandleStale,
    HandleAlreadyClosed,
    HandleOwnershipConflict,
    AttemptRevisionMismatch,
    ClaimRevisionMismatch,
    StepProgressStale,
    DurableAuthorityStale,
    RepositoryBusy,
    RepositoryUnavailable,
    KnownNotCommitted,
    ProvisioningRecoveryRequired,
    InternalInvariantFailure,
}

pub(crate) enum RuntimeHandleRegistrationResult {
    Registered(ProvisioningRuntimeHandle),
    NotFreshInitialization,
    HandleOwnershipConflict,
    RepositoryUnavailable,
    ProvisioningRecoveryRequired,
}

impl std::fmt::Debug for RuntimeHandleRegistrationResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Registered(handle) => formatter.debug_tuple("Registered").field(handle).finish(),
            Self::NotFreshInitialization => formatter.write_str("NotFreshInitialization"),
            Self::HandleOwnershipConflict => formatter.write_str("HandleOwnershipConflict"),
            Self::RepositoryUnavailable => formatter.write_str("RepositoryUnavailable"),
            Self::ProvisioningRecoveryRequired => {
                formatter.write_str("ProvisioningRecoveryRequired")
            }
        }
    }
}

#[derive(Debug)]
pub(crate) enum PermitBoundaryResult {
    Issued(RuntimeExecutionPermit),
    HandleStale,
    HandleAlreadyClosed,
    HandleOwnershipConflict,
    AttemptRevisionMismatch,
    ClaimRevisionMismatch,
    StepProgressStale,
    DurableAuthorityStale,
    RepositoryBusy,
    RepositoryUnavailable,
    KnownNotCommitted,
    CommitOutcomeUnknownQuarantined,
    ProvisioningRecoveryRequired,
    InternalInvariantFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeartbeatFoundationResult {
    HeartbeatFoundationUpdated,
    ClaimRevisionStale,
    ClaimOwnerMismatch,
    ProcessGenerationMismatch,
    RegistryProofStale,
    RegistryReplacementConflict,
    ClockAuthorityUnavailable,
    RepositoryBusy,
    RepositoryUnavailable,
    KnownNotCommitted,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

#[derive(Debug)]
pub(crate) struct RuntimeExecutionPermit {
    operation_id: String,
    claim_id: String,
    claim_revision: i64,
    plan_id: String,
    plan_identity_fingerprint: String,
    step_id: String,
    progress_revision: i64,
    runtime_instance_id: String,
    registry_generation: u64,
    execution_generation: u64,
    lifecycle: Arc<AtomicU8>,
}

impl Drop for RuntimeExecutionPermit {
    fn drop(&mut self) {
        let _ = self.lifecycle.compare_exchange(
            PERMIT_ISSUED,
            PERMIT_INVOCATION_UNKNOWN,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }
}

impl RuntimeExecutionPermit {
    pub(crate) fn seal_recovery_execution(
        operation_id: String,
        claim_id: String,
        claim_revision: i64,
        plan_id: String,
        plan_identity_fingerprint: String,
        step_id: String,
        progress_revision: i64,
        runtime_instance_id: String,
        registry_generation: u64,
        execution_generation: u64,
    ) -> Self {
        Self {
            operation_id,
            claim_id,
            claim_revision,
            plan_id,
            plan_identity_fingerprint,
            step_id,
            progress_revision,
            runtime_instance_id,
            registry_generation,
            execution_generation,
            lifecycle: Arc::new(AtomicU8::new(PERMIT_ISSUED)),
        }
    }

    pub(crate) fn matches_recovery_execution(
        &self,
        operation_id: &str,
        claim_id: &str,
        claim_revision: i64,
        plan_id: &str,
        plan_identity_fingerprint: &str,
        step_id: &str,
        progress_revision: i64,
        runtime_instance_id: &str,
        registry_generation: u64,
        execution_generation: u64,
    ) -> bool {
        self.bindings_match_recovery_execution(
            operation_id,
            claim_id,
            claim_revision,
            plan_id,
            plan_identity_fingerprint,
            step_id,
            progress_revision,
            runtime_instance_id,
            registry_generation,
            execution_generation,
        ) && self.lifecycle.load(Ordering::SeqCst) == PERMIT_ISSUED
    }

    pub(crate) fn bindings_match_recovery_execution(
        &self,
        operation_id: &str,
        claim_id: &str,
        claim_revision: i64,
        plan_id: &str,
        plan_identity_fingerprint: &str,
        step_id: &str,
        progress_revision: i64,
        runtime_instance_id: &str,
        registry_generation: u64,
        execution_generation: u64,
    ) -> bool {
        self.operation_id == operation_id
            && self.claim_id == claim_id
            && self.claim_revision == claim_revision
            && self.plan_id == plan_id
            && self.plan_identity_fingerprint == plan_identity_fingerprint
            && self.step_id == step_id
            && self.progress_revision == progress_revision
            && self.runtime_instance_id == runtime_instance_id
            && self.registry_generation == registry_generation
            && self.execution_generation == execution_generation
    }

    pub(crate) fn refresh_recovery_execution_claim_revision(
        &mut self,
        expected_claim_revision: i64,
        fresh_claim_revision: i64,
    ) -> bool {
        if self.claim_revision != expected_claim_revision
            || fresh_claim_revision <= expected_claim_revision
            || self.lifecycle.load(Ordering::SeqCst) != PERMIT_ISSUED
        {
            return false;
        }
        self.claim_revision = fresh_claim_revision;
        true
    }

    pub(crate) fn recovery_execution_claim_revision(&self) -> i64 {
        self.claim_revision
    }

    pub(crate) fn authorizes_physical_mutation(&self) -> bool {
        self.lifecycle.load(Ordering::SeqCst) == PERMIT_ISSUED
    }

    pub(crate) fn seal_invocation_returned(&self) -> bool {
        self.lifecycle
            .compare_exchange(
                PERMIT_ISSUED,
                PERMIT_BOUNDARY_COMMITTED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    pub(crate) fn seal_not_invoked(&self) -> bool {
        self.lifecycle
            .compare_exchange(
                PERMIT_ISSUED,
                PERMIT_SEALED_NO_EFFECT,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    #[cfg(test)]
    pub(crate) fn operation_id_for_test(&self) -> &str {
        &self.operation_id
    }

    #[cfg(test)]
    pub(crate) const fn progress_revision_for_test(&self) -> i64 {
        self.progress_revision
    }
}

pub(crate) struct SealedNoEffectReceipt {
    operation_id: String,
    step_id: String,
    progress_revision: i64,
    _sealed: (),
}

impl SealedNoEffectReceipt {
    #[cfg(test)]
    pub(crate) fn operation_id_for_test(&self) -> &str {
        &self.operation_id
    }
}

#[cfg(test)]
pub(crate) fn seal_not_invoked_for_test(
    permit: RuntimeExecutionPermit,
    handle: &mut ProvisioningRuntimeHandle,
    occurred_at: &str,
) -> Result<SealedNoEffectReceipt, NonCompletedExitResult> {
    if !is_utc_timestamp(occurred_at)
        || permit.operation_id != handle.initialization.operation_id
        || permit.claim_id != handle.claim_id
        || permit.plan_id != handle.plan_id
        || permit.step_id != handle.step_id
        || permit.progress_revision != handle.progress_revision
        || permit.runtime_instance_id != handle.runtime_instance_id
        || permit.registry_generation != handle.registry_generation
        || permit.lifecycle.load(Ordering::SeqCst) != PERMIT_ISSUED
        || !handle.registry_is(&[RuntimeRegistryLifecycle::Live])
    {
        return Err(NonCompletedExitResult::HandleOwnershipConflict);
    }
    let mut connection = open_read_write(&handle.database_path)
        .map_err(|()| NonCompletedExitResult::RepositoryUnavailable)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| NonCompletedExitResult::RepositoryBusy)?;
    let changed = transaction
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET effect_outcome='no-effect-proven',readback_outcome='verified-absent',
                 progress_revision=progress_revision+1,updated_at=?1
             WHERE operation_id=?2 AND plan_id=?3 AND step_id=?4
               AND progress_revision=?5 AND boundary='started'
               AND effect_outcome='unobserved'",
            params![
                occurred_at,
                handle.initialization.operation_id,
                handle.plan_id,
                handle.step_id,
                handle.progress_revision
            ],
        )
        .map_err(|_| NonCompletedExitResult::RepositoryUnavailable)?;
    if changed != 1 {
        return Err(NonCompletedExitResult::StepProgressStale);
    }
    let revision = handle.progress_revision + 1;
    let readback = transaction
        .query_row(
            "SELECT boundary,effect_outcome,readback_outcome,progress_revision
             FROM manuscript_provisioning_step_progress
             WHERE operation_id=?1 AND step_id=?2",
            (&handle.initialization.operation_id, &handle.step_id),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(|_| NonCompletedExitResult::RepositoryUnavailable)?;
    if readback
        != (
            "started".to_string(),
            "no-effect-proven".to_string(),
            "verified-absent".to_string(),
            revision,
        )
    {
        return Err(NonCompletedExitResult::InternalInvariantFailure);
    }
    transaction
        .commit()
        .map_err(|_| NonCompletedExitResult::KnownNotCommitted)?;
    let reopened = open_read_only(&handle.database_path)
        .map_err(|()| NonCompletedExitResult::ProvisioningRecoveryRequired)?;
    let durable = read_step_progress_tuple(
        &reopened,
        &handle.initialization.operation_id,
        &handle.step_id,
    );
    if !matches!(
        durable,
        Some((ref boundary, ref effect, current))
            if boundary == "started" && effect == "no-effect-proven" && current == revision
    ) {
        return Err(NonCompletedExitResult::ProvisioningRecoveryRequired);
    }
    permit
        .lifecycle
        .store(PERMIT_SEALED_NO_EFFECT, Ordering::SeqCst);
    handle.progress_revision = revision;
    handle.state = RuntimeState::Live {
        phase: RuntimeLifecyclePhase::PermitIssued,
        effect: EffectRisk::NoEffectProven,
    };
    Ok(SealedNoEffectReceipt {
        operation_id: handle.initialization.operation_id.clone(),
        step_id: handle.step_id.clone(),
        progress_revision: revision,
        _sealed: (),
    })
}

pub(crate) struct RuntimeWindowSubscription {
    registry: Arc<SlotCoordinator>,
    lease: SlotLease,
    operation_id: String,
    window_id: String,
    runtime_instance_id: String,
    registry_generation: u64,
    detached: bool,
}

impl RuntimeWindowSubscription {
    pub(crate) fn request_cancellation(&self) -> bool {
        self.registry.request_runtime_cancellation(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
        )
    }

    pub(crate) fn detach(mut self) {
        self.registry
            .detach_window(&self.operation_id, &self.window_id);
        self.detached = true;
    }
}

impl Drop for RuntimeWindowSubscription {
    fn drop(&mut self) {
        if !self.detached {
            self.registry
                .detach_window(&self.operation_id, &self.window_id);
        }
    }
}

pub(crate) struct ProvisioningRuntimeHandle {
    registry: Arc<SlotCoordinator>,
    ownership_context: Arc<
        crate::db::manuscript_provisioning_operation_state::claim_ownership::
            ClaimOwnershipRepositoryContext,
    >,
    lease: SlotLease,
    database_path: PathBuf,
    initialization: ChainedInitializationAuthority,
    runtime_instance_id: String,
    registry_generation: u64,
    claim_id: String,
    owner_type: String,
    owner_id: String,
    scope_kind: String,
    manuscript_channel: Option<String>,
    plan_id: String,
    plan_identity_fingerprint: String,
    precondition_snapshot_hash: String,
    step_id: String,
    step_ordinal: i64,
    progress_revision: i64,
    state: RuntimeState,
    permit_lifecycle: Arc<AtomicU8>,
    closed: bool,
}

impl std::fmt::Debug for ProvisioningRuntimeHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProvisioningRuntimeHandle")
            .field("operation_id", &self.initialization.operation_id)
            .field("runtime_instance_id", &self.runtime_instance_id)
            .field("registry_generation", &self.registry_generation)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Drop for ProvisioningRuntimeHandle {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        self.state = RuntimeState::DroppedUnclosed;
        self.registry.mark_runtime_dropped_nonblocking(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
        );
    }
}

fn resource_for(
    owner_type: &str,
    owner_id: &str,
    scope_kind: &str,
    channel: Option<&str>,
) -> Option<RuntimeResource> {
    if owner_type == "literature" {
        let scope = match (scope_kind, channel) {
            ("literature-aggregate", None) => LiteratureScope::Aggregate,
            ("channel", Some("literature_outline")) => LiteratureScope::Outline,
            ("channel", Some("dedicated_notes")) => LiteratureScope::Notes,
            _ => return None,
        };
        Some(RuntimeResource::Literature {
            owner_id: owner_id.to_string(),
            scope,
        })
    } else if scope_kind == "channel" && channel == Some("primary") {
        Some(RuntimeResource::Ordinary(ResourceKey::new(
            owner_type, owner_id, "primary",
        )))
    } else {
        None
    }
}

fn open_read_write(path: &Path) -> Result<Connection, ()> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|_| ())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| ())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|_| ())?;
    crate::db::schema::validate_global_schema_current(&connection).map_err(|_| ())?;
    if crate::db::manuscript_provisioning_operation_state::step_progress_schema::
        validate_provisioning_contract(&connection)
            .map_err(|_| ())?
    {
        Ok(connection)
    } else {
        Err(())
    }
}

fn open_read_only(path: &Path) -> Result<Connection, ()> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| ())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|_| ())?;
    Ok(connection)
}

impl ProvisioningRuntime {
    pub(crate) fn register_initialized_runtime_handle(
        &self,
        database_path: &Path,
        initialization: ChainedAtomicInitializationResult,
    ) -> RuntimeHandleRegistrationResult {
        let ChainedAtomicInitializationResult::Initialized(initialization) = initialization else {
            return RuntimeHandleRegistrationResult::NotFreshInitialization;
        };
        let connection = match open_read_only(database_path) {
            Ok(connection) => connection,
            Err(()) => return RuntimeHandleRegistrationResult::RepositoryUnavailable,
        };
        let attempt = match read_operation_attempt(&connection, &initialization.operation_id) {
            Ok(Some(attempt)) => attempt,
            _ => return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired,
        };
        let claim = match read_active_claim_for_operation(&connection, &attempt.operation_id) {
            Ok(Some(claim)) => claim,
            _ => return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired,
        };
        let plan = match read_attempt_plan(&connection, &attempt.operation_id) {
            Ok(Some(plan)) => plan,
            _ => return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired,
        };
        let steps = match read_attempt_step_progress(&connection, &attempt.operation_id) {
            Ok(steps) => steps,
            Err(_) => return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired,
        };
        let Some(step) = steps
            .iter()
            .find(|step| step.boundary.as_str() != "converged")
        else {
            return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired;
        };
        let process_generation = self.inner.ownership_context.claim_owner_token();
        let identity_matches = attempt.operation_status == "active"
            && attempt.revision == initialization.attempt_revision
            && initialization.claim_id.as_deref() == Some(claim.claim_id.as_str())
            && initialization.plan_id == plan.plan_id
            && initialization.plan_identity_fingerprint == plan.plan_identity_fingerprint
            && initialization.precondition_snapshot_hash == plan.precondition_snapshot_hash
            && initialization.step_count == steps.len() as i64
            && plan.operation_id == attempt.operation_id
            && claim.operation_id == attempt.operation_id
            && claim.claim_owner_token == process_generation;
        if !identity_matches {
            return RuntimeHandleRegistrationResult::HandleOwnershipConflict;
        }
        let Some(resource) = resource_for(
            &attempt.owner_type,
            &attempt.owner_id,
            &attempt.scope_kind,
            attempt.manuscript_channel.as_deref(),
        ) else {
            return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired;
        };
        let runtime_instance_id = Uuid::new_v4().to_string();
        let registration = RuntimeRegistration {
            operation_id: attempt.operation_id.clone(),
            claim_id: claim.claim_id.clone(),
            runtime_instance_id: runtime_instance_id.clone(),
            process_generation: process_generation.to_string(),
            intent: attempt.intent.clone(),
        };
        let (lease, registry_generation) =
            match self
                .inner
                .slots
                .register_runtime_handle(&resource, registration, 0)
            {
                Ok(result) => result,
                Err(()) => return RuntimeHandleRegistrationResult::HandleOwnershipConflict,
            };
        let fresh_claim = match open_read_only(database_path).and_then(|connection| {
            read_active_claim_for_operation(&connection, &attempt.operation_id)
                .map_err(|_| ())
                .and_then(|claim| claim.ok_or(()))
        }) {
            Ok(claim) => claim,
            Err(()) => {
                let _ = self.inner.slots.release(&lease, registry_generation);
                return RuntimeHandleRegistrationResult::ProvisioningRecoveryRequired;
            }
        };
        let proof = match self
            .inner
            .ownership_context
            .create_proof_from_fresh_claim(fresh_claim, registry_generation)
        {
            Ok(proof) => proof,
            Err(_) => {
                let _ = self.inner.slots.release(&lease, registry_generation);
                return RuntimeHandleRegistrationResult::HandleOwnershipConflict;
            }
        };
        if !self.inner.slots.install_claim_ownership_proof(
            &lease,
            registry_generation,
            &runtime_instance_id,
            proof,
        ) {
            let _ = self.inner.slots.release(&lease, registry_generation);
            return RuntimeHandleRegistrationResult::HandleOwnershipConflict;
        }
        RuntimeHandleRegistrationResult::Registered(ProvisioningRuntimeHandle {
            registry: self.inner.slots.clone(),
            ownership_context: self.inner.ownership_context.clone(),
            lease,
            database_path: database_path.to_path_buf(),
            initialization,
            runtime_instance_id,
            registry_generation,
            claim_id: claim.claim_id,
            owner_type: attempt.owner_type,
            owner_id: attempt.owner_id,
            scope_kind: attempt.scope_kind,
            manuscript_channel: attempt.manuscript_channel,
            plan_id: plan.plan_id,
            plan_identity_fingerprint: plan.plan_identity_fingerprint,
            precondition_snapshot_hash: plan.precondition_snapshot_hash,
            step_id: step.step_id.clone(),
            step_ordinal: step.step_ordinal,
            progress_revision: step.progress_revision,
            state: RuntimeState::Live {
                phase: RuntimeLifecyclePhase::Active,
                effect: EffectRisk::NoEffectPossible,
            },
            permit_lifecycle: Arc::new(AtomicU8::new(PERMIT_NEVER_ISSUED)),
            closed: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn runtime_registry_snapshot_optional_for_test(
        &self,
        operation_id: &str,
    ) -> Option<RuntimeRegistrySnapshot> {
        self.inner
            .slots
            .runtime_registry_snapshot_by_operation(operation_id)
    }

    #[cfg(test)]
    pub(crate) fn runtime_registry_snapshot_for_test(
        &self,
        operation_id: &str,
    ) -> RuntimeRegistrySnapshot {
        self.runtime_registry_snapshot_optional_for_test(operation_id)
            .expect("Runtime Registry entry")
    }
}

impl ProvisioningRuntimeHandle {
    fn registry_is(&self, allowed: &[RuntimeRegistryLifecycle]) -> bool {
        self.registry.validate_runtime_handle(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
            allowed,
        )
    }

    pub(crate) fn attach_window(&self, window_id: &str) -> Option<RuntimeWindowSubscription> {
        if window_id.is_empty()
            || !self.registry.attach_window(
                &self.initialization.operation_id,
                window_id,
                &self.lease,
                self.registry_generation,
                &self.runtime_instance_id,
            )
        {
            return None;
        }
        Some(RuntimeWindowSubscription {
            registry: self.registry.clone(),
            lease: self.lease.clone(),
            operation_id: self.initialization.operation_id.clone(),
            window_id: window_id.to_string(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            registry_generation: self.registry_generation,
            detached: false,
        })
    }

    pub(crate) fn record_claim_heartbeat_foundation(&mut self) -> HeartbeatFoundationResult {
        if self.closed
            || !matches!(
                self.state,
                RuntimeState::Live {
                    phase: RuntimeLifecyclePhase::Active,
                    ..
                }
            )
            || !self.registry_is(&[RuntimeRegistryLifecycle::Live])
        {
            return HeartbeatFoundationResult::RegistryProofStale;
        }
        let ownership = match self.registry.claim_ownership_snapshot(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
        ) {
            Some(snapshot) => snapshot,
            None => return HeartbeatFoundationResult::RegistryProofStale,
        };
        let expected_claim_revision = ownership.claim_revision();
        let mut connection = match open_read_write(&self.database_path) {
            Ok(connection) => connection,
            Err(()) => return HeartbeatFoundationResult::RepositoryUnavailable,
        };
        if let Err(error) = record_claim_heartbeat_with_repository_clock(
            &mut connection,
            &self.ownership_context,
            &ownership,
        ) {
            return match error.code {
                PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE => {
                    HeartbeatFoundationResult::ClockAuthorityUnavailable
                }
                PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED => {
                    HeartbeatFoundationResult::KnownNotCommitted
                }
                PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN => {
                    let _ = self.registry.quarantine_and_invalidate_proof(
                        &self.lease,
                        self.registry_generation,
                        &self.runtime_instance_id,
                    );
                    self.state = RuntimeState::CommitOutcomeUnknownQuarantined;
                    HeartbeatFoundationResult::CommitOutcomeUnknown
                }
                PROVISIONING_CLAIM_OWNER_MISMATCH => {
                    let _ = self.registry.quarantine_and_invalidate_proof(
                        &self.lease,
                        self.registry_generation,
                        &self.runtime_instance_id,
                    );
                    HeartbeatFoundationResult::ProcessGenerationMismatch
                }
                PROVISIONING_OPERATION_CAS_CONFLICT => {
                    let _ = self.registry.quarantine_and_invalidate_proof(
                        &self.lease,
                        self.registry_generation,
                        &self.runtime_instance_id,
                    );
                    HeartbeatFoundationResult::ClaimRevisionStale
                }
                PROVISIONING_OPERATION_DATABASE_ERROR => {
                    HeartbeatFoundationResult::RepositoryUnavailable
                }
                _ => HeartbeatFoundationResult::InternalInvariantFailure,
            };
        }
        #[cfg(test)]
        if heartbeat_foundation_fault_is(HeartbeatFoundationFault::PostCommitOutcomeUnknown) {
            let _ = self.registry.quarantine_and_invalidate_proof(
                &self.lease,
                self.registry_generation,
                &self.runtime_instance_id,
            );
            self.state = RuntimeState::CommitOutcomeUnknownQuarantined;
            return HeartbeatFoundationResult::CommitOutcomeUnknown;
        }
        drop(connection);
        let fresh_claim = match open_read_only(&self.database_path).and_then(|connection| {
            read_active_claim_for_operation(&connection, &self.initialization.operation_id)
                .map_err(|_| ())
                .and_then(|claim| claim.ok_or(()))
        }) {
            Ok(claim) => claim,
            Err(()) => {
                let _ = self.registry.quarantine_and_invalidate_proof(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                );
                return HeartbeatFoundationResult::CommitOutcomeUnknown;
            }
        };
        let new_proof = match self
            .ownership_context
            .create_proof_from_fresh_claim(fresh_claim, self.registry_generation)
        {
            Ok(proof) => proof,
            Err(_) => {
                let _ = self.registry.quarantine_and_invalidate_proof(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                );
                return HeartbeatFoundationResult::ClaimOwnerMismatch;
            }
        };
        #[cfg(test)]
        let force_replacement_conflict =
            heartbeat_foundation_fault_is(HeartbeatFoundationFault::RegistryReplacementConflict);
        #[cfg(not(test))]
        let force_replacement_conflict = false;
        if force_replacement_conflict
            || !self.registry.replace_claim_ownership_proof(
                &self.lease,
                self.registry_generation,
                &self.runtime_instance_id,
                expected_claim_revision,
                new_proof,
            )
        {
            let _ = self.registry.quarantine_and_invalidate_proof(
                &self.lease,
                self.registry_generation,
                &self.runtime_instance_id,
            );
            self.state = RuntimeState::CommitOutcomeUnknownQuarantined;
            return HeartbeatFoundationResult::RegistryReplacementConflict;
        }
        HeartbeatFoundationResult::HeartbeatFoundationUpdated
    }

    #[cfg(test)]
    pub(crate) fn record_claim_heartbeat_with_fault_for_test(
        &mut self,
        fault: HeartbeatFoundationFault,
    ) -> HeartbeatFoundationResult {
        HEARTBEAT_FOUNDATION_FAULT.with(|current| current.set(Some(fault)));
        let result = self.record_claim_heartbeat_foundation();
        HEARTBEAT_FOUNDATION_FAULT.with(|current| current.set(None));
        result
    }

    pub(crate) fn issue_execution_permit(&mut self, occurred_at: &str) -> PermitBoundaryResult {
        #[cfg(test)]
        if permit_fault_is(PermitFault::Begin) {
            return PermitBoundaryResult::KnownNotCommitted;
        }
        if self.closed {
            return PermitBoundaryResult::HandleAlreadyClosed;
        }
        if !matches!(
            self.state,
            RuntimeState::Live {
                phase: RuntimeLifecyclePhase::Active,
                ..
            }
        ) {
            return PermitBoundaryResult::HandleStale;
        }
        if !self.registry_is(&[RuntimeRegistryLifecycle::Live]) {
            return PermitBoundaryResult::HandleOwnershipConflict;
        }
        let ownership = match self.registry.claim_ownership_snapshot(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
        ) {
            Some(snapshot) => snapshot,
            None => return PermitBoundaryResult::HandleOwnershipConflict,
        };
        if !is_utc_timestamp(occurred_at) {
            return PermitBoundaryResult::InternalInvariantFailure;
        }
        let mut connection = match open_read_write(&self.database_path) {
            Ok(connection) => connection,
            Err(()) => return PermitBoundaryResult::RepositoryUnavailable,
        };
        #[cfg(test)]
        let _commit_abort_scope = if permit_fault_is(PermitFault::CommitKnownNotCommitted) {
            Some(arm_native_commit_hook_abort(&connection).0)
        } else {
            None
        };
        let transaction = match connection.transaction_with_behavior(TransactionBehavior::Immediate)
        {
            Ok(transaction) => transaction,
            Err(error) => return classify_permit_begin(error),
        };
        #[cfg(test)]
        if permit_fault_is(PermitFault::DurableValidation) {
            return PermitBoundaryResult::DurableAuthorityStale;
        }
        let attempt = match read_operation_attempt(&transaction, &self.initialization.operation_id)
        {
            Ok(Some(attempt)) => attempt,
            _ => return PermitBoundaryResult::RepositoryUnavailable,
        };
        if attempt.operation_status != "active"
            || attempt.revision != self.initialization.attempt_revision
        {
            return PermitBoundaryResult::AttemptRevisionMismatch;
        }
        let claim = match read_active_claim_for_operation(
            &transaction,
            &self.initialization.operation_id,
        ) {
            Ok(Some(claim)) => claim,
            _ => return PermitBoundaryResult::ClaimRevisionMismatch,
        };
        if !claim_matches_snapshot_and_handle(&claim, &ownership, self) {
            return PermitBoundaryResult::ClaimRevisionMismatch;
        }
        let step = match read_current_step(&transaction, self) {
            Ok(step) => step,
            Err(result) => return result,
        };
        match short_revalidate_runtime_boundary(&transaction, &attempt.operation_id) {
            RuntimeDurableRevalidation::Matched => {}
            RuntimeDurableRevalidation::DurableAuthorityStale => {
                return PermitBoundaryResult::DurableAuthorityStale
            }
            RuntimeDurableRevalidation::IdentityConflict => {
                return PermitBoundaryResult::ProvisioningRecoveryRequired
            }
            RuntimeDurableRevalidation::RepositoryUnavailable => {
                return PermitBoundaryResult::RepositoryUnavailable
            }
        }
        if step.boundary.as_str() != "intended"
            || step.effect_outcome.as_str() != "unobserved"
            || step.readback_outcome.as_str() != "not-run"
            || step.progress_revision != self.progress_revision
        {
            return PermitBoundaryResult::StepProgressStale;
        }
        #[cfg(test)]
        if permit_fault_is(PermitFault::StepUpdate) {
            return PermitBoundaryResult::KnownNotCommitted;
        }
        let changed = match transaction.execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='started',effect_outcome='unobserved',readback_outcome='not-run',
                 started_at=?1,progress_revision=progress_revision+1,updated_at=?1
             WHERE operation_id=?2 AND plan_id=?3 AND step_id=?4
               AND progress_revision=?5 AND boundary='intended'
               AND effect_outcome='unobserved' AND readback_outcome='not-run'",
            params![
                occurred_at,
                self.initialization.operation_id,
                self.plan_id,
                self.step_id,
                self.progress_revision
            ],
        ) {
            Ok(changed) => changed,
            Err(_) => return PermitBoundaryResult::RepositoryUnavailable,
        };
        if changed != 1 {
            return PermitBoundaryResult::StepProgressStale;
        }
        let committed_revision = self.progress_revision + 1;
        #[cfg(test)]
        if permit_fault_is(PermitFault::PreCommitReadback) {
            return PermitBoundaryResult::KnownNotCommitted;
        }
        let precommit = read_step_progress_tuple(
            &transaction,
            &self.initialization.operation_id,
            &self.step_id,
        );
        if !matches!(
            precommit,
            Some((ref boundary, ref effect, revision))
                if boundary == "started"
                    && effect == "unobserved"
                    && revision == committed_revision
        ) {
            return PermitBoundaryResult::InternalInvariantFailure;
        }
        if let Err(error) = transaction.commit() {
            return if commit_is_known_not_committed(&error) {
                PermitBoundaryResult::KnownNotCommitted
            } else {
                self.quarantine_after_unknown();
                PermitBoundaryResult::CommitOutcomeUnknownQuarantined
            };
        }
        #[cfg(test)]
        if permit_fault_is(PermitFault::CommitOutcomeUnknown) {
            self.quarantine_after_unknown();
            return PermitBoundaryResult::CommitOutcomeUnknownQuarantined;
        }
        self.permit_lifecycle
            .store(PERMIT_BOUNDARY_COMMITTED, Ordering::SeqCst);
        self.state = RuntimeState::Live {
            phase: RuntimeLifecyclePhase::PermitBoundaryCommitted,
            effect: EffectRisk::NoEffectPossible,
        };
        #[cfg(test)]
        if permit_fault_is(PermitFault::PostCommitReadback) {
            self.quarantine_after_unknown();
            return PermitBoundaryResult::CommitOutcomeUnknownQuarantined;
        }
        let reopened = open_read_only(&self.database_path)
            .ok()
            .and_then(|connection| {
                read_step_progress_tuple(
                    &connection,
                    &self.initialization.operation_id,
                    &self.step_id,
                )
            });
        if !matches!(
            reopened,
            Some((ref boundary, ref effect, revision))
                if boundary == "started"
                    && effect == "unobserved"
                    && revision == committed_revision
        ) {
            self.quarantine_after_unknown();
            return PermitBoundaryResult::CommitOutcomeUnknownQuarantined;
        }
        self.progress_revision = committed_revision;
        #[cfg(test)]
        if permit_fault_is(PermitFault::PermitIssue) {
            return PermitBoundaryResult::ProvisioningRecoveryRequired;
        }
        self.permit_lifecycle.store(PERMIT_ISSUED, Ordering::SeqCst);
        self.state = RuntimeState::Live {
            phase: RuntimeLifecyclePhase::PermitIssued,
            effect: EffectRisk::NoEffectPossible,
        };
        PermitBoundaryResult::Issued(RuntimeExecutionPermit {
            operation_id: self.initialization.operation_id.clone(),
            claim_id: self.claim_id.clone(),
            claim_revision: ownership.claim_revision(),
            plan_id: self.plan_id.clone(),
            plan_identity_fingerprint: self.plan_identity_fingerprint.clone(),
            step_id: self.step_id.clone(),
            progress_revision: self.progress_revision,
            runtime_instance_id: self.runtime_instance_id.clone(),
            registry_generation: self.registry_generation,
            execution_generation: 0,
            lifecycle: self.permit_lifecycle.clone(),
        })
    }

    #[cfg(test)]
    pub(crate) fn issue_execution_permit_with_fault_for_test(
        &mut self,
        occurred_at: &str,
        fault: PermitFault,
    ) -> PermitBoundaryResult {
        PERMIT_FAULT.with(|current| current.set(Some(fault)));
        let result = self.issue_execution_permit(occurred_at);
        PERMIT_FAULT.with(|current| current.set(None));
        result
    }

    fn quarantine_after_unknown(&mut self) {
        let _ = self.registry.transition_runtime_handle(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
            RuntimeRegistryLifecycle::Live,
            RuntimeRegistryLifecycle::Quarantined,
        );
        self.state = RuntimeState::CommitOutcomeUnknownQuarantined;
    }

    pub(crate) fn close_non_completed(
        mut self,
        reason: NonCompletedExitReason,
        occurred_at: &str,
    ) -> NonCompletedExitResult {
        #[cfg(test)]
        if exit_fault_is(ExitFault::BeginExit) {
            return NonCompletedExitResult::HandleOwnershipConflict;
        }
        if self.closed {
            return NonCompletedExitResult::HandleAlreadyClosed;
        }
        if !self.registry.transition_runtime_handle(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
            RuntimeRegistryLifecycle::Live,
            RuntimeRegistryLifecycle::Exiting,
        ) {
            return match self
                .registry
                .runtime_registry_snapshot(&self.lease)
                .map(|snapshot| snapshot.lifecycle)
            {
                Some(RuntimeRegistryLifecycle::Quarantined) => {
                    NonCompletedExitResult::CommitOutcomeUnknownQuarantined
                }
                Some(RuntimeRegistryLifecycle::Retained) => {
                    NonCompletedExitResult::RecoveryRequiredExisting
                }
                Some(RuntimeRegistryLifecycle::DroppedUnclosed) => {
                    NonCompletedExitResult::HandleStale
                }
                _ => NonCompletedExitResult::HandleOwnershipConflict,
            };
        }
        let ownership = match self.registry.claim_ownership_snapshot(
            &self.lease,
            self.registry_generation,
            &self.runtime_instance_id,
        ) {
            Some(snapshot) => snapshot,
            None => {
                let _ = self.registry.quarantine_and_invalidate_proof(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                );
                return NonCompletedExitResult::HandleOwnershipConflict;
            }
        };
        let memory_effect = match self.state {
            RuntimeState::Live { effect, .. } => effect,
            RuntimeState::Exiting { effect, .. } => effect,
            RuntimeState::CommitOutcomeUnknownQuarantined => {
                return NonCompletedExitResult::CommitOutcomeUnknownQuarantined
            }
            RuntimeState::ClosedTerminal | RuntimeState::ClosedRecoveryRetained => {
                return NonCompletedExitResult::HandleAlreadyClosed
            }
            RuntimeState::DroppedUnclosed => return NonCompletedExitResult::HandleStale,
        };
        self.state = RuntimeState::Exiting {
            effect: memory_effect,
            exit_generation: self.registry_generation,
        };
        let result = close_runtime_handle_non_completed_atomically(
            &self.database_path,
            &self,
            &ownership,
            reason,
            occurred_at,
            memory_effect,
        );
        match result {
            NonCompletedExitResult::SafelyTerminalizedAndReleased
            | NonCompletedExitResult::AuthoritativeExistingTerminal => {
                #[cfg(test)]
                if exit_fault_is(ExitFault::RegistryTerminalTransition) {
                    self.closed = true;
                    return NonCompletedExitResult::InternalInvariantFailure;
                }
                if self.registry.remove_terminal_runtime_handle(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                ) {
                    self.state = RuntimeState::ClosedTerminal;
                    self.closed = true;
                    result
                } else {
                    NonCompletedExitResult::InternalInvariantFailure
                }
            }
            NonCompletedExitResult::RecoveryRequiredAndRetained
            | NonCompletedExitResult::RecoveryRequiredExisting => {
                #[cfg(test)]
                if exit_fault_is(ExitFault::RegistryRetainedTransition) {
                    self.closed = true;
                    return NonCompletedExitResult::InternalInvariantFailure;
                }
                if self.registry.transition_runtime_handle(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                    RuntimeRegistryLifecycle::Exiting,
                    RuntimeRegistryLifecycle::Retained,
                ) {
                    self.state = RuntimeState::ClosedRecoveryRetained;
                    self.closed = true;
                    result
                } else {
                    NonCompletedExitResult::InternalInvariantFailure
                }
            }
            NonCompletedExitResult::CommitOutcomeUnknownQuarantined => {
                #[cfg(test)]
                if exit_fault_is(ExitFault::RegistryQuarantinedTransition) {
                    self.closed = true;
                    return NonCompletedExitResult::InternalInvariantFailure;
                }
                let _ = self.registry.transition_runtime_handle(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                    RuntimeRegistryLifecycle::Exiting,
                    RuntimeRegistryLifecycle::Quarantined,
                );
                self.state = RuntimeState::CommitOutcomeUnknownQuarantined;
                self.closed = true;
                result
            }
            _ => {
                let _ = self.registry.transition_runtime_handle(
                    &self.lease,
                    self.registry_generation,
                    &self.runtime_instance_id,
                    RuntimeRegistryLifecycle::Exiting,
                    RuntimeRegistryLifecycle::DroppedUnclosed,
                );
                self.state = RuntimeState::DroppedUnclosed;
                self.closed = true;
                result
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn close_non_completed_with_fault_for_test(
        self,
        reason: NonCompletedExitReason,
        occurred_at: &str,
        fault: ExitFault,
    ) -> NonCompletedExitResult {
        EXIT_FAULT.with(|current| current.set(Some(fault)));
        let result = self.close_non_completed(reason, occurred_at);
        EXIT_FAULT.with(|current| current.set(None));
        result
    }

    #[cfg(test)]
    pub(crate) fn operation_id_for_test(&self) -> &str {
        &self.initialization.operation_id
    }

    #[cfg(test)]
    pub(crate) fn claim_id_for_test(&self) -> &str {
        &self.claim_id
    }

    #[cfg(test)]
    pub(crate) fn initialization_authority_for_test(&self) -> ChainedInitializationAuthority {
        self.initialization.clone()
    }

    #[cfg(test)]
    pub(crate) fn registry_snapshot_for_test(&self) -> RuntimeRegistrySnapshot {
        self.registry
            .runtime_registry_snapshot(&self.lease)
            .expect("Runtime Registry snapshot")
    }
}

fn classify_permit_begin(error: SqliteError) -> PermitBoundaryResult {
    match error {
        SqliteError::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            ) =>
        {
            PermitBoundaryResult::RepositoryBusy
        }
        _ => PermitBoundaryResult::RepositoryUnavailable,
    }
}

fn commit_is_known_not_committed(error: &SqliteError) -> bool {
    matches!(
        error,
        SqliteError::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::DatabaseBusy
                    | ErrorCode::DatabaseLocked
                    | ErrorCode::ConstraintViolation
            )
    )
}

fn claim_matches_snapshot_and_handle(
    claim: &ProvisioningActiveClaim,
    ownership: &ClaimOwnershipSnapshot,
    handle: &ProvisioningRuntimeHandle,
) -> bool {
    ownership.matches_claim(claim)
        && claim.claim_id == handle.claim_id
        && claim.operation_id == handle.initialization.operation_id
        && claim.owner_type == handle.owner_type
        && claim.owner_id == handle.owner_id
        && claim.scope_kind == handle.scope_kind
        && claim.manuscript_channel == handle.manuscript_channel
}

fn read_current_step(
    transaction: &Transaction<'_>,
    handle: &ProvisioningRuntimeHandle,
) -> Result<DurableStepProgressRow, PermitBoundaryResult> {
    let steps = read_attempt_step_progress(transaction, &handle.initialization.operation_id)
        .map_err(|_| PermitBoundaryResult::RepositoryUnavailable)?;
    if steps.len() as i64 != handle.initialization.step_count {
        return Err(PermitBoundaryResult::ProvisioningRecoveryRequired);
    }
    steps
        .into_iter()
        .find(|step| step.step_id == handle.step_id && step.step_ordinal == handle.step_ordinal)
        .ok_or(PermitBoundaryResult::StepProgressStale)
}

fn read_step_progress_tuple(
    connection: &Connection,
    operation_id: &str,
    step_id: &str,
) -> Option<(String, String, i64)> {
    connection
        .query_row(
            "SELECT boundary,effect_outcome,progress_revision
             FROM manuscript_provisioning_step_progress
             WHERE operation_id=?1 AND step_id=?2",
            (operation_id, step_id),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()
        .flatten()
}

fn durable_step_risk(step: &DurableStepProgressRow) -> EffectRisk {
    match (
        step.boundary.as_str(),
        step.effect_outcome.as_str(),
        step.readback_outcome.as_str(),
    ) {
        ("intended", "unobserved", "not-run") => EffectRisk::NoEffectPossible,
        ("started", "no-effect-proven", "verified-absent") => EffectRisk::NoEffectProven,
        ("started", "unobserved", _) => EffectRisk::EffectIndeterminate,
        (_, "reused", _) => EffectRisk::EffectAppliedComplete,
        ("effect-observed" | "readback-verified" | "converged", _, _) => {
            EffectRisk::EffectAppliedComplete
        }
        _ => EffectRisk::EffectIndeterminate,
    }
}

fn permit_risk(handle: &ProvisioningRuntimeHandle) -> EffectRisk {
    match handle.permit_lifecycle.load(Ordering::SeqCst) {
        PERMIT_NEVER_ISSUED => EffectRisk::NoEffectPossible,
        PERMIT_SEALED_NO_EFFECT => EffectRisk::NoEffectProven,
        PERMIT_CONSUMED_OUTCOME => match handle.state {
            RuntimeState::Live { effect, .. } | RuntimeState::Exiting { effect, .. } => effect,
            _ => EffectRisk::EffectIndeterminate,
        },
        PERMIT_BOUNDARY_COMMITTED | PERMIT_ISSUED | PERMIT_INVOCATION_UNKNOWN => {
            EffectRisk::EffectIndeterminate
        }
        _ => EffectRisk::EffectIndeterminate,
    }
}

fn terminal_tuple_for(
    risk: EffectRisk,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
) {
    if matches!(
        risk,
        EffectRisk::NoEffectPossible | EffectRisk::NoEffectProven
    ) {
        ("failed", "terminal-failed", "retryable", "retry", None)
    } else {
        let phase = if matches!(
            risk,
            EffectRisk::EffectAppliedComplete | EffectRisk::EffectAppliedPartial
        ) {
            "partial"
        } else {
            "failed"
        };
        (
            phase,
            "terminal-recovery-required",
            "provisioning-recovery-required",
            "recover",
            Some("physical-only"),
        )
    }
}

fn sync_exit_projection(
    transaction: &Transaction<'_>,
    attempt: &ProvisioningOperationAttempt,
    classification: &str,
    next_action: &str,
    cause: &str,
    occurred_at: &str,
) -> rusqlite::Result<()> {
    if attempt.owner_type != "literature" || attempt.scope_kind != "literature-aggregate" {
        return Ok(());
    }
    let changed = transaction.execute(
        "UPDATE manuscript_provisioning_literature_child_states
         SET revision=revision+1,child_summary_status='terminal-unresolved',
             result_classification=?1,next_action=?2,default_readiness='not-ready',
             final_verification_outcome='not-verified',original_cause_code=?3,updated_at=?4
         WHERE aggregate_operation_id=?5 AND current_operation_id=?5
           AND current_operation_scope_kind='literature-aggregate'
           AND child_summary_status='assigned'",
        params![
            classification,
            next_action,
            cause,
            occurred_at,
            attempt.operation_id
        ],
    )?;
    if changed == 2 {
        Ok(())
    } else {
        Err(SqliteError::QueryReturnedNoRows)
    }
}

fn insert_exit_outbox(
    transaction: &Transaction<'_>,
    operation_id: &str,
    occurred_at: &str,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO manuscript_provisioning_audit_outbox (
           operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
         ) VALUES (?1,'pending',0,0,?2,?2)",
        (operation_id, occurred_at),
    )?;
    Ok(())
}

fn full_exit_readback(
    connection: &Connection,
    handle: &ProvisioningRuntimeHandle,
    ownership: &ClaimOwnershipSnapshot,
    expected_status: &str,
    claim_expected: bool,
) -> bool {
    let attempt = read_operation_attempt(connection, &handle.initialization.operation_id)
        .ok()
        .flatten();
    let claim = read_active_claim_for_operation(connection, &handle.initialization.operation_id)
        .ok()
        .flatten();
    let plan = read_attempt_plan(connection, &handle.initialization.operation_id)
        .ok()
        .flatten();
    let steps = read_attempt_step_progress(connection, &handle.initialization.operation_id).ok();
    let outbox_count = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_audit_outbox
             WHERE operation_id=?1 AND delivery_status='pending'",
            [&handle.initialization.operation_id],
            |row| row.get::<_, i64>(0),
        )
        .ok();
    let projection_ok =
        if handle.owner_type == "literature" && handle.scope_kind == "literature-aggregate" {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
                 WHERE aggregate_operation_id=?1
                   AND current_operation_id=?1
                   AND child_summary_status='terminal-unresolved'",
                    [&handle.initialization.operation_id],
                    |row| row.get::<_, i64>(0),
                )
                .ok()
                == Some(2)
        } else {
            true
        };
    attempt.as_ref().is_some_and(|attempt| {
        attempt.operation_status == expected_status
            && attempt.owner_type == handle.owner_type
            && attempt.owner_id == handle.owner_id
    }) && (claim.is_some() == claim_expected)
        && claim
            .as_ref()
            .is_none_or(|claim| claim_matches_snapshot_and_handle(claim, ownership, handle))
        && plan.as_ref().is_some_and(|plan| {
            plan.plan_id == handle.plan_id
                && plan.plan_identity_fingerprint == handle.plan_identity_fingerprint
                && plan.precondition_snapshot_hash == handle.precondition_snapshot_hash
        })
        && steps
            .as_ref()
            .is_some_and(|steps| steps.len() as i64 == handle.initialization.step_count)
        && outbox_count == Some(1)
        && projection_ok
}

fn classify_existing_exit(
    transaction: &Transaction<'_>,
    handle: &ProvisioningRuntimeHandle,
    ownership: &ClaimOwnershipSnapshot,
    attempt: &ProvisioningOperationAttempt,
) -> Option<NonCompletedExitResult> {
    if !attempt.operation_status.starts_with("terminal-") {
        return None;
    }
    let claim = read_active_claim_for_operation(transaction, &attempt.operation_id)
        .ok()
        .flatten();
    let outbox = transaction
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_audit_outbox WHERE operation_id=?1",
            [&attempt.operation_id],
            |row| row.get::<_, i64>(0),
        )
        .ok();
    if outbox != Some(1) {
        return Some(NonCompletedExitResult::ProvisioningRecoveryRequired);
    }
    if attempt.operation_status == "terminal-recovery-required"
        && claim
            .as_ref()
            .is_some_and(|claim| claim_matches_snapshot_and_handle(claim, ownership, handle))
    {
        Some(NonCompletedExitResult::RecoveryRequiredExisting)
    } else if claim.is_none() {
        Some(NonCompletedExitResult::AuthoritativeExistingTerminal)
    } else {
        Some(NonCompletedExitResult::ProvisioningRecoveryRequired)
    }
}

fn close_runtime_handle_non_completed_atomically(
    database_path: &Path,
    handle: &ProvisioningRuntimeHandle,
    ownership: &ClaimOwnershipSnapshot,
    reason: NonCompletedExitReason,
    occurred_at: &str,
    memory_effect: EffectRisk,
) -> NonCompletedExitResult {
    if !is_utc_timestamp(occurred_at) {
        return NonCompletedExitResult::InternalInvariantFailure;
    }
    let mut connection = match open_read_write(database_path) {
        Ok(connection) => connection,
        Err(()) => return NonCompletedExitResult::RepositoryUnavailable,
    };
    #[cfg(test)]
    let _commit_abort_scope = if exit_fault_is(ExitFault::CommitKnownNotCommitted) {
        Some(arm_native_commit_hook_abort(&connection).0)
    } else {
        None
    };
    let transaction = match connection.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(transaction) => transaction,
        Err(error) => {
            return match classify_permit_begin(error) {
                PermitBoundaryResult::RepositoryBusy => NonCompletedExitResult::RepositoryBusy,
                _ => NonCompletedExitResult::RepositoryUnavailable,
            }
        }
    };
    if !handle.registry_is(&[RuntimeRegistryLifecycle::Exiting]) {
        return NonCompletedExitResult::HandleOwnershipConflict;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::AttemptRead) {
        return NonCompletedExitResult::RepositoryUnavailable;
    }
    let attempt = match read_operation_attempt(&transaction, &handle.initialization.operation_id) {
        Ok(Some(attempt)) => attempt,
        _ => return NonCompletedExitResult::RepositoryUnavailable,
    };
    if let Some(existing) = classify_existing_exit(&transaction, handle, ownership, &attempt) {
        return existing;
    }
    if attempt.operation_status != "active"
        || attempt.revision != handle.initialization.attempt_revision
    {
        return NonCompletedExitResult::AttemptRevisionMismatch;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::ClaimRead) {
        return NonCompletedExitResult::RepositoryUnavailable;
    }
    let claim = match read_active_claim_for_operation(&transaction, &attempt.operation_id) {
        Ok(Some(claim)) => claim,
        _ => return NonCompletedExitResult::ClaimRevisionMismatch,
    };
    if !claim_matches_snapshot_and_handle(&claim, ownership, handle) {
        return NonCompletedExitResult::ClaimRevisionMismatch;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::StepRead) {
        return NonCompletedExitResult::RepositoryUnavailable;
    }
    let steps = match read_attempt_step_progress(&transaction, &attempt.operation_id) {
        Ok(steps) if steps.len() as i64 == handle.initialization.step_count => steps,
        _ => return NonCompletedExitResult::ProvisioningRecoveryRequired,
    };
    let Some(step) = steps.iter().find(|step| step.step_id == handle.step_id) else {
        return NonCompletedExitResult::StepProgressStale;
    };
    if step.progress_revision != handle.progress_revision {
        return NonCompletedExitResult::StepProgressStale;
    }
    match short_revalidate_runtime_boundary(&transaction, &attempt.operation_id) {
        RuntimeDurableRevalidation::Matched => {}
        RuntimeDurableRevalidation::DurableAuthorityStale => {
            return NonCompletedExitResult::DurableAuthorityStale
        }
        RuntimeDurableRevalidation::IdentityConflict => {
            return NonCompletedExitResult::ProvisioningRecoveryRequired
        }
        RuntimeDurableRevalidation::RepositoryUnavailable => {
            return NonCompletedExitResult::RepositoryUnavailable
        }
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::RiskJoin) {
        return NonCompletedExitResult::InternalInvariantFailure;
    }
    let final_risk = memory_effect
        .join(durable_step_risk(step))
        .join(permit_risk(handle));
    let (phase, status, classification, next_action, partial_kind) = terminal_tuple_for(final_risk);
    #[cfg(test)]
    if exit_fault_is(ExitFault::StepUpdate)
        || exit_fault_is(ExitFault::AttemptUpdate)
        || (!matches!(
            final_risk,
            EffectRisk::NoEffectPossible | EffectRisk::NoEffectProven
        ) && exit_fault_is(ExitFault::RecoveryUpdate))
    {
        return NonCompletedExitResult::KnownNotCommitted;
    }
    let changed = match transaction.execute(
        "UPDATE manuscript_provisioning_operation_attempts
         SET phase=?1,operation_status=?2,result_classification=?3,next_action=?4,
             partial_kind=?5,original_cause_code=?6,
             final_verification_outcome=CASE
               WHEN ?2='terminal-recovery-required' THEN 'not-verified'
               ELSE final_verification_outcome END,
             revision=revision+1,updated_at=?7,terminal_at=?7
         WHERE operation_id=?8 AND revision=?9 AND operation_status='active'",
        params![
            phase,
            status,
            classification,
            next_action,
            partial_kind,
            reason.cause_code(),
            occurred_at,
            attempt.operation_id,
            attempt.revision
        ],
    ) {
        Ok(changed) => changed,
        Err(_) => return NonCompletedExitResult::RepositoryUnavailable,
    };
    if changed != 1 {
        return NonCompletedExitResult::AttemptRevisionMismatch;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::ProjectionRead) || exit_fault_is(ExitFault::ProjectionSync) {
        return NonCompletedExitResult::KnownNotCommitted;
    }
    if sync_exit_projection(
        &transaction,
        &attempt,
        classification,
        next_action,
        reason.cause_code(),
        occurred_at,
    )
    .is_err()
    {
        return NonCompletedExitResult::ProvisioningRecoveryRequired;
    }
    let safe = matches!(
        final_risk,
        EffectRisk::NoEffectPossible | EffectRisk::NoEffectProven
    );
    if safe {
        #[cfg(test)]
        if exit_fault_is(ExitFault::ClaimRelease) {
            return NonCompletedExitResult::KnownNotCommitted;
        }
        let deleted = match transaction.execute(
            "DELETE FROM manuscript_provisioning_active_claims
             WHERE claim_id=?1 AND operation_id=?2 AND claim_owner_token=?3
               AND claim_revision=?4",
            params![
                claim.claim_id,
                claim.operation_id,
                claim.claim_owner_token,
                claim.claim_revision
            ],
        ) {
            Ok(deleted) => deleted,
            Err(_) => return NonCompletedExitResult::RepositoryUnavailable,
        };
        if deleted != 1 {
            return NonCompletedExitResult::ClaimRevisionMismatch;
        }
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::OutboxInsert) {
        return NonCompletedExitResult::KnownNotCommitted;
    }
    if insert_exit_outbox(&transaction, &attempt.operation_id, occurred_at).is_err() {
        return NonCompletedExitResult::RepositoryUnavailable;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::PreCommitReadback) {
        return NonCompletedExitResult::KnownNotCommitted;
    }
    if !full_exit_readback(&transaction, handle, ownership, status, !safe) {
        return NonCompletedExitResult::InternalInvariantFailure;
    }
    if let Err(error) = transaction.commit() {
        if commit_is_known_not_committed(&error) {
            return NonCompletedExitResult::KnownNotCommitted;
        }
        drop(connection);
        let _ = open_read_only(database_path)
            .ok()
            .and_then(|connection| read_operation_attempt(&connection, &attempt.operation_id).ok());
        return NonCompletedExitResult::CommitOutcomeUnknownQuarantined;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::CommitOutcomeUnknown) {
        drop(connection);
        let _ = open_read_only(database_path)
            .ok()
            .and_then(|connection| read_operation_attempt(&connection, &attempt.operation_id).ok());
        return NonCompletedExitResult::CommitOutcomeUnknownQuarantined;
    }
    #[cfg(test)]
    if exit_fault_is(ExitFault::PostCommitReadback) {
        return NonCompletedExitResult::CommitOutcomeUnknownQuarantined;
    }
    let reopened = match open_read_only(database_path) {
        Ok(connection) => connection,
        Err(()) => return NonCompletedExitResult::CommitOutcomeUnknownQuarantined,
    };
    if !full_exit_readback(&reopened, handle, ownership, status, !safe) {
        return NonCompletedExitResult::CommitOutcomeUnknownQuarantined;
    }
    if safe {
        NonCompletedExitResult::SafelyTerminalizedAndReleased
    } else {
        NonCompletedExitResult::RecoveryRequiredAndRetained
    }
}
