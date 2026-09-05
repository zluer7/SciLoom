use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
    ClaimOwnershipRepositoryContext, FixedRepositoryUtcClock,
};
use crate::db::manuscript_provisioning_operation_state::{
    read_active_claim_for_operation, read_attempt_plan, read_attempt_step_progress,
    read_operation_attempt, ChainedAtomicInitializationResult, ProvisioningActiveClaim,
};
use crate::manuscript_provisioning_contract::{
    DurablePlanOwnerType, DurableStepKind, DurableStepScope,
};
use crate::owner_authority_lease::OwnerAuthorityLeaseRegistry;
use crate::physical_freshness::{
    ExpectedTargetState, PhysicalResourceKind, PhysicalVerificationRequest,
    ValidatedPhysicalCondition,
};
use crate::provisioning_runtime::core::ProvisioningRuntime;
use crate::provisioning_runtime::database_provider::SqliteRuntimeDatabaseProvider;
use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
use crate::provisioning_runtime::lifecycle::{InlineRuntimeTaskSpawner, NoopRuntimeEventSink};
use crate::provisioning_runtime::ownership_supervisor::{
    OwnershipSupervisorTypedResult, RecoveryOwnershipAcquisitionResult,
    ABANDONMENT_CONFIRMATION_INTERVAL_MS,
};
use crate::provisioning_runtime::shared_executor::{
    AdapterContractManifest, AdapterInvocationOutcome, AdapterPlanningFailure,
    AdapterPreMutationFailure, AdapterReadback, ExecutionInvocationContext, SharedExecutionAdapter,
    SharedExecutionResult, SharedExecutorFoundation,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use crate::provisioning_runtime_non_completed_exit_tests::{
    initialized_owner, initialized_review, TempDatabase,
};
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::thread;
use uuid::Uuid;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(crate) fn initialized_claim(
    database: &TempDatabase,
    result: ChainedAtomicInitializationResult,
) -> ProvisioningActiveClaim {
    let authority = match result {
        ChainedAtomicInitializationResult::Initialized(authority)
        | ChainedAtomicInitializationResult::AuthoritativeExisting(authority) => authority,
        other => panic!("fixture must initialize, got {other:?}"),
    };
    read_active_claim_for_operation(&database.open(), &authority.operation_id)
        .expect("read initialized Claim")
        .expect("initialized Claim")
}

fn event_count(
    report: &crate::provisioning_runtime::ownership_supervisor::OwnershipSupervisorTickReport,
    result: OwnershipSupervisorTypedResult,
) -> usize {
    report
        .events
        .iter()
        .filter(|event| event.result == result)
        .count()
}

pub(crate) fn recovery_harness(
    database: &TempDatabase,
    original_heartbeat: i64,
    process_generation_value: &str,
) -> (
    ProvisioningRuntime,
    Arc<FixedMonotonicClock>,
    Arc<OwnerAuthorityLeaseRegistry>,
) {
    let identifier = format!("local.labpod.se1.{}.test", Uuid::new_v4());
    let provider = Arc::new(
        SqliteRuntimeDatabaseProvider::new_isolated(database.path().to_path_buf(), &identifier)
            .expect("isolated provider"),
    );
    let process_generation = Arc::new(ProcessGeneration::fixed_for_test(process_generation_value));
    let context = Arc::new(ClaimOwnershipRepositoryContext::new(
        process_generation.clone(),
        Arc::new(FixedRepositoryUtcClock::new(original_heartbeat + 400_000)),
    ));
    let monotonic = Arc::new(FixedMonotonicClock::new(0));
    let runtime = ProvisioningRuntime::new_production(
        provider,
        context,
        monotonic.clone(),
        Arc::new(RecordingTicker::default()),
        Arc::new(InlineRuntimeTaskSpawner),
        Arc::new(NoopRuntimeEventSink),
    );
    let authority_registry = Arc::new(OwnerAuthorityLeaseRegistry::from_process_generation(
        process_generation,
    ));
    (runtime, monotonic, authority_registry)
}

pub(crate) fn acquire_recovery(
    database: &TempDatabase,
    runtime: &ProvisioningRuntime,
    monotonic: &FixedMonotonicClock,
    original_claim: &ProvisioningActiveClaim,
) -> String {
    let supervisor = runtime
        .retained_ownership_supervisor_for_test()
        .expect("Supervisor");
    let first = supervisor.tick();
    assert_eq!(
        event_count(
            &first,
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated
        ),
        1
    );
    monotonic.advance_ms(ABANDONMENT_CONFIRMATION_INTERVAL_MS);
    let second = supervisor.tick();
    assert_eq!(
        event_count(
            &second,
            OwnershipSupervisorTypedResult::AbandonedEligibleForHandoff
        ),
        1
    );
    assert_eq!(
        supervisor.acquire_recovery_ownership(&original_claim.claim_id),
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted,
        "recovery acquisition for {}:{}",
        original_claim.owner_type,
        original_claim.owner_id
    );
    database
        .open()
        .query_row(
            "SELECT c.claim_id
             FROM manuscript_provisioning_active_claims c
             JOIN manuscript_provisioning_operation_attempts a
               ON a.operation_id=c.operation_id
             WHERE a.previous_operation_id=?1",
            [&original_claim.operation_id],
            |row| row.get(0),
        )
        .expect("Recovery Claim")
}

#[derive(Debug, Clone, Copy)]
enum SyntheticMode {
    Complete,
    AppliedComplete,
    Partial,
    Conflict,
    ReadbackUnavailable,
    VerifiedAbsent,
    PrecheckConflict,
    InvocationInterrupted,
    InvocationOutcomeUnknown,
    LongRunningHeartbeat,
    Panic,
}

struct SyntheticAdapter {
    root: PathBuf,
    target: PathBuf,
    mode: SyntheticMode,
    contract_version: &'static str,
    step_scope: DurableStepScope,
    invocation_count: usize,
    heartbeat_count: usize,
}

impl SyntheticAdapter {
    fn new(database: &TempDatabase, mode: SyntheticMode) -> Self {
        Self {
            root: database
                .path()
                .parent()
                .expect("fixture parent")
                .to_path_buf(),
            target: database.path().to_path_buf(),
            mode,
            contract_version: "synthetic-contract@1",
            step_scope: DurableStepScope::Primary,
            invocation_count: 0,
            heartbeat_count: 0,
        }
    }
}

impl SharedExecutionAdapter for SyntheticAdapter {
    fn manifest(&self) -> AdapterContractManifest {
        let steps = if self.step_scope == DurableStepScope::LiteratureAggregate {
            vec![
                (
                    DurableStepKind::EnsureDirectory,
                    DurableStepScope::LiteratureAggregate,
                ),
                (
                    DurableStepKind::RegisterFolderFileRef,
                    DurableStepScope::LiteratureAggregate,
                ),
            ]
        } else {
            vec![
                (DurableStepKind::EnsureDirectory, self.step_scope),
                (DurableStepKind::EnsureManuscript, self.step_scope),
            ]
        };
        AdapterContractManifest::new(
            "synthetic-se1-only",
            self.contract_version,
            HASH_A.to_string(),
            HASH_B.to_string(),
            steps,
        )
        .expect("synthetic manifest")
    }

    fn validate_plan(
        &self,
        _planning: &crate::provisioning_runtime::ownership_supervisor::
            RecoveryExecutionPlanningFacts,
        _project_id: &str,
    ) -> Result<(), AdapterPlanningFailure> {
        Ok(())
    }

    fn physical_request(
        &self,
        planning: &crate::provisioning_runtime::ownership_supervisor::
            RecoveryExecutionPlanningFacts,
        _step_ordinal: usize,
    ) -> PhysicalVerificationRequest {
        PhysicalVerificationRequest {
            resource_role: "synthetic-existing-resource".to_string(),
            owner_type: planning.owner_type.clone(),
            owner_id: planning.owner_id.clone(),
            channel: planning
                .manuscript_channel
                .clone()
                .unwrap_or_else(|| "aggregate".to_string()),
            scope: planning.scope_kind.clone(),
            managed_root: self.root.clone(),
            requested_path: self.target.clone(),
            expected_kind: PhysicalResourceKind::MarkdownFile,
            expected_target_state: ExpectedTargetState::ExistingExact,
            allow_existing_reuse: true,
        }
    }

    fn pre_mutation_check(
        &mut self,
        _planning: &crate::provisioning_runtime::ownership_supervisor::
            RecoveryExecutionPlanningFacts,
        _step_ordinal: usize,
        condition: ValidatedPhysicalCondition,
    ) -> Result<ValidatedPhysicalCondition, AdapterPreMutationFailure> {
        if matches!(self.mode, SyntheticMode::PrecheckConflict) {
            Err(AdapterPreMutationFailure::Conflict)
        } else {
            Ok(condition)
        }
    }

    fn invoke_once(
        &mut self,
        _step_ordinal: usize,
        invocation: &mut ExecutionInvocationContext<'_>,
        _condition: ValidatedPhysicalCondition,
    ) -> AdapterInvocationOutcome {
        self.invocation_count += 1;
        match self.mode {
            SyntheticMode::InvocationInterrupted => AdapterInvocationOutcome::Interrupted,
            SyntheticMode::InvocationOutcomeUnknown => AdapterInvocationOutcome::OutcomeUnknown,
            SyntheticMode::LongRunningHeartbeat => {
                assert!(invocation.permit().recovery_execution_claim_revision() > 0);
                invocation
                    .renew_claim_heartbeat()
                    .expect("first in-apply heartbeat");
                invocation
                    .renew_claim_heartbeat()
                    .expect("second in-apply heartbeat");
                self.heartbeat_count += 2;
                AdapterInvocationOutcome::Returned {
                    effect: crate::db::manuscript_provisioning_operation_state::
                        ExecutionEffectClassification::Reused,
                    observed_identity_hash: HASH_A.to_string(),
                    resource_record_id: Some("synthetic-resource".to_string()),
                }
            }
            SyntheticMode::Panic => panic!("synthetic invocation panic"),
            _ => AdapterInvocationOutcome::Returned {
                effect: if matches!(self.mode, SyntheticMode::AppliedComplete) {
                    crate::db::manuscript_provisioning_operation_state::
                        ExecutionEffectClassification::Created
                } else {
                    crate::db::manuscript_provisioning_operation_state::
                        ExecutionEffectClassification::Reused
                },
                observed_identity_hash: HASH_A.to_string(),
                resource_record_id: Some("synthetic-resource".to_string()),
            },
        }
    }

    fn bounded_authoritative_readback(
        &mut self,
        _planning: &crate::provisioning_runtime::ownership_supervisor::
            RecoveryExecutionPlanningFacts,
        _step_ordinal: usize,
        _invocation: &AdapterInvocationOutcome,
    ) -> AdapterReadback {
        AdapterReadback {
            classification: match self.mode {
                SyntheticMode::Partial => {
                    crate::db::manuscript_provisioning_operation_state::
                        ExecutionReadbackClassification::VerifiedPartial
                }
                SyntheticMode::Conflict => {
                    crate::db::manuscript_provisioning_operation_state::
                        ExecutionReadbackClassification::Conflict
                }
                SyntheticMode::ReadbackUnavailable
                | SyntheticMode::InvocationInterrupted
                | SyntheticMode::InvocationOutcomeUnknown
                | SyntheticMode::Panic => {
                    crate::db::manuscript_provisioning_operation_state::
                        ExecutionReadbackClassification::Unavailable
                }
                SyntheticMode::VerifiedAbsent => {
                    crate::db::manuscript_provisioning_operation_state::
                        ExecutionReadbackClassification::VerifiedAbsent
                }
                _ => crate::db::manuscript_provisioning_operation_state::
                    ExecutionReadbackClassification::VerifiedComplete,
            },
            observed_identity_hash: Some(HASH_A.to_string()),
            resource_record_id: Some("synthetic-resource".to_string()),
        }
    }
}

fn prepared_executor(
    label: &str,
) -> (
    TempDatabase,
    SharedExecutorFoundation,
    Arc<OwnerAuthorityLeaseRegistry>,
    String,
) {
    let database = TempDatabase::new(label);
    let claim = initialized_claim(&database, initialized_review(&database, label));
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = format!("se1-recovery-process-generation-{label}");
    let (runtime, monotonic, authority_registry) =
        recovery_harness(&database, heartbeat, &generation);
    let recovery_claim_id = acquire_recovery(&database, &runtime, &monotonic, &claim);
    let executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry.clone())
            .expect("production-compiled Shared Executor foundation");
    (database, executor, authority_registry, recovery_claim_id)
}

pub(crate) fn prepared_executor_for_owner(
    label: &str,
    owner_type: crate::manuscript_provisioning_contract::DurablePlanOwnerType,
) -> (
    TempDatabase,
    SharedExecutorFoundation,
    Arc<OwnerAuthorityLeaseRegistry>,
    String,
) {
    let database = TempDatabase::new(label);
    let claim = initialized_claim(&database, initialized_owner(&database, owner_type));
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = format!("se1-owner-process-generation-{label}");
    let (runtime, monotonic, authority_registry) =
        recovery_harness(&database, heartbeat, &generation);
    let recovery_claim_id = acquire_recovery(&database, &runtime, &monotonic, &claim);
    let executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry.clone())
            .expect("owner-neutral Executor");
    (database, executor, authority_registry, recovery_claim_id)
}

#[test]
fn se1_recovery_plan_stays_zero_step_and_successor_binds_manifest() {
    let (database, executor, leases, recovery_claim_id) =
        prepared_executor("se1-successor-binding");
    let adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-successor-binding",
            &adapter,
        )
        .expect("materialize execution");
    let connection = database.open();
    let recovery_step_count: i64 = connection
        .query_row(
            "SELECT p.step_count
             FROM manuscript_provisioning_step_plans p
             JOIN manuscript_provisioning_operation_attempts a
               ON a.operation_id=p.operation_id
             WHERE a.operation_id=?1",
            [handle.recovery_operation_id_for_test()],
            |row| row.get(0),
        )
        .expect("Recovery zero-Step Plan");
    assert_eq!(recovery_step_count, 0);
    let plan = read_attempt_plan(&connection, handle.operation_id_for_test())
        .expect("read executable Plan")
        .expect("executable Plan");
    assert_eq!(plan.step_count, 2);
    assert_eq!(
        plan.planner_version,
        handle.adapter_manifest_hash_for_test()
    );
    assert_eq!(leases.active_lease_count(), 1);
    drop(connection);

    let mut adapter = adapter;
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::Completed
    );
    assert_eq!(adapter.invocation_count, 2);
    assert_eq!(leases.active_lease_count(), 0);
    let connection = database.open();
    let attempt = read_operation_attempt(&connection, handle.operation_id_for_test())
        .expect("read Attempt")
        .expect("Attempt");
    assert_eq!(attempt.operation_status, "terminal-completed");
    assert!(
        read_active_claim_for_operation(&connection, handle.operation_id_for_test())
            .expect("read Claim")
            .is_none()
    );
    let steps = read_attempt_step_progress(&connection, handle.operation_id_for_test())
        .expect("read Steps");
    assert!(steps
        .iter()
        .all(|step| step.boundary.as_str() == "converged"));
}

#[test]
fn se1_partial_readback_retains_claim_and_never_reinvokes() {
    let (database, executor, leases, recovery_claim_id) = prepared_executor("se1-partial");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::Partial);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-partial",
            &adapter,
        )
        .expect("materialize execution");
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::RecoveryRequired
    );
    assert_eq!(adapter.invocation_count, 1);
    assert_eq!(leases.active_lease_count(), 0);
    let connection = database.open();
    let attempt = read_operation_attempt(&connection, handle.operation_id_for_test())
        .expect("read Attempt")
        .expect("Attempt");
    assert_eq!(attempt.operation_status, "terminal-recovery-required");
    assert!(
        read_active_claim_for_operation(&connection, handle.operation_id_for_test())
            .expect("read retained Claim")
            .is_some()
    );
}

#[test]
fn se1_reused_and_applied_complete_are_both_readback_verified() {
    for (label, mode, expected_effect) in [
        ("se1-reused", SyntheticMode::Complete, "reused"),
        (
            "se1-applied-complete",
            SyntheticMode::AppliedComplete,
            "created",
        ),
    ] {
        let (database, executor, _, recovery_claim_id) = prepared_executor(label);
        let mut adapter = SyntheticAdapter::new(&database, mode);
        let mut handle = executor
            .materialize_recovery_execution(
                &recovery_claim_id,
                "project-se1",
                "synthetic-window",
                label,
                &adapter,
            )
            .expect("materialize");
        assert_eq!(
            handle.execute_next_step(&mut adapter),
            SharedExecutionResult::StepConverged
        );
        let steps = read_attempt_step_progress(&database.open(), handle.operation_id_for_test())
            .expect("read Steps");
        assert_eq!(steps[0].effect_outcome.as_str(), expected_effect);
        assert_eq!(steps[0].readback_outcome.as_str(), "verified");
    }
}

#[test]
fn se1_conflict_and_readback_unavailable_are_conservative() {
    for (label, mode, expected_readback) in [
        ("se1-readback-conflict", SyntheticMode::Conflict, "conflict"),
        (
            "se1-readback-unavailable",
            SyntheticMode::ReadbackUnavailable,
            "unavailable",
        ),
    ] {
        let (database, executor, _, recovery_claim_id) = prepared_executor(label);
        let mut adapter = SyntheticAdapter::new(&database, mode);
        let mut handle = executor
            .materialize_recovery_execution(
                &recovery_claim_id,
                "project-se1",
                "synthetic-window",
                label,
                &adapter,
            )
            .expect("materialize");
        assert_eq!(
            handle.execute_next_step(&mut adapter),
            SharedExecutionResult::RecoveryRequired
        );
        let steps = read_attempt_step_progress(&database.open(), handle.operation_id_for_test())
            .expect("read Steps");
        assert_eq!(steps[0].readback_outcome.as_str(), expected_readback);
        assert_eq!(steps[0].effect_outcome.as_str(), "unobserved");
    }
}

#[test]
fn se1_long_running_apply_renews_and_propagates_latest_claim_revision() {
    let (database, executor, _, recovery_claim_id) = prepared_executor("se1-long-heartbeat");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::LongRunningHeartbeat);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-long-heartbeat",
            &adapter,
        )
        .expect("materialize");
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    assert_eq!(adapter.heartbeat_count, 2);
    let claim = read_active_claim_for_operation(&database.open(), handle.operation_id_for_test())
        .expect("read Claim")
        .expect("active execution Claim");
    assert!(claim.claim_revision >= 4);
}

#[test]
fn se1_step_result_response_loss_reconciles_without_adapter_replay() {
    let (database, executor, _, recovery_claim_id) = prepared_executor("se1-result-response-loss");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-result-response-loss",
            &adapter,
        )
        .expect("materialize");
    handle.force_result_response_loss_once_for_test();
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    assert_eq!(adapter.invocation_count, 1);
    let steps = read_attempt_step_progress(&database.open(), handle.operation_id_for_test())
        .expect("read Steps");
    assert_eq!(steps[0].boundary.as_str(), "converged");
    assert_eq!(steps[1].boundary.as_str(), "intended");
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::Completed
    );
    assert_eq!(adapter.invocation_count, 2);
}

#[test]
fn se1_all_nine_owner_families_materialize_isolated_execution_authority() {
    for owner in [
        DurablePlanOwnerType::Experiment,
        DurablePlanOwnerType::ExperimentRun,
        DurablePlanOwnerType::Literature,
        DurablePlanOwnerType::Review,
        DurablePlanOwnerType::ResultItem,
        DurablePlanOwnerType::Finding,
        DurablePlanOwnerType::OutputCandidate,
        DurablePlanOwnerType::OutputGap,
        DurablePlanOwnerType::ResearchOutput,
    ] {
        let label = format!("se1-owner-{}", owner.as_str());
        let (database, executor, _, recovery_claim_id) = prepared_executor_for_owner(&label, owner);
        let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
        if owner == DurablePlanOwnerType::Literature {
            adapter.step_scope = DurableStepScope::LiteratureAggregate;
        }
        let handle = executor
            .materialize_recovery_execution(
                &recovery_claim_id,
                "project-se1",
                "synthetic-window",
                &label,
                &adapter,
            )
            .unwrap_or_else(|error| {
                panic!(
                    "materialize owner-neutral execution for {}: {error:?}",
                    owner.as_str()
                )
            });
        let attempt = read_operation_attempt(&database.open(), handle.operation_id_for_test())
            .expect("read Attempt")
            .expect("Attempt");
        assert_eq!(attempt.owner_type, owner.as_str());
        assert!(
            read_active_claim_for_operation(&database.open(), handle.operation_id_for_test())
                .expect("read Claim")
                .is_some()
        );
    }
}

#[test]
fn se1_precheck_conflict_is_not_invoked_and_is_retained() {
    let (database, executor, _, recovery_claim_id) = prepared_executor("se1-precheck");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::PrecheckConflict);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-precheck",
            &adapter,
        )
        .expect("materialize execution");
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::AdapterPreMutationRejected
    );
    assert_eq!(adapter.invocation_count, 0);
    let connection = database.open();
    let attempt = read_operation_attempt(&connection, handle.operation_id_for_test())
        .expect("read Attempt")
        .expect("Attempt");
    let steps = read_attempt_step_progress(&connection, handle.operation_id_for_test())
        .expect("read Steps");
    assert_eq!(attempt.operation_status, "active");
    assert_eq!(steps[0].boundary.as_str(), "intended");
    assert!(
        read_active_claim_for_operation(&connection, handle.operation_id_for_test())
            .expect("read Claim")
            .is_some()
    );
}

#[test]
fn se1_executor_sealed_not_invoked_plus_fresh_absent_is_no_effect_proven() {
    let (database, executor, _, recovery_claim_id) = prepared_executor("se1-no-effect-proven");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::VerifiedAbsent);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-no-effect-proven",
            &adapter,
        )
        .expect("materialize");
    handle.force_not_invoked_once_for_test();
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::RecoveryRequired
    );
    assert_eq!(adapter.invocation_count, 0);
    let steps = read_attempt_step_progress(&database.open(), handle.operation_id_for_test())
        .expect("read Steps");
    assert_eq!(steps[0].effect_outcome.as_str(), "no-effect-proven");
    assert_eq!(steps[0].readback_outcome.as_str(), "verified-absent");
}

#[test]
fn se1_invocation_unknown_and_panic_close_conservatively() {
    for (label, mode) in [
        ("se1-interrupted", SyntheticMode::InvocationInterrupted),
        ("se1-unknown", SyntheticMode::InvocationOutcomeUnknown),
        ("se1-panic", SyntheticMode::Panic),
    ] {
        let (database, executor, _, recovery_claim_id) = prepared_executor(label);
        let mut adapter = SyntheticAdapter::new(&database, mode);
        let mut handle = executor
            .materialize_recovery_execution(
                &recovery_claim_id,
                "project-se1",
                "synthetic-window",
                label,
                &adapter,
            )
            .expect("materialize execution");
        assert_eq!(
            handle.execute_next_step(&mut adapter),
            SharedExecutionResult::RecoveryRequired
        );
        assert_eq!(adapter.invocation_count, 1);
    }
}

#[test]
fn se1_adapter_manifest_drift_fails_closed_before_invocation() {
    let (database, executor, leases, recovery_claim_id) = prepared_executor("se1-manifest-drift");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-manifest-drift",
            &adapter,
        )
        .expect("materialize execution");
    adapter.contract_version = "synthetic-contract@2";
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::AdapterContractMismatch
    );
    assert_eq!(adapter.invocation_count, 0);
    drop(handle);
    assert_eq!(leases.active_lease_count(), 0);
}

#[test]
fn se1_adapter_manifest_hash_is_deterministic() {
    let database = TempDatabase::new("se1-manifest-hash");
    let first = SyntheticAdapter::new(&database, SyntheticMode::Complete)
        .manifest()
        .canonical_hash();
    let second = SyntheticAdapter::new(&database, SyntheticMode::Complete)
        .manifest()
        .canonical_hash();
    assert_eq!(first, second);
    assert_eq!(first.len(), 64);
    assert!(first
        .as_bytes()
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)));
}

#[test]
fn se1_concurrent_materialization_consumes_exactly_one_recovery_guard() {
    let (database, executor, _, recovery_claim_id) =
        prepared_executor("se1-concurrent-materialize");
    let executor = Arc::new(executor);
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for index in 0..2 {
        let executor = executor.clone();
        let barrier = barrier.clone();
        let recovery_claim_id = recovery_claim_id.clone();
        let path = database.path().to_path_buf();
        workers.push(thread::spawn(move || {
            let fixture_root = path.parent().expect("fixture root").to_path_buf();
            let adapter = SyntheticAdapter {
                root: fixture_root,
                target: path,
                mode: SyntheticMode::Complete,
                contract_version: "synthetic-contract@1",
                step_scope: DurableStepScope::Primary,
                invocation_count: 0,
                heartbeat_count: 0,
            };
            barrier.wait();
            executor
                .materialize_recovery_execution(
                    &recovery_claim_id,
                    "project-se1",
                    &format!("synthetic-window-{index}"),
                    &format!("se1-concurrent-{index}"),
                    &adapter,
                )
                .is_ok()
        }));
    }
    barrier.wait();
    let successes = workers
        .into_iter()
        .map(|worker| worker.join().expect("materialization worker"))
        .filter(|success| *success)
        .count();
    assert_eq!(successes, 1);
    let successor_count: i64 = database
        .open()
        .query_row(
            "SELECT COUNT(*)
             FROM manuscript_provisioning_step_plans
             WHERE step_count=2 AND length(planner_version)=64",
            [],
            |row| row.get(0),
        )
        .expect("count executable successors");
    // The winning Handle is dropped by its worker and the process-local slot
    // is quarantined; the durable successor itself is still unique.
    assert_eq!(successor_count, 1);
}

#[test]
fn se1_planning_lease_stale_blocks_before_adapter_invocation() {
    let (database, executor, leases, recovery_claim_id) = prepared_executor("se1-planning-stale");
    let mut adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-planning-stale",
            &adapter,
        )
        .expect("materialize execution");
    leases.rotate_generation_for_test();
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::PlanningLeaseStale
    );
    assert_eq!(adapter.invocation_count, 0);
}

#[test]
fn se1_restart_unknown_step_is_never_reinvoked() {
    let (database, executor, _, recovery_claim_id) = prepared_executor("se1-restart-unknown");
    let mut first_adapter = SyntheticAdapter::new(&database, SyntheticMode::Partial);
    let mut first_handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-restart-first",
            &first_adapter,
        )
        .expect("materialize first execution");
    assert_eq!(
        first_handle.execute_next_step(&mut first_adapter),
        SharedExecutionResult::RecoveryRequired
    );
    let failed_execution_id = first_handle.operation_id_for_test().to_string();
    let retained_claim = read_active_claim_for_operation(&database.open(), &failed_execution_id)
        .expect("read retained Claim")
        .expect("retained Claim");
    let heartbeat = retained_claim
        .last_heartbeat_at
        .parse::<i64>()
        .expect("heartbeat");
    drop(first_handle);

    let (runtime, monotonic, authority_registry) = recovery_harness(
        &database,
        heartbeat,
        "se1-restart-second-process-generation",
    );
    let second_recovery_claim = acquire_recovery(&database, &runtime, &monotonic, &retained_claim);
    let second_executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry)
            .expect("second executor");
    let second_adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let result = second_executor.materialize_recovery_execution(
        &second_recovery_claim,
        "project-se1",
        "synthetic-window",
        "se1-restart-second",
        &second_adapter,
    );
    assert!(matches!(
        result,
        Err(SharedExecutionResult::RecoveryAuthorityUnavailable)
    ));
    assert_eq!(second_adapter.invocation_count, 0);
}

#[test]
fn se1_restart_resumes_only_the_unfinished_adapter_suffix() {
    let (database, executor, _, recovery_claim_id) = prepared_executor("se1-restart-suffix");
    let mut first_adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let mut first_handle = executor
        .materialize_recovery_execution(
            &recovery_claim_id,
            "project-se1",
            "synthetic-window",
            "se1-restart-suffix-first",
            &first_adapter,
        )
        .expect("materialize first execution");
    assert_eq!(
        first_handle.execute_next_step(&mut first_adapter),
        SharedExecutionResult::StepConverged
    );
    assert_eq!(first_adapter.invocation_count, 1);
    let predecessor_execution_id = first_handle.operation_id_for_test().to_string();
    let retained_claim =
        read_active_claim_for_operation(&database.open(), &predecessor_execution_id)
            .expect("read active execution Claim")
            .expect("execution Claim");
    let heartbeat = retained_claim
        .last_heartbeat_at
        .parse::<i64>()
        .expect("heartbeat");
    drop(first_handle);

    let (runtime, monotonic, authority_registry) =
        recovery_harness(&database, heartbeat, "se1-restart-suffix-second-generation");
    let second_recovery_claim = acquire_recovery(&database, &runtime, &monotonic, &retained_claim);
    let second_executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry)
            .expect("second executor");
    let mut second_adapter = SyntheticAdapter::new(&database, SyntheticMode::Complete);
    let mut second_handle = second_executor
        .materialize_recovery_execution(
            &second_recovery_claim,
            "project-se1",
            "synthetic-window",
            "se1-restart-suffix-second",
            &second_adapter,
        )
        .expect("materialize remaining suffix");
    let resumed_plan = read_attempt_plan(&database.open(), second_handle.operation_id_for_test())
        .expect("read resumed Plan")
        .expect("resumed Plan");
    assert_eq!(resumed_plan.step_count, 1);
    assert_eq!(
        second_handle.execute_next_step(&mut second_adapter),
        SharedExecutionResult::Completed
    );
    assert_eq!(second_adapter.invocation_count, 1);
}
