use super::manuscript_provisioning_commit_failure_test_support::{
    arm_native_commit_hook_abort, finish_sql_trace, remove_native_commit_hook, start_sql_trace,
    NativeCommitAbortEvidence, SqlTraceEvent,
};
use super::manuscript_provisioning_operation_state::step_progress::{
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
    DurableStepEffectOutcome, DurableStepKind, DurableStepScope, PlanFingerprintProfile,
    PlanTemplateKind,
};
use super::manuscript_provisioning_operation_state::{
    converge_step, create_attempt_claim_plan_and_steps, create_literature_child_durable_attempt,
    dry_run_progress_cleanup, execute_progress_cleanup, list_recovery_step_progress,
    mark_stale_claim_candidate, mark_step_started, read_active_claim_for_operation,
    read_attempt_plan, read_attempt_step_progress, read_literature_child_projections,
    read_operation_attempt, record_claim_heartbeat, record_step_effect_observed,
    record_step_no_effect, record_step_readback_verified, replace_claim_for_recovery,
    terminalize_attempt_release_claim_and_enqueue_audit, terminalize_literature_child_attempt,
    AtomicDurableAttemptInput, ClaimCasInput, DurableStepPlanInput, DurableStepSkeletonInput,
    LiteratureChildDurableAttemptInput, ProgressAuthorityInput, ProgressMutationStatus,
    ProvisioningOperationRepositoryError, RecoveryReplacementInput, TerminalAttemptInput,
    ACTIVE_CLAIM_CONFLICT, ATTEMPT_NOT_ACTIVE, CLAIM_HOLDER_MISMATCH, CLEANUP_PROGRESS_RETAINED,
    LITERATURE_PROJECTION_CONFLICT, MAX_RECOVERY_CHAIN_DEPTH, PROGRESS_PAYLOAD_CONFLICT,
    PROGRESS_REVISION_CONFLICT, PROGRESS_TRANSITION_INVALID, PROVISIONING_OPERATION_CAS_CONFLICT,
    PROVISIONING_OPERATION_DATABASE_ERROR, PROVISIONING_OPERATION_NOT_FOUND,
    PROVISIONING_RECOVERY_PRECONDITION_CHANGED, RECOVERY_EVIDENCE_INVALID,
    STRUCTURAL_PROGRESS_CORRUPTION, TERMINAL_PROGRESS_INCOMPLETE,
};
use super::schema;
use crate::provisioning_runtime::runtime_issue::{normalize_runtime_issues, RuntimeIssueKind};
use crate::provisioning_runtime::schema_capability::{
    check_schema_capability, check_sqlite_schema_capability, SchemaCapability,
    SchemaCapabilityAccess,
};
use crate::provisioning_runtime::startup_scanner::{
    scan_sqlite_audit_candidates, scan_sqlite_runtime_candidates,
};
use rusqlite::{params, Connection, Error, ErrorCode, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt::Debug;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
const HASH_F: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const HASH_G: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn v41() -> Connection {
    let connection = Connection::open_in_memory().expect("open isolated SQLite");
    schema::run_migrations(&connection).expect("install exact v41 schema");
    connection
}

fn aggregate_input(operation_id: &str, owner_id: &str) -> AtomicDurableAttemptInput {
    AtomicDurableAttemptInput {
        operation_id: operation_id.to_string(),
        claim_id: format!("claim-{operation_id}"),
        claim_owner_token: format!("token-{operation_id}"),
        owner_type: DurablePlanOwnerType::Literature,
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::LiteratureAggregate,
        manuscript_channel: None,
        aggregate_operation_id: None,
        intent: DurablePlanIntent::CreateDefault,
        trigger_kind: "owner-create".to_string(),
        occurred_at: T0.to_string(),
        plan: DurableStepPlanInput {
            plan_id: HASH_A.to_string(),
            plan_version: 1,
            plan_template_kind: PlanTemplateKind::LiteratureAggregate,
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
            step_scope: DurableStepScope::LiteratureAggregate,
            step_version: 1,
        }],
    }
}

fn review_input(operation_id: &str, owner_id: &str) -> AtomicDurableAttemptInput {
    let mut input = aggregate_input(operation_id, owner_id);
    input.owner_type = DurablePlanOwnerType::Review;
    input.scope_kind = DurablePlanScopeKind::Channel;
    input.manuscript_channel = Some(DurableManuscriptChannel::Primary);
    input.plan.plan_template_kind = PlanTemplateKind::ManagedPrimary;
    input.steps[0].step_scope = DurableStepScope::Primary;
    input
}

fn child_input(
    aggregate: &AtomicDurableAttemptInput,
    operation_id: &str,
    channel: DurableManuscriptChannel,
    projection_revision: i64,
    claim_revision: i64,
) -> LiteratureChildDurableAttemptInput {
    LiteratureChildDurableAttemptInput {
        operation_id: operation_id.to_string(),
        aggregate_operation_id: aggregate.operation_id.clone(),
        aggregate_claim_id: aggregate.claim_id.clone(),
        aggregate_claim_owner_token: aggregate.claim_owner_token.clone(),
        expected_aggregate_claim_revision: claim_revision,
        owner_id: aggregate.owner_id.clone(),
        manuscript_channel: channel,
        intent: DurablePlanIntent::Retry,
        trigger_kind: "explicit-retry".to_string(),
        occurred_at: T1.to_string(),
        expected_projection_revision: projection_revision,
        expected_current_operation_id: aggregate.operation_id.clone(),
        expected_current_operation_scope_kind: DurablePlanScopeKind::LiteratureAggregate,
        plan: DurableStepPlanInput {
            plan_id: HASH_C.to_string(),
            plan_version: 1,
            plan_template_kind: PlanTemplateKind::LiteratureChannel,
            plan_identity_fingerprint: HASH_D.to_string(),
            precondition_snapshot_hash: HASH_E.to_string(),
            fingerprint_profile: PlanFingerprintProfile::RestrictedJcsSha256V1,
            canonical_resource_identity_hash: HASH_A.to_string(),
            canonical_placement_identity_hash: HASH_B.to_string(),
            parent_shared_identity_hash: Some(HASH_C.to_string()),
            declared_step_count: 1,
            planner_version: "planner-v1".to_string(),
        },
        steps: vec![DurableStepSkeletonInput {
            step_id: HASH_E.to_string(),
            step_ordinal: 0,
            step_kind: DurableStepKind::EnsureManuscript,
            step_scope: match channel {
                DurableManuscriptChannel::LiteratureOutline => DurableStepScope::LiteratureOutline,
                DurableManuscriptChannel::DedicatedNotes => DurableStepScope::DedicatedNotes,
                DurableManuscriptChannel::Primary => panic!("invalid Literature child channel"),
            },
            step_version: 1,
        }],
    }
}

fn child_authority(
    aggregate: &AtomicDurableAttemptInput,
    child: &LiteratureChildDurableAttemptInput,
    revision: i64,
    occurred_at: &str,
) -> ProgressAuthorityInput {
    ProgressAuthorityInput {
        operation_id: child.operation_id.clone(),
        plan_id: child.plan.plan_id.clone(),
        step_id: child.steps[0].step_id.clone(),
        claim_id: aggregate.claim_id.clone(),
        claim_owner_token: aggregate.claim_owner_token.clone(),
        expected_progress_revision: revision,
        occurred_at: occurred_at.to_string(),
    }
}

fn converge_child(
    connection: &mut Connection,
    aggregate: &AtomicDurableAttemptInput,
    child: &LiteratureChildDurableAttemptInput,
) {
    mark_step_started(connection, &child_authority(aggregate, child, 0, T2)).expect("start");
    record_step_effect_observed(
        connection,
        &child_authority(aggregate, child, 1, T3),
        DurableStepEffectOutcome::Created,
        HASH_A,
        Some("literature-resource"),
    )
    .expect("observe");
    record_step_readback_verified(connection, &child_authority(aggregate, child, 2, T4))
        .expect("verify");
    converge_step(connection, &child_authority(aggregate, child, 3, T5)).expect("converge");
}

#[test]
fn p4_2e_literature_child_has_v41_plan_steps_and_only_aggregate_claim() {
    let mut connection = v41();
    let aggregate = aggregate_input("aggregate-e1", "literature-e1");
    create_attempt_claim_plan_and_steps(&mut connection, &aggregate).expect("aggregate");
    let child = child_input(
        &aggregate,
        "outline-e1",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    let created =
        create_literature_child_durable_attempt(&mut connection, &child).expect("child init");

    assert_eq!(created.plan.operation_id, child.operation_id);
    assert_eq!(created.steps.len(), 1);
    assert!(read_attempt_plan(&connection, &child.operation_id)
        .expect("read Plan")
        .is_some());
    assert_eq!(
        read_attempt_step_progress(&connection, &child.operation_id)
            .expect("read Steps")
            .len(),
        1
    );
    assert!(
        read_active_claim_for_operation(&connection, &child.operation_id)
            .expect("read direct claim")
            .is_none()
    );
    assert_eq!(
        read_active_claim_for_operation(&connection, &aggregate.operation_id)
            .expect("read aggregate claim")
            .expect("aggregate claim")
            .claim_revision,
        1
    );
    let projections = read_literature_child_projections(&connection, &aggregate.operation_id)
        .expect("projection");
    let outline = projections
        .iter()
        .find(|row| row.manuscript_channel == DurableManuscriptChannel::LiteratureOutline)
        .expect("outline");
    assert_eq!(outline.current_operation_id, child.operation_id);
    assert_eq!(
        outline.current_operation_scope_kind.as_str(),
        "literature-child"
    );
}

#[test]
fn p4_2e_r2_a_literature_claim_uniqueness_and_sibling_scope_use_exact_v41_authority() {
    let mut connection = v41();
    let aggregate = aggregate_input("aggregate-r2-a", "literature-r2-a");
    create_attempt_claim_plan_and_steps(&mut connection, &aggregate).expect("aggregate");

    let mut conflicting = aggregate_input("aggregate-r2-a-conflict", "literature-r2-a");
    conflicting.plan.plan_id = HASH_E.to_string();
    conflicting.steps[0].step_id = HASH_D.to_string();
    assert_eq!(
        create_attempt_claim_plan_and_steps(&mut connection, &conflicting)
            .expect_err("one owner has one aggregate Claim authority")
            .code,
        super::manuscript_provisioning_operation_state::ACTIVE_CLAIM_CONFLICT
    );

    let outline = child_input(
        &aggregate,
        "outline-r2-a",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    create_literature_child_durable_attempt(&mut connection, &outline).expect("outline child");

    let projections = read_literature_child_projections(&connection, &aggregate.operation_id)
        .expect("projections after outline");
    let notes_projection = projections
        .iter()
        .find(|row| row.manuscript_channel == DurableManuscriptChannel::DedicatedNotes)
        .expect("notes sibling");
    assert_eq!(
        notes_projection.current_operation_id, aggregate.operation_id,
        "outline mutation cannot steal the notes sibling scope"
    );
    assert_eq!(
        notes_projection.current_operation_scope_kind.as_str(),
        "literature-aggregate"
    );

    let mut notes = child_input(
        &aggregate,
        "notes-r2-a",
        DurableManuscriptChannel::DedicatedNotes,
        notes_projection.revision,
        1,
    );
    notes.plan.plan_id = HASH_F.to_string();
    notes.steps[0].step_id = HASH_G.to_string();
    create_literature_child_durable_attempt(&mut connection, &notes).expect("notes child");
    assert!(
        read_active_claim_for_operation(&connection, &outline.operation_id)
            .expect("outline direct Claim")
            .is_none()
    );
    assert!(
        read_active_claim_for_operation(&connection, &notes.operation_id)
            .expect("notes direct Claim")
            .is_none()
    );
    assert_eq!(
        read_active_claim_for_operation(&connection, &aggregate.operation_id)
            .expect("aggregate Claim")
            .expect("aggregate Claim remains unique")
            .claim_revision,
        2
    );
}

#[test]
fn p4_2e_literature_child_terminal_and_projection_are_one_v41_transaction() {
    let mut connection = v41();
    let aggregate = aggregate_input("aggregate-terminal-e1", "literature-terminal-e1");
    create_attempt_claim_plan_and_steps(&mut connection, &aggregate).expect("aggregate");
    let child = child_input(
        &aggregate,
        "outline-terminal-e1",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    create_literature_child_durable_attempt(&mut connection, &child).expect("child");
    converge_child(&mut connection, &aggregate, &child);
    let terminal = TerminalAttemptInput::completed(
        &child.operation_id,
        &aggregate.claim_id,
        &aggregate.claim_owner_token,
        0,
        1,
        "2026-07-24T00:00:06.000Z",
    );
    let result =
        terminalize_literature_child_attempt(&mut connection, &terminal).expect("terminal child");

    assert_eq!(result.child.operation_status, "terminal-completed");
    assert_eq!(
        result.projection.child_summary_status.as_str(),
        "terminal-completed"
    );
    assert_eq!(result.projection.current_operation_id, child.operation_id);
    assert!(result.aggregate_claim.is_some());
    assert!(result.aggregate_outbox.is_none());
}

#[test]
fn p4_2e_progress_cas_uses_frozen_conflict_priority() {
    let mut connection = v41();
    let input = aggregate_input("cas-priority-e2", "literature-cas-e2");
    create_attempt_claim_plan_and_steps(&mut connection, &input).expect("init");
    let authority = |revision: i64, occurred_at: &str| ProgressAuthorityInput {
        operation_id: input.operation_id.clone(),
        plan_id: input.plan.plan_id.clone(),
        step_id: input.steps[0].step_id.clone(),
        claim_id: input.claim_id.clone(),
        claim_owner_token: input.claim_owner_token.clone(),
        expected_progress_revision: revision,
        occurred_at: occurred_at.to_string(),
    };

    let first = mark_step_started(&mut connection, &authority(0, T1)).expect("first start");
    assert_eq!(first.status, ProgressMutationStatus::Applied);

    let exact_replay =
        mark_step_started(&mut connection, &authority(0, T1)).expect("exact stale replay");
    assert_eq!(exact_replay.status, ProgressMutationStatus::AlreadyApplied);

    let stale_different = mark_step_started(&mut connection, &authority(0, T2))
        .expect_err("revision must win over payload");
    assert_eq!(stale_different.code, PROGRESS_REVISION_CONFLICT);

    let current_different = mark_step_started(&mut connection, &authority(1, T2))
        .expect_err("current revision exposes payload conflict");
    assert_eq!(current_different.code, PROGRESS_PAYLOAD_CONFLICT);
}

fn insert_recovery_chain(connection: &Connection, depth: usize, prefix: &str) -> String {
    assert!(depth > 0);
    let root = format!("{prefix}-0");
    for index in 0..depth {
        let operation_id = format!("{prefix}-{index}");
        let previous = (index > 0).then(|| format!("{prefix}-{}", index - 1));
        let root_id = (index > 0).then(|| root.clone());
        let active = index + 1 == depth;
        connection
            .execute(
                "INSERT INTO manuscript_provisioning_operation_attempts (
                   operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
                   intent, trigger_kind, phase, operation_status,
                   result_classification, next_action, partial_kind, revision,
                   previous_operation_id, root_operation_id,
                   folder_effect, manuscript_effect, file_ref_effect, binding_effect,
                   final_verification_outcome, facts_schema_version,
                   started_at, updated_at, terminal_at
                 ) VALUES (
                   ?1, 'channel', 'review', ?2, 'primary',
                   ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11,
                   'none', 'none', 'none', 'none', ?12, 1, ?13, ?13, ?14
                 )",
                params![
                    operation_id,
                    format!("owner-{prefix}"),
                    if index == 0 {
                        "create-default"
                    } else {
                        "recover"
                    },
                    if index == 0 {
                        "owner-create"
                    } else {
                        "explicit-recovery"
                    },
                    if active { "preflight" } else { "failed" },
                    if active {
                        "active"
                    } else {
                        "terminal-recovery-required"
                    },
                    if active {
                        None::<&str>
                    } else {
                        Some("provisioning-recovery-required")
                    },
                    if active {
                        None::<&str>
                    } else {
                        Some("recover")
                    },
                    if active {
                        None::<&str>
                    } else {
                        Some("physical-only")
                    },
                    previous,
                    root_id,
                    if active { "not-run" } else { "not-passed" },
                    T0,
                    if active { None::<&str> } else { Some(T0) },
                ],
            )
            .expect("insert chain Attempt");
        let plan_id = format!("{:064x}", index + 1000);
        let step_id = format!("{:064x}", index + 2000);
        connection
            .execute(
                "INSERT INTO manuscript_provisioning_step_plans (
                   plan_id, operation_id, plan_version, plan_template_kind,
                   plan_identity_fingerprint, precondition_snapshot_hash,
                   fingerprint_profile, owner_type, owner_id, scope_kind,
                   manuscript_channel, intent, canonical_resource_identity_hash,
                   canonical_placement_identity_hash, step_count, planner_version, created_at
                 ) VALUES (
                   ?1, ?2, 1, 'managed-primary', ?3, ?4,
                   'restricted-jcs-sha256-v1', 'review', ?5, 'channel',
                   'primary', ?6, ?7, ?8, 1, 'planner-v1', ?9
                 )",
                params![
                    plan_id,
                    operation_id,
                    HASH_A,
                    HASH_B,
                    format!("owner-{prefix}"),
                    if index == 0 {
                        "create-default"
                    } else {
                        "recover"
                    },
                    HASH_C,
                    HASH_D,
                    T0,
                ],
            )
            .expect("insert chain Plan");
        connection
            .execute(
                "INSERT INTO manuscript_provisioning_step_progress (
                   step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
                   step_version, is_required, boundary, effect_outcome, readback_outcome,
                   effect_facts_schema_version, progress_revision, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, 0, 'ensure-directory', 'primary',
                   1, 1, 'intended', 'unobserved', 'not-run', 1, 0, ?4, ?4
                 )",
                params![step_id, plan_id, operation_id, T0],
            )
            .expect("insert chain Step");
    }
    format!("{prefix}-{}", depth - 1)
}

fn insert_successor_reference(
    connection: &Connection,
    operation_id: &str,
    previous_operation_id: &str,
    scope_kind: &str,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: Option<&str>,
) {
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               intent, trigger_kind, phase, operation_status,
               result_classification, next_action, partial_kind, revision,
               previous_operation_id, root_operation_id,
               folder_effect, manuscript_effect, file_ref_effect, binding_effect,
               final_verification_outcome, facts_schema_version,
               started_at, updated_at, terminal_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5,
               'recover', 'explicit-recovery', 'preflight', 'active',
               NULL, NULL, NULL, 0, ?6, ?6,
               'none', 'none', 'none', 'none',
               'not-run', 1, ?7, ?7, NULL
             )",
            params![
                operation_id,
                scope_kind,
                owner_type,
                owner_id,
                manuscript_channel,
                previous_operation_id,
                T0,
            ],
        )
        .expect("insert exact-v41 persisted successor reference");
}

fn try_insert_active_claim_reference(
    connection: &Connection,
    label: &str,
    operation_id: &str,
    scope_kind: &str,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: Option<&str>,
) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT INTO manuscript_provisioning_active_claims (
               claim_id, scope_kind, owner_type, owner_id, manuscript_channel,
               operation_id, claim_owner_token, claim_revision, claimed_at,
               last_heartbeat_at, last_progress_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8, ?8)",
        params![
            format!("claim-{label}"),
            scope_kind,
            owner_type,
            owner_id,
            manuscript_channel,
            operation_id,
            format!("holder-{label}"),
            T0,
        ],
    )
}

fn insert_active_claim_reference(
    connection: &Connection,
    label: &str,
    operation_id: &str,
    scope_kind: &str,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: Option<&str>,
) {
    try_insert_active_claim_reference(
        connection,
        label,
        operation_id,
        scope_kind,
        owner_type,
        owner_id,
        manuscript_channel,
    )
    .expect("insert exact-v41 active Claim reference");
}

#[test]
fn p4_2e_recovery_evidence_is_bounded_and_fail_closed() {
    assert_eq!(MAX_RECOVERY_CHAIN_DEPTH, 32);
    for depth in [31_usize, 32] {
        let connection = v41();
        let target = insert_recovery_chain(&connection, depth, &format!("valid-{depth}"));
        let evidence =
            list_recovery_step_progress(&connection, &target).expect("depth must be valid");
        assert_eq!(evidence.chain.len(), depth);
    }

    let too_deep = v41();
    let target = insert_recovery_chain(&too_deep, 33, "too-deep");
    assert_eq!(
        list_recovery_step_progress(&too_deep, &target)
            .expect_err("depth 33 must fail")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    let broken = v41();
    let target = insert_recovery_chain(&broken, 2, "broken");
    broken
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM manuscript_provisioning_step_progress WHERE operation_id='broken-0';
             DELETE FROM manuscript_provisioning_step_plans WHERE operation_id='broken-0';
             DELETE FROM manuscript_provisioning_operation_attempts WHERE operation_id='broken-0';
             PRAGMA foreign_keys=ON;",
        )
        .expect("make isolated broken chain");
    assert_eq!(
        list_recovery_step_progress(&broken, &target)
            .expect_err("broken predecessor must fail")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    let root_mismatch = v41();
    let target = insert_recovery_chain(&root_mismatch, 3, "root-mismatch");
    root_mismatch
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET root_operation_id='root-mismatch-1' WHERE operation_id=?1",
            [&target],
        )
        .expect("corrupt declared root");
    assert_eq!(
        list_recovery_step_progress(&root_mismatch, &target)
            .expect_err("root mismatch must fail")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    let wrong_terminal = v41();
    let target = insert_recovery_chain(&wrong_terminal, 2, "wrong-terminal");
    wrong_terminal
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET operation_status='terminal-failed', result_classification='repair-required',
                 next_action='repair', partial_kind=NULL
             WHERE operation_id='wrong-terminal-0'",
            [],
        )
        .expect("change predecessor terminal relation");
    assert_eq!(
        list_recovery_step_progress(&wrong_terminal, &target)
            .expect_err("wrong terminal relationship must fail")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    let malformed_steps = v41();
    let target = insert_recovery_chain(&malformed_steps, 2, "malformed-steps");
    malformed_steps
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&target],
        )
        .expect("remove required Step");
    assert_eq!(
        list_recovery_step_progress(&malformed_steps, &target)
            .expect_err("missing required Step must fail")
            .code,
        STRUCTURAL_PROGRESS_CORRUPTION
    );

    let cycle = v41();
    let target = insert_recovery_chain(&cycle, 2, "cycle");
    cycle
        .execute_batch(
            "PRAGMA ignore_check_constraints=ON;
             UPDATE manuscript_provisioning_operation_attempts
             SET intent='recover', trigger_kind='explicit-recovery',
                 previous_operation_id='cycle-1', root_operation_id='cycle-0'
             WHERE operation_id='cycle-0';
             UPDATE manuscript_provisioning_step_plans
             SET intent='recover' WHERE operation_id='cycle-0';
             UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed', operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',
                 next_action='recover', partial_kind='physical-only',
                 final_verification_outcome='not-passed', terminal_at='2026-07-24T00:00:00.000Z'
             WHERE operation_id='cycle-1';
             PRAGMA ignore_check_constraints=OFF;",
        )
        .expect("make isolated cyclic chain");
    assert_eq!(
        list_recovery_step_progress(&cycle, &target)
            .expect_err("cycle must fail")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );
}

fn authority_snapshot(connection: &Connection) -> Vec<String> {
    let mut snapshot = [
        (
            "attempt",
            "SELECT operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
                    aggregate_operation_id, intent, trigger_kind, phase, operation_status,
                    result_classification, next_action, original_cause_code, partial_kind,
                    revision, previous_operation_id, root_operation_id, folder_effect,
                    manuscript_effect, file_ref_effect, binding_effect,
                    default_folder_file_ref_id, default_manuscript_file_ref_id, binding_id,
                    final_verification_outcome, inspector_version, verifier_version,
                    facts_schema_version, started_at, updated_at, terminal_at
             FROM manuscript_provisioning_operation_attempts ORDER BY operation_id",
        ),
        (
            "claim",
            "SELECT claim_id, scope_kind, owner_type, owner_id, manuscript_channel,
                    operation_id, length(claim_owner_token), claim_revision, claimed_at,
                    last_heartbeat_at, last_progress_at, stale_observed_at,
                    length(stale_observed_by_token)
             FROM manuscript_provisioning_active_claims ORDER BY claim_id",
        ),
        (
            "plan",
            "SELECT plan_id, operation_id, plan_version, plan_template_kind,
                    plan_identity_fingerprint, precondition_snapshot_hash,
                    fingerprint_profile, owner_type, owner_id, scope_kind,
                    manuscript_channel, intent, canonical_resource_identity_hash,
                    canonical_placement_identity_hash, parent_shared_identity_hash,
                    step_count, planner_version, created_at
             FROM manuscript_provisioning_step_plans ORDER BY operation_id, plan_id",
        ),
        (
            "step",
            "SELECT step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
                    step_version, is_required, boundary, effect_outcome, readback_outcome,
                    observed_identity_hash, resource_record_id, effect_facts_schema_version,
                    progress_revision, created_at, updated_at, started_at,
                    effect_observed_at, readback_verified_at, converged_at
             FROM manuscript_provisioning_step_progress ORDER BY operation_id, step_ordinal",
        ),
        (
            "projection",
            "SELECT aggregate_operation_id, owner_type, owner_id, manuscript_channel,
                    current_operation_id, current_operation_scope_kind, revision,
                    child_summary_status, result_classification, next_action,
                    default_readiness, final_verification_outcome, original_cause_code,
                    updated_at
             FROM manuscript_provisioning_literature_child_states
             ORDER BY aggregate_operation_id, manuscript_channel",
        ),
        (
            "outbox",
            "SELECT operation_id, delivery_status, revision, delivery_attempt_count,
                    operation_log_id, error_code, created_at, updated_at, delivered_at
             FROM manuscript_provisioning_audit_outbox ORDER BY operation_id",
        ),
    ]
    .into_iter()
    .flat_map(|(label, sql)| {
        let mut statement = connection.prepare(sql).expect("prepare snapshot");
        let column_count = statement.column_count();
        statement
            .query_map([], |row| {
                let values = (0..column_count)
                    .map(|index| format!("{:?}", row.get_ref(index).expect("snapshot value")))
                    .collect::<Vec<_>>()
                    .join("|");
                Ok(format!("{label}:{values}"))
            })
            .expect("query snapshot")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect snapshot")
    })
    .collect::<Vec<_>>();
    let mut token_statement = connection
        .prepare(
            "SELECT claim_id, claim_owner_token, stale_observed_by_token
             FROM manuscript_provisioning_active_claims ORDER BY claim_id",
        )
        .expect("prepare safe token snapshot");
    snapshot.extend(
        token_statement
            .query_map([], |row| {
                let claim_id: String = row.get(0)?;
                let holder: String = row.get(1)?;
                let stale: Option<String> = row.get(2)?;
                let holder_digest = format!("{:x}", Sha256::digest(holder.as_bytes()));
                let stale_digest =
                    stale.map(|value| format!("{:x}", Sha256::digest(value.as_bytes())));
                Ok(format!(
                    "claim-token:{claim_id}|{holder_digest}|{}",
                    stale_digest.as_deref().unwrap_or("NULL")
                ))
            })
            .expect("query safe token snapshot")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect safe token snapshot"),
    );
    snapshot
}

fn converge_single_step(connection: &mut Connection, input: &AtomicDurableAttemptInput) {
    let authority = |revision: i64, occurred_at: &str| ProgressAuthorityInput {
        operation_id: input.operation_id.clone(),
        plan_id: input.plan.plan_id.clone(),
        step_id: input.steps[0].step_id.clone(),
        claim_id: input.claim_id.clone(),
        claim_owner_token: input.claim_owner_token.clone(),
        expected_progress_revision: revision,
        occurred_at: occurred_at.to_string(),
    };
    mark_step_started(connection, &authority(0, T1)).expect("start");
    record_step_effect_observed(
        connection,
        &authority(1, T2),
        DurableStepEffectOutcome::Created,
        HASH_E,
        Some("resource"),
    )
    .expect("observe");
    record_step_readback_verified(connection, &authority(2, T3)).expect("verify");
    converge_step(connection, &authority(3, T4)).expect("converge");
}

fn terminalize_and_deliver_fixture(connection: &mut Connection, input: &AtomicDurableAttemptInput) {
    terminalize_attempt_release_claim_and_enqueue_audit(
        connection,
        &TerminalAttemptInput::completed(
            &input.operation_id,
            &input.claim_id,
            &input.claim_owner_token,
            0,
            0,
            T5,
        ),
    )
    .expect("terminal");
    connection
        .execute(
            "UPDATE manuscript_provisioning_audit_outbox
             SET delivery_status='delivered', operation_log_id=?1,
                 delivered_at=?2, updated_at=?2
             WHERE operation_id=?3",
            params![
                format!("log-{}", input.operation_id),
                T5,
                input.operation_id
            ],
        )
        .expect("deliver audit fixture");
}

#[test]
fn p4_2e_startup_and_cleanup_dry_run_have_dual_zero_write_evidence() {
    let mut connection = v41();
    let input = review_input("zero-write-e3", "review-zero-write-e3");
    create_attempt_claim_plan_and_steps(&mut connection, &input).expect("init");

    let startup_changes = connection.total_changes();
    let startup_snapshot = authority_snapshot(&connection);
    scan_sqlite_runtime_candidates(&connection, "scanner-token", T1).expect("startup scan");
    assert_eq!(connection.total_changes(), startup_changes);
    assert_eq!(authority_snapshot(&connection), startup_snapshot);

    converge_single_step(&mut connection, &input);
    terminalize_and_deliver_fixture(&mut connection, &input);
    let cleanup_changes = connection.total_changes();
    let cleanup_snapshot = authority_snapshot(&connection);
    let decision =
        dry_run_progress_cleanup(&connection, &input.operation_id, "2026-07-25T00:00:00.000Z")
            .expect("cleanup dry run");
    assert!(decision.eligible);
    assert_eq!(connection.total_changes(), cleanup_changes);
    assert_eq!(authority_snapshot(&connection), cleanup_snapshot);
}

#[test]
fn p4_2e_cleanup_projection_gate_is_scope_specific_and_fail_closed() {
    let mut literature = v41();
    let aggregate = aggregate_input("projection-missing-e3", "literature-projection-e3");
    create_attempt_claim_plan_and_steps(&mut literature, &aggregate).expect("aggregate");
    converge_single_step(&mut literature, &aggregate);
    terminalize_and_deliver_fixture(&mut literature, &aggregate);
    literature
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1 AND manuscript_channel='dedicated_notes'",
            [&aggregate.operation_id],
        )
        .expect("remove required projection fixture");
    assert_eq!(
        dry_run_progress_cleanup(
            &literature,
            &aggregate.operation_id,
            "2026-07-25T00:00:00.000Z"
        )
        .expect_err("missing Literature projection must fail closed")
        .code,
        STRUCTURAL_PROGRESS_CORRUPTION
    );

    let mut ordinary = v41();
    let review = review_input("unexpected-projection-e3", "review-projection-e3");
    create_attempt_claim_plan_and_steps(&mut ordinary, &review).expect("review");
    converge_single_step(&mut ordinary, &review);
    terminalize_and_deliver_fixture(&mut ordinary, &review);
    ordinary
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .expect("disable FK for isolated corruption");
    ordinary
        .execute(
            "INSERT INTO manuscript_provisioning_literature_child_states (
               aggregate_operation_id, owner_type, owner_id, manuscript_channel,
               current_operation_id, current_operation_scope_kind, revision,
               child_summary_status, default_readiness,
               final_verification_outcome, updated_at
             ) VALUES (
               ?1, 'literature', ?2, 'literature_outline',
               ?1, 'literature-aggregate', 0, 'assigned',
               'not-verified', 'not-run', ?3
             )",
            params![review.operation_id, review.owner_id, T5],
        )
        .expect("insert isolated unexpected projection");
    ordinary
        .execute_batch("PRAGMA foreign_keys=ON;")
        .expect("restore FK");
    assert_eq!(
        dry_run_progress_cleanup(&ordinary, &review.operation_id, "2026-07-25T00:00:00.000Z")
            .expect_err("non-Literature projection must fail closed")
            .code,
        STRUCTURAL_PROGRESS_CORRUPTION
    );
}

static NEXT_TEMP_DB: AtomicU64 = AtomicU64::new(1);

#[test]
fn p4_2e_r2_b_source_gate_rejects_deferred_fk_commit_fault_authority() {
    let source = include_str!("manuscript_provisioning_step_progress_p4_2e_tests.rs");
    let forbidden = [
        concat!("fn install_deferred_", "commit_fault"),
        concat!("p4e_commit_fault_", "parent"),
        concat!("p4e_commit_fault_", "child"),
        concat!("p4e_atomic_", "commit_fault"),
        concat!("p4e_recovery_", "commit_fault"),
        concat!("p4e_terminal_", "commit_fault"),
        concat!("p4e_cleanup_", "commit_fault"),
        concat!("p4e_literature_terminal_", "commit_fault"),
    ];
    for symbol in forbidden {
        assert!(
            !source.contains(symbol),
            "R2-B forbids the deferred-FK/trigger commit-fault authority: {symbol}"
        );
    }

    let support = include_str!("manuscript_provisioning_commit_failure_test_support.rs");
    assert!(support.contains("connection.commit_hook"));
    assert!(support.contains("connection.trace"));
    assert!(support.contains("Sha256::digest"));
    for forbidden in [
        "unsafe",
        "sqlite3_vfs",
        "rusqlite::ffi",
        "std::env::var",
        "tauri::command",
        "AppHandle",
        "execute(",
        "execute_batch(",
    ] {
        assert!(
            !support.contains(forbidden),
            "test support must remain observer/hook-only: {forbidden}"
        );
    }

    let module_registry = include_str!("mod.rs").replace("\r\n", "\n");
    assert!(module_registry
        .contains("#[cfg(test)]\nmod manuscript_provisioning_commit_failure_test_support;"));
    let cargo = include_str!("../../Cargo.toml").replace("\r\n", "\n");
    let (normal_dependencies, dev_dependencies) = cargo
        .split_once("[dev-dependencies]")
        .expect("Cargo dev-dependency section");
    assert!(
        normal_dependencies.contains("rusqlite = { version = \"0.32\", features = [\"bundled\"] }")
    );
    assert!(!normal_dependencies.contains("\"hooks\""));
    assert!(!normal_dependencies.contains("\"trace\""));
    assert!(dev_dependencies
        .contains("rusqlite = { version = \"0.32\", features = [\"hooks\", \"trace\"] }"));

    let production = [
        include_str!("manuscript_provisioning_operation_state.rs"),
        include_str!("manuscript_provisioning_operation_state/runtime.rs"),
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs"),
        include_str!("manuscript_provisioning_operation_state/step_progress_schema.rs"),
        include_str!("schema.rs"),
    ]
    .join("\n");
    assert!(!production.contains("commit_hook"));
    assert!(!production.contains(".trace("));
}

fn file_v41(label: &str) -> (PathBuf, Connection) {
    let id = NEXT_TEMP_DB.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "labpod-p4-2e-r2-b-{label}-{}-{id}",
        std::process::id()
    ));
    std::fs::create_dir(&root).expect("create isolated R2-B temp directory");
    let path = root.join("labpod.sqlite3");
    let connection = Connection::open(&path).expect("open isolated file SQLite");
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
        .expect("set DELETE journal mode");
    assert_eq!(journal_mode, "delete");
    schema::run_migrations(&connection).expect("install exact v41 schema");
    (path, connection)
}

fn remove_isolated_v41(path: PathBuf) {
    let root = path.parent().expect("isolated DB parent").to_path_buf();
    assert!(
        root.starts_with(std::env::temp_dir()),
        "R2-B cleanup must stay under the temp directory"
    );
    for suffix in ["-journal", "-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        assert!(
            !sidecar.exists(),
            "SQLite sidecar must be recovered before cleanup: {}",
            sidecar.display()
        );
    }
    std::fs::remove_file(&path).expect("remove isolated R2-B SQLite");
    std::fs::remove_dir(root).expect("remove isolated R2-B temp directory");
}

fn trace_through_commit(trace: &[SqlTraceEvent]) -> &[SqlTraceEvent] {
    let commit = trace
        .iter()
        .position(|event| event.statement_kind == "COMMIT")
        .expect("SQLite native COMMIT must be traced");
    &trace[..=commit]
}

fn assert_qualified_commit_trace(
    normal: &[SqlTraceEvent],
    fault: &[SqlTraceEvent],
    final_body_table: &str,
    required_mutation_tables: &[&str],
) {
    let normal = trace_through_commit(normal);
    let fault = trace_through_commit(fault);
    assert_eq!(
        normal, fault,
        "normal and fault paths must have identical expanded-SQL/parameter digests through COMMIT"
    );
    let final_body = fault
        .iter()
        .rev()
        .find(|event| !matches!(event.statement_kind.as_str(), "COMMIT" | "BEGIN"))
        .expect("transaction body trace");
    assert_eq!(
        final_body.target_table.as_deref(),
        Some(final_body_table),
        "the production transaction must reach its final readback/body-end checkpoint"
    );
    let mutation_tables = fault
        .iter()
        .filter(|event| {
            matches!(
                event.statement_kind.as_str(),
                "INSERT" | "UPDATE" | "DELETE"
            )
        })
        .filter_map(|event| event.target_table.clone())
        .collect::<BTreeSet<_>>();
    for table in required_mutation_tables {
        assert!(
            mutation_tables.contains(*table),
            "missing expected production mutation table in trace: {table}"
        );
    }
}

fn assert_native_commit_hook_abort(
    error_code: &str,
    error_message: &str,
    evidence: &NativeCommitAbortEvidence,
) {
    assert_eq!(error_code, PROVISIONING_OPERATION_DATABASE_ERROR);
    assert!(
        error_message.contains("commit"),
        "fault must surface from the actual COMMIT boundary: {error_message}"
    );
    assert_eq!(
        evidence.callback_calls(),
        1,
        "the connection-local native commit hook must fire exactly once"
    );
    assert!(
        !evidence.is_enabled(),
        "the one-shot fault must disable itself when it fires"
    );
}

fn reopen_and_assert_snapshot(path: &PathBuf, expected: &[String]) {
    let reopened = Connection::open(path).expect("reopen after failed commit");
    let journal_mode: String = reopened
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("read reopened journal mode");
    assert_eq!(journal_mode, "delete");
    let quick_check: String = reopened
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .expect("quick_check after reopen");
    assert_eq!(quick_check, "ok");
    let mut foreign_key_check = reopened
        .prepare("PRAGMA foreign_key_check")
        .expect("prepare foreign_key_check");
    assert!(
        foreign_key_check
            .query([])
            .expect("query foreign_key_check")
            .next()
            .expect("read foreign_key_check")
            .is_none(),
        "foreign_key_check must return no rows"
    );
    assert_eq!(authority_snapshot(&reopened), expected);
    drop(foreign_key_check);
    drop(reopened);
    assert!(
        !PathBuf::from(format!("{}-journal", path.display())).exists(),
        "DELETE journal must be recovered after reopen"
    );
}

fn claim_cas_for_test(
    claim: &super::manuscript_provisioning_operation_state::ProvisioningActiveClaim,
) -> ClaimCasInput {
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

fn recovery_input(
    old: &AtomicDurableAttemptInput,
    observed_claim_revision: i64,
) -> RecoveryReplacementInput {
    let mut plan = old.plan.clone();
    plan.plan_id = HASH_E.to_string();
    RecoveryReplacementInput {
        snapshot_id: "snapshot-commit".to_string(),
        inspected_at: "2026-07-24T00:10:00.000Z".to_string(),
        inspected_owner_type: "review".to_string(),
        inspected_owner_id: old.owner_id.clone(),
        inspected_manuscript_channel: Some("primary".to_string()),
        observed_old_operation_id: old.operation_id.clone(),
        observed_operation_revision: 0,
        observed_claim_id: old.claim_id.clone(),
        observed_claim_revision,
        old_claim_owner_token: old.claim_owner_token.clone(),
        explicit_authorization_id: "authorization-commit".to_string(),
        new_operation_id: "recovery-new-commit".to_string(),
        new_claim_id: "recovery-new-claim-commit".to_string(),
        new_claim_owner_token: "recovery-new-token-commit".to_string(),
        durable_plan: Some(plan),
        durable_steps: vec![DurableStepSkeletonInput {
            step_id: HASH_D.to_string(),
            step_ordinal: 0,
            step_kind: DurableStepKind::EnsureDirectory,
            step_scope: DurableStepScope::Primary,
            step_version: 1,
        }],
        occurred_at: "2026-07-24T00:10:01.000Z".to_string(),
    }
}

fn setup_recovery(
    connection: &mut Connection,
    old: &AtomicDurableAttemptInput,
) -> RecoveryReplacementInput {
    let created = create_attempt_claim_plan_and_steps(connection, old).expect("old Attempt");
    let observed = mark_stale_claim_candidate(
        connection,
        &claim_cas_for_test(&created.claim),
        "observer-token",
        "2026-07-24T00:10:00.000Z",
    )
    .expect("mark stale");
    recovery_input(old, observed.claim_revision)
}

fn setup_terminal(connection: &mut Connection, input: &AtomicDurableAttemptInput) {
    create_attempt_claim_plan_and_steps(connection, input).expect("init");
    converge_single_step(connection, input);
}

fn setup_cleanup(connection: &mut Connection, input: &AtomicDurableAttemptInput) {
    setup_terminal(connection, input);
    terminalize_and_deliver_fixture(connection, input);
}

fn setup_literature_final_terminal(
    connection: &mut Connection,
    aggregate: &AtomicDurableAttemptInput,
) -> LiteratureChildDurableAttemptInput {
    create_attempt_claim_plan_and_steps(connection, aggregate).expect("aggregate");
    converge_single_step(connection, aggregate);
    let outline = child_input(
        aggregate,
        "literature-outline-commit",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    create_literature_child_durable_attempt(connection, &outline).expect("outline child");
    let mut notes = child_input(
        aggregate,
        "literature-notes-commit",
        DurableManuscriptChannel::DedicatedNotes,
        0,
        1,
    );
    notes.plan.plan_id = HASH_F.to_string();
    notes.steps[0].step_id = HASH_G.to_string();
    create_literature_child_durable_attempt(connection, &notes).expect("notes child");
    converge_child(connection, aggregate, &outline);
    converge_child(connection, aggregate, &notes);
    terminalize_literature_child_attempt(
        connection,
        &TerminalAttemptInput::completed(
            &outline.operation_id,
            &aggregate.claim_id,
            &aggregate.claim_owner_token,
            0,
            2,
            "2026-07-24T00:00:06.000Z",
        ),
    )
    .expect("terminalize first Literature child");
    notes
}

#[test]
fn p4_2e_r2_b_native_commit_hook_abort_reports_constraint_commithook() {
    let (path, mut connection) = file_v41("native-code");
    connection
        .execute_batch("CREATE TEMP TABLE r2b_native_commit_probe (id INTEGER PRIMARY KEY)")
        .expect("create connection-local calibration table");
    let before = authority_snapshot(&connection);
    let (_scope, evidence) = arm_native_commit_hook_abort(&connection);
    start_sql_trace(&mut connection);
    let error = {
        let transaction = connection
            .transaction()
            .expect("begin native commit-code calibration");
        transaction
            .execute("INSERT INTO r2b_native_commit_probe(id) VALUES (1)", [])
            .expect("calibration body completes");
        transaction
            .commit()
            .expect_err("SQLite native commit hook must abort")
    };
    let trace = finish_sql_trace(&mut connection);
    remove_native_commit_hook(&connection);
    assert_eq!(
        trace_through_commit(&trace)
            .last()
            .expect("calibration COMMIT")
            .statement_kind,
        "COMMIT"
    );
    assert_eq!(evidence.callback_calls(), 1);
    match error {
        Error::SqliteFailure(code, _) => {
            assert_eq!(code.code, ErrorCode::ConstraintViolation);
            assert_eq!(code.extended_code, 531);
        }
        other => panic!("expected SQLite native commit-hook error, got {other:?}"),
    }
    drop(connection);
    reopen_and_assert_snapshot(&path, &before);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_b_atomic_init_native_commit_hook_abort_has_no_partial_persistence() {
    let input = aggregate_input("atomic-commit-hook", "literature-atomic-commit-hook");
    let (normal_path, mut normal) = file_v41("atomic-normal");
    let (fault_path, mut fault) = file_v41("atomic-fault");
    let before = authority_snapshot(&normal);
    assert_eq!(authority_snapshot(&fault), before);

    start_sql_trace(&mut normal);
    create_attempt_claim_plan_and_steps(&mut normal, &input).expect("normal atomic init");
    let normal_trace = finish_sql_trace(&mut normal);
    assert_ne!(authority_snapshot(&normal), before);

    let (_scope, evidence) = arm_native_commit_hook_abort(&fault);
    start_sql_trace(&mut fault);
    let error = create_attempt_claim_plan_and_steps(&mut fault, &input)
        .expect_err("SQLite native commit-hook abort must fail atomic init");
    let fault_trace = finish_sql_trace(&mut fault);
    remove_native_commit_hook(&fault);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert_qualified_commit_trace(
        &normal_trace,
        &fault_trace,
        "manuscript_provisioning_step_progress",
        &[
            "manuscript_provisioning_operation_attempts",
            "manuscript_provisioning_active_claims",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_literature_child_states",
        ],
    );

    drop(normal);
    drop(fault);
    reopen_and_assert_snapshot(&fault_path, &before);
    remove_isolated_v41(normal_path);
    remove_isolated_v41(fault_path);
}

#[test]
fn p4_2e_r2_b_recovery_replacement_native_commit_hook_abort_restores_both_sides() {
    let old = review_input("recovery-old-commit", "review-recovery-commit");
    let (normal_path, mut normal) = file_v41("recovery-normal");
    let (fault_path, mut fault) = file_v41("recovery-fault");
    let normal_input = setup_recovery(&mut normal, &old);
    let fault_input = setup_recovery(&mut fault, &old);
    assert_eq!(normal_input, fault_input);
    let before = authority_snapshot(&normal);
    assert_eq!(authority_snapshot(&fault), before);

    start_sql_trace(&mut normal);
    replace_claim_for_recovery(&mut normal, &normal_input).expect("normal recovery replacement");
    let normal_trace = finish_sql_trace(&mut normal);
    assert_ne!(authority_snapshot(&normal), before);

    let (_scope, evidence) = arm_native_commit_hook_abort(&fault);
    start_sql_trace(&mut fault);
    let error = replace_claim_for_recovery(&mut fault, &fault_input)
        .expect_err("SQLite native commit-hook abort must fail recovery");
    let fault_trace = finish_sql_trace(&mut fault);
    remove_native_commit_hook(&fault);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert_qualified_commit_trace(
        &normal_trace,
        &fault_trace,
        "manuscript_provisioning_active_claims",
        &[
            "manuscript_provisioning_operation_attempts",
            "manuscript_provisioning_active_claims",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_audit_outbox",
        ],
    );

    drop(normal);
    drop(fault);
    reopen_and_assert_snapshot(&fault_path, &before);
    remove_isolated_v41(normal_path);
    remove_isolated_v41(fault_path);
}

#[test]
fn p4_2e_r2_b_public_terminal_native_commit_hook_abort_restores_terminal_claim_and_outbox() {
    let input = review_input("terminal-commit-hook", "review-terminal-commit-hook");
    let terminal = TerminalAttemptInput::completed(
        &input.operation_id,
        &input.claim_id,
        &input.claim_owner_token,
        0,
        0,
        T5,
    );
    let (normal_path, mut normal) = file_v41("terminal-normal");
    let (fault_path, mut fault) = file_v41("terminal-fault");
    setup_terminal(&mut normal, &input);
    setup_terminal(&mut fault, &input);
    let before = authority_snapshot(&normal);
    assert_eq!(authority_snapshot(&fault), before);

    start_sql_trace(&mut normal);
    terminalize_attempt_release_claim_and_enqueue_audit(&mut normal, &terminal)
        .expect("normal public terminal");
    let normal_trace = finish_sql_trace(&mut normal);
    assert_ne!(authority_snapshot(&normal), before);

    let (_scope, evidence) = arm_native_commit_hook_abort(&fault);
    start_sql_trace(&mut fault);
    let error = terminalize_attempt_release_claim_and_enqueue_audit(&mut fault, &terminal)
        .expect_err("SQLite native commit-hook abort must fail public terminal");
    let fault_trace = finish_sql_trace(&mut fault);
    remove_native_commit_hook(&fault);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert_qualified_commit_trace(
        &normal_trace,
        &fault_trace,
        "manuscript_provisioning_audit_outbox",
        &[
            "manuscript_provisioning_operation_attempts",
            "manuscript_provisioning_active_claims",
            "manuscript_provisioning_audit_outbox",
        ],
    );

    drop(normal);
    drop(fault);
    reopen_and_assert_snapshot(&fault_path, &before);
    remove_isolated_v41(normal_path);
    remove_isolated_v41(fault_path);
}

#[test]
fn p4_2e_r2_b_literature_terminal_projection_native_commit_hook_abort_restores_aggregate() {
    let aggregate = aggregate_input(
        "literature-aggregate-commit-hook",
        "literature-terminal-commit-hook",
    );
    let (normal_path, mut normal) = file_v41("literature-terminal-normal");
    let (fault_path, mut fault) = file_v41("literature-terminal-fault");
    let normal_child = setup_literature_final_terminal(&mut normal, &aggregate);
    let fault_child = setup_literature_final_terminal(&mut fault, &aggregate);
    assert_eq!(normal_child, fault_child);
    let before = authority_snapshot(&normal);
    assert_eq!(authority_snapshot(&fault), before);
    let terminal = TerminalAttemptInput::completed(
        &normal_child.operation_id,
        &aggregate.claim_id,
        &aggregate.claim_owner_token,
        0,
        3,
        "2026-07-24T00:00:07.000Z",
    );

    start_sql_trace(&mut normal);
    terminalize_literature_child_attempt(&mut normal, &terminal)
        .expect("normal Literature terminal/projection");
    let normal_trace = finish_sql_trace(&mut normal);
    assert_ne!(authority_snapshot(&normal), before);

    let (_scope, evidence) = arm_native_commit_hook_abort(&fault);
    start_sql_trace(&mut fault);
    let error = terminalize_literature_child_attempt(&mut fault, &terminal)
        .expect_err("SQLite native commit-hook abort must fail Literature terminal");
    let fault_trace = finish_sql_trace(&mut fault);
    remove_native_commit_hook(&fault);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert_qualified_commit_trace(
        &normal_trace,
        &fault_trace,
        "manuscript_provisioning_literature_child_states",
        &[
            "manuscript_provisioning_operation_attempts",
            "manuscript_provisioning_active_claims",
            "manuscript_provisioning_literature_child_states",
            "manuscript_provisioning_audit_outbox",
        ],
    );

    drop(normal);
    drop(fault);
    reopen_and_assert_snapshot(&fault_path, &before);
    remove_isolated_v41(normal_path);
    remove_isolated_v41(fault_path);
}

#[test]
fn p4_2e_r2_b_cleanup_native_commit_hook_abort_restores_leaf_first_authority() {
    let input = review_input("cleanup-commit-hook", "review-cleanup-commit-hook");
    let (normal_path, mut normal) = file_v41("cleanup-normal");
    let (fault_path, mut fault) = file_v41("cleanup-fault");
    setup_cleanup(&mut normal, &input);
    setup_cleanup(&mut fault, &input);
    let before = authority_snapshot(&normal);
    assert_eq!(authority_snapshot(&fault), before);

    start_sql_trace(&mut normal);
    super::manuscript_provisioning_operation_state::execute_progress_cleanup(
        &mut normal,
        &input.operation_id,
        "2026-07-25T00:00:00.000Z",
    )
    .expect("normal cleanup");
    let normal_trace = finish_sql_trace(&mut normal);
    assert_ne!(authority_snapshot(&normal), before);

    let (_scope, evidence) = arm_native_commit_hook_abort(&fault);
    start_sql_trace(&mut fault);
    let error = super::manuscript_provisioning_operation_state::execute_progress_cleanup(
        &mut fault,
        &input.operation_id,
        "2026-07-25T00:00:00.000Z",
    )
    .expect_err("SQLite native commit-hook abort must fail cleanup");
    let fault_trace = finish_sql_trace(&mut fault);
    remove_native_commit_hook(&fault);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert_qualified_commit_trace(
        &normal_trace,
        &fault_trace,
        "manuscript_provisioning_operation_attempts",
        &[
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_audit_outbox",
            "manuscript_provisioning_operation_attempts",
        ],
    );

    drop(normal);
    drop(fault);
    reopen_and_assert_snapshot(&fault_path, &before);
    remove_isolated_v41(normal_path);
    remove_isolated_v41(fault_path);
}

#[test]
fn p4_2e_r2_b_commit_hook_abort_is_connection_local_and_one_shot() {
    let target_input = review_input("isolation-target-commit-hook", "review-isolation-target");
    let control_input = review_input("isolation-control-commit", "review-isolation-control");
    let (target_path, mut target) = file_v41("isolation-target");
    let (control_path, mut control) = file_v41("isolation-control");
    let target_before = authority_snapshot(&target);
    let control_before = authority_snapshot(&control);

    let (_scope, evidence) = arm_native_commit_hook_abort(&target);
    create_attempt_claim_plan_and_steps(&mut control, &control_input)
        .expect("non-target connection must commit normally");
    assert_eq!(
        evidence.callback_calls(),
        0,
        "target hook cannot observe another connection"
    );

    start_sql_trace(&mut target);
    let error = create_attempt_claim_plan_and_steps(&mut target, &target_input)
        .expect_err("target native commit hook must abort");
    let trace = finish_sql_trace(&mut target);
    remove_native_commit_hook(&target);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert_eq!(
        trace_through_commit(&trace)
            .last()
            .expect("target COMMIT trace")
            .statement_kind,
        "COMMIT"
    );

    drop(target);
    drop(control);
    reopen_and_assert_snapshot(&target_path, &target_before);
    let reopened_control = Connection::open(&control_path).expect("reopen isolated control");
    assert_ne!(authority_snapshot(&reopened_control), control_before);
    drop(reopened_control);
    remove_isolated_v41(target_path);
    remove_isolated_v41(control_path);
}

#[test]
fn p4_2e_no_effect_fault_harness_never_converts_unknown_effects_to_absence() {
    let mut connection = v41();
    let input = review_input("no-effect-harness-e4", "review-no-effect-e4");
    create_attempt_claim_plan_and_steps(&mut connection, &input).expect("init");
    let authority = |revision: i64, occurred_at: &str| ProgressAuthorityInput {
        operation_id: input.operation_id.clone(),
        plan_id: input.plan.plan_id.clone(),
        step_id: input.steps[0].step_id.clone(),
        claim_id: input.claim_id.clone(),
        claim_owner_token: input.claim_owner_token.clone(),
        expected_progress_revision: revision,
        occurred_at: occurred_at.to_string(),
    };
    mark_step_started(&mut connection, &authority(0, T1)).expect("start");

    let exception: Result<bool, &'static str> = Err("controlled-exception");
    let timeout: Result<bool, &'static str> = Err("controlled-timeout");
    let panic = std::panic::catch_unwind(|| panic!("controlled-panic"));
    assert!(exception.is_err());
    assert!(timeout.is_err());
    assert!(panic.is_err());
    let still_unknown = read_attempt_step_progress(&connection, &input.operation_id)
        .expect("read started Step")
        .remove(0);
    assert_eq!(still_unknown.boundary.as_str(), "started");
    assert_eq!(still_unknown.effect_outcome.as_str(), "unobserved");
    assert_eq!(still_unknown.readback_outcome.as_str(), "not-run");

    let absent =
        record_step_no_effect(&mut connection, &authority(1, T2)).expect("verified absent");
    assert_eq!(absent.status, ProgressMutationStatus::Applied);
    assert_eq!(absent.step.boundary.as_str(), "started");
    assert_eq!(absent.step.effect_outcome.as_str(), "no-effect-proven");
    assert_eq!(absent.step.readback_outcome.as_str(), "verified-absent");
    assert_eq!(
        record_step_no_effect(&mut connection, &authority(1, T3))
            .expect("NoEffect replay")
            .status,
        ProgressMutationStatus::AlreadyApplied
    );
    assert_eq!(
        record_step_effect_observed(
            &mut connection,
            &authority(2, T3),
            DurableStepEffectOutcome::Created,
            HASH_A,
            Some("must-not-write"),
        )
        .expect_err("same Attempt cannot mutate after proven absence")
        .code,
        PROGRESS_TRANSITION_INVALID
    );
}

#[test]
fn p4_2e_r2_a_source_gate_rejects_complete_legacy_test_authority() {
    let runtime = include_str!("manuscript_provisioning_operation_state/runtime.rs");
    for forbidden in [
        "legacy_v40_literature_fixture",
        "legacy_v40_cleanup_fixture",
        "acquire_literature_single_channel",
        "CreateLiteratureChildAttemptInput",
        "LiteratureChildMutationResult",
        "read_literature_child_state",
        "create_literature_child_attempt",
        "LiteratureChildTransitionInput",
        "LiteratureChildTransitionResult",
        "transition_literature_child",
        "CleanupRetentionPolicy",
        "cleanup_decision",
        "dry_run_cleanup",
        "execute_explicit_cleanup",
        "ActiveAttemptTransitionInput",
        "transition_active_attempt_and_record_progress",
        "CreateFollowUpAttemptInput",
        "create_follow_up_attempt_and_claim",
        "PROVISIONING_CLEANUP_REFERENCE_CONFLICT",
        "PROVISIONING_CHILD_STATE_CAS_CONFLICT",
    ] {
        assert!(
            !runtime.contains(forbidden),
            "complete legacy test authority remains in runtime.rs: {forbidden}"
        );
    }

    let operation_state =
        include_str!("manuscript_provisioning_operation_state.rs").replace("\r\n", "\n");
    for forbidden in [
        "pub(crate) struct CreateLiteratureAggregateAttemptInput",
        "pub(crate) struct LiteratureAggregateState",
        "pub(crate) struct ProvisioningLiteratureChildState",
        "pub(crate) fn create_literature_aggregate_attempt",
        "pub(crate) fn read_literature_aggregate_state",
        "fn child_from_row",
    ] {
        assert!(
            !operation_state.contains(forbidden),
            "complete legacy aggregate test authority remains: {forbidden}"
        );
    }

    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let old_p3a3_tests =
        manifest_dir.join("src/db/manuscript_provisioning_operation_state_p3a3_tests.rs");
    assert!(
        !old_p3a3_tests.exists(),
        "old P3A3 business-mainline test module must be removed"
    );

    let fixture = include_str!("manuscript_provisioning_v40_migration_fixture.rs");
    let exported_helpers = fixture
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("pub(crate) fn ")
                .and_then(|rest| rest.split('(').next())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        exported_helpers,
        vec!["open_v40_source_database", "open_v39_source_database"],
        "v40 migration fixture exports must stay on the explicit allowlist"
    );
    for forbidden in [
        "transition",
        "terminalize",
        "complete",
        "acquire_",
        "release_",
        "heartbeat",
        "cleanup",
        "dry_run",
        "mutate",
        "replace",
        "recover",
        "repository",
        "service",
        "state_machine",
        "next_action",
        "active_phase",
    ] {
        assert!(
            !fixture.contains(forbidden),
            "v40 migration fixture contains forbidden business authority: {forbidden}"
        );
    }
    let db_modules = include_str!("mod.rs").replace("\r\n", "\n");
    assert!(
        db_modules.contains("#[cfg(test)]\nmod manuscript_provisioning_v40_migration_fixture;"),
        "v40 migration fixture must be compile-isolated behind cfg(test)"
    );
    let repository =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    for production_source in [runtime, operation_state.as_str(), repository] {
        assert!(
            !production_source.contains("manuscript_provisioning_v40_migration_fixture"),
            "production source must not import the v40 migration fixture"
        );
    }

    assert_eq!(
        repository
            .matches("pub(crate) fn execute_progress_cleanup")
            .count(),
        1,
        "there must be one production v41 cleanup executor"
    );
    assert_eq!(
        operation_state
            .matches("pub(crate) fn apply_terminal_attempt_cas")
            .count(),
        1,
        "Attempt terminal tuple must have one mutation authority"
    );
    assert!(repository.contains("create_literature_child_durable_attempt"));
    assert!(repository.contains("terminalize_literature_child_attempt"));
    assert!(!repository.contains("current_child_operation_id"));
}

fn actor_connection(path: &PathBuf) -> Connection {
    let connection = Connection::open(path).expect("open independent R2-C Actor connection");
    connection
        .busy_timeout(Duration::ZERO)
        .expect("set deterministic zero busy timeout");
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .expect("enable Actor foreign keys");
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("read Actor journal mode");
    assert_eq!(journal_mode, "delete");
    connection
}

fn progress_authority(
    input: &AtomicDurableAttemptInput,
    revision: i64,
    occurred_at: &str,
) -> ProgressAuthorityInput {
    ProgressAuthorityInput {
        operation_id: input.operation_id.clone(),
        plan_id: input.plan.plan_id.clone(),
        step_id: input.steps[0].step_id.clone(),
        claim_id: input.claim_id.clone(),
        claim_owner_token: input.claim_owner_token.clone(),
        expected_progress_revision: revision,
        occurred_at: occurred_at.to_string(),
    }
}

fn count_rows(connection: &Connection, table: &str, predicate: &str) -> i64 {
    connection
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE {predicate}"),
            [],
            |row| row.get(0),
        )
        .expect("count exact-v41 authority rows")
}

fn assert_sqlite_busy_5(error: Error) {
    match error {
        Error::SqliteFailure(failure, _) => {
            assert_eq!(failure.code, ErrorCode::DatabaseBusy);
            assert_eq!(
                failure.extended_code, 5,
                "this file-backed DELETE-journal interleaving freezes SQLITE_BUSY/5"
            );
        }
        other => panic!("expected raw SQLite lock error, got {other:?}"),
    }
}

fn assert_lock_contention<T: Debug>(
    path: &PathBuf,
    expected_snapshot: &[String],
    production_call: impl FnOnce(&mut Connection) -> Result<T, ProvisioningOperationRepositoryError>,
) {
    let mut holder = actor_connection(path);
    let holder_transaction = holder
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("Actor A holds BEGIN IMMEDIATE");
    let mut actor_b = actor_connection(path);
    let raw_error = match actor_b.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(_) => panic!("Actor B unexpectedly acquired the write transaction"),
        Err(error) => error,
    };
    assert_sqlite_busy_5(raw_error);
    let bounded = match production_call(&mut actor_b) {
        Ok(_) => panic!("production entry unexpectedly crossed Actor A write lock"),
        Err(error) => error,
    };
    assert_eq!(bounded.code, PROVISIONING_OPERATION_DATABASE_ERROR);
    assert_eq!(authority_snapshot(&actor_b), expected_snapshot);
    drop(holder_transaction);
    drop(actor_b);
    drop(holder);
}

#[test]
fn p4_2e_r2_c_progress_interleaving_freezes_idempotency_conflicts_and_heartbeat_independence() {
    let (path, mut setup) = file_v41("r2-c-progress");
    let input = review_input("r2-c-progress", "review-r2-c-progress");
    create_attempt_claim_plan_and_steps(&mut setup, &input).expect("create Progress authority");
    drop(setup);

    let actor_b_same = progress_authority(&input, 0, T1);
    let actor_b_stale_payload = progress_authority(&input, 0, T2);
    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    let applied = mark_step_started(&mut actor_a, &progress_authority(&input, 0, T1))
        .expect("Actor A applies Started");
    assert_eq!(applied.status, ProgressMutationStatus::Applied);
    assert_eq!(
        mark_step_started(&mut actor_b, &actor_b_same)
            .expect("Actor B exact replay")
            .status,
        ProgressMutationStatus::AlreadyApplied
    );
    assert_eq!(
        mark_step_started(&mut actor_b, &actor_b_stale_payload)
            .expect_err("stale different payload")
            .code,
        PROGRESS_REVISION_CONFLICT
    );
    assert_eq!(
        mark_step_started(&mut actor_b, &progress_authority(&input, 1, T2))
            .expect_err("current revision different same-boundary payload")
            .code,
        PROGRESS_PAYLOAD_CONFLICT
    );

    let claim = read_active_claim_for_operation(&actor_a, &input.operation_id)
        .expect("read Claim")
        .expect("active Claim");
    let effect_input = progress_authority(&input, 1, T2);
    let heartbeat = record_claim_heartbeat(&mut actor_a, &claim_cas_for_test(&claim), T2)
        .expect("heartbeat advances only Claim revision");
    assert_eq!(heartbeat.claim_revision, 1);
    let observed = record_step_effect_observed(
        &mut actor_b,
        &effect_input,
        DurableStepEffectOutcome::Created,
        HASH_A,
        Some("r2-c-resource"),
    )
    .expect("Progress ignores independent Claim revision");
    assert_eq!(observed.step.progress_revision, 2);
    assert_eq!(observed.step.boundary.as_str(), "effect-observed");

    let mut jump_setup = actor_connection(&path);
    let mut jump = review_input("r2-c-progress-jump", "review-r2-c-progress-jump");
    jump.plan.plan_id = HASH_F.to_string();
    jump.steps[0].step_id = HASH_G.to_string();
    create_attempt_claim_plan_and_steps(&mut jump_setup, &jump).expect("create jump authority");
    assert_eq!(
        converge_step(&mut jump_setup, &progress_authority(&jump, 0, T1))
            .expect_err("cannot jump intended to converged")
            .code,
        PROGRESS_TRANSITION_INVALID
    );
    let final_step = read_attempt_step_progress(&jump_setup, &jump.operation_id)
        .expect("read jump Step")
        .remove(0);
    assert_eq!(final_step.boundary.as_str(), "intended");
    assert_eq!(final_step.progress_revision, 0);

    drop(jump_setup);
    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_progress_terminal_heartbeat_and_double_terminal_have_one_winner() {
    let (path, mut setup) = file_v41("r2-c-terminal");
    let input = review_input("r2-c-terminal", "review-r2-c-terminal");
    let created =
        create_attempt_claim_plan_and_steps(&mut setup, &input).expect("create terminal authority");
    let stale_heartbeat = claim_cas_for_test(&created.claim);
    let terminal = TerminalAttemptInput::completed(
        &input.operation_id,
        &input.claim_id,
        &input.claim_owner_token,
        0,
        0,
        T5,
    );
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(&mut setup, &terminal)
            .expect_err("Terminal must reject incomplete required Step")
            .code,
        TERMINAL_PROGRESS_INCOMPLETE
    );
    assert!(read_active_claim_for_operation(&setup, &input.operation_id)
        .expect("read Claim after rejected terminal")
        .is_some());
    converge_single_step(&mut setup, &input);
    drop(setup);

    let stale_progress = progress_authority(&input, 4, "2026-07-24T00:00:06.000Z");
    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    let winner = terminalize_attempt_release_claim_and_enqueue_audit(&mut actor_a, &terminal)
        .expect("Actor A terminal winner");
    assert_eq!(winner.attempt.operation_status, "terminal-completed");
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(&mut actor_b, &terminal)
            .expect_err("Actor B double terminal loser")
            .code,
        PROVISIONING_OPERATION_CAS_CONFLICT
    );
    let mut different_terminal = terminal.clone();
    different_terminal.occurred_at = "2026-07-24T00:00:07.000Z".to_string();
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(&mut actor_b, &different_terminal)
            .expect_err("different second completion cannot overwrite terminal tuple")
            .code,
        PROVISIONING_OPERATION_CAS_CONFLICT
    );
    assert_eq!(
        record_claim_heartbeat(&mut actor_b, &stale_heartbeat, "2026-07-24T00:00:08.000Z")
            .expect_err("late heartbeat cannot revive released Claim")
            .code,
        PROVISIONING_OPERATION_CAS_CONFLICT
    );
    assert_eq!(
        converge_step(&mut actor_b, &stale_progress)
            .expect_err("late Progress cannot rewrite terminal Attempt")
            .code,
        ATTEMPT_NOT_ACTIVE
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_audit_outbox",
            "operation_id='r2-c-terminal'"
        ),
        1
    );
    assert!(
        read_active_claim_for_operation(&actor_b, &input.operation_id)
            .expect("read released Claim")
            .is_none()
    );
    let final_attempt = read_operation_attempt(&actor_b, &input.operation_id)
        .expect("read terminal Attempt")
        .expect("terminal Attempt");
    assert_eq!(final_attempt.revision, 1);
    assert_eq!(final_attempt.terminal_at.as_deref(), Some(T5));

    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_progress_cleanup_terminal_cleanup_and_double_cleanup_are_monotonic() {
    let (path, mut setup) = file_v41("r2-c-cleanup");
    let active = review_input("r2-c-cleanup-active", "review-r2-c-cleanup-active");
    create_attempt_claim_plan_and_steps(&mut setup, &active).expect("create active cleanup case");
    assert_eq!(
        execute_progress_cleanup(&mut setup, &active.operation_id, "2026-07-25T00:00:00.000Z")
            .expect_err("active Attempt must be retained")
            .code,
        CLEANUP_PROGRESS_RETAINED
    );
    assert_eq!(
        mark_step_started(&mut setup, &progress_authority(&active, 0, T1))
            .expect("Progress remains legal after retained cleanup")
            .status,
        ProgressMutationStatus::Applied
    );

    let mut eligible = review_input("r2-c-cleanup-eligible", "review-r2-c-cleanup-eligible");
    eligible.plan.plan_id = HASH_F.to_string();
    eligible.steps[0].step_id = HASH_G.to_string();
    setup_cleanup(&mut setup, &eligible);
    let stale_progress = progress_authority(&eligible, 4, "2026-07-24T00:00:06.000Z");
    let stale_terminal = TerminalAttemptInput::completed(
        &eligible.operation_id,
        &eligible.claim_id,
        &eligible.claim_owner_token,
        0,
        0,
        "2026-07-24T00:00:06.000Z",
    );
    drop(setup);

    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    let deleted = execute_progress_cleanup(
        &mut actor_a,
        &eligible.operation_id,
        "2026-07-25T00:00:00.000Z",
    )
    .expect("Actor A cleanup winner");
    assert_eq!(deleted.deleted_steps, 1);
    assert_eq!(deleted.deleted_plans, 1);
    assert_eq!(deleted.deleted_attempts, 1);
    assert_eq!(deleted.deleted_outboxes, 1);
    assert_eq!(
        execute_progress_cleanup(
            &mut actor_b,
            &eligible.operation_id,
            "2026-07-25T00:00:00.000Z"
        )
        .expect_err("Actor B double cleanup loser")
        .code,
        PROVISIONING_OPERATION_NOT_FOUND
    );
    assert_eq!(
        converge_step(&mut actor_b, &stale_progress)
            .expect_err("stale Progress cannot rebuild deleted authority")
            .code,
        PROVISIONING_OPERATION_NOT_FOUND
    );
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(&mut actor_b, &stale_terminal)
            .expect_err("stale terminal cannot rebuild deleted authority")
            .code,
        PROVISIONING_OPERATION_NOT_FOUND
    );
    for table in [
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_step_plans",
        "manuscript_provisioning_step_progress",
        "manuscript_provisioning_audit_outbox",
    ] {
        assert_eq!(
            count_rows(&actor_b, table, "operation_id='r2-c-cleanup-eligible'"),
            0,
            "cleanup must not leave a partial authority shell in {table}"
        );
    }

    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_double_recovery_old_heartbeat_and_old_callback_keep_one_chain() {
    let (path, mut setup) = file_v41("r2-c-recovery");
    let old = review_input("r2-c-recovery-old", "review-r2-c-recovery");
    let stale_replacement = setup_recovery(&mut setup, &old);
    let old_claim = read_active_claim_for_operation(&setup, &old.operation_id)
        .expect("read observed old Claim")
        .expect("old Claim");
    let stale_heartbeat = claim_cas_for_test(&old_claim);
    let stale_progress = progress_authority(&old, 0, "2026-07-24T00:10:02.000Z");
    drop(setup);

    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    let winner = replace_claim_for_recovery(&mut actor_a, &stale_replacement)
        .expect("Actor A replacement winner");
    assert_eq!(
        winner.new_attempt.previous_operation_id.as_deref(),
        Some(old.operation_id.as_str())
    );
    assert_eq!(
        replace_claim_for_recovery(&mut actor_b, &stale_replacement)
            .expect_err("Actor B double recovery loser")
            .code,
        PROVISIONING_RECOVERY_PRECONDITION_CHANGED
    );
    assert_eq!(
        record_claim_heartbeat(&mut actor_b, &stale_heartbeat, "2026-07-24T00:10:03.000Z")
            .expect_err("old heartbeat cannot recreate old Claim")
            .code,
        PROVISIONING_OPERATION_CAS_CONFLICT
    );
    assert_eq!(
        mark_step_started(&mut actor_b, &stale_progress)
            .expect_err("old callback cannot rewrite replaced Attempt")
            .code,
        ATTEMPT_NOT_ACTIVE
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_operation_attempts",
            "previous_operation_id='r2-c-recovery-old'"
        ),
        1
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_active_claims",
            "owner_id='review-r2-c-recovery'"
        ),
        1
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_audit_outbox",
            "operation_id='r2-c-recovery-old'"
        ),
        1
    );
    let new_attempt = read_operation_attempt(&actor_b, &stale_replacement.new_operation_id)
        .expect("read successor")
        .expect("one successor");
    assert_eq!(
        new_attempt.root_operation_id.as_deref(),
        Some(old.operation_id.as_str())
    );
    let old_attempt = read_operation_attempt(&actor_b, &old.operation_id)
        .expect("read predecessor")
        .expect("old Attempt retained");
    assert_eq!(old_attempt.revision, 1);
    assert_eq!(old_attempt.operation_status, "terminal-recovery-required");

    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_literature_shared_claim_and_projection_conflict_are_scope_exact() {
    let (path, mut setup) = file_v41("r2-c-literature-projection");
    let aggregate = aggregate_input("r2-c-literature-aggregate", "literature-r2-c-projection");
    create_attempt_claim_plan_and_steps(&mut setup, &aggregate).expect("create aggregate");
    drop(setup);

    let outline = child_input(
        &aggregate,
        "r2-c-literature-outline-a",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    let mut competing_outline = child_input(
        &aggregate,
        "r2-c-literature-outline-b",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        1,
    );
    competing_outline.plan.plan_id = HASH_F.to_string();
    competing_outline.steps[0].step_id = HASH_G.to_string();
    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    create_literature_child_durable_attempt(&mut actor_a, &outline)
        .expect("Actor A assigns outline projection");
    let after_winner = authority_snapshot(&actor_b);
    assert_eq!(
        create_literature_child_durable_attempt(&mut actor_b, &competing_outline)
            .expect_err("Actor B carries current Claim but stale projection revision")
            .code,
        LITERATURE_PROJECTION_CONFLICT
    );
    assert_eq!(
        authority_snapshot(&actor_b),
        after_winner,
        "projection loser must roll back Attempt, Plan and Step as one transaction"
    );

    let projections =
        read_literature_child_projections(&actor_b, &aggregate.operation_id).expect("projections");
    let notes_projection = projections
        .iter()
        .find(|row| row.manuscript_channel == DurableManuscriptChannel::DedicatedNotes)
        .expect("notes projection remains aggregate-scoped");
    assert_eq!(
        notes_projection.current_operation_id,
        aggregate.operation_id
    );
    assert_eq!(notes_projection.revision, 0);
    let mut notes = child_input(
        &aggregate,
        "r2-c-literature-notes",
        DurableManuscriptChannel::DedicatedNotes,
        0,
        1,
    );
    notes.plan.plan_id = HASH_F.to_string();
    notes.steps[0].step_id = HASH_G.to_string();
    create_literature_child_durable_attempt(&mut actor_b, &notes)
        .expect("sibling notes scope remains independently assignable");

    assert!(
        read_active_claim_for_operation(&actor_b, &outline.operation_id)
            .expect("outline direct Claim")
            .is_none()
    );
    assert!(
        read_active_claim_for_operation(&actor_b, &notes.operation_id)
            .expect("notes direct Claim")
            .is_none()
    );
    let shared_claim = read_active_claim_for_operation(&actor_b, &aggregate.operation_id)
        .expect("shared Claim")
        .expect("one aggregate Claim");
    assert_eq!(shared_claim.claim_revision, 2);
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_active_claims",
            "owner_id='literature-r2-c-projection'"
        ),
        1
    );

    let mut conflicting_aggregate = aggregate_input(
        "r2-c-literature-aggregate-conflict",
        "literature-r2-c-projection",
    );
    conflicting_aggregate.plan.plan_id = HASH_G.to_string();
    conflicting_aggregate.steps[0].step_id = HASH_F.to_string();
    assert_eq!(
        create_attempt_claim_plan_and_steps(&mut actor_b, &conflicting_aggregate)
            .expect_err("aggregate/channel authority cannot create a second Claim")
            .code,
        ACTIVE_CLAIM_CONFLICT
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_operation_attempts",
            "operation_id='r2-c-literature-outline-b'"
        ),
        0
    );

    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_last_child_and_explicit_aggregate_terminal_cannot_double_complete() {
    let (path, mut setup) = file_v41("r2-c-literature-terminal");
    let aggregate = aggregate_input(
        "r2-c-literature-terminal-aggregate",
        "literature-r2-c-terminal",
    );
    let notes = setup_literature_final_terminal(&mut setup, &aggregate);
    let stale_explicit_aggregate = TerminalAttemptInput::completed(
        &aggregate.operation_id,
        &aggregate.claim_id,
        &aggregate.claim_owner_token,
        0,
        3,
        "2026-07-24T00:00:07.000Z",
    );
    let last_child = TerminalAttemptInput::completed(
        &notes.operation_id,
        &aggregate.claim_id,
        &aggregate.claim_owner_token,
        0,
        3,
        "2026-07-24T00:00:07.000Z",
    );
    drop(setup);

    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    let winner = terminalize_literature_child_attempt(&mut actor_a, &last_child)
        .expect("last child drives aggregate terminal");
    assert_eq!(winner.aggregate.operation_status, "terminal-completed");
    assert!(winner.aggregate_claim.is_none());
    assert!(winner.aggregate_outbox.is_some());
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(
            &mut actor_b,
            &stale_explicit_aggregate
        )
        .expect_err("explicit aggregate terminal loses after child-driven terminal")
        .code,
        PROVISIONING_OPERATION_CAS_CONFLICT
    );
    assert_eq!(
        terminalize_literature_child_attempt(&mut actor_b, &last_child)
            .expect_err("second child completion cannot release Claim twice")
            .code,
        CLAIM_HOLDER_MISMATCH
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_audit_outbox",
            "operation_id='r2-c-literature-terminal-aggregate'"
        ),
        1
    );
    assert_eq!(
        count_rows(
            &actor_b,
            "manuscript_provisioning_audit_outbox",
            "operation_id<>'r2-c-literature-terminal-aggregate'"
        ),
        0
    );
    assert!(
        read_active_claim_for_operation(&actor_b, &aggregate.operation_id)
            .expect("aggregate Claim released")
            .is_none()
    );
    let projections =
        read_literature_child_projections(&actor_b, &aggregate.operation_id).expect("projections");
    assert_eq!(projections.len(), 2);
    assert!(projections
        .iter()
        .all(|projection| projection.child_summary_status.as_str() == "terminal-completed"));
    let aggregate_after = read_operation_attempt(&actor_b, &aggregate.operation_id)
        .expect("read aggregate")
        .expect("aggregate retained");
    assert_eq!(aggregate_after.revision, 1);
    assert_eq!(
        aggregate_after.terminal_at.as_deref(),
        Some("2026-07-24T00:00:07.000Z")
    );

    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_literature_terminal_cleanup_removes_projection_atomically_and_never_revives() {
    let (path, mut setup) = file_v41("r2-c-literature-cleanup");
    let aggregate = aggregate_input(
        "r2-c-literature-cleanup-aggregate",
        "literature-r2-c-cleanup",
    );
    setup_cleanup(&mut setup, &aggregate);
    let stale_terminal = TerminalAttemptInput::completed(
        &aggregate.operation_id,
        &aggregate.claim_id,
        &aggregate.claim_owner_token,
        0,
        0,
        "2026-07-24T00:00:06.000Z",
    );
    drop(setup);

    let mut actor_a = actor_connection(&path);
    let mut actor_b = actor_connection(&path);
    let deleted = execute_progress_cleanup(
        &mut actor_a,
        &aggregate.operation_id,
        "2026-07-25T00:00:00.000Z",
    )
    .expect("Literature aggregate cleanup winner");
    assert_eq!(deleted.deleted_projections, 2);
    assert_eq!(
        terminalize_attempt_release_claim_and_enqueue_audit(&mut actor_b, &stale_terminal)
            .expect_err("late Literature terminal cannot recreate Projection or Attempt")
            .code,
        PROVISIONING_OPERATION_NOT_FOUND
    );
    for table in [
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_step_plans",
        "manuscript_provisioning_step_progress",
        "manuscript_provisioning_literature_child_states",
        "manuscript_provisioning_audit_outbox",
    ] {
        let predicate = if table == "manuscript_provisioning_literature_child_states" {
            "aggregate_operation_id='r2-c-literature-cleanup-aggregate'"
        } else {
            "operation_id='r2-c-literature-cleanup-aggregate'"
        };
        assert_eq!(
            count_rows(&actor_b, table, predicate),
            0,
            "Literature cleanup must remove the whole authority leaf set from {table}"
        );
    }

    drop(actor_b);
    drop(actor_a);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_c_sqlite_lock_contention_is_busy_or_locked_without_partial_state() {
    {
        let (path, mut setup) = file_v41("r2-c-lock-progress");
        let input = review_input("r2-c-lock-progress", "review-r2-c-lock-progress");
        create_attempt_claim_plan_and_steps(&mut setup, &input).expect("Progress lock fixture");
        let before = authority_snapshot(&setup);
        drop(setup);
        assert_lock_contention(&path, &before, |connection| {
            mark_step_started(connection, &progress_authority(&input, 0, T1))
        });
        remove_isolated_v41(path);
    }
    {
        let (path, mut setup) = file_v41("r2-c-lock-terminal");
        let input = review_input("r2-c-lock-terminal", "review-r2-c-lock-terminal");
        setup_terminal(&mut setup, &input);
        let terminal = TerminalAttemptInput::completed(
            &input.operation_id,
            &input.claim_id,
            &input.claim_owner_token,
            0,
            0,
            T5,
        );
        let before = authority_snapshot(&setup);
        drop(setup);
        assert_lock_contention(&path, &before, |connection| {
            terminalize_attempt_release_claim_and_enqueue_audit(connection, &terminal)
        });
        remove_isolated_v41(path);
    }
    {
        let (path, mut setup) = file_v41("r2-c-lock-recovery");
        let old = review_input("r2-c-lock-recovery-old", "review-r2-c-lock-recovery");
        let replacement = setup_recovery(&mut setup, &old);
        let before = authority_snapshot(&setup);
        drop(setup);
        assert_lock_contention(&path, &before, |connection| {
            replace_claim_for_recovery(connection, &replacement)
        });
        remove_isolated_v41(path);
    }
    {
        let (path, mut setup) = file_v41("r2-c-lock-literature");
        let aggregate = aggregate_input("r2-c-lock-literature", "literature-r2-c-lock");
        create_attempt_claim_plan_and_steps(&mut setup, &aggregate)
            .expect("Literature lock fixture");
        let child = child_input(
            &aggregate,
            "r2-c-lock-literature-child",
            DurableManuscriptChannel::LiteratureOutline,
            0,
            0,
        );
        let before = authority_snapshot(&setup);
        drop(setup);
        assert_lock_contention(&path, &before, |connection| {
            create_literature_child_durable_attempt(connection, &child)
        });
        remove_isolated_v41(path);
    }
    {
        let (path, mut setup) = file_v41("r2-c-lock-cleanup");
        let input = review_input("r2-c-lock-cleanup", "review-r2-c-lock-cleanup");
        setup_cleanup(&mut setup, &input);
        let before = authority_snapshot(&setup);
        drop(setup);
        assert_lock_contention(&path, &before, |connection| {
            execute_progress_cleanup(connection, &input.operation_id, "2026-07-25T00:00:00.000Z")
        });
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_c_source_gate_requires_controlled_file_backed_interleavings() {
    let source = include_str!("manuscript_provisioning_step_progress_p4_2e_tests.rs");
    assert!(
        !source.contains(concat!("thread::", "sleep")),
        "R2-C ordering must never depend on sleep"
    );
    for required in [
        "fn actor_connection",
        "busy_timeout(Duration::ZERO)",
        "fn assert_lock_contention",
        "TransactionBehavior::Immediate",
        "assert_sqlite_busy_5",
        "authority_snapshot",
        "p4_2e_r2_c_progress_interleaving",
        "p4_2e_r2_c_double_recovery",
        "p4_2e_r2_c_literature_shared_claim",
        "p4_2e_r2_c_sqlite_lock_contention",
    ] {
        assert!(
            source.contains(required),
            "R2-C controlled-interleaving evidence missing: {required}"
        );
    }
    let repository =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    let runtime = include_str!("manuscript_provisioning_operation_state/runtime.rs");
    let production = format!("{repository}\n{runtime}");
    for forbidden in [
        "R2_C_PAUSE",
        "r2_c_pause",
        "concurrency_feature",
        "std::env::var",
    ] {
        assert!(
            !production.contains(forbidden),
            "R2-C must not add a production pause/configuration seam: {forbidden}"
        );
    }
}

fn query_snapshot(connection: &Connection, label: &str, sql: &str) -> Vec<String> {
    let mut statement = connection.prepare(sql).expect("prepare stable snapshot");
    let column_count = statement.column_count();
    statement
        .query_map([], |row| {
            let values = (0..column_count)
                .map(|index| format!("{:?}", row.get_ref(index).expect("snapshot value")))
                .collect::<Vec<_>>()
                .join("|");
            Ok(format!("{label}:{values}"))
        })
        .expect("query stable snapshot")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect stable snapshot")
}

fn meta_snapshot(connection: &Connection) -> Vec<String> {
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read meta user_version");
    let mut snapshot = vec![format!("user-version:{user_version}")];
    snapshot.extend(query_snapshot(
        connection,
        "migration",
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    ));
    snapshot.extend(query_snapshot(
        connection,
        "schema",
        "SELECT type, name, tbl_name, COALESCE(sql, '')
         FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name, tbl_name",
    ));
    snapshot.extend(query_snapshot(
        connection,
        "operation-log",
        "SELECT id, operation_type, source, module, status, created_at, updated_at
         FROM operation_logs ORDER BY created_at, id",
    ));
    snapshot
}

fn assert_read_only_trace(trace: &[SqlTraceEvent]) {
    assert!(
        !trace.is_empty(),
        "production read entry must be visible in SQL trace"
    );
    for event in trace {
        assert!(
            !matches!(
                event.statement_kind.as_str(),
                "INSERT"
                    | "UPDATE"
                    | "DELETE"
                    | "REPLACE"
                    | "CREATE"
                    | "ALTER"
                    | "DROP"
                    | "VACUUM"
                    | "BEGIN"
                    | "COMMIT"
                    | "ROLLBACK"
            ),
            "zero-write entry emitted forbidden SQL kind: {:?}",
            event
        );
    }
}

fn assert_actual_connection_zero_write<T>(
    connection: &mut Connection,
    production_call: impl FnOnce(&Connection) -> T,
) -> T {
    let changes_before = connection.total_changes();
    let authority_before = authority_snapshot(connection);
    let meta_before = meta_snapshot(connection);
    start_sql_trace(connection);
    let result = production_call(connection);
    let trace = finish_sql_trace(connection);
    assert_eq!(
        connection.total_changes(),
        changes_before,
        "total_changes must come from and remain unchanged on the actual execution Connection"
    );
    assert_eq!(authority_snapshot(connection), authority_before);
    assert_eq!(meta_snapshot(connection), meta_before);
    assert_read_only_trace(&trace);
    result
}

fn reopen_r2_d_fixture(path: &PathBuf, expected_foreign_key_violations: usize) -> Connection {
    let connection = actor_connection(path);
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .expect("quick_check completed fixture");
    assert_eq!(quick_check, "ok");
    let foreign_key_violations = {
        let mut statement = connection
            .prepare("PRAGMA foreign_key_check")
            .expect("prepare foreign_key_check");
        statement
            .query([])
            .expect("query foreign_key_check")
            .mapped(|row| row.get::<_, String>(0))
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect foreign_key_check")
            .len()
    };
    assert_eq!(
        foreign_key_violations, expected_foreign_key_violations,
        "fixture FK state must be explicit before the zero-write baseline"
    );
    connection
}

fn file_sha256(path: &PathBuf) -> String {
    format!(
        "{:x}",
        Sha256::digest(fs::read(path).expect("read isolated SQLite for file hash"))
    )
}

fn isolated_file_fixture(label: &str) -> (PathBuf, Connection) {
    let id = NEXT_TEMP_DB.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "labpod-p4-2e-r2-d-{label}-{}-{id}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("create isolated R2-D temp directory");
    let path = root.join("labpod.sqlite3");
    let connection = Connection::open(&path).expect("open isolated R2-D SQLite");
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
        .expect("set isolated DELETE journal mode");
    assert_eq!(journal_mode, "delete");
    (path, connection)
}

fn capability_snapshot(connection: &Connection) -> Vec<String> {
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read capability user_version");
    let mut snapshot = vec![format!("user-version:{user_version}")];
    snapshot.extend(query_snapshot(
        connection,
        "schema",
        "SELECT type, name, tbl_name, COALESCE(sql, '')
         FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name, tbl_name",
    ));
    for (label, table, sql) in [
        (
            "migration",
            "schema_migrations",
            "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
        ),
        (
            "operation-log",
            "operation_logs",
            "SELECT id, operation_type, source, module, status, created_at, updated_at
             FROM operation_logs ORDER BY created_at, id",
        ),
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .expect("read capability meta table presence");
        if exists == 1 {
            snapshot.extend(query_snapshot(connection, label, sql));
        }
    }
    snapshot
}

fn reopen_capability_fixture(path: &PathBuf) -> Connection {
    let connection = actor_connection(path);
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .expect("quick_check capability fixture");
    assert_eq!(quick_check, "ok");
    let violation_count = connection
        .prepare("PRAGMA foreign_key_check")
        .expect("prepare capability foreign_key_check")
        .query([])
        .expect("query capability foreign_key_check")
        .mapped(|row| row.get::<_, String>(0))
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect capability foreign_key_check")
        .len();
    assert_eq!(violation_count, 0);
    connection
}

fn assert_capability_file_zero_write(
    path: &PathBuf,
    mut connection: Connection,
    expected: SchemaCapability,
) {
    let hash_before = file_sha256(path);
    let changes_before = connection.total_changes();
    let meta_before = capability_snapshot(&connection);
    start_sql_trace(&mut connection);
    let actual = check_sqlite_schema_capability(&connection);
    let trace = finish_sql_trace(&mut connection);
    assert_eq!(actual, expected);
    assert_eq!(connection.total_changes(), changes_before);
    assert_eq!(capability_snapshot(&connection), meta_before);
    assert_read_only_trace(&trace);
    drop(connection);
    assert_eq!(file_sha256(path), hash_before);
}

fn matrix_review_input(
    index: u64,
    operation_id: &str,
    owner_id: &str,
) -> AtomicDurableAttemptInput {
    let mut input = review_input(operation_id, owner_id);
    input.claim_owner_token = "scanner-token".to_string();
    input.plan.plan_id = format!("{:064x}", 10_000 + index * 2);
    input.steps[0].step_id = format!("{:064x}", 10_001 + index * 2);
    input
}

fn matrix_aggregate_input(
    index: u64,
    operation_id: &str,
    owner_id: &str,
) -> AtomicDurableAttemptInput {
    let mut input = aggregate_input(operation_id, owner_id);
    input.claim_owner_token = "scanner-token".to_string();
    input.plan.plan_id = format!("{:064x}", 20_000 + index * 4);
    input.steps[0].step_id = format!("{:064x}", 20_001 + index * 4);
    input
}

fn matrix_child_input(
    index: u64,
    aggregate: &AtomicDurableAttemptInput,
    operation_id: &str,
    channel: DurableManuscriptChannel,
    projection_revision: i64,
    claim_revision: i64,
) -> LiteratureChildDurableAttemptInput {
    let mut input = child_input(
        aggregate,
        operation_id,
        channel,
        projection_revision,
        claim_revision,
    );
    input.plan.plan_id = format!("{:064x}", 30_000 + index * 4);
    input.steps[0].step_id = format!("{:064x}", 30_001 + index * 4);
    input
}

fn assert_cleanup_decision(
    connection: &mut Connection,
    operation_id: &str,
    terminal_before: &str,
    eligible: bool,
    reasons: &[&'static str],
) {
    let decision = assert_actual_connection_zero_write(connection, |actual| {
        dry_run_progress_cleanup(actual, operation_id, terminal_before)
    })
    .expect("cleanup dry-run decision");
    assert_eq!(decision.operation_id, operation_id);
    assert_eq!(
        decision.eligible, eligible,
        "cleanup eligibility mismatch for {operation_id}: {:?}",
        decision.reasons
    );
    assert_eq!(
        decision.reasons, reasons,
        "cleanup reasons mismatch for {operation_id}"
    );
}

fn assert_cleanup_error(connection: &mut Connection, operation_id: &str, expected_code: &str) {
    let error = assert_actual_connection_zero_write(connection, |actual| {
        dry_run_progress_cleanup(actual, operation_id, "2026-07-25T00:00:00.000Z")
    })
    .expect_err("cleanup dry-run must fail closed");
    assert_eq!(error.code, expected_code);
}

fn advance_fixture_to(
    connection: &mut Connection,
    input: &AtomicDurableAttemptInput,
    boundary: &str,
) {
    if boundary == "intended" {
        return;
    }
    mark_step_started(connection, &progress_authority(input, 0, T1)).expect("fixture started");
    if boundary == "started" {
        return;
    }
    record_step_effect_observed(
        connection,
        &progress_authority(input, 1, T2),
        DurableStepEffectOutcome::Created,
        HASH_A,
        Some("r2-d-resource"),
    )
    .expect("fixture effect observed");
    if boundary == "effect-observed" {
        return;
    }
    record_step_readback_verified(connection, &progress_authority(input, 2, T3))
        .expect("fixture readback verified");
    if boundary == "readback-verified" {
        return;
    }
    converge_step(connection, &progress_authority(input, 3, T4)).expect("fixture converged");
}

#[test]
fn p4_2e_r2_d_startup_progress_claim_matrix_is_actual_connection_dual_zero() {
    let (path, mut fixture) = file_v41("r2-d-startup-progress");
    let states = [
        ("intended", "r2-d-scan-intended"),
        ("started", "r2-d-scan-started"),
        ("effect-observed", "r2-d-scan-effect"),
        ("readback-verified", "r2-d-scan-readback"),
        ("converged", "r2-d-scan-converged"),
    ];
    let mut inputs = Vec::new();
    for (index, (boundary, operation_id)) in states.iter().enumerate() {
        let input = matrix_review_input(
            index as u64 + 1,
            operation_id,
            &format!("owner-{operation_id}"),
        );
        create_attempt_claim_plan_and_steps(&mut fixture, &input).expect("create scan fixture");
        advance_fixture_to(&mut fixture, &input, boundary);
        inputs.push(input);
    }
    let missing_claim = matrix_review_input(10, "r2-d-scan-missing-claim", "owner-missing-claim");
    create_attempt_claim_plan_and_steps(&mut fixture, &missing_claim)
        .expect("create missing Claim fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_active_claims WHERE operation_id=?1",
            [&missing_claim.operation_id],
        )
        .expect("remove Claim during fixture preparation");
    let claim_mismatch =
        matrix_review_input(11, "r2-d-scan-claim-mismatch", "owner-claim-mismatch");
    create_attempt_claim_plan_and_steps(&mut fixture, &claim_mismatch)
        .expect("create Claim mismatch fixture");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET owner_id='other-owner' WHERE operation_id=?1",
            [&claim_mismatch.operation_id],
        )
        .expect("create Claim identity mismatch without schema change");
    let heartbeat = matrix_review_input(12, "r2-d-scan-heartbeat", "owner-heartbeat");
    let heartbeat_created = create_attempt_claim_plan_and_steps(&mut fixture, &heartbeat)
        .expect("create heartbeat fixture");
    record_claim_heartbeat(
        &mut fixture,
        &claim_cas_for_test(&heartbeat_created.claim),
        T1,
    )
    .expect("fixed-time heartbeat fixture");
    let mut crash = matrix_review_input(13, "r2-d-scan-crash", "owner-crash");
    crash.claim_owner_token = "other-instance-token".to_string();
    create_attempt_claim_plan_and_steps(&mut fixture, &crash).expect("crash-holder fixture");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let candidates = assert_actual_connection_zero_write(&mut connection, |actual| {
        scan_sqlite_runtime_candidates(actual, "scanner-token", T2)
    })
    .expect("scan exact-v41 progress matrix");
    assert_eq!(candidates.len(), 9);
    for input in &inputs {
        let candidate = candidates
            .iter()
            .find(|value| value.operation_id == input.operation_id)
            .expect("matrix candidate");
        let boundary = states
            .iter()
            .find(|(_, operation_id)| *operation_id == input.operation_id)
            .expect("matrix boundary")
            .0;
        if boundary == "intended" {
            assert_eq!(candidate.result_classification, None);
            assert_eq!(candidate.next_action, None);
            assert_eq!(candidate.safe_error_code, None);
        } else {
            assert_eq!(
                candidate.result_classification.as_deref(),
                Some("provisioning-recovery-required")
            );
            assert_eq!(candidate.next_action.as_deref(), Some("recover"));
            assert_eq!(
                candidate.safe_error_code.as_deref(),
                Some("durable-progress-recovery-required")
            );
        }
    }
    for operation_id in [
        missing_claim.operation_id.as_str(),
        claim_mismatch.operation_id.as_str(),
        heartbeat.operation_id.as_str(),
    ] {
        let candidate = candidates
            .iter()
            .find(|value| value.operation_id == operation_id)
            .expect("Claim matrix candidate");
        assert_eq!(candidate.operation_status, "active");
        assert_eq!(candidate.result_classification, None);
        assert_eq!(candidate.safe_error_code, None);
    }
    let crash_candidate = candidates
        .iter()
        .find(|value| value.operation_id == crash.operation_id)
        .expect("crash-holder candidate");
    assert_eq!(
        crash_candidate.stale_kind,
        Some(RuntimeIssueKind::CrashCandidate)
    );
    let summary = normalize_runtime_issues(candidates);
    assert_eq!(summary.business_issue_count, 9);
    assert_eq!(summary.audit_issue_count, 0);
    assert_eq!(
        summary
            .issues
            .iter()
            .filter(|issue| issue.kind == RuntimeIssueKind::RecoveryRequired)
            .count(),
        4
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_d_startup_audit_matrix_is_actual_connection_dual_zero() {
    let (path, mut fixture) = file_v41("r2-d-startup-audit");
    let pending = matrix_review_input(20, "r2-d-audit-pending", "owner-audit-pending");
    setup_terminal(&mut fixture, &pending);
    terminalize_attempt_release_claim_and_enqueue_audit(
        &mut fixture,
        &TerminalAttemptInput::completed(
            &pending.operation_id,
            &pending.claim_id,
            &pending.claim_owner_token,
            0,
            0,
            T5,
        ),
    )
    .expect("pending Outbox fixture");
    let failed = matrix_review_input(21, "r2-d-audit-failed", "owner-audit-failed");
    setup_terminal(&mut fixture, &failed);
    terminalize_attempt_release_claim_and_enqueue_audit(
        &mut fixture,
        &TerminalAttemptInput::completed(
            &failed.operation_id,
            &failed.claim_id,
            &failed.claim_owner_token,
            0,
            0,
            T5,
        ),
    )
    .expect("failed Outbox base fixture");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_audit_outbox
             SET delivery_status='failed', revision=1, delivery_attempt_count=1,
                 error_code='CONTROLLED_AUDIT_FAILURE'
             WHERE operation_id=?1",
            [&failed.operation_id],
        )
        .expect("mark failed Outbox fixture");
    let delivered = matrix_review_input(22, "r2-d-audit-delivered", "owner-audit-delivered");
    setup_cleanup(&mut fixture, &delivered);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let candidates = assert_actual_connection_zero_write(&mut connection, |actual| {
        scan_sqlite_audit_candidates(actual)
    })
    .expect("scan exact-v41 audit matrix");
    assert_eq!(candidates.len(), 2);
    let pending_candidate = candidates
        .iter()
        .find(|value| value.operation_id == pending.operation_id)
        .expect("pending audit candidate");
    assert_eq!(pending_candidate.audit_status.as_deref(), Some("pending"));
    let failed_candidate = candidates
        .iter()
        .find(|value| value.operation_id == failed.operation_id)
        .expect("failed audit candidate");
    assert_eq!(failed_candidate.audit_status.as_deref(), Some("failed"));
    assert!(candidates
        .iter()
        .all(|value| value.operation_id != delivered.operation_id));
    let summary = normalize_runtime_issues(candidates);
    assert_eq!(summary.business_issue_count, 0);
    assert_eq!(summary.audit_issue_count, 2);
    assert_eq!(
        summary
            .issues
            .iter()
            .map(|issue| issue.kind)
            .collect::<Vec<_>>(),
        vec![
            RuntimeIssueKind::AuditFailed,
            RuntimeIssueKind::AuditPending
        ]
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[derive(Debug)]
struct R2DReadFailureAccess;

impl SchemaCapabilityAccess for R2DReadFailureAccess {
    fn read_user_version(&self) -> Result<i64, ()> {
        Err(())
    }

    fn validate_composed_contracts(&self) -> Result<bool, ()> {
        panic!("read failure must short-circuit before schema validation")
    }
}

#[test]
fn p4_2e_r2_d_capability_unavailable_matrix_is_file_level_zero_write() {
    {
        let (path, fixture) = isolated_file_fixture("capability-v39");
        fixture
            .execute_batch("PRAGMA user_version=39;")
            .expect("set explicit not-migrated fixture version");
        drop(fixture);
        let connection = reopen_capability_fixture(&path);
        assert_capability_file_zero_write(
            &path,
            connection,
            SchemaCapability::UnavailableNotMigrated,
        );
        remove_isolated_v41(path);
    }
    {
        let (path, fixture) = file_v41("r2-d-capability-invalid-v41");
        fixture
            .execute_batch("DROP INDEX uq_manuscript_provisioning_step_plan_operation;")
            .expect("prepare invalid/tampered-v41 fixture");
        drop(fixture);
        let connection = reopen_capability_fixture(&path);
        assert_capability_file_zero_write(
            &path,
            connection,
            SchemaCapability::UnavailableInvalidSchema,
        );
        remove_isolated_v41(path);
    }
    {
        let (path, fixture) = file_v41("r2-d-capability-future-version");
        fixture
            .pragma_update(None, "user_version", schema::CURRENT_SCHEMA_VERSION + 1)
            .expect("prepare higher-version fixture");
        drop(fixture);
        let connection = reopen_capability_fixture(&path);
        assert_capability_file_zero_write(
            &path,
            connection,
            SchemaCapability::UnavailableInvalidSchema,
        );
        remove_isolated_v41(path);
    }
    {
        let (path, fixture) = isolated_file_fixture("capability-read-failure-sentinel");
        fixture
            .execute_batch(
                "CREATE TABLE read_failure_sentinel (
                   id INTEGER PRIMARY KEY,
                   marker TEXT NOT NULL
                 );
                 INSERT INTO read_failure_sentinel(id, marker) VALUES (1, 'bounded-sentinel');",
            )
            .expect("prepare read-failure sentinel");
        drop(fixture);
        let hash_before = file_sha256(&path);
        assert_eq!(
            check_schema_capability(&R2DReadFailureAccess),
            SchemaCapability::ReadFailed
        );
        assert_eq!(file_sha256(&path), hash_before);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_d_cleanup_basic_and_structure_matrix_is_actual_connection_dual_zero() {
    let (path, mut fixture) = file_v41("r2-d-cleanup-basic");

    let eligible = matrix_review_input(100, "r2-d-cleanup-eligible", "owner-cleanup-eligible");
    setup_cleanup(&mut fixture, &eligible);

    let intended = matrix_review_input(101, "r2-d-cleanup-intended", "owner-cleanup-intended");
    create_attempt_claim_plan_and_steps(&mut fixture, &intended).expect("intended fixture");

    let started = matrix_review_input(102, "r2-d-cleanup-started", "owner-cleanup-started");
    create_attempt_claim_plan_and_steps(&mut fixture, &started).expect("started fixture");
    advance_fixture_to(&mut fixture, &started, "started");

    let effect = matrix_review_input(103, "r2-d-cleanup-effect", "owner-cleanup-effect");
    create_attempt_claim_plan_and_steps(&mut fixture, &effect).expect("effect fixture");
    advance_fixture_to(&mut fixture, &effect, "effect-observed");

    let readback = matrix_review_input(104, "r2-d-cleanup-readback", "owner-cleanup-readback");
    create_attempt_claim_plan_and_steps(&mut fixture, &readback).expect("readback fixture");
    advance_fixture_to(&mut fixture, &readback, "readback-verified");

    let converged = matrix_review_input(105, "r2-d-cleanup-converged", "owner-cleanup-converged");
    create_attempt_claim_plan_and_steps(&mut fixture, &converged).expect("converged fixture");
    advance_fixture_to(&mut fixture, &converged, "converged");

    let pending = matrix_review_input(106, "r2-d-cleanup-pending", "owner-cleanup-pending");
    setup_terminal(&mut fixture, &pending);
    terminalize_attempt_release_claim_and_enqueue_audit(
        &mut fixture,
        &TerminalAttemptInput::completed(
            &pending.operation_id,
            &pending.claim_id,
            &pending.claim_owner_token,
            0,
            0,
            T5,
        ),
    )
    .expect("pending Outbox fixture");

    let failed = matrix_review_input(107, "r2-d-cleanup-failed", "owner-cleanup-failed");
    setup_terminal(&mut fixture, &failed);
    terminalize_attempt_release_claim_and_enqueue_audit(
        &mut fixture,
        &TerminalAttemptInput::completed(
            &failed.operation_id,
            &failed.claim_id,
            &failed.claim_owner_token,
            0,
            0,
            T5,
        ),
    )
    .expect("failed Outbox base fixture");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_audit_outbox
             SET delivery_status='failed', revision=1, delivery_attempt_count=1,
                 error_code='CONTROLLED_AUDIT_FAILURE'
             WHERE operation_id=?1",
            [&failed.operation_id],
        )
        .expect("failed Outbox fixture");

    let retention = matrix_review_input(108, "r2-d-cleanup-retention", "owner-cleanup-retention");
    setup_cleanup(&mut fixture, &retention);

    let missing_plan = matrix_review_input(
        109,
        "r2-d-cleanup-missing-plan",
        "owner-cleanup-missing-plan",
    );
    create_attempt_claim_plan_and_steps(&mut fixture, &missing_plan).expect("missing Plan fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&missing_plan.operation_id],
        )
        .expect("remove missing-Plan Step fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_plans WHERE operation_id=?1",
            [&missing_plan.operation_id],
        )
        .expect("remove Plan fixture");

    let missing_step = matrix_review_input(
        110,
        "r2-d-cleanup-missing-step",
        "owner-cleanup-missing-step",
    );
    create_attempt_claim_plan_and_steps(&mut fixture, &missing_step).expect("missing Step fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&missing_step.operation_id],
        )
        .expect("remove Step fixture");

    let malformed = matrix_review_input(111, "r2-d-cleanup-malformed", "owner-cleanup-malformed");
    create_attempt_claim_plan_and_steps(&mut fixture, &malformed).expect("malformed Step fixture");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET step_ordinal=1 WHERE operation_id=?1",
            [&malformed.operation_id],
        )
        .expect("prepare malformed ordinal fixture");

    let count_mismatch = matrix_review_input(112, "r2-d-cleanup-count", "owner-cleanup-count");
    create_attempt_claim_plan_and_steps(&mut fixture, &count_mismatch)
        .expect("Plan count mismatch fixture");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_step_plans
             SET step_count=2 WHERE operation_id=?1",
            [&count_mismatch.operation_id],
        )
        .expect("prepare Plan count mismatch fixture");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    assert_cleanup_decision(
        &mut connection,
        &eligible.operation_id,
        "2026-07-25T00:00:00.000Z",
        true,
        &[],
    );
    let active_nonconverged = [
        "active-claim",
        "audit-not-delivered",
        "progress-not-converged",
        "retention-not-satisfied",
        "unresolved-durable-condition",
    ];
    for input in [
        &intended,
        &started,
        &effect,
        &readback,
        &missing_step,
        &malformed,
        &count_mismatch,
    ] {
        assert_cleanup_decision(
            &mut connection,
            &input.operation_id,
            "2026-07-25T00:00:00.000Z",
            false,
            &active_nonconverged,
        );
    }
    assert_cleanup_decision(
        &mut connection,
        &converged.operation_id,
        "2026-07-25T00:00:00.000Z",
        false,
        &[
            "active-claim",
            "audit-not-delivered",
            "retention-not-satisfied",
            "unresolved-durable-condition",
        ],
    );
    for input in [&pending, &failed] {
        assert_cleanup_decision(
            &mut connection,
            &input.operation_id,
            "2026-07-25T00:00:00.000Z",
            false,
            &["audit-not-delivered"],
        );
    }
    assert_cleanup_decision(
        &mut connection,
        &retention.operation_id,
        T4,
        false,
        &["retention-not-satisfied"],
    );
    assert_cleanup_decision(
        &mut connection,
        &missing_plan.operation_id,
        "2026-07-25T00:00:00.000Z",
        false,
        &[
            "active-claim",
            "audit-not-delivered",
            "retention-not-satisfied",
            "structural-progress-corruption",
            "unresolved-durable-condition",
        ],
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_d_cleanup_chain_reference_matrix_is_actual_connection_dual_zero() {
    let (path, mut fixture) = file_v41("r2-d-cleanup-chain");
    let root = matrix_review_input(120, "r2-d-chain-root", "owner-chain-root");
    setup_cleanup(&mut fixture, &root);
    fixture
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               intent, trigger_kind, phase, operation_status,
               result_classification, next_action, partial_kind, revision,
               previous_operation_id, root_operation_id,
               folder_effect, manuscript_effect, file_ref_effect, binding_effect,
               final_verification_outcome, facts_schema_version,
               started_at, updated_at, terminal_at
             ) VALUES (
               'r2-d-chain-successor', 'channel', 'review', ?1, 'primary',
               'recover', 'explicit-recovery', 'preflight', 'active',
               NULL, NULL, NULL, 0, ?2, ?2,
               'none', 'none', 'none', 'none', 'not-run', 1, ?3, ?3, NULL
             )",
            params![root.owner_id, root.operation_id, T5],
        )
        .expect("prepare previous/root recovery successor reference");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    assert_cleanup_decision(
        &mut connection,
        &root.operation_id,
        "2026-07-25T00:00:00.000Z",
        false,
        &["attempt-or-recovery-reference"],
    );
    drop(connection);
    remove_isolated_v41(path);
}

fn setup_matrix_child(
    connection: &mut Connection,
    index: u64,
    label: &str,
) -> (
    AtomicDurableAttemptInput,
    LiteratureChildDurableAttemptInput,
) {
    let aggregate = matrix_aggregate_input(
        index,
        &format!("r2-d-{label}-aggregate"),
        &format!("owner-r2-d-{label}"),
    );
    create_attempt_claim_plan_and_steps(connection, &aggregate).expect("matrix aggregate");
    let child = matrix_child_input(
        index,
        &aggregate,
        &format!("r2-d-{label}-child"),
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    create_literature_child_durable_attempt(connection, &child).expect("matrix child");
    converge_child(connection, &aggregate, &child);
    (aggregate, child)
}

#[test]
fn p4_2e_r2_d_cleanup_literature_projection_matrix_is_actual_connection_dual_zero() {
    let (path, mut fixture) = file_v41("r2-d-cleanup-literature");

    let aggregate_ok =
        matrix_aggregate_input(130, "r2-d-lit-aggregate-ok", "owner-r2-d-lit-aggregate-ok");
    setup_cleanup(&mut fixture, &aggregate_ok);
    let duplicate_error = fixture
        .execute(
            "INSERT INTO manuscript_provisioning_literature_child_states (
               aggregate_operation_id, owner_type, owner_id, manuscript_channel,
               current_operation_id, current_operation_scope_kind, revision,
               child_summary_status, result_classification, next_action,
               default_readiness, final_verification_outcome, original_cause_code, updated_at
             )
             SELECT aggregate_operation_id, owner_type, owner_id, manuscript_channel,
                    current_operation_id, current_operation_scope_kind, revision,
                    child_summary_status, result_classification, next_action,
                    default_readiness, final_verification_outcome, original_cause_code, updated_at
             FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_ok.operation_id],
        )
        .expect_err("exact-v41 primary key must reject duplicate Projection");
    assert!(matches!(
        duplicate_error,
        Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
    ));
    let channel_conflict = fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET manuscript_channel='dedicated_notes'
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_ok.operation_id],
        )
        .expect_err("exact-v41 primary key must reject aggregate channel conflict");
    assert!(matches!(
        channel_conflict,
        Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
    ));

    let aggregate_missing_outline = matrix_aggregate_input(
        131,
        "r2-d-lit-missing-outline",
        "owner-r2-d-lit-missing-outline",
    );
    setup_cleanup(&mut fixture, &aggregate_missing_outline);
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_missing_outline.operation_id],
        )
        .expect("remove outline Projection");

    let aggregate_missing_notes = matrix_aggregate_input(
        132,
        "r2-d-lit-missing-notes",
        "owner-r2-d-lit-missing-notes",
    );
    setup_cleanup(&mut fixture, &aggregate_missing_notes);
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1 AND manuscript_channel='dedicated_notes'",
            [&aggregate_missing_notes.operation_id],
        )
        .expect("remove notes Projection");

    let aggregate_wrong_pointer = matrix_aggregate_input(
        133,
        "r2-d-lit-wrong-pointer",
        "owner-r2-d-lit-wrong-pointer",
    );
    setup_cleanup(&mut fixture, &aggregate_wrong_pointer);
    let pointer_target = matrix_review_input(
        138,
        "r2-d-lit-pointer-target",
        "owner-r2-d-lit-pointer-target",
    );
    create_attempt_claim_plan_and_steps(&mut fixture, &pointer_target)
        .expect("prepare cross-owner pointer target");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_id=?1
             WHERE aggregate_operation_id=?2 AND manuscript_channel='literature_outline'",
            params![
                pointer_target.operation_id,
                aggregate_wrong_pointer.operation_id
            ],
        )
        .expect("prepare wrong current operation pointer");

    let aggregate_wrong_scope =
        matrix_aggregate_input(134, "r2-d-lit-wrong-scope", "owner-r2-d-lit-wrong-scope");
    setup_cleanup(&mut fixture, &aggregate_wrong_scope);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_scope_kind='literature-child'
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_wrong_scope.operation_id],
        )
        .expect("prepare wrong aggregate Projection scope");

    let aggregate_wrong_owner =
        matrix_aggregate_input(135, "r2-d-lit-wrong-owner", "owner-r2-d-lit-wrong-owner");
    setup_cleanup(&mut fixture, &aggregate_wrong_owner);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET owner_id='other-owner'
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_wrong_owner.operation_id],
        )
        .expect("prepare wrong Projection provenance");

    let aggregate_wrong_summary = matrix_aggregate_input(
        136,
        "r2-d-lit-wrong-summary",
        "owner-r2-d-lit-wrong-summary",
    );
    setup_cleanup(&mut fixture, &aggregate_wrong_summary);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET child_summary_status='terminal-completed',
                 default_readiness='ready',
                 final_verification_outcome='passed'
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_wrong_summary.operation_id],
        )
        .expect("prepare summary/terminal tuple mismatch");

    let aggregate_revision =
        matrix_aggregate_input(137, "r2-d-lit-revision", "owner-r2-d-lit-revision");
    setup_cleanup(&mut fixture, &aggregate_revision);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET revision=1
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate_revision.operation_id],
        )
        .expect("prepare aggregate Projection revision combination");

    let (_child_ok_aggregate, child_ok) = setup_matrix_child(&mut fixture, 140, "lit-child-ok");
    let (child_missing_aggregate, child_missing) =
        setup_matrix_child(&mut fixture, 141, "lit-child-missing");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_id=?1,
                 current_operation_scope_kind='literature-aggregate',
                 revision=2
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&child_missing_aggregate.operation_id],
        )
        .expect("remove child current Projection without deleting schema-valid row");

    let (_child_scope_aggregate, child_scope) =
        setup_matrix_child(&mut fixture, 142, "lit-child-scope");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_scope_kind='literature-aggregate'
             WHERE current_operation_id=?1",
            [&child_scope.operation_id],
        )
        .expect("prepare child Projection scope mismatch");

    let (_child_summary_aggregate, child_summary) =
        setup_matrix_child(&mut fixture, 143, "lit-child-summary");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET child_summary_status='terminal-completed',
                 default_readiness='ready',
                 final_verification_outcome='passed'
             WHERE current_operation_id=?1",
            [&child_summary.operation_id],
        )
        .expect("prepare child Projection summary mismatch");

    let (_child_channel_aggregate, child_channel) =
        setup_matrix_child(&mut fixture, 144, "lit-child-channel");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=(
               SELECT aggregate_operation_id
               FROM manuscript_provisioning_operation_attempts
               WHERE operation_id=?1
             ) AND manuscript_channel='dedicated_notes'",
            [&child_channel.operation_id],
        )
        .expect("make alternate channel key available");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET manuscript_channel='dedicated_notes'
             WHERE current_operation_id=?1",
            [&child_channel.operation_id],
        )
        .expect("prepare child Projection channel mismatch");

    let non_literature = matrix_review_input(
        150,
        "r2-d-unexpected-projection",
        "owner-unexpected-projection",
    );
    setup_cleanup(&mut fixture, &non_literature);
    fixture
        .execute(
            "INSERT INTO manuscript_provisioning_literature_child_states (
               aggregate_operation_id, owner_type, owner_id, manuscript_channel,
               current_operation_id, current_operation_scope_kind, revision,
               child_summary_status, default_readiness,
               final_verification_outcome, updated_at
             ) VALUES (
               ?1, 'literature', ?2, 'literature_outline',
               ?1, 'literature-aggregate', 0, 'assigned',
               'not-verified', 'not-run', ?3
             )",
            params![non_literature.operation_id, non_literature.owner_id, T5],
        )
        .expect("prepare non-Literature unexpected Projection");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    assert_cleanup_decision(
        &mut connection,
        &aggregate_ok.operation_id,
        "2026-07-25T00:00:00.000Z",
        true,
        &[],
    );
    for aggregate in [
        &aggregate_missing_outline,
        &aggregate_missing_notes,
        &aggregate_wrong_pointer,
        &aggregate_wrong_scope,
        &aggregate_wrong_owner,
    ] {
        assert_cleanup_error(
            &mut connection,
            &aggregate.operation_id,
            STRUCTURAL_PROGRESS_CORRUPTION,
        );
    }
    assert_cleanup_error(
        &mut connection,
        &aggregate_wrong_summary.operation_id,
        PROVISIONING_OPERATION_DATABASE_ERROR,
    );
    assert_cleanup_decision(
        &mut connection,
        &aggregate_revision.operation_id,
        "2026-07-25T00:00:00.000Z",
        true,
        &[],
    );
    assert_cleanup_decision(
        &mut connection,
        &child_ok.operation_id,
        "2026-07-25T00:00:00.000Z",
        false,
        &[
            "audit-not-delivered",
            "literature-projection-reference",
            "retention-not-satisfied",
            "unresolved-durable-condition",
        ],
    );
    for child in [&child_missing, &child_scope, &child_channel] {
        assert_cleanup_error(
            &mut connection,
            &child.operation_id,
            STRUCTURAL_PROGRESS_CORRUPTION,
        );
    }
    assert_cleanup_error(
        &mut connection,
        &child_summary.operation_id,
        PROVISIONING_OPERATION_DATABASE_ERROR,
    );
    assert_cleanup_error(
        &mut connection,
        &non_literature.operation_id,
        STRUCTURAL_PROGRESS_CORRUPTION,
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_d_startup_mixed_batch_is_bounded_stable_and_owner_isolated() {
    let (path, mut fixture) = file_v41("r2-d-startup-mixed");
    let ordinary = matrix_review_input(160, "r2-d-mixed-ordinary", "owner-mixed-ordinary");
    create_attempt_claim_plan_and_steps(&mut fixture, &ordinary).expect("ordinary fixture");

    let incomplete = matrix_review_input(161, "r2-d-mixed-incomplete", "owner-mixed-incomplete");
    create_attempt_claim_plan_and_steps(&mut fixture, &incomplete).expect("incomplete fixture");
    advance_fixture_to(&mut fixture, &incomplete, "started");

    let literature = matrix_aggregate_input(162, "r2-d-mixed-literature", "owner-mixed-literature");
    create_attempt_claim_plan_and_steps(&mut fixture, &literature).expect("Literature aggregate");
    let literature_child = matrix_child_input(
        162,
        &literature,
        "r2-d-mixed-literature-outline",
        DurableManuscriptChannel::LiteratureOutline,
        0,
        0,
    );
    create_literature_child_durable_attempt(&mut fixture, &literature_child)
        .expect("partial Literature child");

    let corrupt = matrix_review_input(163, "r2-d-mixed-corrupt", "owner-mixed-corrupt");
    create_attempt_claim_plan_and_steps(&mut fixture, &corrupt).expect("corrupt base fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&corrupt.operation_id],
        )
        .expect("remove corrupt Step fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_plans WHERE operation_id=?1",
            [&corrupt.operation_id],
        )
        .expect("remove corrupt Plan fixture");

    let audit = matrix_review_input(164, "r2-d-mixed-audit", "owner-mixed-audit");
    setup_terminal(&mut fixture, &audit);
    terminalize_attempt_release_claim_and_enqueue_audit(
        &mut fixture,
        &TerminalAttemptInput::completed(
            &audit.operation_id,
            &audit.claim_id,
            &audit.claim_owner_token,
            0,
            0,
            T5,
        ),
    )
    .expect("pending Audit fixture");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let business = assert_actual_connection_zero_write(&mut connection, |actual| {
        scan_sqlite_runtime_candidates(actual, "scanner-token", T2)
    })
    .expect("mixed business scan");
    let audit_candidates = assert_actual_connection_zero_write(&mut connection, |actual| {
        scan_sqlite_audit_candidates(actual)
    })
    .expect("mixed audit scan");
    assert_eq!(business.len(), 5);
    assert_eq!(audit_candidates.len(), 1);
    let operation_ids = business
        .iter()
        .map(|candidate| candidate.operation_id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        operation_ids,
        BTreeSet::from([
            corrupt.operation_id.as_str(),
            incomplete.operation_id.as_str(),
            literature.operation_id.as_str(),
            literature_child.operation_id.as_str(),
            ordinary.operation_id.as_str(),
        ])
    );
    let incomplete_candidate = business
        .iter()
        .find(|candidate| candidate.operation_id == incomplete.operation_id)
        .expect("incomplete candidate");
    assert_eq!(
        incomplete_candidate.result_classification.as_deref(),
        Some("provisioning-recovery-required")
    );
    assert_eq!(incomplete_candidate.next_action.as_deref(), Some("recover"));
    assert_eq!(
        incomplete_candidate.safe_error_code.as_deref(),
        Some("durable-progress-recovery-required")
    );
    let corrupt_candidate = business
        .iter()
        .find(|candidate| candidate.operation_id == corrupt.operation_id)
        .expect("corrupt candidate");
    assert_eq!(
        corrupt_candidate.result_classification.as_deref(),
        Some("blocked")
    );
    assert_eq!(corrupt_candidate.next_action.as_deref(), Some("stop"));
    assert_eq!(
        corrupt_candidate.safe_error_code.as_deref(),
        Some("active-attempt-plan-missing")
    );
    let literature_candidate = business
        .iter()
        .find(|candidate| candidate.operation_id == literature.operation_id)
        .expect("Literature aggregate candidate");
    assert_eq!(literature_candidate.literature_children.len(), 2);
    assert_eq!(
        literature_candidate
            .literature_children
            .iter()
            .filter(|child| child.operation_id.as_deref()
                == Some(literature_child.operation_id.as_str()))
            .count(),
        1
    );
    assert_eq!(audit_candidates[0].operation_id, audit.operation_id);
    assert_eq!(audit_candidates[0].audit_status.as_deref(), Some("pending"));

    let mut all = business.clone();
    all.extend(audit_candidates.clone());
    let first = normalize_runtime_issues(all.clone());
    let second = normalize_runtime_issues(all);
    assert_eq!(first, second);
    assert_eq!(first.business_issue_count, 4);
    assert_eq!(first.audit_issue_count, 1);
    assert!(first.issues.len() <= 5);

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_d_startup_heartbeat_freshness_boundary_is_fixed_clock_zero_write() {
    let (path, mut fixture) = file_v41("r2-d-startup-heartbeat-boundary");
    let input = matrix_review_input(
        170,
        "r2-d-heartbeat-boundary",
        "owner-r2-d-heartbeat-boundary",
    );
    let created =
        create_attempt_claim_plan_and_steps(&mut fixture, &input).expect("heartbeat Attempt");
    record_claim_heartbeat(
        &mut fixture,
        &claim_cas_for_test(&created.claim),
        "2026-07-24T00:00:01.000Z",
    )
    .expect("fixed heartbeat fixture");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let fresh = assert_actual_connection_zero_write(&mut connection, |actual| {
        scan_sqlite_runtime_candidates(actual, "scanner-token", "2026-07-24T00:05:00.999Z")
    })
    .expect("scan immediately before stale threshold");
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].stale_kind, None);

    let threshold = assert_actual_connection_zero_write(&mut connection, |actual| {
        scan_sqlite_runtime_candidates(actual, "scanner-token", "2026-07-24T00:05:01.000Z")
    })
    .expect("scan exactly at stale threshold");
    assert_eq!(threshold.len(), 1);
    assert_eq!(
        threshold[0].stale_kind,
        Some(RuntimeIssueKind::StaleCandidate)
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_d_source_gate_binds_real_entries_to_complete_zero_write_evidence() {
    let source = include_str!("manuscript_provisioning_step_progress_p4_2e_tests.rs");
    for required in [
        "fn assert_actual_connection_zero_write",
        "let changes_before = connection.total_changes();",
        "authority_snapshot(connection)",
        "meta_snapshot(connection)",
        "start_sql_trace(connection)",
        "fn reopen_r2_d_fixture",
        "scan_sqlite_runtime_candidates(actual",
        "scan_sqlite_audit_candidates(actual)",
        "dry_run_progress_cleanup(actual",
        "PRAGMA user_version=42",
        "SchemaCapability::UnavailableNotMigrated",
        "SchemaCapability::UnavailableInvalidSchema",
        "SchemaCapability::ReadFailed",
        "2026-07-24T00:05:00.999Z",
        "2026-07-24T00:05:01.000Z",
        "p4_2e_r2_d_startup_mixed_batch",
        "p4_2e_r2_d_cleanup_literature_projection_matrix",
    ] {
        assert!(
            source.contains(required),
            "R2-D source evidence missing: {required}"
        );
    }
    assert!(
        source.contains("DROP INDEX uq_manuscript_provisioning_step_plan_operation")
            && source.contains("r2-d-capability-invalid-v41"),
        "schema tampering is confined to the explicit invalid-schema capability fixture"
    );
    assert!(!source.contains("C:\\Users\\gengj\\AppData\\Roaming"));

    let scanner = include_str!("../provisioning_runtime/startup_scanner.rs");
    let cleanup =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    assert!(scanner.contains("pub(crate) fn scan_sqlite_runtime_candidates"));
    assert!(scanner.contains("pub(crate) fn scan_sqlite_audit_candidates"));
    assert!(cleanup.contains("pub(crate) fn dry_run_progress_cleanup"));
    for forbidden in [
        "R2_D_REPAIR",
        "r2_d_repair",
        "scanner_repair",
        "dry_run_mutation",
    ] {
        assert!(!format!("{scanner}\n{cleanup}").contains(forbidden));
    }
}

#[test]
fn p4_2e_r2_e_recovery_depth_boundary_is_actual_connection_dual_zero() {
    assert_eq!(MAX_RECOVERY_CHAIN_DEPTH, 32);
    for depth in [31_usize, 32, 33] {
        let (path, fixture) = file_v41(&format!("r2-e-recovery-depth-{depth}"));
        let target =
            insert_recovery_chain(&fixture, depth, &format!("r2-e-recovery-depth-{depth}"));
        drop(fixture);

        let mut connection = reopen_r2_d_fixture(&path, 0);
        let result = assert_actual_connection_zero_write(&mut connection, |actual| {
            list_recovery_step_progress(actual, &target)
        });
        if depth <= MAX_RECOVERY_CHAIN_DEPTH {
            assert_eq!(
                result
                    .expect("depth within the bound must be accepted")
                    .chain
                    .len(),
                depth
            );
        } else {
            assert_eq!(
                result
                    .expect_err("depth above the bound must fail closed")
                    .code,
                RECOVERY_EVIDENCE_INVALID
            );
        }

        drop(connection);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_e_f1_current_non_leaf_recovery_evidence_fails_closed_dual_zero() {
    let (path, fixture) = file_v41("r2-e-f1-current-non-leaf-red");
    insert_recovery_chain(&fixture, 3, "r2-e-f1-current-non-leaf");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, "r2-e-f1-current-non-leaf-1")
    });
    assert_eq!(
        result
            .expect_err("a current Attempt with a persisted successor is not a legal leaf")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f1_current_leaf_recovery_evidence_is_allowed_dual_zero() {
    let (path, fixture) = file_v41("r2-e-f1-current-leaf");
    let leaf = insert_recovery_chain(&fixture, 3, "r2-e-f1-current-leaf");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let evidence = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &leaf)
    })
    .expect("a current Recovery chain leaf must remain eligible");
    assert_eq!(
        evidence.chain,
        vec![
            "r2-e-f1-current-leaf-0",
            "r2-e-f1-current-leaf-1",
            "r2-e-f1-current-leaf-2",
        ]
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f1_root_with_successor_recovery_evidence_fails_closed_dual_zero() {
    let (path, fixture) = file_v41("r2-e-f1-root-successor");
    insert_recovery_chain(&fixture, 2, "r2-e-f1-root-successor");
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, "r2-e-f1-root-successor-0")
    });
    assert_eq!(
        result
            .expect_err("a root with a persisted successor is not a legal current leaf")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f1_cross_identity_successors_fail_closed_dual_zero() {
    for (label, scope_kind, owner_type, owner_id, channel) in [
        (
            "cross-owner",
            "channel",
            "review",
            "different-owner",
            Some("primary"),
        ),
        (
            "cross-scope",
            "literature-aggregate",
            "literature",
            "owner-r2-e-f1-cross-scope",
            None,
        ),
        (
            "cross-channel",
            "channel",
            "literature",
            "owner-r2-e-f1-cross-channel",
            Some("literature_outline"),
        ),
    ] {
        let prefix = format!("r2-e-f1-{label}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, 1, &prefix);
        insert_successor_reference(
            &fixture,
            &format!("{prefix}-foreign-successor"),
            &current,
            scope_kind,
            owner_type,
            owner_id,
            channel,
        );
        drop(fixture);

        let mut connection = reopen_r2_d_fixture(&path, 0);
        let result = assert_actual_connection_zero_write(&mut connection, |actual| {
            list_recovery_step_progress(actual, &current)
        });
        assert_eq!(
            result
                .expect_err("any persisted cross-identity successor must fail closed")
                .code,
            RECOVERY_EVIDENCE_INVALID,
            "{label}"
        );

        drop(connection);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_e_f1_multiple_successors_fail_closed_dual_zero() {
    let (path, fixture) = file_v41("r2-e-f1-multiple-successors");
    let current = insert_recovery_chain(&fixture, 1, "r2-e-f1-multiple-successors-current");
    for index in 0..2 {
        insert_successor_reference(
            &fixture,
            &format!("r2-e-f1-multiple-successor-{index}"),
            &current,
            "channel",
            "review",
            &format!("multiple-successor-owner-{index}"),
            Some("primary"),
        );
    }
    let successor_count: i64 = fixture
        .query_row(
            "SELECT COUNT(*)
             FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?1",
            [&current],
            |row| row.get(0),
        )
        .expect("count exact-v41 successors");
    assert_eq!(
        successor_count, 2,
        "exact-v41 permits multiple persisted successor references"
    );
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &current)
    });
    assert_eq!(
        result
            .expect_err("multiple persisted successors make current ineligible")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f1_source_gate_requires_bounded_current_leaf_eligibility() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    assert_eq!(
        production
            .matches("pub(crate) fn list_recovery_step_progress(")
            .count(),
        1,
        "there must be exactly one production Recovery evidence entry"
    );

    let leaf_guard_start = production
        .find("fn recovery_current_has_persisted_successor(")
        .expect("current-leaf helper must exist");
    let entry_start = production
        .find("pub(crate) fn list_recovery_step_progress(")
        .expect("production Recovery evidence entry must exist");
    assert!(leaf_guard_start < entry_start);
    let leaf_guard = &production[leaf_guard_start..entry_start];
    for required in [
        "manuscript_provisioning_operation_attempts",
        "previous_operation_id=?1",
        "LIMIT 1",
        ".optional()",
    ] {
        assert!(
            leaf_guard.contains(required),
            "bounded current-leaf query is missing semantic evidence: {required}"
        );
    }
    for forbidden in ["INSERT ", "UPDATE ", "DELETE ", "BEGIN ", "COMMIT "] {
        assert!(
            !leaf_guard.contains(forbidden),
            "current-leaf helper must remain read-only: {forbidden}"
        );
    }

    let entry_end = production[entry_start..]
        .find("#[derive(Debug, Clone, PartialEq, Eq)]")
        .map(|offset| entry_start + offset)
        .expect("Recovery evidence entry boundary");
    let entry = &production[entry_start..entry_end];
    let leaf_check = entry
        .find("recovery_current_has_persisted_successor(")
        .expect("entry must call current-leaf eligibility");
    let traversal = entry
        .find("while let Some(value)")
        .expect("entry must retain bounded previous traversal");
    let evidence_return = entry
        .find("Ok(RecoveryStepEvidence")
        .expect("entry must return Recovery evidence");
    assert!(leaf_check < traversal && traversal < evidence_return);
    assert!(entry[..traversal].contains("RECOVERY_EVIDENCE_INVALID"));
    for forbidden in ["std::env", "cfg!(test)", "feature =", "fault", "pause"] {
        assert!(
            !format!("{leaf_guard}\n{entry}").contains(forbidden),
            "current-leaf eligibility must not add a production switch: {forbidden}"
        );
    }
}

#[test]
fn p4_2e_r2_e_f2_terminal_predecessor_active_claim_fails_closed_dual_zero() {
    let (path, fixture) = file_v41("r2-e-f2-terminal-predecessor-active-claim-red");
    let current = insert_recovery_chain(&fixture, 2, "r2-e-f2-terminal-predecessor-active-claim");
    insert_active_claim_reference(
        &fixture,
        "r2-e-f2-terminal-predecessor-active-claim",
        "r2-e-f2-terminal-predecessor-active-claim-0",
        "channel",
        "review",
        "owner-r2-e-f2-terminal-predecessor-active-claim",
        Some("primary"),
    );
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &current)
    });
    assert_eq!(
        result
            .expect_err(
                "a terminal Recovery predecessor retaining an active Claim must fail closed"
            )
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f2_legal_terminal_predecessors_are_allowed_dual_zero() {
    for depth in [2_usize, 4] {
        let prefix = format!("r2-e-f2-legal-terminal-predecessors-{depth}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, depth, &prefix);
        drop(fixture);

        let mut connection = reopen_r2_d_fixture(&path, 0);
        let evidence = assert_actual_connection_zero_write(&mut connection, |actual| {
            list_recovery_step_progress(actual, &current)
        })
        .expect("terminal predecessors without active Claims must remain eligible");
        assert_eq!(evidence.chain.len(), depth);

        drop(connection);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_e_f2_middle_predecessor_active_claim_fails_closed_dual_zero() {
    let (path, fixture) = file_v41("r2-e-f2-middle-predecessor-active-claim");
    let current = insert_recovery_chain(&fixture, 3, "r2-e-f2-middle-predecessor-active-claim");
    insert_active_claim_reference(
        &fixture,
        "r2-e-f2-middle-predecessor-active-claim",
        "r2-e-f2-middle-predecessor-active-claim-1",
        "channel",
        "review",
        "owner-r2-e-f2-middle-predecessor-active-claim",
        Some("primary"),
    );
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &current)
    });
    assert_eq!(
        result
            .expect_err("an active Claim on a middle predecessor must fail closed")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f2_any_middle_chain_level_active_claim_fails_closed_dual_zero() {
    for predecessor_index in [1_usize, 2] {
        let prefix = format!("r2-e-f2-any-middle-active-claim-{predecessor_index}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, 4, &prefix);
        insert_active_claim_reference(
            &fixture,
            &format!("{prefix}-claim"),
            &format!("{prefix}-{predecessor_index}"),
            "channel",
            "review",
            &format!("owner-{prefix}"),
            Some("primary"),
        );
        drop(fixture);

        let mut connection = reopen_r2_d_fixture(&path, 0);
        let result = assert_actual_connection_zero_write(&mut connection, |actual| {
            list_recovery_step_progress(actual, &current)
        });
        assert_eq!(
            result
                .expect_err("an active Claim at any predecessor level must fail closed")
                .code,
            RECOVERY_EVIDENCE_INVALID,
            "predecessor index {predecessor_index}"
        );

        drop(connection);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_e_f2_cross_identity_claims_are_not_ignored_dual_zero() {
    for (label, scope_kind, owner_type, owner_id, channel) in [
        (
            "cross-owner",
            "channel",
            "review",
            "different-owner",
            Some("primary"),
        ),
        (
            "cross-scope",
            "literature-aggregate",
            "literature",
            "different-literature-owner",
            None,
        ),
        (
            "cross-channel",
            "channel",
            "literature",
            "different-literature-owner",
            Some("dedicated_notes"),
        ),
    ] {
        let prefix = format!("r2-e-f2-{label}-claim");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, 2, &prefix);
        insert_active_claim_reference(
            &fixture,
            &prefix,
            &format!("{prefix}-0"),
            scope_kind,
            owner_type,
            owner_id,
            channel,
        );
        drop(fixture);

        let mut connection = reopen_r2_d_fixture(&path, 0);
        let result = assert_actual_connection_zero_write(&mut connection, |actual| {
            list_recovery_step_progress(actual, &current)
        });
        assert_eq!(
            result
                .expect_err("any Claim referencing the predecessor operation must fail closed")
                .code,
            RECOVERY_EVIDENCE_INVALID,
            "{label}"
        );

        drop(connection);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_e_f2_multiple_claim_reference_is_schema_rejected_and_one_claim_blocks() {
    let prefix = "r2-e-f2-multiple-claim-reference";
    let (path, fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 2, prefix);
    let predecessor = format!("{prefix}-0");
    insert_active_claim_reference(
        &fixture,
        "r2-e-f2-multiple-claim-reference-first",
        &predecessor,
        "channel",
        "review",
        &format!("owner-{prefix}"),
        Some("primary"),
    );
    let duplicate_error = try_insert_active_claim_reference(
        &fixture,
        "r2-e-f2-multiple-claim-reference-second",
        &predecessor,
        "channel",
        "review",
        &format!("owner-{prefix}"),
        Some("primary"),
    )
    .expect_err("exact-v41 UNIQUE operation_id must reject a second active Claim");
    assert!(matches!(
        duplicate_error,
        Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
    ));
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &current)
    });
    assert_eq!(
        result
            .expect_err("the one persisted active Claim must fail closed")
            .code,
        RECOVERY_EVIDENCE_INVALID
    );

    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f2_source_gate_requires_predecessor_active_claim_eligibility() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    assert_eq!(
        production
            .matches("pub(crate) fn list_recovery_step_progress(")
            .count(),
        1,
        "there must be exactly one production Recovery evidence entry"
    );
    assert!(production.contains("pub(crate) const MAX_RECOVERY_CHAIN_DEPTH: usize = 32;"));

    let claim_guard_start = production
        .find("fn recovery_predecessor_has_active_claim(")
        .expect("predecessor active-Claim helper must exist");
    let entry_start = production
        .find("pub(crate) fn list_recovery_step_progress(")
        .expect("production Recovery evidence entry must exist");
    assert!(claim_guard_start < entry_start);
    let claim_guard = &production[claim_guard_start..entry_start];
    for required in [
        "manuscript_provisioning_active_claims",
        "WHERE operation_id=?1",
        "LIMIT 1",
        ".optional()",
    ] {
        assert!(
            claim_guard.contains(required),
            "bounded predecessor Claim query is missing semantic evidence: {required}"
        );
    }
    for forbidden in ["INSERT ", "UPDATE ", "DELETE ", "BEGIN ", "COMMIT "] {
        assert!(
            !claim_guard.contains(forbidden),
            "predecessor Claim helper must remain read-only: {forbidden}"
        );
    }

    let entry_end = production[entry_start..]
        .find("#[derive(Debug, Clone, PartialEq, Eq)]")
        .map(|offset| entry_start + offset)
        .expect("Recovery evidence entry boundary");
    let entry = &production[entry_start..entry_end];
    let relation_check = entry
        .find("recovery_relation_matches(&previous, &value)")
        .expect("predecessor terminal relation validation must remain");
    let claim_check = entry
        .find("recovery_predecessor_has_active_claim(connection, &previous.operation_id)")
        .expect("entry must check every predecessor operation for an active Claim");
    let accept_predecessor = entry
        .find("Some(previous)")
        .expect("entry must continue bounded predecessor traversal");
    assert!(relation_check < claim_check && claim_check < accept_predecessor);
    assert!(entry[claim_check..accept_predecessor].contains("RECOVERY_EVIDENCE_INVALID"));
    assert!(entry.contains("recovery_current_has_persisted_successor(connection, operation_id)"));
    assert!(entry.contains("while let Some(value)"));
    assert!(entry.contains("chain.len() == MAX_RECOVERY_CHAIN_DEPTH"));
    for forbidden in ["std::env", "cfg!(test)", "feature =", "fault", "pause"] {
        assert!(
            !format!("{claim_guard}\n{entry}").contains(forbidden),
            "predecessor Claim eligibility must not add a production switch: {forbidden}"
        );
    }
}

fn foreign_key_violation_count(connection: &Connection) -> usize {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .expect("prepare fixture foreign_key_check");
    statement
        .query([])
        .expect("query fixture foreign_key_check")
        .mapped(|row| row.get::<_, String>(0))
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect fixture foreign_key_check")
        .len()
}

fn assert_recovery_error_file_zero_write(
    path: PathBuf,
    expected_foreign_key_violations: usize,
    current_operation_id: &str,
    expected_code: &str,
) {
    let mut connection = reopen_r2_d_fixture(&path, expected_foreign_key_violations);
    let result = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, current_operation_id)
    });
    assert_eq!(
        result
            .expect_err("corrupt Recovery evidence must fail closed")
            .code,
        expected_code
    );
    drop(connection);
    remove_isolated_v41(path);
}

fn assert_recovery_invalid_file_zero_write(
    path: PathBuf,
    expected_foreign_key_violations: usize,
    current_operation_id: &str,
) {
    assert_recovery_error_file_zero_write(
        path,
        expected_foreign_key_violations,
        current_operation_id,
        RECOVERY_EVIDENCE_INVALID,
    );
}

fn assert_recovery_ok_file_zero_write(
    path: PathBuf,
    expected_foreign_key_violations: usize,
    current_operation_id: &str,
) {
    let mut connection = reopen_r2_d_fixture(&path, expected_foreign_key_violations);
    let evidence = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, current_operation_id)
    })
    .expect("legal Recovery evidence must remain available");
    assert_eq!(evidence.attempt.operation_id, current_operation_id);
    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f3_missing_plan_is_structural_corruption_dual_zero() {
    let prefix = "r2-e-f3-missing-plan";
    let (path, fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 1, prefix);
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&current],
        )
        .expect("remove Step before Plan");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_plans WHERE operation_id=?1",
            [&current],
        )
        .expect("remove Recovery Plan");
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    assert_recovery_error_file_zero_write(path, 0, &current, STRUCTURAL_PROGRESS_CORRUPTION);
}

#[test]
fn p4_2e_r2_e_f3_plan_and_required_step_corruption_are_structural_dual_zero() {
    for (label, mutation) in [
        (
            "missing-step",
            "DELETE FROM manuscript_provisioning_step_progress
             WHERE operation_id='r2-e-f3-missing-step-0'",
        ),
        (
            "plan-owner-mismatch",
            "UPDATE manuscript_provisioning_step_plans
             SET owner_id='different-owner'
             WHERE operation_id='r2-e-f3-plan-owner-mismatch-0'",
        ),
        (
            "step-ordinal-gap",
            "UPDATE manuscript_provisioning_step_progress
             SET step_ordinal=1
             WHERE operation_id='r2-e-f3-step-ordinal-gap-0'",
        ),
    ] {
        let prefix = format!("r2-e-f3-{label}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, 1, &prefix);
        fixture
            .execute_batch(mutation)
            .expect("construct schema-valid structural corruption");
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);

        assert_recovery_error_file_zero_write(path, 0, &current, STRUCTURAL_PROGRESS_CORRUPTION);
    }
}

#[test]
fn p4_2e_r2_e_f3_step_plan_identity_corruption_is_structural_dual_zero() {
    let prefix = "r2-e-f3-step-plan-mismatch";
    let (path, fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 1, prefix);
    fixture
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .expect("disable FK only for composite identity corruption fixture");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET plan_id=?1 WHERE operation_id=?2",
            [HASH_F, current.as_str()],
        )
        .expect("construct Step/Plan identity mismatch");
    fixture
        .execute_batch("PRAGMA foreign_keys=ON;")
        .expect("restore FK after composite identity corruption fixture");
    let expected_foreign_key_violations = foreign_key_violation_count(&fixture);
    assert_eq!(expected_foreign_key_violations, 1);
    drop(fixture);

    assert_recovery_error_file_zero_write(
        path,
        expected_foreign_key_violations,
        &current,
        STRUCTURAL_PROGRESS_CORRUPTION,
    );
}

#[test]
fn p4_2e_r2_e_f3_exact_v41_rejects_unsupported_step_shapes_without_damage() {
    let prefix = "r2-e-f3-schema-rejection";
    let (path, fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 1, prefix);
    for mutation in [
        "UPDATE manuscript_provisioning_step_progress
         SET step_version=2 WHERE operation_id='r2-e-f3-schema-rejection-0'",
        "UPDATE manuscript_provisioning_step_progress
         SET step_kind='unsupported-kind'
         WHERE operation_id='r2-e-f3-schema-rejection-0'",
        "UPDATE manuscript_provisioning_step_progress
         SET step_scope='unsupported-scope'
         WHERE operation_id='r2-e-f3-schema-rejection-0'",
        "UPDATE manuscript_provisioning_step_progress
         SET boundary='converged'
         WHERE operation_id='r2-e-f3-schema-rejection-0'",
    ] {
        let error = fixture
            .execute_batch(mutation)
            .expect_err("exact-v41 must reject unsupported Step shape");
        assert!(matches!(
            error,
            Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
        ));
    }
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let evidence = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &current)
    })
    .expect("rejected writes must leave legal Progress evidence intact");
    assert_eq!(evidence.attempt.operation_id, current);
    assert_eq!(evidence.steps.len(), 1);
    assert_eq!(evidence.chain, vec![current]);
    drop(connection);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_a1_discovery_terminal_completed_with_intended_required_step_is_structural_dual_zero()
{
    let prefix = "r2-e-e3-terminal-unconverged";
    let (path, fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 1, prefix);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='completed', operation_status='terminal-completed',
                 result_classification='completed', next_action='none',
                 final_verification_outcome='passed',
                 revision=revision+1, terminal_at=?2, updated_at=?2
             WHERE operation_id=?1",
            params![current, T5],
        )
        .expect("construct schema-valid completed Attempt with unconverged required Step");
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    assert_recovery_error_file_zero_write(path, 0, &current, STRUCTURAL_PROGRESS_CORRUPTION);
}

#[test]
fn p4_2e_r2_e_f3_source_gate_separates_structure_from_recovery_relations() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    let structure_start = production
        .find("fn validate_recovery_progress_structure(")
        .expect("Recovery Progress structure helper must exist");
    let relation_start = production
        .find("fn recovery_relation_matches(")
        .expect("Recovery relation helper must exist");
    let startup_start = production
        .find("pub(crate) fn read_startup_progress_projection(")
        .expect("bounded Recovery entry must end before startup projection");
    assert!(structure_start < relation_start);
    let structure = &production[structure_start..relation_start];
    let recovery = &production[relation_start..startup_start];

    assert!(structure.contains("read_attempt_plan(connection, &attempt.operation_id)?"));
    assert!(structure.contains("read_attempt_step_progress(connection, &attempt.operation_id)?"));
    assert!(structure.contains("STRUCTURAL_PROGRESS_CORRUPTION"));
    assert!(!structure.contains("RECOVERY_EVIDENCE_INVALID"));
    assert!(!structure.contains("read_literature_child_projections"));

    for required in [
        "RECOVERY_EVIDENCE_INVALID",
        "MAX_RECOVERY_CHAIN_DEPTH",
        "recovery_current_has_persisted_successor",
        "recovery_predecessor_has_active_claim",
        "validate_recovery_progress_structure(connection, &value)?",
    ] {
        assert!(
            recovery.contains(required),
            "Recovery relation boundary missing: {required}"
        );
    }
    for forbidden in ["error.message", ".message()", "cfg!(test)", "#[cfg(test)]"] {
        assert!(
            !structure.contains(forbidden) && !recovery.contains(forbidden),
            "F3 forbids message remapping or a test-only production branch: {forbidden}"
        );
    }
    assert!(production.contains("pub(crate) const MAX_RECOVERY_CHAIN_DEPTH: usize = 32;"));
}

#[test]
fn p4_2e_r2_e_f4_missing_outline_projection_is_structural_dual_zero() {
    let (path, mut fixture) = file_v41("r2-e-f4-missing-outline");
    let aggregate = matrix_aggregate_input(
        300,
        "r2-e-f4-missing-outline",
        "owner-r2-e-f4-missing-outline",
    );
    create_attempt_claim_plan_and_steps(&mut fixture, &aggregate)
        .expect("create legal Literature aggregate Recovery fixture");
    fixture
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1
               AND manuscript_channel='literature_outline'",
            [&aggregate.operation_id],
        )
        .expect("remove required outline Projection");
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    assert_recovery_error_file_zero_write(
        path,
        0,
        &aggregate.operation_id,
        STRUCTURAL_PROGRESS_CORRUPTION,
    );
}

#[test]
fn p4_2e_r2_e_f4_recovered_aggregate_projection_targets_current_leaf_dual_zero() {
    let (path, mut fixture) = file_v41("r2-e-f4-recovered-aggregate");
    let aggregate = matrix_aggregate_input(
        301,
        "r2-e-f4-recovered-aggregate-root",
        "owner-r2-e-f4-recovered-aggregate",
    );
    let created = create_attempt_claim_plan_and_steps(&mut fixture, &aggregate)
        .expect("create Literature aggregate root");
    let observed = mark_stale_claim_candidate(
        &mut fixture,
        &claim_cas_for_test(&created.claim),
        "r2-e-f4-recovery-observer",
        "2026-07-24T00:10:00.000Z",
    )
    .expect("mark aggregate root stale");
    let mut recovery_plan = aggregate.plan.clone();
    recovery_plan.plan_id = HASH_F.to_string();
    let recovery_operation_id = "r2-e-f4-recovered-aggregate-current";
    replace_claim_for_recovery(
        &mut fixture,
        &RecoveryReplacementInput {
            snapshot_id: "r2-e-f4-recovery-snapshot".to_string(),
            inspected_at: "2026-07-24T00:10:00.000Z".to_string(),
            inspected_owner_type: "literature".to_string(),
            inspected_owner_id: aggregate.owner_id.clone(),
            inspected_manuscript_channel: None,
            observed_old_operation_id: aggregate.operation_id.clone(),
            observed_operation_revision: 0,
            observed_claim_id: aggregate.claim_id.clone(),
            observed_claim_revision: observed.claim_revision,
            old_claim_owner_token: aggregate.claim_owner_token.clone(),
            explicit_authorization_id: "r2-e-f4-recovery-authorization".to_string(),
            new_operation_id: recovery_operation_id.to_string(),
            new_claim_id: "r2-e-f4-recovered-aggregate-claim".to_string(),
            new_claim_owner_token: "r2-e-f4-recovered-aggregate-token".to_string(),
            durable_plan: Some(recovery_plan),
            durable_steps: vec![DurableStepSkeletonInput {
                step_id: HASH_G.to_string(),
                step_ordinal: 0,
                step_kind: DurableStepKind::EnsureDirectory,
                step_scope: DurableStepScope::LiteratureAggregate,
                step_version: 1,
            }],
            occurred_at: "2026-07-24T00:10:01.000Z".to_string(),
        },
    )
    .expect("replace aggregate root with Recovery current leaf");
    let projections = read_literature_child_projections(&fixture, &aggregate.operation_id)
        .expect("read reassigned aggregate Projections");
    assert_eq!(projections.len(), 2);
    assert!(projections.iter().all(|projection| {
        projection.current_operation_id == recovery_operation_id
            && projection.current_operation_scope_kind.as_str() == "literature-aggregate"
    }));
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    assert_recovery_ok_file_zero_write(path, 0, recovery_operation_id);
}

#[test]
fn p4_2e_r2_e_f4_aggregate_projection_matrix_is_exact_and_dual_zero() {
    for (index, label) in [
        (302_u64, "legal"),
        (303, "revision-only"),
        (304, "missing-notes"),
        (305, "wrong-pointer"),
        (306, "wrong-scope"),
        (307, "wrong-channel"),
        (308, "wrong-owner"),
        (309, "wrong-summary"),
    ] {
        let operation_id = format!("r2-e-f4-aggregate-{label}");
        let (path, mut fixture) = file_v41(&operation_id);
        let aggregate =
            matrix_aggregate_input(index, &operation_id, &format!("owner-{operation_id}"));
        create_attempt_claim_plan_and_steps(&mut fixture, &aggregate)
            .expect("create aggregate Projection matrix fixture");
        match label {
            "legal" => {}
            "revision-only" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET revision=7
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='literature_outline'",
                        [&aggregate.operation_id],
                    )
                    .expect("advance only aggregate Projection revision");
            }
            "missing-notes" => {
                fixture
                    .execute(
                        "DELETE FROM manuscript_provisioning_literature_child_states
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='dedicated_notes'",
                        [&aggregate.operation_id],
                    )
                    .expect("remove required notes Projection");
            }
            "wrong-pointer" => {
                let target = matrix_review_input(
                    index + 100,
                    &format!("{operation_id}-target"),
                    &format!("owner-{operation_id}-target"),
                );
                create_attempt_claim_plan_and_steps(&mut fixture, &target)
                    .expect("create schema-valid wrong-pointer target");
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET current_operation_id=?1
                         WHERE aggregate_operation_id=?2
                           AND manuscript_channel='literature_outline'",
                        params![target.operation_id, aggregate.operation_id],
                    )
                    .expect("point aggregate Projection at another operation");
            }
            "wrong-scope" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET current_operation_scope_kind='literature-child'
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='literature_outline'",
                        [&aggregate.operation_id],
                    )
                    .expect("set incompatible aggregate Projection scope");
            }
            "wrong-channel" => {
                fixture
                    .execute(
                        "DELETE FROM manuscript_provisioning_literature_child_states
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='dedicated_notes'",
                        [&aggregate.operation_id],
                    )
                    .expect("free notes channel key");
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET manuscript_channel='dedicated_notes'
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='literature_outline'",
                        [&aggregate.operation_id],
                    )
                    .expect("move outline Projection to wrong channel");
            }
            "wrong-owner" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET owner_id='different-owner'
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='literature_outline'",
                        [&aggregate.operation_id],
                    )
                    .expect("corrupt aggregate Projection provenance");
            }
            "wrong-summary" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET child_summary_status='terminal-completed',
                             result_classification='completed', next_action='none',
                             default_readiness='ready',
                             final_verification_outcome='passed'
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='literature_outline'",
                        [&aggregate.operation_id],
                    )
                    .expect("store schema-valid conflicting aggregate summary");
            }
            _ => unreachable!(),
        }
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);

        if matches!(label, "legal" | "revision-only") {
            assert_recovery_ok_file_zero_write(path, 0, &aggregate.operation_id);
        } else {
            assert_recovery_error_file_zero_write(
                path,
                0,
                &aggregate.operation_id,
                STRUCTURAL_PROGRESS_CORRUPTION,
            );
        }
    }
}

#[test]
fn p4_2e_r2_e_f4_child_projection_matrix_is_exact_and_dual_zero() {
    for (index, label) in [
        (320_u64, "legal"),
        (321, "missing"),
        (322, "wrong-pointer"),
        (323, "wrong-scope"),
        (324, "wrong-channel"),
        (325, "wrong-owner"),
        (326, "wrong-summary"),
    ] {
        let (path, mut fixture) = file_v41(&format!("r2-e-f4-child-{label}"));
        let (aggregate, child) = setup_matrix_child(&mut fixture, index, &format!("f4-{label}"));
        match label {
            "legal" => {}
            "missing" => {
                fixture
                    .execute(
                        "DELETE FROM manuscript_provisioning_literature_child_states
                         WHERE current_operation_id=?1",
                        [&child.operation_id],
                    )
                    .expect("remove child current Projection");
            }
            "wrong-pointer" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET current_operation_id=?1,
                             current_operation_scope_kind='literature-aggregate',
                             revision=revision+1
                         WHERE current_operation_id=?2",
                        params![aggregate.operation_id, child.operation_id],
                    )
                    .expect("point child Projection back at aggregate");
            }
            "wrong-scope" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET current_operation_scope_kind='literature-aggregate'
                         WHERE current_operation_id=?1",
                        [&child.operation_id],
                    )
                    .expect("set incompatible child Projection scope");
            }
            "wrong-channel" => {
                fixture
                    .execute(
                        "DELETE FROM manuscript_provisioning_literature_child_states
                         WHERE aggregate_operation_id=?1
                           AND manuscript_channel='dedicated_notes'",
                        [&aggregate.operation_id],
                    )
                    .expect("free alternate child channel key");
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET manuscript_channel='dedicated_notes'
                         WHERE current_operation_id=?1",
                        [&child.operation_id],
                    )
                    .expect("move child Projection to wrong channel");
            }
            "wrong-owner" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET owner_id='different-owner'
                         WHERE current_operation_id=?1",
                        [&child.operation_id],
                    )
                    .expect("corrupt child Projection provenance");
            }
            "wrong-summary" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_literature_child_states
                         SET child_summary_status='terminal-completed',
                             result_classification='completed', next_action='none',
                             default_readiness='ready',
                             final_verification_outcome='passed'
                         WHERE current_operation_id=?1",
                        [&child.operation_id],
                    )
                    .expect("store schema-valid conflicting child summary");
            }
            _ => unreachable!(),
        }
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);

        if label == "legal" {
            assert_recovery_ok_file_zero_write(path, 0, &child.operation_id);
        } else {
            assert_recovery_error_file_zero_write(
                path,
                0,
                &child.operation_id,
                STRUCTURAL_PROGRESS_CORRUPTION,
            );
        }
    }
}

#[test]
fn p4_2e_r2_e_f4_non_literature_and_cardinality_matrix_is_exact() {
    {
        let (path, mut fixture) = file_v41("r2-e-f4-non-literature-legal");
        let ordinary = matrix_review_input(
            340,
            "r2-e-f4-non-literature-legal",
            "owner-r2-e-f4-non-literature-legal",
        );
        create_attempt_claim_plan_and_steps(&mut fixture, &ordinary)
            .expect("create legal non-Literature fixture");
        drop(fixture);
        assert_recovery_ok_file_zero_write(path, 0, &ordinary.operation_id);
    }
    {
        let (path, mut fixture) = file_v41("r2-e-f4-non-literature-unexpected");
        let ordinary = matrix_review_input(
            341,
            "r2-e-f4-non-literature-unexpected",
            "owner-r2-e-f4-non-literature-unexpected",
        );
        create_attempt_claim_plan_and_steps(&mut fixture, &ordinary)
            .expect("create non-Literature unexpected Projection fixture");
        fixture
            .execute(
                "INSERT INTO manuscript_provisioning_literature_child_states (
                   aggregate_operation_id, owner_type, owner_id, manuscript_channel,
                   current_operation_id, current_operation_scope_kind, revision,
                   child_summary_status, default_readiness,
                   final_verification_outcome, updated_at
                 ) VALUES (
                   ?1, 'literature', ?2, 'literature_outline',
                   ?1, 'literature-aggregate', 0, 'assigned',
                   'not-verified', 'not-run', ?3
                 )",
                params![ordinary.operation_id, ordinary.owner_id, T5],
            )
            .expect("insert schema-valid unexpected Projection");
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);
        assert_recovery_error_file_zero_write(
            path,
            0,
            &ordinary.operation_id,
            STRUCTURAL_PROGRESS_CORRUPTION,
        );
    }
    {
        let (path, mut fixture) = file_v41("r2-e-f4-cardinality-schema");
        let aggregate = matrix_aggregate_input(
            342,
            "r2-e-f4-cardinality-schema",
            "owner-r2-e-f4-cardinality-schema",
        );
        create_attempt_claim_plan_and_steps(&mut fixture, &aggregate)
            .expect("create cardinality schema fixture");
        let duplicate = fixture
            .execute(
                "INSERT INTO manuscript_provisioning_literature_child_states (
                   aggregate_operation_id, owner_type, owner_id, manuscript_channel,
                   current_operation_id, current_operation_scope_kind, revision,
                   child_summary_status, default_readiness,
                   final_verification_outcome, updated_at
                 ) VALUES (
                   ?1, 'literature', ?2, 'literature_outline',
                   ?1, 'literature-aggregate', 0, 'assigned',
                   'not-verified', 'not-run', ?3
                 )",
                params![aggregate.operation_id, aggregate.owner_id, T5],
            )
            .expect_err("exact-v41 primary key must reject duplicate channel");
        assert!(matches!(
            duplicate,
            Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
        ));
        let unknown_channel = fixture
            .execute(
                "UPDATE manuscript_provisioning_literature_child_states
                 SET manuscript_channel='unknown-channel'
                 WHERE aggregate_operation_id=?1
                   AND manuscript_channel='literature_outline'",
                [&aggregate.operation_id],
            )
            .expect_err("exact-v41 CHECK must reject unknown Projection channel");
        assert!(matches!(
            unknown_channel,
            Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
        ));
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);
        assert_recovery_ok_file_zero_write(path, 0, &aggregate.operation_id);
    }
}

#[test]
fn p4_2e_r2_e_f4_source_gate_uses_one_read_only_projection_validator() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    assert_eq!(
        production
            .matches("fn validate_literature_projection_structure(")
            .count(),
        1
    );
    let validator_start = production
        .find("fn validate_literature_projection_structure(")
        .expect("shared Projection validator must exist");
    let cleanup_start = production
        .find("pub(crate) fn dry_run_progress_cleanup(")
        .expect("Cleanup dry-run entry must exist");
    let validator = &production[validator_start..cleanup_start];
    for required in [
        "STRUCTURAL_PROGRESS_CORRUPTION",
        "read_literature_child_projections",
        "\"literature-aggregate\"",
        "\"literature-child\"",
        "projection_matches_child_attempt",
        "WHERE aggregate_operation_id=?1 OR current_operation_id=?1",
    ] {
        assert!(
            validator.contains(required),
            "Projection validator boundary missing: {required}"
        );
    }
    for forbidden in [
        "dry_run_progress_cleanup",
        "execute_progress_cleanup",
        "INSERT ",
        "UPDATE ",
        "DELETE ",
        "error.message",
        "cfg!(test)",
        "#[cfg(test)]",
    ] {
        assert!(
            !validator.contains(forbidden),
            "Projection validator must remain pure and production-safe: {forbidden}"
        );
    }

    let recovery_start = production
        .find("pub(crate) fn list_recovery_step_progress(")
        .expect("Recovery entry must exist");
    let startup_start = production
        .find("pub(crate) fn read_startup_progress_projection(")
        .expect("Recovery entry boundary must exist");
    let recovery = &production[recovery_start..startup_start];
    assert!(recovery.contains("validate_literature_projection_structure(connection, &attempt)?;"));
    assert!(!recovery.contains("dry_run_progress_cleanup"));
    assert!(!recovery.contains("execute_progress_cleanup"));
    assert!(recovery.contains("RECOVERY_EVIDENCE_INVALID"));
    assert!(recovery.contains("MAX_RECOVERY_CHAIN_DEPTH"));
    assert!(production.contains("pub(crate) const MAX_RECOVERY_CHAIN_DEPTH: usize = 32;"));
}

#[test]
fn p4_2e_r2_e_e2_broken_previous_root_and_missing_middle_are_dual_zero() {
    for (label, depth, mutation) in [
        (
            "broken-previous",
            2_usize,
            "UPDATE manuscript_provisioning_operation_attempts
             SET previous_operation_id='missing-recovery-predecessor'
             WHERE operation_id='r2-e-e2-broken-previous-1'",
        ),
        (
            "broken-root",
            2,
            "UPDATE manuscript_provisioning_operation_attempts
             SET root_operation_id='missing-recovery-root'
             WHERE operation_id='r2-e-e2-broken-root-1'",
        ),
        (
            "missing-middle",
            3,
            "DELETE FROM manuscript_provisioning_operation_attempts
             WHERE operation_id='r2-e-e2-missing-middle-1'",
        ),
    ] {
        let prefix = format!("r2-e-e2-{label}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, depth, &prefix);
        fixture
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable FK only for corruption fixture");
        fixture
            .execute_batch(mutation)
            .expect("construct broken Recovery reference");
        fixture
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("restore FK after corruption fixture");
        let expected_foreign_key_violations = foreign_key_violation_count(&fixture);
        assert!(
            expected_foreign_key_violations > 0,
            "{label} must retain explicit FK corruption evidence"
        );
        drop(fixture);

        assert_recovery_invalid_file_zero_write(path, expected_foreign_key_violations, &current);
    }
}

#[test]
fn p4_2e_r2_e_e2_root_identity_variants_fail_closed_dual_zero() {
    for label in ["non-root-existing", "previous-root-inconsistent"] {
        let prefix = format!("r2-e-e2-{label}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, 3, &prefix);
        let replacement_root = if label == "non-root-existing" {
            format!("{prefix}-1")
        } else {
            current.clone()
        };
        let target = if label == "non-root-existing" {
            current.clone()
        } else {
            format!("{prefix}-1")
        };
        fixture
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET root_operation_id=?1
                 WHERE operation_id=?2",
                params![replacement_root, target],
            )
            .expect("construct schema-valid root identity mismatch");
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);

        assert_recovery_invalid_file_zero_write(path, 0, &current);
    }
}

#[test]
fn p4_2e_r2_e_e2_cross_owner_scope_and_channel_predecessors_are_dual_zero() {
    for (label, sql) in [
        (
            "cross-owner",
            "UPDATE manuscript_provisioning_operation_attempts
             SET owner_id='different-recovery-owner'
             WHERE operation_id='r2-e-e2-cross-owner-0'",
        ),
        (
            "cross-scope",
            "UPDATE manuscript_provisioning_operation_attempts
             SET owner_type='literature', owner_id='cross-scope-owner',
                 scope_kind='literature-aggregate', manuscript_channel=NULL
             WHERE operation_id='r2-e-e2-cross-scope-0'",
        ),
        (
            "cross-channel",
            "UPDATE manuscript_provisioning_operation_attempts
             SET owner_type='literature', owner_id='cross-channel-owner',
                 manuscript_channel='dedicated_notes'
             WHERE operation_id='r2-e-e2-cross-channel-0'",
        ),
    ] {
        let prefix = format!("r2-e-e2-{label}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, 2, &prefix);
        fixture
            .execute_batch(sql)
            .expect("construct schema-valid cross-identity predecessor");
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);

        assert_recovery_invalid_file_zero_write(path, 0, &current);
    }
}

#[test]
fn p4_2e_r2_e_e2_cross_aggregate_predecessor_is_dual_zero() {
    let prefix = "r2-e-e2-cross-aggregate";
    let (path, mut fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 2, prefix);
    let first_aggregate = matrix_aggregate_input(
        501,
        "r2-e-e2-cross-aggregate-anchor-a",
        "r2-e-e2-cross-aggregate-owner-a",
    );
    let second_aggregate = matrix_aggregate_input(
        502,
        "r2-e-e2-cross-aggregate-anchor-b",
        "r2-e-e2-cross-aggregate-owner-b",
    );
    create_attempt_claim_plan_and_steps(&mut fixture, &first_aggregate)
        .expect("create first aggregate anchor");
    create_attempt_claim_plan_and_steps(&mut fixture, &second_aggregate)
        .expect("create second aggregate anchor");
    for (operation_id, aggregate_operation_id) in [
        (format!("{prefix}-0"), first_aggregate.operation_id),
        (format!("{prefix}-1"), second_aggregate.operation_id),
    ] {
        fixture
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET scope_kind='literature-child', owner_type='literature',
                     owner_id='r2-e-e2-cross-aggregate-owner',
                     manuscript_channel='literature_outline', aggregate_operation_id=?1
                 WHERE operation_id=?2",
                params![aggregate_operation_id, operation_id],
            )
            .expect("construct schema-valid Literature child Attempt");
        fixture
            .execute(
                "UPDATE manuscript_provisioning_step_plans
                 SET scope_kind='literature-child', owner_type='literature',
                     owner_id='r2-e-e2-cross-aggregate-owner',
                     manuscript_channel='literature_outline'
                 WHERE operation_id=?1",
                [operation_id],
            )
            .expect("align current Recovery Plan identity");
    }
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    assert_recovery_invalid_file_zero_write(path, 0, &current);
}

#[test]
fn p4_2e_r2_e_e2_two_and_three_node_cycles_are_dual_zero() {
    for (label, depth, cycle_start_previous) in [
        ("two-node-cycle", 4_usize, 2_usize),
        ("three-node-cycle", 5_usize, 3_usize),
    ] {
        let prefix = format!("r2-e-e2-{label}");
        let (path, fixture) = file_v41(&prefix);
        let current = insert_recovery_chain(&fixture, depth, &prefix);
        fixture
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET previous_operation_id=?1
                 WHERE operation_id=?2",
                params![
                    format!("{prefix}-{cycle_start_previous}"),
                    format!("{prefix}-1"),
                ],
            )
            .expect("construct schema-valid Recovery cycle");
        assert_eq!(foreign_key_violation_count(&fixture), 0);
        drop(fixture);

        assert_recovery_invalid_file_zero_write(path, 0, &current);
    }
}

#[test]
fn p4_2e_r2_e_e2_relation_mismatch_is_dual_zero_and_self_references_are_rejected() {
    let relation_prefix = "r2-e-e2-terminal-relation-mismatch";
    let (relation_path, relation_fixture) = file_v41(relation_prefix);
    let relation_current = insert_recovery_chain(&relation_fixture, 2, relation_prefix);
    relation_fixture
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET operation_status='terminal-failed', phase='failed',
                 result_classification='retryable', next_action='retry',
                 partial_kind=NULL
             WHERE operation_id=?1",
            [format!("{relation_prefix}-0")],
        )
        .expect("construct schema-valid predecessor/successor relation mismatch");
    assert_eq!(foreign_key_violation_count(&relation_fixture), 0);
    drop(relation_fixture);
    assert_recovery_invalid_file_zero_write(relation_path, 0, &relation_current);

    let self_prefix = "r2-e-e2-self-reference-schema-rejection";
    let (self_path, self_fixture) = file_v41(self_prefix);
    let self_current = insert_recovery_chain(&self_fixture, 2, self_prefix);
    for column in ["previous_operation_id", "root_operation_id"] {
        let sql = format!(
            "UPDATE manuscript_provisioning_operation_attempts
             SET {column}=?1 WHERE operation_id=?1"
        );
        let error = self_fixture
            .execute(&sql, [&self_current])
            .expect_err("exact-v41 must reject a self-reference");
        assert!(matches!(
            error,
            Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
        ));
    }
    assert_eq!(foreign_key_violation_count(&self_fixture), 0);
    drop(self_fixture);

    let mut connection = reopen_r2_d_fixture(&self_path, 0);
    let evidence = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &self_current)
    })
    .expect("failed self-reference writes must leave the legal chain intact");
    assert_eq!(evidence.chain.len(), 2);
    drop(connection);
    remove_isolated_v41(self_path);
}

#[test]
fn p4_2e_r2_e_e2_unsupported_attempt_shape_and_terminal_tuple_are_schema_rejected() {
    let prefix = "r2-e-e2-unsupported-evidence-shape";
    let (path, fixture) = file_v41(prefix);
    let current = insert_recovery_chain(&fixture, 2, prefix);
    for sql in [
        "UPDATE manuscript_provisioning_operation_attempts
         SET facts_schema_version=2
         WHERE operation_id='r2-e-e2-unsupported-evidence-shape-0'",
        "UPDATE manuscript_provisioning_operation_attempts
         SET operation_status='terminal-completed', phase='completed',
             result_classification='completed', next_action='recover',
             partial_kind=NULL, final_verification_outcome='passed'
         WHERE operation_id='r2-e-e2-unsupported-evidence-shape-0'",
    ] {
        let error = fixture
            .execute_batch(sql)
            .expect_err("exact-v41 must reject unsupported evidence shape");
        assert!(matches!(
            error,
            Error::SqliteFailure(code, _) if code.code == ErrorCode::ConstraintViolation
        ));
    }
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let evidence = assert_actual_connection_zero_write(&mut connection, |actual| {
        list_recovery_step_progress(actual, &current)
    })
    .expect("rejected corruption writes must leave the legal chain intact");
    assert_eq!(evidence.chain.len(), 2);
    drop(connection);
    remove_isolated_v41(path);
}

#[path = "manuscript_provisioning_step_progress_r2_e_a1_discovery_tests.rs"]
mod r2_e_a1_discovery;
