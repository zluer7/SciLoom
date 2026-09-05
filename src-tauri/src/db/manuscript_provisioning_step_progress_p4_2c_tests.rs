use super::manuscript_provisioning_operation_state::step_progress::{
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
    DurableStepBoundary, DurableStepEffectOutcome, DurableStepKind, DurableStepScope,
    PlanFingerprintProfile, PlanTemplateKind,
};
use super::manuscript_provisioning_operation_state::{
    converge_step, create_attempt_claim_plan_and_steps,
    create_attempt_claim_plan_and_steps_with_fault, dry_run_progress_cleanup,
    execute_progress_cleanup, list_recovery_step_progress, mark_step_started, read_attempt_plan,
    read_attempt_step_progress, read_cleanup_progress_references, read_current_unconverged_steps,
    read_literature_child_projections, read_operation_attempt, read_required_step_summary,
    read_startup_progress_projection, record_claim_heartbeat, record_step_effect_observed,
    record_step_no_effect, record_step_readback_verified, replace_claim_for_recovery,
    sync_literature_terminal_projection, terminalize_attempt_release_claim_and_enqueue_audit,
    AtomicDurableAttemptInput, AtomicInitFault, ClaimCasInput, DurableStepPlanInput,
    DurableStepSkeletonInput, ProgressAuthorityInput, ProgressMutationStatus,
    ProvisioningActiveClaim, RecoveryReplacementInput, TerminalAttemptInput, ACTIVE_CLAIM_CONFLICT,
    ATTEMPT_NOT_ACTIVE, CLAIM_HOLDER_MISMATCH, CLEANUP_PROGRESS_RETAINED,
    PROGRESS_REVISION_CONFLICT, PROGRESS_TRANSITION_INVALID, PROVISIONING_OPERATION_DATABASE_ERROR,
    STRUCTURAL_PROGRESS_CORRUPTION, TERMINAL_PROGRESS_INCOMPLETE,
};
use super::schema;
use crate::provisioning_runtime::feedback::RuntimeSafeErrorCode;
use crate::provisioning_runtime::startup_scanner::scan_sqlite_runtime_candidates;
use rusqlite::Connection;

const T0: &str = "2026-07-24T00:00:00.000Z";
const T1: &str = "2026-07-24T00:00:01.000Z";
const T2: &str = "2026-07-24T00:00:02.000Z";
const T3: &str = "2026-07-24T00:00:03.000Z";
const T4: &str = "2026-07-24T00:00:04.000Z";
const T5: &str = "2026-07-24T00:00:05.000Z";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const HASH_E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn v41() -> Connection {
    let connection = Connection::open_in_memory().expect("open isolated SQLite");
    schema::run_migrations(&connection).expect("install exact v41 schema");
    connection
}

fn durable_input(operation_id: &str, owner_id: &str) -> AtomicDurableAttemptInput {
    AtomicDurableAttemptInput {
        operation_id: operation_id.to_string(),
        claim_id: format!("claim-{operation_id}"),
        claim_owner_token: format!("token-{operation_id}"),
        owner_type: DurablePlanOwnerType::Review,
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
        aggregate_operation_id: None,
        intent: DurablePlanIntent::CreateDefault,
        trigger_kind: "owner-create".to_string(),
        occurred_at: T0.to_string(),
        plan: DurableStepPlanInput {
            plan_id: HASH_A.to_string(),
            plan_version: 1,
            plan_template_kind: PlanTemplateKind::ManagedPrimary,
            plan_identity_fingerprint: HASH_B.to_string(),
            precondition_snapshot_hash: HASH_C.to_string(),
            fingerprint_profile: PlanFingerprintProfile::RestrictedJcsSha256V1,
            canonical_resource_identity_hash: HASH_D.to_string(),
            canonical_placement_identity_hash: HASH_E.to_string(),
            parent_shared_identity_hash: None,
            declared_step_count: 1,
            planner_version: "planner-v1".to_string(),
        },
        steps: vec![DurableStepSkeletonInput {
            step_id: HASH_B.to_string(),
            step_ordinal: 0,
            step_kind: DurableStepKind::EnsureDirectory,
            step_scope: DurableStepScope::Primary,
            step_version: 1,
        }],
    }
}

fn authority(input: &AtomicDurableAttemptInput, revision: i64, at: &str) -> ProgressAuthorityInput {
    ProgressAuthorityInput {
        operation_id: input.operation_id.clone(),
        plan_id: input.plan.plan_id.clone(),
        step_id: input.steps[0].step_id.clone(),
        claim_id: input.claim_id.clone(),
        claim_owner_token: input.claim_owner_token.clone(),
        expected_progress_revision: revision,
        occurred_at: at.to_string(),
    }
}

fn claim_cas(claim: &ProvisioningActiveClaim) -> ClaimCasInput {
    ClaimCasInput {
        claim_id: claim.claim_id.clone(),
        holder_operation_id: claim.operation_id.clone(),
        claim_owner_token: claim.claim_owner_token.clone(),
        expected_claim_revision: claim.claim_revision,
        scope_kind: claim.scope_kind.clone(),
        owner_type: claim.owner_type.clone(),
        owner_id: claim.owner_id.clone(),
        manuscript_channel: claim.manuscript_channel.clone(),
    }
}

fn literature_aggregate_input(operation_id: &str, owner_id: &str) -> AtomicDurableAttemptInput {
    let mut input = durable_input(operation_id, owner_id);
    input.owner_type = DurablePlanOwnerType::Literature;
    input.scope_kind = DurablePlanScopeKind::LiteratureAggregate;
    input.manuscript_channel = None;
    input.plan.plan_template_kind = PlanTemplateKind::LiteratureAggregate;
    input.steps[0].step_scope = DurableStepScope::LiteratureAggregate;
    input
}

fn converge_only_step(connection: &mut Connection, input: &AtomicDurableAttemptInput) {
    mark_step_started(connection, &authority(input, 0, T1)).expect("start");
    record_step_effect_observed(
        connection,
        &authority(input, 1, T2),
        DurableStepEffectOutcome::Created,
        HASH_C,
        Some("resource-1"),
    )
    .expect("observe");
    record_step_readback_verified(connection, &authority(input, 2, T3)).expect("verify");
    converge_step(connection, &authority(input, 3, T4)).expect("converge");
}

#[test]
fn p4_2c_atomic_init_creates_attempt_claim_plan_and_steps_or_nothing() {
    let mut connection = v41();
    let input = durable_input("atomic-success", "review-1");
    let created =
        create_attempt_claim_plan_and_steps(&mut connection, &input).expect("atomic init");
    assert_eq!(created.attempt.operation_status, "active");
    assert_eq!(created.plan.operation_id, input.operation_id);
    assert_eq!(created.steps.len(), 1);
    assert_eq!(created.steps[0].boundary, DurableStepBoundary::Intended);

    for fault in [
        AtomicInitFault::Attempt,
        AtomicInitFault::Claim,
        AtomicInitFault::Plan,
        AtomicInitFault::Step(0),
        AtomicInitFault::LiteratureProjection,
        AtomicInitFault::Readback,
    ] {
        let mut isolated = v41();
        let failed = durable_input("atomic-fault", "review-fault");
        create_attempt_claim_plan_and_steps_with_fault(&mut isolated, &failed, fault)
            .expect_err("fault must roll back");
        for table in [
            "manuscript_provisioning_operation_attempts",
            "manuscript_provisioning_active_claims",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_step_progress",
        ] {
            let count: i64 = isolated
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count rollback table");
            assert_eq!(count, 0, "{table} after {fault:?}");
        }
    }
}

#[test]
fn p4_2c_atomic_init_rejects_identity_structure_and_claim_conflicts() {
    let mut connection = v41();
    let first = durable_input("atomic-first", "review-shared");
    create_attempt_claim_plan_and_steps(&mut connection, &first).expect("first init");

    let mut conflict = durable_input("atomic-second", "review-shared");
    conflict.plan.plan_id = HASH_E.to_string();
    conflict.steps[0].step_id = HASH_D.to_string();
    assert_eq!(
        create_attempt_claim_plan_and_steps(&mut connection, &conflict)
            .expect_err("active owner/channel claim conflict")
            .code,
        ACTIVE_CLAIM_CONFLICT
    );

    let mut malformed = durable_input("atomic-malformed", "review-malformed");
    malformed.plan.declared_step_count = 2;
    assert!(create_attempt_claim_plan_and_steps(&mut connection, &malformed).is_err());
    assert!(read_attempt_plan(&connection, "atomic-malformed")
        .expect("read")
        .is_none());

    let mut duplicate = durable_input("atomic-duplicate", "review-duplicate");
    duplicate.plan.declared_step_count = 2;
    duplicate.steps.push(duplicate.steps[0].clone());
    duplicate.steps[1].step_ordinal = 1;
    assert!(create_attempt_claim_plan_and_steps(&mut connection, &duplicate).is_err());
    assert!(read_attempt_plan(&connection, "atomic-duplicate")
        .expect("read")
        .is_none());

    let mut zero_recovery = durable_input("atomic-zero-recovery", "review-zero-recovery");
    zero_recovery.intent = DurablePlanIntent::Recover;
    zero_recovery.trigger_kind = "explicit-recovery".to_string();
    zero_recovery.plan.plan_id = HASH_D.to_string();
    zero_recovery.plan.declared_step_count = 0;
    zero_recovery.steps.clear();
    let zero = create_attempt_claim_plan_and_steps(&mut connection, &zero_recovery)
        .expect("zero-step recover Plan is explicit and valid");
    assert!(zero.steps.is_empty());
}

#[test]
fn p4_2c_progress_cas_is_narrow_idempotent_and_heartbeat_independent() {
    let mut connection = v41();
    let input = durable_input("cas-chain", "review-cas");
    let created =
        create_attempt_claim_plan_and_steps(&mut connection, &input).expect("atomic init");
    let heartbeat = record_claim_heartbeat(&mut connection, &claim_cas(&created.claim), T1)
        .expect("heartbeat may advance claim revision");
    assert_eq!(heartbeat.claim_revision, 1);

    let started = mark_step_started(&mut connection, &authority(&input, 0, T2)).expect("started");
    assert_eq!(started.step.progress_revision, 1);
    assert_eq!(started.status, ProgressMutationStatus::Applied);
    assert_eq!(
        mark_step_started(&mut connection, &authority(&input, 0, T2))
            .expect("stale exact replay")
            .status,
        ProgressMutationStatus::AlreadyApplied
    );
    assert_eq!(
        mark_step_started(&mut connection, &authority(&input, 0, T3))
            .expect_err("stale revision precedes same-boundary payload conflict")
            .code,
        PROGRESS_REVISION_CONFLICT
    );
    assert_eq!(
        record_step_readback_verified(&mut connection, &authority(&input, 1, T3))
            .expect_err("cannot skip observed boundary")
            .code,
        PROGRESS_TRANSITION_INVALID
    );
    assert_eq!(
        record_step_effect_observed(
            &mut connection,
            &authority(&input, 0, T3),
            DurableStepEffectOutcome::Created,
            HASH_C,
            None,
        )
        .expect_err("stale revision")
        .code,
        PROGRESS_REVISION_CONFLICT
    );
    let mut wrong_holder = authority(&input, 1, T3);
    wrong_holder.claim_owner_token = "wrong-holder".to_string();
    assert_eq!(
        record_step_effect_observed(
            &mut connection,
            &wrong_holder,
            DurableStepEffectOutcome::Created,
            HASH_C,
            None,
        )
        .expect_err("wrong claim holder")
        .code,
        CLAIM_HOLDER_MISMATCH
    );

    converge_only_step_from_started(&mut connection, &input);
    assert!(
        read_current_unconverged_steps(&connection, &input.operation_id)
            .expect("unconverged")
            .is_empty()
    );
    assert_eq!(
        converge_step(&mut connection, &authority(&input, 3, T5))
            .expect("exact stale replay")
            .status,
        ProgressMutationStatus::AlreadyApplied
    );
}

fn converge_only_step_from_started(connection: &mut Connection, input: &AtomicDurableAttemptInput) {
    record_step_effect_observed(
        connection,
        &authority(input, 1, T3),
        DurableStepEffectOutcome::Created,
        HASH_C,
        Some("resource-1"),
    )
    .expect("observe");
    record_step_readback_verified(connection, &authority(input, 2, T4)).expect("verify");
    converge_step(connection, &authority(input, 3, T5)).expect("converge");
}

#[test]
fn p4_2c_no_effect_stays_started_and_blocks_reexecution_in_same_attempt() {
    let mut connection = v41();
    let input = durable_input("no-effect", "review-no-effect");
    create_attempt_claim_plan_and_steps(&mut connection, &input).expect("atomic init");
    mark_step_started(&mut connection, &authority(&input, 0, T1)).expect("start");
    let no_effect =
        record_step_no_effect(&mut connection, &authority(&input, 1, T2)).expect("prove absent");
    assert_eq!(no_effect.step.boundary, DurableStepBoundary::Started);
    assert_eq!(
        no_effect.step.effect_outcome,
        DurableStepEffectOutcome::NoEffectProven
    );
    assert_eq!(
        record_step_effect_observed(
            &mut connection,
            &authority(&input, 2, T3),
            DurableStepEffectOutcome::Created,
            HASH_C,
            None,
        )
        .expect_err("no effect proof prevents same-attempt adapter replay")
        .code,
        PROGRESS_TRANSITION_INVALID
    );
}

#[test]
fn p4_2c_terminal_reads_latest_claim_and_requires_all_steps_converged() {
    let mut connection = v41();
    let input = durable_input("terminal", "review-terminal");
    let created =
        create_attempt_claim_plan_and_steps(&mut connection, &input).expect("atomic init");
    let terminal = TerminalAttemptInput::completed(
        "terminal",
        &input.claim_id,
        &input.claim_owner_token,
        0,
        0,
        T5,
    );
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(&mut connection, &terminal)
            .expect_err("incomplete Progress")
            .code,
        TERMINAL_PROGRESS_INCOMPLETE
    );

    converge_only_step(&mut connection, &input);
    let latest_claim = record_claim_heartbeat(&mut connection, &claim_cas(&created.claim), T5)
        .expect("late heartbeat advances claim revision");
    let result = terminalize_attempt_release_claim_and_enqueue_audit(&mut connection, &terminal)
        .expect("terminal uses latest transaction-local claim revision");
    assert_eq!(result.attempt.operation_status, "terminal-completed");
    assert_eq!(result.outbox.delivery_status, "pending");
    assert!(record_claim_heartbeat(&mut connection, &claim_cas(&latest_claim), T5).is_err());
    assert_eq!(
        mark_step_started(&mut connection, &authority(&input, 4, T5))
            .expect_err("terminal attempt is immutable")
            .code,
        ATTEMPT_NOT_ACTIVE
    );

    let mut structural_connection = v41();
    let structural = durable_input("terminal-structural", "review-terminal-structural");
    create_attempt_claim_plan_and_steps(&mut structural_connection, &structural)
        .expect("structural fixture");
    structural_connection
        .execute(
            "UPDATE manuscript_provisioning_step_plans SET step_count=2
             WHERE operation_id='terminal-structural'",
            [],
        )
        .expect("isolated structural corruption fixture");
    let structural_terminal = TerminalAttemptInput::completed(
        "terminal-structural",
        &structural.claim_id,
        &structural.claim_owner_token,
        0,
        0,
        T5,
    );
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(
            &mut structural_connection,
            &structural_terminal,
        )
        .expect_err("structural corruption blocks terminal")
        .code,
        STRUCTURAL_PROGRESS_CORRUPTION
    );
}

#[test]
fn p4_2c_queries_project_startup_and_cleanup_leaf_first() {
    let mut connection = v41();
    let input = durable_input("cleanup", "review-cleanup");
    create_attempt_claim_plan_and_steps(&mut connection, &input).expect("atomic init");
    let startup =
        read_startup_progress_projection(&connection, "cleanup").expect("startup projection");
    assert_eq!(startup.boundary, Some(DurableStepBoundary::Intended));
    assert_eq!(startup.required_count, 1);
    assert_eq!(
        read_required_step_summary(&connection, "cleanup")
            .expect("summary")
            .converged_count,
        0
    );
    let active_references =
        read_cleanup_progress_references(&connection, "cleanup").expect("cleanup references");
    assert_eq!(active_references.plan_count, 1);
    assert_eq!(active_references.step_count, 1);
    assert_eq!(active_references.unconverged_step_count, 1);
    assert_eq!(active_references.active_claim_count, 1);
    assert_eq!(
        dry_run_progress_cleanup(&connection, "cleanup", "2026-07-25T00:00:00.000Z")
            .expect("dry run")
            .eligible,
        false
    );
    assert_eq!(
        execute_progress_cleanup(&mut connection, "cleanup", "2026-07-25T00:00:00.000Z")
            .expect_err("active durable state retained")
            .code,
        CLEANUP_PROGRESS_RETAINED
    );

    converge_only_step(&mut connection, &input);
    let terminal = TerminalAttemptInput::completed(
        "cleanup",
        &input.claim_id,
        &input.claim_owner_token,
        0,
        0,
        T5,
    );
    terminalize_attempt_release_claim_and_enqueue_audit(&mut connection, &terminal)
        .expect("terminal");
    connection
        .execute(
            "UPDATE manuscript_provisioning_audit_outbox
             SET delivery_status='delivered', operation_log_id='log-cleanup',
                 delivered_at=?2, updated_at=?2
             WHERE operation_id=?1",
            ("cleanup", T5),
        )
        .expect("isolated delivered outbox fixture");
    let decision = dry_run_progress_cleanup(&connection, "cleanup", "2026-07-25T00:00:00.000Z")
        .expect("eligible dry run");
    assert!(decision.eligible, "{:?}", decision.reasons);
    let deleted = execute_progress_cleanup(&mut connection, "cleanup", "2026-07-25T00:00:00.000Z")
        .expect("leaf-first cleanup");
    assert_eq!(deleted.deleted_steps, 1);
    assert_eq!(deleted.deleted_plans, 1);
    assert_eq!(deleted.deleted_outboxes, 1);
    assert_eq!(deleted.deleted_attempts, 1);
    assert!(read_attempt_step_progress(&connection, "cleanup")
        .expect("read deleted")
        .is_empty());
}

fn prepare_literature_recovery(connection: &mut Connection) -> RecoveryReplacementInput {
    let old = literature_aggregate_input("literature-old", "literature-1");
    let created =
        create_attempt_claim_plan_and_steps(connection, &old).expect("aggregate atomic init");
    let observed = super::manuscript_provisioning_operation_state::mark_stale_claim_candidate(
        connection,
        &claim_cas(&created.claim),
        "observer-token",
        "2026-07-24T00:10:00.000Z",
    )
    .expect("mark stale");

    let mut recovery_plan = old.plan.clone();
    recovery_plan.plan_id = HASH_E.to_string();
    recovery_plan.declared_step_count = 1;
    let recovery_steps = vec![DurableStepSkeletonInput {
        step_id: HASH_D.to_string(),
        step_ordinal: 0,
        step_kind: DurableStepKind::EnsureDirectory,
        step_scope: DurableStepScope::LiteratureAggregate,
        step_version: 1,
    }];
    RecoveryReplacementInput {
        snapshot_id: "snapshot-1".to_string(),
        inspected_at: "2026-07-24T00:10:00.000Z".to_string(),
        inspected_owner_type: "literature".to_string(),
        inspected_owner_id: "literature-1".to_string(),
        inspected_manuscript_channel: None,
        observed_old_operation_id: "literature-old".to_string(),
        observed_operation_revision: 0,
        observed_claim_id: "claim-literature-old".to_string(),
        observed_claim_revision: observed.claim_revision,
        old_claim_owner_token: "token-literature-old".to_string(),
        explicit_authorization_id: "authorization-1".to_string(),
        new_operation_id: "literature-recovery".to_string(),
        new_claim_id: "claim-literature-recovery".to_string(),
        new_claim_owner_token: "recovery-token".to_string(),
        durable_plan: Some(recovery_plan),
        durable_steps: recovery_steps,
        occurred_at: "2026-07-24T00:10:01.000Z".to_string(),
    }
}

#[test]
fn p4_2c_recovery_creates_a_new_immutable_plan_and_reassigns_literature_projection() {
    let mut connection = v41();
    let recovery = prepare_literature_recovery(&mut connection);
    let recovered = replace_claim_for_recovery(&mut connection, &recovery)
        .expect("atomic recovery replacement");
    assert_eq!(
        recovered.old_attempt.operation_status,
        "terminal-recovery-required"
    );
    assert_eq!(recovered.new_attempt.intent, "recover");
    assert_eq!(
        read_attempt_plan(&connection, "literature-old")
            .expect("old plan")
            .expect("old plan retained")
            .plan_id,
        HASH_A
    );
    assert_eq!(
        read_attempt_plan(&connection, "literature-recovery")
            .expect("new plan")
            .expect("new plan created")
            .plan_id,
        HASH_E
    );
    let evidence =
        list_recovery_step_progress(&connection, "literature-recovery").expect("recovery evidence");
    assert_eq!(
        evidence.chain,
        vec!["literature-old", "literature-recovery"]
    );
    assert_eq!(evidence.steps.len(), 1);
    let projection =
        read_literature_child_projections(&connection, "literature-old").expect("projection");
    assert_eq!(projection.len(), 2);
    assert!(projection
        .iter()
        .all(|child| child.current_operation_id == "literature-recovery" && child.revision == 1));
}

#[test]
fn p4_2c_startup_scanner_consumes_v41_progress_without_writing() {
    let mut connection = v41();
    let input = durable_input("startup-v41", "review-startup");
    create_attempt_claim_plan_and_steps(&mut connection, &input).expect("atomic init");
    let before = connection.total_changes();
    let intended = scan_sqlite_runtime_candidates(&connection, "startup-token", T1)
        .expect("scan intended Progress");
    assert_eq!(connection.total_changes(), before);
    assert_eq!(intended.len(), 1);
    assert_ne!(
        intended[0].safe_error_code.as_deref(),
        Some("durable-progress-recovery-required")
    );

    mark_step_started(&mut connection, &authority(&input, 0, T2)).expect("start");
    let before_started_scan = connection.total_changes();
    let started = scan_sqlite_runtime_candidates(&connection, "startup-token", T3)
        .expect("scan started Progress");
    assert_eq!(connection.total_changes(), before_started_scan);
    assert_eq!(
        started[0].safe_error_code.as_deref(),
        Some("durable-progress-recovery-required")
    );
    assert_eq!(
        started[0].result_classification.as_deref(),
        Some("provisioning-recovery-required")
    );
}

#[test]
fn p4_2c_runtime_and_scanner_reject_damaged_provisioning_contract_without_writing() {
    let mut recovery_connection = v41();
    let recovery = prepare_literature_recovery(&mut recovery_connection);
    recovery_connection
        .execute_batch("DROP INDEX uq_manuscript_provisioning_step_plan_operation;")
        .expect("damage isolated provisioning contract");
    let recovery_changes_before = recovery_connection.total_changes();
    let error = replace_claim_for_recovery(&mut recovery_connection, &recovery)
        .expect_err("damaged contract must block recovery");
    assert_eq!(error.code, PROVISIONING_OPERATION_DATABASE_ERROR);
    assert_eq!(recovery_connection.total_changes(), recovery_changes_before);
    assert!(
        read_operation_attempt(&recovery_connection, "literature-recovery")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        read_operation_attempt(&recovery_connection, "literature-old")
            .unwrap()
            .unwrap()
            .operation_status,
        "active"
    );

    let scanner_connection = v41();
    scanner_connection
        .execute_batch("DROP INDEX uq_manuscript_provisioning_step_plan_operation;")
        .expect("damage isolated scanner provisioning contract");
    let scanner_changes_before = scanner_connection.total_changes();
    assert_eq!(
        scan_sqlite_runtime_candidates(&scanner_connection, "startup-token", T1),
        Err(RuntimeSafeErrorCode::StartupScanFailed)
    );
    assert_eq!(scanner_connection.total_changes(), scanner_changes_before);
}

#[test]
fn p4_2c_literature_projection_is_a_transactional_derived_summary() {
    let mut connection = v41();
    let aggregate = literature_aggregate_input("projection-aggregate", "literature-projection");
    create_attempt_claim_plan_and_steps(&mut connection, &aggregate).expect("aggregate init");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               aggregate_operation_id, intent, trigger_kind, phase, operation_status,
               revision, folder_effect, manuscript_effect, file_ref_effect, binding_effect,
               final_verification_outcome, facts_schema_version, started_at, updated_at
             ) VALUES (
               'projection-child', 'literature-child', 'literature',
               'literature-projection', 'literature_outline', 'projection-aggregate',
               'retry', 'explicit-retry', 'preflight', 'active', 0,
               'none', 'none', 'none', 'none', 'not-run', 1, ?1, ?1
             )",
            [T1],
        )
        .expect("isolated child Attempt fixture");
    connection
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_id='projection-child',
                 current_operation_scope_kind='literature-child',
                 revision=revision+1, updated_at=?1
             WHERE aggregate_operation_id='projection-aggregate'
               AND manuscript_channel='literature_outline'",
            [T1],
        )
        .expect("mechanically assign child fixture");
    let child = read_operation_attempt(&connection, "projection-child")
        .expect("read child")
        .expect("child exists");
    let terminal = TerminalAttemptInput::completed(
        "projection-child",
        "aggregate-claim",
        "aggregate-token",
        0,
        0,
        T2,
    );
    {
        let transaction = connection.transaction().expect("projection transaction");
        transaction
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET phase='completed', operation_status='terminal-completed',
                     result_classification='completed', next_action='none',
                     final_verification_outcome='passed', revision=revision+1,
                     terminal_at=?2, updated_at=?2
                 WHERE operation_id=?1",
                ("projection-child", T2),
            )
            .expect("terminal child fixture");
        sync_literature_terminal_projection(&transaction, &child, &terminal)
            .expect("sync derived projection");
        transaction.commit().expect("commit derived projection");
    }
    let projection =
        read_literature_child_projections(&connection, "projection-aggregate").expect("projection");
    let outline = projection
        .iter()
        .find(|child| child.manuscript_channel == DurableManuscriptChannel::LiteratureOutline)
        .expect("outline projection");
    assert_eq!(outline.child_summary_status.as_str(), "terminal-completed");
    assert_eq!(outline.default_readiness.as_str(), "ready");
    assert_eq!(outline.revision, 2);

    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               aggregate_operation_id, intent, trigger_kind, phase, operation_status,
               revision, folder_effect, manuscript_effect, file_ref_effect, binding_effect,
               final_verification_outcome, facts_schema_version, started_at, updated_at
             ) VALUES (
               'projection-unassigned', 'literature-child', 'literature',
               'literature-projection', 'dedicated_notes', 'projection-aggregate',
               'retry', 'explicit-retry', 'preflight', 'active', 0,
               'none', 'none', 'none', 'none', 'not-run', 1, ?1, ?1
             )",
            [T1],
        )
        .expect("unassigned child fixture");
    let unassigned = read_operation_attempt(&connection, "projection-unassigned")
        .expect("read child")
        .expect("child exists");
    {
        let transaction = connection.transaction().expect("rollback transaction");
        transaction
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET phase='completed', operation_status='terminal-completed',
                     result_classification='completed', next_action='none',
                     final_verification_outcome='passed', revision=revision+1,
                     terminal_at=?2, updated_at=?2
                 WHERE operation_id=?1",
                ("projection-unassigned", T2),
            )
            .expect("tentative terminal");
        assert!(sync_literature_terminal_projection(&transaction, &unassigned, &terminal).is_err());
    }
    assert_eq!(
        read_operation_attempt(&connection, "projection-unassigned")
            .expect("read rollback")
            .expect("child retained")
            .operation_status,
        "active"
    );
}
