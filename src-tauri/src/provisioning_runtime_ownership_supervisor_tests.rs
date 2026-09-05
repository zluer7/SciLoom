use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
    ClaimOwnershipRepositoryContext, FixedRepositoryUtcClock,
};
use crate::db::manuscript_provisioning_operation_state::{
    read_active_claim_for_operation, ChainedAtomicInitializationResult, ProvisioningActiveClaim,
};
use crate::manuscript_provisioning_contract::DurablePlanOwnerType;
use crate::provisioning_runtime::core::ProvisioningRuntime;
use crate::provisioning_runtime::database_provider::SqliteRuntimeDatabaseProvider;
use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
use crate::provisioning_runtime::lifecycle::{InlineRuntimeTaskSpawner, NoopRuntimeEventSink};
use crate::provisioning_runtime::non_completed_exit::RuntimeHandleRegistrationResult;
use crate::provisioning_runtime::ownership_supervisor::{
    OwnershipSupervisorTypedResult, RecoveryOwnershipAcquisitionResult, RecoveryTakeoverFault,
    RetainedOwnershipSupervisor, ABANDONMENT_CONFIRMATION_INTERVAL_MS, GRACE_PERIOD_MS,
    HEARTBEAT_INTERVAL_MS, MAX_CONSECUTIVE_RENEW_FAILURES, SCHEDULING_JITTER_BUDGET_MS,
    SQLITE_BUSY_TIMEOUT_MS,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use crate::provisioning_runtime_non_completed_exit_tests::{
    initialized_owner, initialized_review, TempDatabase,
};
use rusqlite::params;
use std::sync::{Arc, Barrier};
use std::thread;
use uuid::Uuid;

const TERMINAL_AT: &str = "2026-07-26T13:02:00Z";

fn harness(
    database: &TempDatabase,
    process_generation: &str,
    repository_epoch_ms: i64,
    monotonic_ms: i64,
) -> (
    Arc<RetainedOwnershipSupervisor>,
    Arc<FixedRepositoryUtcClock>,
    Arc<FixedMonotonicClock>,
) {
    let identifier = format!("local.labpod.p1-03-r2.{}.test", Uuid::new_v4());
    let provider = Arc::new(
        SqliteRuntimeDatabaseProvider::new_isolated(database.path().to_path_buf(), &identifier)
            .expect("create isolated Runtime database provider"),
    );
    let repository_clock = Arc::new(FixedRepositoryUtcClock::new(repository_epoch_ms));
    let context = Arc::new(ClaimOwnershipRepositoryContext::new(
        Arc::new(ProcessGeneration::fixed_for_test(process_generation)),
        repository_clock.clone(),
    ));
    let monotonic_clock = Arc::new(FixedMonotonicClock::new(monotonic_ms));
    let runtime = ProvisioningRuntime::new_production(
        provider,
        context,
        monotonic_clock.clone(),
        Arc::new(RecordingTicker::default()),
        Arc::new(InlineRuntimeTaskSpawner),
        Arc::new(NoopRuntimeEventSink),
    );
    (
        runtime
            .retained_ownership_supervisor_for_test()
            .expect("production-compiled Supervisor"),
        repository_clock,
        monotonic_clock,
    )
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

fn retained_terminal(database: &TempDatabase, operation_id: &str) {
    let connection = database.open();
    connection
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed',
                 operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',
                 next_action='recover',
                 partial_kind='physical-only',
                 original_cause_code='RUNTIME_EFFECT_INDETERMINATE',
                 final_verification_outcome='not-verified',
                 revision=revision+1,
                 updated_at=?1,
                 terminal_at=?1
             WHERE operation_id=?2 AND operation_status='active'",
            params![TERMINAL_AT, operation_id],
        )
        .expect("make recovery-retained Attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
             ) VALUES (?1,'pending',0,0,?2,?2)",
            params![operation_id, TERMINAL_AT],
        )
        .expect("insert recovery outbox");
}

fn initialized_claim(
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

fn make_recovery_partial(database: &TempDatabase, operation_id: &str) {
    let connection = database.open();
    connection
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed',
                 operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',
                 next_action='recover',
                 partial_kind='physical-only',
                 original_cause_code='RUNTIME_EFFECT_INDETERMINATE',
                 final_verification_outcome='not-verified',
                 revision=revision+1,
                 updated_at=?1,
                 terminal_at=?1
             WHERE operation_id=?2 AND operation_status='active'",
            params![TERMINAL_AT, operation_id],
        )
        .expect("make partial recovery Attempt");
}

fn finish_recovery_outbox(database: &TempDatabase, operation_id: &str) {
    let connection = database.open();
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
             ) VALUES (?1,'pending',0,0,?2,?2)",
            params![operation_id, TERMINAL_AT],
        )
        .expect("finish recovery outbox");
}

fn qualify_for_takeover(supervisor: &RetainedOwnershipSupervisor, monotonic: &FixedMonotonicClock) {
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
}

fn assert_recovery_ownership_rows(
    database: &TempDatabase,
    predecessor_operation_id: &str,
    expected_owner_token: &str,
) {
    let connection = database.open();
    assert!(
        read_active_claim_for_operation(&connection, predecessor_operation_id)
            .expect("read predecessor Claim")
            .is_none()
    );
    let (operation_id, claim_id, owner_token, previous_operation_id, intent, trigger): (
        String,
        String,
        String,
        String,
        String,
        String,
    ) = connection
        .query_row(
            "SELECT a.operation_id,c.claim_id,c.claim_owner_token,
                    a.previous_operation_id,a.intent,a.trigger_kind
             FROM manuscript_provisioning_operation_attempts a
             JOIN manuscript_provisioning_active_claims c
               ON c.operation_id=a.operation_id
             WHERE a.previous_operation_id=?1",
            [predecessor_operation_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("read Recovery ownership tuple");
    assert_ne!(operation_id, predecessor_operation_id);
    assert!(!claim_id.is_empty());
    assert_eq!(owner_token, expected_owner_token);
    assert_eq!(previous_operation_id, predecessor_operation_id);
    assert_eq!(intent, "recover");
    assert_eq!(trigger, "explicit-recovery");
    let (plan_intent, step_count): (String, i64) = connection
        .query_row(
            "SELECT intent,step_count FROM manuscript_provisioning_step_plans
             WHERE operation_id=?1",
            [&operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read Recovery ownership Plan");
    assert_eq!(plan_intent, "recover");
    assert_eq!(step_count, 0);
}

#[test]
fn p1_03_r2_time_decision_ledger_is_closed_and_satisfies_lease_margin() {
    assert_eq!(HEARTBEAT_INTERVAL_MS, 30_000);
    assert_eq!(GRACE_PERIOD_MS, 30_000);
    assert_eq!(ABANDONMENT_CONFIRMATION_INTERVAL_MS, 30_000);
    assert_eq!(SQLITE_BUSY_TIMEOUT_MS, 5_000);
    assert_eq!(SCHEDULING_JITTER_BUDGET_MS, 30_000);
    assert_eq!(MAX_CONSECUTIVE_RENEW_FAILURES, 1);
    assert!(
        300_000
            > HEARTBEAT_INTERVAL_MS + SQLITE_BUSY_TIMEOUT_MS as i64 + SCHEDULING_JITTER_BUDGET_MS
    );
    assert_eq!(crate::db::schema::CURRENT_SCHEMA_VERSION, 58);
}

#[test]
fn p1_03_r2_restart_discovers_orphan_and_requires_new_two_stage_confirmation() {
    let database = TempDatabase::new("p1-03-r2-restart");
    let claim = initialized_claim(&database, initialized_review(&database, "p1-03-r2-restart"));
    let heartbeat = claim
        .last_heartbeat_at
        .parse::<i64>()
        .expect("epoch heartbeat");
    let before = claim.clone();

    let (first_process, _, first_monotonic) = harness(
        &database,
        "process-generation-after-restart-a",
        heartbeat + 400_000,
        100,
    );
    let first = first_process.tick();
    assert_eq!(
        event_count(
            &first,
            OwnershipSupervisorTypedResult::OrphanedDurableClaimRegistered
        ),
        1
    );
    assert_eq!(
        event_count(
            &first,
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated
        ),
        1
    );
    assert_eq!(first_process.eligibility_count_for_test(), 0);

    // A new process has an empty Registry and cannot inherit the old process'
    // candidate even when more wall time has passed.
    first_monotonic.advance_ms(ABANDONMENT_CONFIRMATION_INTERVAL_MS);
    let (second_process, _, second_monotonic) = harness(
        &database,
        "process-generation-after-restart-b",
        heartbeat + 900_000,
        0,
    );
    let restart_first = second_process.tick();
    assert_eq!(
        event_count(
            &restart_first,
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated
        ),
        1
    );
    assert_eq!(second_process.eligibility_count_for_test(), 0);
    second_monotonic.advance_ms(ABANDONMENT_CONFIRMATION_INTERVAL_MS);
    let restart_second = second_process.tick();
    assert_eq!(
        event_count(
            &restart_second,
            OwnershipSupervisorTypedResult::AbandonedEligibleForHandoff
        ),
        1
    );
    let eligibility = second_process
        .take_eligibility_for_test(&claim.claim_id)
        .expect("sealed eligibility");
    assert_eq!(eligibility.claim_id_for_test(), claim.claim_id);
    assert_eq!(eligibility.claim_revision_for_test(), claim.claim_revision);

    let connection = database.open();
    let after = read_active_claim_for_operation(&connection, &claim.operation_id)
        .expect("read Claim")
        .expect("Claim retained");
    assert_eq!(after.claim_owner_token, before.claim_owner_token);
    assert_eq!(after.claim_revision, before.claim_revision);
    assert_eq!(after.last_heartbeat_at, before.last_heartbeat_at);
}

#[test]
fn p1_04_cross_process_takeover_commits_durable_recovery_ownership_without_execution() {
    let database = TempDatabase::new("p1-04-cross-process");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-04-cross-process"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let recovery_generation = "process-generation-p1-04-cross";
    let (supervisor, _, monotonic) =
        harness(&database, recovery_generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);

    assert_eq!(
        supervisor.acquire_recovery_ownership(&claim.claim_id),
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
    );
    assert_eq!(supervisor.recovery_guard_count_for_test(), 1);
    assert_recovery_ownership_rows(&database, &claim.operation_id, recovery_generation);
}

#[test]
fn p1_04_same_process_takeover_changes_formal_durable_recovery_identity() {
    let database = TempDatabase::new("p1-04-same-process");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-04-same-process"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let same_generation = claim.claim_owner_token.clone();
    let (supervisor, _, monotonic) = harness(&database, &same_generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);

    assert_eq!(
        supervisor.acquire_recovery_ownership(&claim.claim_id),
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
    );
    assert_recovery_ownership_rows(&database, &claim.operation_id, &same_generation);
}

#[test]
fn p1_04_owner_neutral_takeover_covers_all_nine_owner_families() {
    let owners = [
        DurablePlanOwnerType::Experiment,
        DurablePlanOwnerType::ExperimentRun,
        DurablePlanOwnerType::Literature,
        DurablePlanOwnerType::Review,
        DurablePlanOwnerType::ResultItem,
        DurablePlanOwnerType::Finding,
        DurablePlanOwnerType::OutputCandidate,
        DurablePlanOwnerType::OutputGap,
        DurablePlanOwnerType::ResearchOutput,
    ];
    for owner in owners {
        let database = TempDatabase::new(&format!("p1-04-owner-{}", owner.as_str()));
        let claim = initialized_claim(&database, initialized_owner(&database, owner));
        let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
        let recovery_generation = format!("p1-04-recovery-generation-{}", owner.as_str());
        let (supervisor, _, monotonic) =
            harness(&database, &recovery_generation, heartbeat + 400_000, 0);
        qualify_for_takeover(&supervisor, &monotonic);
        assert_eq!(
            supervisor.acquire_recovery_ownership(&claim.claim_id),
            RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted,
            "owner {}",
            owner.as_str()
        );
        assert_recovery_ownership_rows(&database, &claim.operation_id, &recovery_generation);
    }
}

#[test]
fn p1_04_recovery_retained_predecessor_transfers_without_duplicate_outbox() {
    let database = TempDatabase::new("p1-04-retained");
    let claim = initialized_claim(&database, initialized_review(&database, "p1-04-retained"));
    retained_terminal(&database, &claim.operation_id);
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = "p1-04-retained-new-generation";
    let (supervisor, _, monotonic) = harness(&database, generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);
    assert_eq!(
        supervisor.acquire_recovery_ownership(&claim.claim_id),
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
    );
    let outbox_count: i64 = database
        .open()
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_audit_outbox
             WHERE operation_id=?1",
            [&claim.operation_id],
            |row| row.get(0),
        )
        .expect("count predecessor Outbox");
    assert_eq!(outbox_count, 1);
}

#[test]
fn p1_04_known_not_committed_restores_single_use_eligibility() {
    let database = TempDatabase::new("p1-04-known-not-committed");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-04-known-not-committed"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = "p1-04-known-not-committed-generation";
    let (supervisor, _, monotonic) = harness(&database, generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);
    database
        .open()
        .execute_batch(&format!(
            "CREATE TRIGGER p1_04_abort_transfer
             BEFORE UPDATE ON manuscript_provisioning_operation_attempts
             WHEN OLD.operation_id='{}'
             BEGIN SELECT RAISE(ABORT, 'p1-04 known not committed'); END;",
            claim.operation_id
        ))
        .expect("install rollback trigger");
    assert_eq!(
        supervisor.acquire_recovery_ownership(&claim.claim_id),
        RecoveryOwnershipAcquisitionResult::KnownNotCommitted
    );
    assert_eq!(supervisor.eligibility_count_for_test(), 1);
    assert!(
        read_active_claim_for_operation(&database.open(), &claim.operation_id)
            .expect("read old Claim")
            .is_some()
    );
}

#[test]
fn p1_04_commit_response_loss_reopens_and_attaches_known_committed_transfer() {
    let database = TempDatabase::new("p1-04-response-loss");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-04-response-loss"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = "p1-04-response-loss-generation";
    let (supervisor, _, monotonic) = harness(&database, generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);
    assert_eq!(
        supervisor.acquire_recovery_ownership_with_fault_for_test(
            &claim.claim_id,
            RecoveryTakeoverFault::ResponseLostAfterCommit,
        ),
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
    );
    assert_eq!(supervisor.recovery_guard_count_for_test(), 1);
    assert_recovery_ownership_rows(&database, &claim.operation_id, generation);
}

#[test]
fn p1_04_committed_but_unattached_is_reconstructed_and_closed() {
    let database = TempDatabase::new("p1-04-attachment-repair");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-04-attachment-repair"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = "p1-04-attachment-repair-generation";
    let (supervisor, _, monotonic) = harness(&database, generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);
    assert_eq!(
        supervisor.acquire_recovery_ownership_with_fault_for_test(
            &claim.claim_id,
            RecoveryTakeoverFault::AttachmentFailsOnce,
        ),
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
    );
    assert_eq!(supervisor.recovery_guard_count_for_test(), 1);
}

#[test]
fn p1_04_two_takeover_consumers_produce_exactly_one_recovery_owner() {
    let database = TempDatabase::new("p1-04-concurrent");
    let claim = initialized_claim(&database, initialized_review(&database, "p1-04-concurrent"));
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let generation = "p1-04-concurrent-generation";
    let (supervisor, _, monotonic) = harness(&database, generation, heartbeat + 400_000, 0);
    qualify_for_takeover(&supervisor, &monotonic);
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let supervisor = supervisor.clone();
        let barrier = barrier.clone();
        let claim_id = claim.claim_id.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            supervisor.acquire_recovery_ownership(&claim_id)
        }));
    }
    barrier.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("takeover worker"))
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                **result
                    == RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
            })
            .count(),
        1
    );
    assert_eq!(supervisor.recovery_guard_count_for_test(), 1);
}

#[test]
fn p1_03_r2_fingerprint_mutation_cancels_candidate_and_never_yields_eligibility() {
    let database = TempDatabase::new("p1-03-r2-fingerprint");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-03-r2-fingerprint"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, monotonic) = harness(
        &database,
        "different-process-generation",
        heartbeat + 400_000,
        10,
    );
    assert_eq!(
        event_count(
            &supervisor.tick(),
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated
        ),
        1
    );
    let connection = database.open();
    connection
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET claim_revision=claim_revision+1,last_heartbeat_at=?1
             WHERE claim_id=?2",
            params![(heartbeat + 1).to_string(), claim.claim_id],
        )
        .expect("simulate authoritative heartbeat race");
    drop(connection);
    monotonic.advance_ms(ABANDONMENT_CONFIRMATION_INTERVAL_MS);
    let second = supervisor.tick();
    assert_eq!(
        event_count(
            &second,
            OwnershipSupervisorTypedResult::ExpiredCandidateCancelled
        ),
        1
    );
    assert_eq!(supervisor.eligibility_count_for_test(), 0);
}

#[test]
fn p1_03_r2_current_generation_without_live_handle_is_dropped_not_live() {
    let database = TempDatabase::new("p1-03-r2-dropped");
    let claim = initialized_claim(&database, initialized_review(&database, "p1-03-r2-dropped"));
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, _) = harness(&database, &claim.claim_owner_token, heartbeat + 1, 0);
    let report = supervisor.tick();
    assert_eq!(
        event_count(&report, OwnershipSupervisorTypedResult::OwnershipStillValid),
        1
    );
    assert_eq!(
        event_count(&report, OwnershipSupervisorTypedResult::OwnershipRenewed),
        0
    );
}

#[test]
fn p1_03_r2_live_handle_renews_only_through_registry_checkout() {
    let database = TempDatabase::new("p1-03-r2-live");
    let initialized = initialized_review(&database, "p1-03-r2-live");
    let claim = initialized_claim(&database, initialized.clone());
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let identifier = format!("local.labpod.p1-03-r2.live.{}.test", Uuid::new_v4());
    let provider = Arc::new(
        SqliteRuntimeDatabaseProvider::new_isolated(database.path().to_path_buf(), &identifier)
            .expect("isolated provider"),
    );
    let context = Arc::new(ClaimOwnershipRepositoryContext::new(
        Arc::new(ProcessGeneration::fixed_for_test(&claim.claim_owner_token)),
        Arc::new(FixedRepositoryUtcClock::new(heartbeat + 30_000)),
    ));
    let runtime = ProvisioningRuntime::new_production(
        provider,
        context,
        Arc::new(FixedMonotonicClock::new(30_000)),
        Arc::new(RecordingTicker::default()),
        Arc::new(InlineRuntimeTaskSpawner),
        Arc::new(NoopRuntimeEventSink),
    );
    let _handle = match runtime.register_initialized_runtime_handle(database.path(), initialized) {
        RuntimeHandleRegistrationResult::Registered(handle) => handle,
        other => panic!("register live Handle, got {other:?}"),
    };
    let supervisor = runtime
        .retained_ownership_supervisor_for_test()
        .expect("Supervisor");
    let report = supervisor.tick();
    assert_eq!(
        event_count(&report, OwnershipSupervisorTypedResult::OwnershipRenewed),
        1
    );
    let renewed = read_active_claim_for_operation(&database.open(), &claim.operation_id)
        .expect("read Claim")
        .expect("live Claim");
    assert_eq!(renewed.claim_revision, claim.claim_revision + 1);
}

#[test]
fn p1_03_r2_grace_and_clock_rollback_fail_closed_without_candidate() {
    let grace_database = TempDatabase::new("p1-03-r2-grace");
    let grace_claim = initialized_claim(
        &grace_database,
        initialized_review(&grace_database, "p1-03-r2-grace"),
    );
    let heartbeat = grace_claim
        .last_heartbeat_at
        .parse::<i64>()
        .expect("heartbeat");
    let (grace_supervisor, _, _) = harness(
        &grace_database,
        &grace_claim.claim_owner_token,
        heartbeat + 300_001,
        0,
    );
    let grace = grace_supervisor.tick();
    assert_eq!(
        event_count(&grace, OwnershipSupervisorTypedResult::OwnershipExpiring),
        1
    );
    assert_eq!(
        event_count(
            &grace,
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated
        ),
        0
    );

    let rollback_database = TempDatabase::new("p1-03-r2-rollback");
    let rollback_claim = initialized_claim(
        &rollback_database,
        initialized_review(&rollback_database, "p1-03-r2-rollback"),
    );
    let rollback_heartbeat = rollback_claim
        .last_heartbeat_at
        .parse::<i64>()
        .expect("heartbeat");
    let (rollback_supervisor, _, _) = harness(
        &rollback_database,
        &rollback_claim.claim_owner_token,
        rollback_heartbeat - 1,
        0,
    );
    let rollback = rollback_supervisor.tick();
    assert_eq!(
        event_count(
            &rollback,
            OwnershipSupervisorTypedResult::ClockAuthorityUnavailable
        ),
        1
    );
    assert_eq!(rollback_supervisor.eligibility_count_for_test(), 0);
}

#[test]
fn p1_03_r2_dropped_sentinel_closes_only_after_safe_terminal_authority() {
    let database = TempDatabase::new("p1-03-r2-safe-close");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-03-r2-safe-close"),
    );
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, _) = harness(&database, &claim.claim_owner_token, heartbeat + 1, 0);
    assert_eq!(
        event_count(
            &supervisor.tick(),
            OwnershipSupervisorTypedResult::OwnershipStillValid
        ),
        1
    );
    let mut connection = database.open();
    let transaction = connection.transaction().expect("safe close transaction");
    transaction
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed',operation_status='terminal-failed',
                 result_classification='retryable',next_action='retry',
                 original_cause_code='SAFE_NO_EFFECT',
                 revision=revision+1,updated_at=?1,terminal_at=?1
             WHERE operation_id=?2 AND operation_status='active'",
            params![TERMINAL_AT, claim.operation_id],
        )
        .expect("terminalize Attempt");
    transaction
        .execute(
            "DELETE FROM manuscript_provisioning_active_claims
             WHERE claim_id=?1 AND claim_revision=?2",
            params![claim.claim_id, claim.claim_revision],
        )
        .expect("P1-02 simulated safe Claim close");
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
             ) VALUES (?1,'pending',0,0,?2,?2)",
            params![claim.operation_id, TERMINAL_AT],
        )
        .expect("safe outbox");
    transaction.commit().expect("commit safe terminal set");
    let closed = supervisor.tick();
    assert_eq!(
        event_count(
            &closed,
            OwnershipSupervisorTypedResult::QuarantinedClassifiedSafeClosed
        ),
        1
    );
    assert!(supervisor.tick().events.is_empty());
}

#[test]
fn p1_03_r2_retained_current_owner_renews_with_fresh_proof() {
    let database = TempDatabase::new("p1-03-r2-retained");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-03-r2-retained"),
    );
    retained_terminal(&database, &claim.operation_id);
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, _) = harness(
        &database,
        &claim.claim_owner_token,
        heartbeat + 30_000,
        30_000,
    );
    let report = supervisor.tick();
    assert_eq!(
        event_count(&report, OwnershipSupervisorTypedResult::OwnershipRenewed),
        1
    );
    let connection = database.open();
    let renewed = read_active_claim_for_operation(&connection, &claim.operation_id)
        .expect("read renewed Claim")
        .expect("retained Claim");
    assert_eq!(renewed.claim_revision, claim.claim_revision + 1);
    assert_eq!(renewed.claim_owner_token, claim.claim_owner_token);
}

#[test]
fn p1_03_r2_quarantine_uses_fresh_authoritative_revision_to_rebuild_retained() {
    let database = TempDatabase::new("p1-03-r2-quarantine");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-03-r2-quarantine"),
    );
    make_recovery_partial(&database, &claim.operation_id);
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, _) = harness(&database, &claim.claim_owner_token, heartbeat + 1, 0);
    let first = supervisor.tick();
    assert!(
        event_count(
            &first,
            OwnershipSupervisorTypedResult::PartialInvariantBroken
        ) >= 1
    );
    finish_recovery_outbox(&database, &claim.operation_id);
    let second = supervisor.tick();
    assert_eq!(
        event_count(
            &second,
            OwnershipSupervisorTypedResult::QuarantinedClassifiedRetained
        ),
        1
    );
}

#[test]
fn p1_03_r2_two_ticks_cannot_consume_the_same_retained_proof_twice() {
    let database = TempDatabase::new("p1-03-r2-double-checkout");
    let claim = initialized_claim(
        &database,
        initialized_review(&database, "p1-03-r2-double-checkout"),
    );
    retained_terminal(&database, &claim.operation_id);
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, monotonic) = harness(
        &database,
        &claim.claim_owner_token,
        heartbeat + 30_000,
        30_000,
    );
    assert_eq!(
        event_count(
            &supervisor.tick(),
            OwnershipSupervisorTypedResult::OwnershipRenewed
        ),
        1
    );
    monotonic.advance_ms(HEARTBEAT_INTERVAL_MS);
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let supervisor = supervisor.clone();
        let barrier = barrier.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            supervisor.tick()
        }));
    }
    barrier.wait();
    let reports: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("join Supervisor tick"))
        .collect();
    let renewed: usize = reports
        .iter()
        .map(|report| event_count(report, OwnershipSupervisorTypedResult::OwnershipRenewed))
        .sum();
    assert_eq!(renewed, 1);
    let connection = database.open();
    let after = read_active_claim_for_operation(&connection, &claim.operation_id)
        .expect("read Claim")
        .expect("retained Claim");
    assert_eq!(after.claim_revision, claim.claim_revision + 2);
}

#[test]
fn p1_03_r2_discovery_and_fingerprint_are_owner_neutral_for_all_nine_owners() {
    let owners = [
        DurablePlanOwnerType::Experiment,
        DurablePlanOwnerType::ExperimentRun,
        DurablePlanOwnerType::Literature,
        DurablePlanOwnerType::Review,
        DurablePlanOwnerType::ResultItem,
        DurablePlanOwnerType::Finding,
        DurablePlanOwnerType::OutputCandidate,
        DurablePlanOwnerType::OutputGap,
        DurablePlanOwnerType::ResearchOutput,
    ];
    let mut discovered = 0;
    let mut candidates = 0;
    for owner in owners {
        let database = TempDatabase::new(&format!("p1-03-r2-owner-{}", owner.as_str()));
        let result = initialized_owner(&database, owner);
        let claim = initialized_claim(&database, result);
        let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
        let (supervisor, _, _) =
            harness(&database, "new-process-generation", heartbeat + 400_000, 0);
        let report = supervisor.tick();
        discovered += event_count(
            &report,
            OwnershipSupervisorTypedResult::DurableClaimDiscovered,
        );
        candidates += event_count(
            &report,
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated,
        );
    }
    assert_eq!(discovered, 9);
    assert_eq!(candidates, 9);
}

fn assert_repository_read_fault_fails_closed(
    owner_type: DurablePlanOwnerType,
    faulted_table: &str,
) {
    let database = TempDatabase::new(&format!(
        "p1-03-r2-read-fault-{}-{faulted_table}",
        owner_type.as_str()
    ));
    let claim = initialized_claim(&database, initialized_owner(&database, owner_type));
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (supervisor, _, _) = harness(
        &database,
        "fault-observer-process-generation",
        heartbeat + 400_000,
        0,
    );
    let faulted_name = format!("{faulted_table}_p1_03_r2_fault");
    database
        .open()
        .execute_batch(&format!(
            "ALTER TABLE {faulted_table} RENAME TO {faulted_name};"
        ))
        .expect("inject repository read fault");

    let report = supervisor.tick();

    database
        .open()
        .execute_batch(&format!(
            "ALTER TABLE {faulted_name} RENAME TO {faulted_table};"
        ))
        .expect("restore isolated fixture table");
    let after = read_active_claim_for_operation(&database.open(), &claim.operation_id)
        .expect("read Claim after fault")
        .expect("Claim remains retained");
    assert_eq!(after, claim);
    assert_eq!(supervisor.eligibility_count_for_test(), 0);
    assert_eq!(
        event_count(&report, OwnershipSupervisorTypedResult::OwnershipRenewed),
        0
    );
    assert_eq!(
        event_count(
            &report,
            OwnershipSupervisorTypedResult::ExpiredCandidateCreated
        ),
        0
    );
    assert_eq!(
        event_count(
            &report,
            OwnershipSupervisorTypedResult::AbandonedEligibleForHandoff
        ),
        0
    );
    assert!(
        event_count(
            &report,
            OwnershipSupervisorTypedResult::RepositoryUnavailable
        ) + event_count(
            &report,
            OwnershipSupervisorTypedResult::AuthorityUnavailable
        ) + event_count(
            &report,
            OwnershipSupervisorTypedResult::PartialInvariantBroken
        ) >= 1
    );
}

#[test]
fn p1_03_r2_repository_read_faults_never_mutate_claim_or_create_eligibility() {
    for table in [
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_step_plans",
        "manuscript_provisioning_step_progress",
        "manuscript_provisioning_audit_outbox",
    ] {
        assert_repository_read_fault_fails_closed(DurablePlanOwnerType::Review, table);
    }
    assert_repository_read_fault_fails_closed(
        DurablePlanOwnerType::Literature,
        "manuscript_provisioning_literature_child_states",
    );
}
