use super::*;
use crate::db::manuscript_provisioning_operation_state::{
    verify_progress_cleanup_deleted_rows, verify_progress_cleanup_final_readback,
    ProgressCleanupFinalReadback, ProgressCleanupRowKind,
};
use rusqlite::hooks::{Action, AuthAction, AuthContext, Authorization};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
    Arc, Mutex,
};

const CLEANUP_CUTOFF: &str = "2026-07-25T00:00:00.000Z";

fn make_terminal_unconverged_fixture(label: &str, boundary: &str) -> (PathBuf, String) {
    let (path, fixture) = file_v41(label);
    let operation_id = insert_recovery_chain(&fixture, 1, label);
    match boundary {
        "intended" => {}
        "started" => {
            fixture
                .execute(
                    "UPDATE manuscript_provisioning_step_progress
                     SET boundary='started', progress_revision=1,
                         started_at=?2, updated_at=?2
                     WHERE operation_id=?1",
                    params![operation_id, T1],
                )
                .expect("construct started required Step");
        }
        "effect-observed" => {
            fixture
                .execute(
                    "UPDATE manuscript_provisioning_step_progress
                     SET boundary='effect-observed', effect_outcome='created',
                         readback_outcome='effect-observed',
                         observed_identity_hash=?2, resource_record_id='a1-resource',
                         progress_revision=2, started_at=?3,
                         effect_observed_at=?4, updated_at=?4
                     WHERE operation_id=?1",
                    params![operation_id, HASH_A, T1, T2],
                )
                .expect("construct effect-observed required Step");
        }
        "readback-verified" => {
            fixture
                .execute(
                    "UPDATE manuscript_provisioning_step_progress
                     SET boundary='readback-verified', effect_outcome='created',
                         readback_outcome='verified', observed_identity_hash=?2,
                         resource_record_id='a1-resource', progress_revision=3,
                         started_at=?3, effect_observed_at=?4,
                         readback_verified_at=?5, updated_at=?5
                     WHERE operation_id=?1",
                    params![operation_id, HASH_A, T1, T2, T3],
                )
                .expect("construct readback-verified required Step");
        }
        _ => panic!("unsupported A1 Step boundary: {boundary}"),
    }
    fixture
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='completed', operation_status='terminal-completed',
                 result_classification='completed', next_action='none',
                 final_verification_outcome='passed',
                 revision=revision+1, terminal_at=?2, updated_at=?2
             WHERE operation_id=?1",
            params![operation_id, T5],
        )
        .expect("construct terminal-completed Attempt");
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);
    (path, operation_id)
}

fn assert_terminal_unconverged_strict_red(label: &str, boundary: &str) {
    let (path, operation_id) = make_terminal_unconverged_fixture(label, boundary);
    assert_recovery_error_file_zero_write(path, 0, &operation_id, STRUCTURAL_PROGRESS_CORRUPTION);
}

#[test]
fn p4_2e_r2_e_a1_discovery_terminal_completed_with_started_required_step_is_structural() {
    assert_terminal_unconverged_strict_red("a1-e3-started", "started");
}

#[test]
fn p4_2e_r2_e_a1_discovery_terminal_completed_with_effect_observed_required_step_is_structural() {
    assert_terminal_unconverged_strict_red("a1-e3-effect", "effect-observed");
}

#[test]
fn p4_2e_r2_e_a1_discovery_terminal_completed_with_readback_verified_required_step_is_structural() {
    assert_terminal_unconverged_strict_red("a1-e3-readback", "readback-verified");
}

#[test]
fn p4_2e_r2_e_a1_discovery_terminal_completed_with_all_required_steps_converged_is_allowed() {
    let label = "a1-e3-converged";
    let (path, fixture) = file_v41(label);
    let operation_id = insert_recovery_chain(&fixture, 1, label);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='converged', effect_outcome='created',
                 readback_outcome='verified', observed_identity_hash=?2,
                 resource_record_id='a1-resource', progress_revision=4,
                 started_at=?3, effect_observed_at=?4,
                 readback_verified_at=?5, converged_at=?6, updated_at=?6
             WHERE operation_id=?1",
            params![operation_id, HASH_A, T1, T2, T3, T4],
        )
        .expect("construct converged required Step");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='completed', operation_status='terminal-completed',
                 result_classification='completed', next_action='none',
                 final_verification_outcome='passed',
                 revision=revision+1, terminal_at=?2, updated_at=?2
             WHERE operation_id=?1",
            params![operation_id, T5],
        )
        .expect("construct consistent terminal-completed Attempt");
    drop(fixture);
    assert_recovery_ok_file_zero_write(path, 0, &operation_id);
}

#[test]
fn p4_2e_r2_e_a1_discovery_active_attempt_with_nonconverged_required_step_is_allowed() {
    let label = "a1-e3-active";
    let (path, fixture) = file_v41(label);
    let operation_id = insert_recovery_chain(&fixture, 1, label);
    drop(fixture);
    assert_recovery_ok_file_zero_write(path, 0, &operation_id);
}

#[test]
fn p4_2e_r2_e_f5_terminal_recovery_required_with_nonconverged_step_is_allowed() {
    let label = "f5-e3-recovery-required";
    let (path, fixture) = file_v41(label);
    let operation_id = insert_recovery_chain(&fixture, 1, label);
    fixture
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed',
                 operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',
                 next_action='recover', partial_kind='physical-only',
                 final_verification_outcome='not-passed',
                 revision=revision+1, terminal_at=?2, updated_at=?2
             WHERE operation_id=?1",
            params![operation_id, T5],
        )
        .expect("construct legal terminal-recovery-required Attempt");
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);
    assert_recovery_ok_file_zero_write(path, 0, &operation_id);
}

#[test]
fn p4_2e_r2_e_f5_terminal_completed_with_one_of_multiple_required_steps_unconverged_is_structural()
{
    let label = "f5-e3-multiple-required";
    let (path, fixture) = file_v41(label);
    let operation_id = insert_recovery_chain(&fixture, 1, label);
    let plan_id: String = fixture
        .query_row(
            "SELECT plan_id
             FROM manuscript_provisioning_step_plans
             WHERE operation_id=?1",
            [&operation_id],
            |row| row.get(0),
        )
        .expect("read Recovery Plan identity");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_step_plans
             SET step_count=2
             WHERE operation_id=?1",
            [&operation_id],
        )
        .expect("declare two required Steps");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='converged', effect_outcome='created',
                 readback_outcome='verified', observed_identity_hash=?2,
                 resource_record_id='f5-resource-0', progress_revision=4,
                 started_at=?3, effect_observed_at=?4,
                 readback_verified_at=?5, converged_at=?6, updated_at=?6
             WHERE operation_id=?1 AND step_ordinal=0",
            params![operation_id, HASH_A, T1, T2, T3, T4],
        )
        .expect("converge first required Step");
    fixture
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
               step_version, is_required, boundary, effect_outcome, readback_outcome,
               effect_facts_schema_version, progress_revision, created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, 1, 'ensure-manuscript', 'primary',
               1, 1, 'intended', 'unobserved', 'not-run', 1, 0, ?4, ?4
             )",
            params![HASH_F, plan_id, operation_id, T0],
        )
        .expect("insert second unconverged required Step");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='completed', operation_status='terminal-completed',
                 result_classification='completed', next_action='none',
                 final_verification_outcome='passed',
                 revision=revision+1, terminal_at=?2, updated_at=?2
             WHERE operation_id=?1",
            params![operation_id, T5],
        )
        .expect("construct inconsistent terminal-completed Attempt");
    assert_eq!(foreign_key_violation_count(&fixture), 0);
    drop(fixture);
    assert_recovery_error_file_zero_write(path, 0, &operation_id, STRUCTURAL_PROGRESS_CORRUPTION);
}

fn assert_executor_rejected_before_delete(
    path: PathBuf,
    operation_id: &str,
    terminal_before: &str,
    expected_code: &str,
) {
    let mut connection = reopen_r2_d_fixture(&path, 0);
    let changes_before = connection.total_changes();
    let authority_before = authority_snapshot(&connection);
    let meta_before = meta_snapshot(&connection);
    start_sql_trace(&mut connection);
    let error = execute_progress_cleanup(&mut connection, operation_id, terminal_before)
        .expect_err("Cleanup executor must fail closed");
    let trace = finish_sql_trace(&mut connection);
    assert_eq!(
        error.code, expected_code,
        "unexpected Cleanup error: {error:?}"
    );
    assert_eq!(connection.total_changes(), changes_before);
    assert_eq!(authority_snapshot(&connection), authority_before);
    assert_eq!(meta_snapshot(&connection), meta_before);
    assert!(
        trace
            .iter()
            .all(|event| event.statement_kind.as_str() != "DELETE"),
        "fail-closed Cleanup emitted DELETE: {trace:?}"
    );
    drop(connection);

    let reopened = reopen_r2_d_fixture(&path, 0);
    assert_eq!(authority_snapshot(&reopened), authority_before);
    assert_eq!(meta_snapshot(&reopened), meta_before);
    drop(reopened);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_a1_discovery_cleanup_claim_outbox_and_retention_authority_fail_closed() {
    let active = matrix_review_input(500, "a1-e4-active", "owner-a1-e4-active");
    let (active_path, mut active_fixture) = file_v41("a1-e4-active");
    setup_cleanup(&mut active_fixture, &active);
    insert_active_claim_reference(
        &active_fixture,
        "a1-e4-active",
        &active.operation_id,
        "channel",
        "review",
        &active.owner_id,
        Some("primary"),
    );
    drop(active_fixture);
    assert_executor_rejected_before_delete(
        active_path,
        &active.operation_id,
        CLEANUP_CUTOFF,
        CLEANUP_PROGRESS_RETAINED,
    );

    for (index, status) in ["pending", "failed"].into_iter().enumerate() {
        let operation_id = format!("a1-e4-outbox-{status}");
        let owner_id = format!("owner-a1-e4-outbox-{status}");
        let input = matrix_review_input(501 + index as u64, &operation_id, &owner_id);
        let (path, mut fixture) = file_v41(&operation_id);
        setup_terminal(&mut fixture, &input);
        terminalize_attempt_release_claim_and_enqueue_audit(
            &mut fixture,
            &TerminalAttemptInput::completed(
                &input.operation_id,
                &input.claim_id,
                &input.claim_owner_token,
                0,
                0,
                T5,
            ),
        )
        .expect("terminal Outbox fixture");
        if status == "failed" {
            fixture
                .execute(
                    "UPDATE manuscript_provisioning_audit_outbox
                     SET delivery_status='failed', revision=1,
                         delivery_attempt_count=1, error_code='A1_CONTROLLED_FAILURE'
                     WHERE operation_id=?1",
                    [&input.operation_id],
                )
                .expect("failed Outbox fixture");
        }
        drop(fixture);
        assert_executor_rejected_before_delete(
            path,
            &input.operation_id,
            CLEANUP_CUTOFF,
            CLEANUP_PROGRESS_RETAINED,
        );
    }

    let retention = matrix_review_input(503, "a1-e4-retention", "owner-a1-e4-retention");
    let (retention_path, mut retention_fixture) = file_v41("a1-e4-retention");
    setup_cleanup(&mut retention_fixture, &retention);
    drop(retention_fixture);
    assert_executor_rejected_before_delete(
        retention_path,
        &retention.operation_id,
        T4,
        CLEANUP_PROGRESS_RETAINED,
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_cleanup_step_plan_and_reference_authority_fail_closed() {
    let step = matrix_review_input(510, "a1-e4-step", "owner-a1-e4-step");
    let (step_path, mut step_fixture) = file_v41("a1-e4-step");
    setup_cleanup(&mut step_fixture, &step);
    step_fixture
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='readback-verified', converged_at=NULL,
                 progress_revision=progress_revision+1, updated_at=?2
             WHERE operation_id=?1",
            params![step.operation_id, T5],
        )
        .expect("make required Step nonconverged");
    drop(step_fixture);
    assert_executor_rejected_before_delete(
        step_path,
        &step.operation_id,
        CLEANUP_CUTOFF,
        CLEANUP_PROGRESS_RETAINED,
    );

    let plan = matrix_review_input(511, "a1-e4-plan", "owner-a1-e4-plan");
    let (plan_path, mut plan_fixture) = file_v41("a1-e4-plan");
    setup_cleanup(&mut plan_fixture, &plan);
    plan_fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&plan.operation_id],
        )
        .expect("remove Step fixture");
    plan_fixture
        .execute(
            "DELETE FROM manuscript_provisioning_step_plans WHERE operation_id=?1",
            [&plan.operation_id],
        )
        .expect("remove Plan fixture");
    drop(plan_fixture);
    assert_executor_rejected_before_delete(
        plan_path,
        &plan.operation_id,
        CLEANUP_CUTOFF,
        CLEANUP_PROGRESS_RETAINED,
    );

    let referenced = matrix_review_input(512, "a1-e4-referenced", "owner-a1-e4-referenced");
    let (reference_path, mut reference_fixture) = file_v41("a1-e4-referenced");
    setup_cleanup(&mut reference_fixture, &referenced);
    insert_successor_reference(
        &reference_fixture,
        "a1-e4-successor",
        &referenced.operation_id,
        "channel",
        "review",
        &referenced.owner_id,
        Some("primary"),
    );
    drop(reference_fixture);
    assert_executor_rejected_before_delete(
        reference_path,
        &referenced.operation_id,
        CLEANUP_CUTOFF,
        CLEANUP_PROGRESS_RETAINED,
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_cleanup_literature_and_non_literature_projection_fail_closed() {
    let aggregate = matrix_aggregate_input(520, "a1-e4-lit-missing", "owner-a1-e4-lit-missing");
    let (aggregate_path, mut aggregate_fixture) = file_v41("a1-e4-lit-missing");
    setup_cleanup(&mut aggregate_fixture, &aggregate);
    aggregate_fixture
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1 AND manuscript_channel='literature_outline'",
            [&aggregate.operation_id],
        )
        .expect("remove required Literature Projection");
    drop(aggregate_fixture);
    assert_executor_rejected_before_delete(
        aggregate_path,
        &aggregate.operation_id,
        CLEANUP_CUTOFF,
        STRUCTURAL_PROGRESS_CORRUPTION,
    );

    let review = matrix_review_input(521, "a1-e4-unexpected", "owner-a1-e4-unexpected");
    let (review_path, mut review_fixture) = file_v41("a1-e4-unexpected");
    setup_cleanup(&mut review_fixture, &review);
    review_fixture
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
        .expect("insert schema-valid unexpected Projection");
    drop(review_fixture);
    assert_executor_rejected_before_delete(
        review_path,
        &review.operation_id,
        CLEANUP_CUTOFF,
        STRUCTURAL_PROGRESS_CORRUPTION,
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_cleanup_eligible_ordinary_and_literature_are_exact() {
    let ordinary = matrix_review_input(530, "a1-e4-ordinary-ok", "owner-a1-e4-ordinary-ok");
    let (ordinary_path, mut ordinary_fixture) = file_v41("a1-e4-ordinary-ok");
    setup_cleanup(&mut ordinary_fixture, &ordinary);
    drop(ordinary_fixture);
    let mut ordinary_connection = reopen_r2_d_fixture(&ordinary_path, 0);
    let ordinary_result = execute_progress_cleanup(
        &mut ordinary_connection,
        &ordinary.operation_id,
        CLEANUP_CUTOFF,
    )
    .expect("eligible ordinary Cleanup");
    assert_eq!(
        (
            ordinary_result.deleted_steps,
            ordinary_result.deleted_plans,
            ordinary_result.deleted_projections,
            ordinary_result.deleted_outboxes,
            ordinary_result.deleted_attempts,
        ),
        (1, 1, 0, 1, 1)
    );
    drop(ordinary_connection);
    let ordinary_reopened = reopen_r2_d_fixture(&ordinary_path, 0);
    assert!(authority_snapshot(&ordinary_reopened)
        .iter()
        .all(|row| !row.contains(&ordinary.operation_id)));
    drop(ordinary_reopened);
    remove_isolated_v41(ordinary_path);

    let aggregate = matrix_aggregate_input(531, "a1-e4-literature-ok", "owner-a1-e4-literature-ok");
    let (aggregate_path, mut aggregate_fixture) = file_v41("a1-e4-literature-ok");
    setup_cleanup(&mut aggregate_fixture, &aggregate);
    drop(aggregate_fixture);
    let mut aggregate_connection = reopen_r2_d_fixture(&aggregate_path, 0);
    let aggregate_result = execute_progress_cleanup(
        &mut aggregate_connection,
        &aggregate.operation_id,
        CLEANUP_CUTOFF,
    )
    .expect("eligible Literature aggregate Cleanup");
    assert_eq!(
        (
            aggregate_result.deleted_steps,
            aggregate_result.deleted_plans,
            aggregate_result.deleted_projections,
            aggregate_result.deleted_outboxes,
            aggregate_result.deleted_attempts,
        ),
        (1, 1, 2, 1, 1)
    );
    drop(aggregate_connection);
    let aggregate_reopened = reopen_r2_d_fixture(&aggregate_path, 0);
    assert!(authority_snapshot(&aggregate_reopened)
        .iter()
        .all(|row| !row.contains(&aggregate.operation_id)));
    drop(aggregate_reopened);
    remove_isolated_v41(aggregate_path);
}

#[test]
fn p4_2e_r2_e_f6_cleanup_dry_run_freezes_exact_authoritative_counts() {
    let ordinary = matrix_review_input(532, "f6-planned-ordinary", "owner-f6-planned-ordinary");
    let (ordinary_path, mut ordinary_fixture) = file_v41("f6-planned-ordinary");
    setup_cleanup(&mut ordinary_fixture, &ordinary);
    let ordinary_decision =
        dry_run_progress_cleanup(&ordinary_fixture, &ordinary.operation_id, CLEANUP_CUTOFF)
            .expect("ordinary cleanup inspection");
    assert!(ordinary_decision.eligible);
    assert_eq!(
        (
            ordinary_decision.planned_steps,
            ordinary_decision.planned_plans,
            ordinary_decision.planned_projections,
            ordinary_decision.planned_outboxes,
            ordinary_decision.planned_attempts,
        ),
        (1, 1, 0, 1, 1)
    );
    drop(ordinary_fixture);
    remove_isolated_v41(ordinary_path);

    let aggregate =
        matrix_aggregate_input(533, "f6-planned-literature", "owner-f6-planned-literature");
    let (aggregate_path, mut aggregate_fixture) = file_v41("f6-planned-literature");
    setup_cleanup(&mut aggregate_fixture, &aggregate);
    let aggregate_decision =
        dry_run_progress_cleanup(&aggregate_fixture, &aggregate.operation_id, CLEANUP_CUTOFF)
            .expect("Literature aggregate cleanup inspection");
    assert!(aggregate_decision.eligible);
    assert_eq!(
        (
            aggregate_decision.planned_steps,
            aggregate_decision.planned_plans,
            aggregate_decision.planned_projections,
            aggregate_decision.planned_outboxes,
            aggregate_decision.planned_attempts,
        ),
        (1, 1, 2, 1, 1)
    );
    drop(aggregate_fixture);
    remove_isolated_v41(aggregate_path);
}

#[test]
fn p4_2e_r2_e_f6_cleanup_delete_count_verifier_rejects_every_mismatch() {
    for row_kind in [
        ProgressCleanupRowKind::Step,
        ProgressCleanupRowKind::Plan,
        ProgressCleanupRowKind::Projection,
        ProgressCleanupRowKind::Outbox,
        ProgressCleanupRowKind::Attempt,
    ] {
        for actual in [0, 2] {
            let error = verify_progress_cleanup_deleted_rows(row_kind, 1, actual)
                .expect_err("under-delete and over-delete must fail the transaction invariant");
            assert_eq!(error.code, STRUCTURAL_PROGRESS_CORRUPTION);
        }
        verify_progress_cleanup_deleted_rows(row_kind, 1, 1)
            .expect("an exact affected-row count must pass");
    }
    verify_progress_cleanup_deleted_rows(ProgressCleanupRowKind::Projection, 0, 0)
        .expect("ordinary zero-row Projection delete is an exact result");
}

#[test]
fn p4_2e_r2_e_f6_cleanup_final_readback_rejects_every_residual() {
    let clean = ProgressCleanupFinalReadback {
        step_rows: 0,
        plan_rows: 0,
        projection_rows: 0,
        outbox_rows: 0,
        attempt_rows: 0,
        active_claim_rows: 0,
        blocking_reference_rows: 0,
    };
    verify_progress_cleanup_final_readback(&clean).expect("all-zero final readback must pass");

    for residual in [
        ProgressCleanupFinalReadback {
            step_rows: 1,
            ..clean.clone()
        },
        ProgressCleanupFinalReadback {
            plan_rows: 1,
            ..clean.clone()
        },
        ProgressCleanupFinalReadback {
            projection_rows: 1,
            ..clean.clone()
        },
        ProgressCleanupFinalReadback {
            outbox_rows: 1,
            ..clean.clone()
        },
        ProgressCleanupFinalReadback {
            attempt_rows: 1,
            ..clean.clone()
        },
        ProgressCleanupFinalReadback {
            active_claim_rows: 1,
            ..clean.clone()
        },
        ProgressCleanupFinalReadback {
            blocking_reference_rows: 1,
            ..clean.clone()
        },
    ] {
        let error = verify_progress_cleanup_final_readback(&residual)
            .expect_err("any final cleanup residual must fail the transaction invariant");
        assert_eq!(error.code, STRUCTURAL_PROGRESS_CORRUPTION);
    }
}

#[test]
fn p4_2e_r2_e_f6_cleanup_handles_multi_step_and_zero_step_plans_exactly() {
    let mut multi = matrix_review_input(536, "f6-multi-step", "owner-f6-multi-step");
    multi.plan.declared_step_count = 2;
    let mut second_step = multi.steps[0].clone();
    second_step.step_id = format!("{:064x}", 90_001);
    second_step.step_ordinal = 1;
    second_step.step_kind = DurableStepKind::EnsureManuscript;
    multi.steps.push(second_step);
    let (multi_path, mut multi_fixture) = file_v41("f6-multi-step");
    create_attempt_claim_plan_and_steps(&mut multi_fixture, &multi).expect("multi-Step init");
    for (index, step) in multi.steps.iter().enumerate() {
        let authority = |revision: i64, occurred_at: &str| ProgressAuthorityInput {
            operation_id: multi.operation_id.clone(),
            plan_id: multi.plan.plan_id.clone(),
            step_id: step.step_id.clone(),
            claim_id: multi.claim_id.clone(),
            claim_owner_token: multi.claim_owner_token.clone(),
            expected_progress_revision: revision,
            occurred_at: occurred_at.to_string(),
        };
        mark_step_started(&mut multi_fixture, &authority(0, T1)).expect("start Step");
        record_step_effect_observed(
            &mut multi_fixture,
            &authority(1, T2),
            DurableStepEffectOutcome::Created,
            HASH_E,
            Some(&format!("f6-resource-{index}")),
        )
        .expect("observe Step");
        record_step_readback_verified(&mut multi_fixture, &authority(2, T3)).expect("verify Step");
        converge_step(&mut multi_fixture, &authority(3, T4)).expect("converge Step");
    }
    terminalize_and_deliver_fixture(&mut multi_fixture, &multi);
    let multi_decision =
        dry_run_progress_cleanup(&multi_fixture, &multi.operation_id, CLEANUP_CUTOFF)
            .expect("multi-Step cleanup inspection");
    assert!(multi_decision.eligible);
    assert_eq!(multi_decision.planned_steps, 2);
    let multi_result =
        execute_progress_cleanup(&mut multi_fixture, &multi.operation_id, CLEANUP_CUTOFF)
            .expect("multi-Step cleanup");
    assert_eq!(multi_result.deleted_steps, 2);
    drop(multi_fixture);
    remove_isolated_v41(multi_path);

    let mut zero = matrix_review_input(537, "f6-zero-step", "owner-f6-zero-step");
    zero.intent = DurablePlanIntent::Recover;
    zero.trigger_kind = "explicit-recovery".to_string();
    zero.plan.declared_step_count = 0;
    zero.steps.clear();
    let (zero_path, mut zero_fixture) = file_v41("f6-zero-step");
    create_attempt_claim_plan_and_steps(&mut zero_fixture, &zero).expect("zero-Step init");
    terminalize_and_deliver_fixture(&mut zero_fixture, &zero);
    let zero_decision = dry_run_progress_cleanup(&zero_fixture, &zero.operation_id, CLEANUP_CUTOFF)
        .expect("zero-Step cleanup inspection");
    assert!(zero_decision.eligible);
    assert_eq!(zero_decision.planned_steps, 0);
    let zero_result =
        execute_progress_cleanup(&mut zero_fixture, &zero.operation_id, CLEANUP_CUTOFF)
            .expect("zero-Step cleanup");
    assert_eq!(zero_result.deleted_steps, 0);
    drop(zero_fixture);
    remove_isolated_v41(zero_path);
}

#[test]
fn p4_2e_r2_e_f6_cleanup_literature_child_remains_projection_referenced() {
    let (path, mut fixture) = file_v41("f6-literature-child-retained");
    let (aggregate, child) = setup_matrix_child(&mut fixture, 538, "f6-literature-child-retained");
    terminalize_literature_child_attempt(
        &mut fixture,
        &TerminalAttemptInput::completed(
            &child.operation_id,
            &aggregate.claim_id,
            &aggregate.claim_owner_token,
            0,
            1,
            T5,
        ),
    )
    .expect("terminalize current Literature child");
    let decision = dry_run_progress_cleanup(&fixture, &child.operation_id, CLEANUP_CUTOFF)
        .expect("Literature child cleanup inspection");
    assert!(!decision.eligible);
    assert_eq!(decision.planned_steps, 1);
    assert_eq!(decision.planned_plans, 1);
    assert_eq!(decision.planned_projections, 0);
    assert_eq!(decision.planned_outboxes, 1);
    assert_eq!(decision.planned_attempts, 1);
    assert_eq!(
        decision.reasons,
        ["audit-not-delivered", "literature-projection-reference"]
    );
    drop(fixture);
    remove_isolated_v41(path);
}

#[derive(Clone)]
struct DeleteFaultEvidence {
    denied: Arc<AtomicBool>,
    authorizer_calls: Arc<AtomicUsize>,
    deleted_tables: Arc<Mutex<Vec<String>>>,
}

fn arm_delete_fault(connection: &Connection, target_table: &'static str) -> DeleteFaultEvidence {
    let denied = Arc::new(AtomicBool::new(false));
    let authorizer_calls = Arc::new(AtomicUsize::new(0));
    let deleted_tables = Arc::new(Mutex::new(Vec::new()));

    let denied_callback = Arc::clone(&denied);
    let calls_callback = Arc::clone(&authorizer_calls);
    connection.authorizer(Some(move |context: AuthContext<'_>| {
        calls_callback.fetch_add(1, AtomicOrdering::SeqCst);
        if let AuthAction::Delete { table_name } = context.action {
            if table_name == target_table && !denied_callback.swap(true, AtomicOrdering::SeqCst) {
                return Authorization::Deny;
            }
        }
        Authorization::Allow
    }));

    let updates_callback = Arc::clone(&deleted_tables);
    connection.update_hook(Some(
        move |action: Action, _database: &str, table: &str, _rowid: i64| {
            if action == Action::SQLITE_DELETE {
                updates_callback
                    .lock()
                    .expect("record DELETE update-hook evidence")
                    .push(table.to_string());
            }
        },
    ));
    DeleteFaultEvidence {
        denied,
        authorizer_calls,
        deleted_tables,
    }
}

fn remove_delete_fault(connection: &Connection) {
    connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    connection.update_hook(None::<fn(Action, &str, &str, i64)>);
}

fn assert_final_readback_fault_rolls_back(label: &str, input: &AtomicDurableAttemptInput) {
    let (path, mut fixture) = file_v41(label);
    setup_cleanup(&mut fixture, input);
    let authority_before = authority_snapshot(&fixture);
    let meta_before = meta_snapshot(&fixture);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let attempt_deleted = Arc::new(AtomicBool::new(false));
    let readback_denied = Arc::new(AtomicBool::new(false));
    let deleted_for_authorizer = Arc::clone(&attempt_deleted);
    let denied_for_authorizer = Arc::clone(&readback_denied);
    connection.authorizer(Some(move |context: AuthContext<'_>| {
        if deleted_for_authorizer.load(AtomicOrdering::SeqCst) {
            if let AuthAction::Read { table_name, .. } = context.action {
                if table_name == "manuscript_provisioning_step_progress"
                    && !denied_for_authorizer.swap(true, AtomicOrdering::SeqCst)
                {
                    return Authorization::Deny;
                }
            }
        }
        Authorization::Allow
    }));
    let deleted_for_update_hook = Arc::clone(&attempt_deleted);
    connection.update_hook(Some(
        move |action: Action, _database: &str, table: &str, _rowid: i64| {
            if action == Action::SQLITE_DELETE
                && table == "manuscript_provisioning_operation_attempts"
            {
                deleted_for_update_hook.store(true, AtomicOrdering::SeqCst);
            }
        },
    ));

    let error = execute_progress_cleanup(&mut connection, &input.operation_id, CLEANUP_CUTOFF)
        .expect_err("final cleanup readback SQLite fault must abort the transaction");
    remove_delete_fault(&connection);
    assert_eq!(error.code, PROVISIONING_OPERATION_DATABASE_ERROR);
    assert!(attempt_deleted.load(AtomicOrdering::SeqCst));
    assert!(readback_denied.load(AtomicOrdering::SeqCst));
    drop(connection);

    let reopened = reopen_r2_d_fixture(&path, 0);
    assert_eq!(authority_snapshot(&reopened), authority_before);
    assert_eq!(meta_snapshot(&reopened), meta_before);
    drop(reopened);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_f6_cleanup_final_readback_fault_rolls_back_ordinary_and_literature() {
    let ordinary = matrix_review_input(
        534,
        "f6-final-readback-ordinary",
        "owner-f6-final-readback-ordinary",
    );
    assert_final_readback_fault_rolls_back("f6-final-readback-ordinary", &ordinary);
    let literature = matrix_aggregate_input(
        535,
        "f6-final-readback-literature",
        "owner-f6-final-readback-literature",
    );
    assert_final_readback_fault_rolls_back("f6-final-readback-literature", &literature);
}

#[test]
fn p4_2e_r2_e_a1_discovery_e5a_authorizer_update_hook_trace_is_qualified() {
    let input = matrix_review_input(540, "a1-e5a-probe", "owner-a1-e5a-probe");
    let (path, mut fixture) = file_v41("a1-e5a-probe");
    setup_cleanup(&mut fixture, &input);
    let authority_before = authority_snapshot(&fixture);
    let meta_before = meta_snapshot(&fixture);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let evidence = arm_delete_fault(&connection, "manuscript_provisioning_step_plans");
    start_sql_trace(&mut connection);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin isolated capability probe");
    transaction
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [&input.operation_id],
        )
        .expect("probe predecessor DELETE");
    let error = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_step_plans WHERE operation_id=?1",
            [&input.operation_id],
        )
        .expect_err("authorizer must deny target statement");
    match error {
        Error::SqliteFailure(code, _) => {
            assert_eq!(code.code, ErrorCode::AuthorizationForStatementDenied);
            assert_eq!(code.extended_code, 23);
        }
        other => panic!("unexpected authorizer error: {other:?}"),
    }
    drop(transaction);
    let trace = finish_sql_trace(&mut connection);
    remove_delete_fault(&connection);
    assert!(evidence.denied.load(AtomicOrdering::SeqCst));
    assert!(evidence.authorizer_calls.load(AtomicOrdering::SeqCst) > 0);
    assert_eq!(
        evidence
            .deleted_tables
            .lock()
            .expect("read update-hook evidence")
            .as_slice(),
        ["manuscript_provisioning_step_progress"]
    );
    assert!(trace.iter().any(|event| {
        event.statement_kind == "DELETE"
            && event.target_table.as_deref() == Some("manuscript_provisioning_step_progress")
    }));
    assert!(trace.iter().all(|event| {
        event.target_table.as_deref() != Some("manuscript_provisioning_step_plans")
    }));
    drop(connection);

    let reopened = reopen_r2_d_fixture(&path, 0);
    assert_eq!(authority_snapshot(&reopened), authority_before);
    assert_eq!(meta_snapshot(&reopened), meta_before);
    drop(reopened);
    remove_isolated_v41(path);

    let (other_path, other) = file_v41("a1-e5a-other-connection");
    assert_eq!(
        other
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .expect("non-target connection remains usable"),
        schema::CURRENT_SCHEMA_VERSION
    );
    drop(other);
    remove_isolated_v41(other_path);
}

fn assert_production_delete_fault_rolls_back(
    label: &str,
    input: &AtomicDurableAttemptInput,
    target_table: &'static str,
    required_predecessor_tables: &[&str],
    forbidden_later_tables: &[&str],
) {
    let (path, mut fixture) = file_v41(label);
    setup_cleanup(&mut fixture, input);
    let authority_before = authority_snapshot(&fixture);
    let meta_before = meta_snapshot(&fixture);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let evidence = arm_delete_fault(&connection, target_table);
    start_sql_trace(&mut connection);
    let error = execute_progress_cleanup(&mut connection, &input.operation_id, CLEANUP_CUTOFF)
        .expect_err("real Cleanup executor must surface target statement fault");
    let trace = finish_sql_trace(&mut connection);
    remove_delete_fault(&connection);
    assert_eq!(error.code, PROVISIONING_OPERATION_DATABASE_ERROR);
    assert!(evidence.denied.load(AtomicOrdering::SeqCst));
    let deleted_tables = evidence
        .deleted_tables
        .lock()
        .expect("read production update-hook evidence")
        .clone();
    for table in required_predecessor_tables {
        assert!(
            deleted_tables.iter().any(|actual| actual == table),
            "missing predecessor DELETE evidence for {table}: {deleted_tables:?}"
        );
    }
    assert!(
        !deleted_tables.iter().any(|actual| actual == target_table),
        "denied target DELETE must not execute"
    );
    for table in forbidden_later_tables {
        assert!(
            trace.iter().all(|event| {
                !(event.statement_kind == "DELETE" && event.target_table.as_deref() == Some(table))
            }),
            "a DELETE after the denied target was traced for {table}: {trace:?}"
        );
    }
    drop(connection);

    let reopened = reopen_r2_d_fixture(&path, 0);
    assert_eq!(authority_snapshot(&reopened), authority_before);
    assert_eq!(meta_snapshot(&reopened), meta_before);
    drop(reopened);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_ordinary_intermediate_delete_fault_rolls_back() {
    let input = matrix_review_input(550, "a1-e6-ordinary", "owner-a1-e6-ordinary");
    assert_production_delete_fault_rolls_back(
        "a1-e6-ordinary",
        &input,
        "manuscript_provisioning_step_plans",
        &["manuscript_provisioning_step_progress"],
        &[
            "manuscript_provisioning_literature_child_states",
            "manuscript_provisioning_audit_outbox",
            "manuscript_provisioning_operation_attempts",
        ],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_ordinary_first_step_delete_fault_is_zero_delete() {
    let input = matrix_review_input(552, "a1-e6-ordinary-step", "owner-a1-e6-ordinary-step");
    assert_production_delete_fault_rolls_back(
        "a1-e6-ordinary-step",
        &input,
        "manuscript_provisioning_step_progress",
        &[],
        &[
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_literature_child_states",
            "manuscript_provisioning_audit_outbox",
            "manuscript_provisioning_operation_attempts",
        ],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_ordinary_outbox_delete_fault_rolls_back() {
    let input = matrix_review_input(553, "a1-e6-ordinary-outbox", "owner-a1-e6-ordinary-outbox");
    assert_production_delete_fault_rolls_back(
        "a1-e6-ordinary-outbox",
        &input,
        "manuscript_provisioning_audit_outbox",
        &[
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_step_plans",
        ],
        &["manuscript_provisioning_operation_attempts"],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_ordinary_attempt_delete_fault_rolls_back() {
    let input = matrix_review_input(
        554,
        "a1-e6-ordinary-attempt",
        "owner-a1-e6-ordinary-attempt",
    );
    assert_production_delete_fault_rolls_back(
        "a1-e6-ordinary-attempt",
        &input,
        "manuscript_provisioning_operation_attempts",
        &[
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_audit_outbox",
        ],
        &[],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_literature_projection_delete_fault_rolls_back() {
    let input = matrix_aggregate_input(551, "a1-e6-literature", "owner-a1-e6-literature");
    assert_production_delete_fault_rolls_back(
        "a1-e6-literature",
        &input,
        "manuscript_provisioning_literature_child_states",
        &[
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_step_plans",
        ],
        &[
            "manuscript_provisioning_audit_outbox",
            "manuscript_provisioning_operation_attempts",
        ],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_literature_first_step_delete_fault_is_zero_delete() {
    let input = matrix_aggregate_input(555, "a1-e6-literature-step", "owner-a1-e6-literature-step");
    assert_production_delete_fault_rolls_back(
        "a1-e6-literature-step",
        &input,
        "manuscript_provisioning_step_progress",
        &[],
        &[
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_literature_child_states",
            "manuscript_provisioning_audit_outbox",
            "manuscript_provisioning_operation_attempts",
        ],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_literature_plan_delete_fault_rolls_back() {
    let input = matrix_aggregate_input(556, "a1-e6-literature-plan", "owner-a1-e6-literature-plan");
    assert_production_delete_fault_rolls_back(
        "a1-e6-literature-plan",
        &input,
        "manuscript_provisioning_step_plans",
        &["manuscript_provisioning_step_progress"],
        &[
            "manuscript_provisioning_literature_child_states",
            "manuscript_provisioning_audit_outbox",
            "manuscript_provisioning_operation_attempts",
        ],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_literature_outbox_delete_fault_rolls_back() {
    let input = matrix_aggregate_input(
        557,
        "a1-e6-literature-outbox",
        "owner-a1-e6-literature-outbox",
    );
    assert_production_delete_fault_rolls_back(
        "a1-e6-literature-outbox",
        &input,
        "manuscript_provisioning_audit_outbox",
        &[
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_literature_child_states",
        ],
        &["manuscript_provisioning_operation_attempts"],
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_literature_attempt_delete_fault_rolls_back() {
    let input = matrix_aggregate_input(
        558,
        "a1-e6-literature-attempt",
        "owner-a1-e6-literature-attempt",
    );
    assert_production_delete_fault_rolls_back(
        "a1-e6-literature-attempt",
        &input,
        "manuscript_provisioning_operation_attempts",
        &[
            "manuscript_provisioning_step_progress",
            "manuscript_provisioning_step_plans",
            "manuscript_provisioning_literature_child_states",
            "manuscript_provisioning_audit_outbox",
        ],
        &[],
    );
}

fn assert_commit_fault_rolls_back(label: &str, input: &AtomicDurableAttemptInput) {
    let (path, mut fixture) = file_v41(label);
    setup_cleanup(&mut fixture, input);
    let authority_before = authority_snapshot(&fixture);
    let meta_before = meta_snapshot(&fixture);
    drop(fixture);

    let mut connection = reopen_r2_d_fixture(&path, 0);
    let deleted_tables = Arc::new(Mutex::new(Vec::new()));
    let updates = Arc::clone(&deleted_tables);
    connection.update_hook(Some(
        move |action: Action, _database: &str, table: &str, _rowid: i64| {
            if action == Action::SQLITE_DELETE {
                updates
                    .lock()
                    .expect("record commit-fault DELETE evidence")
                    .push(table.to_string());
            }
        },
    ));
    let (_scope, evidence) = arm_native_commit_hook_abort(&connection);
    start_sql_trace(&mut connection);
    let error = execute_progress_cleanup(&mut connection, &input.operation_id, CLEANUP_CUTOFF)
        .expect_err("native COMMIT fault must abort real Cleanup");
    let trace = finish_sql_trace(&mut connection);
    remove_native_commit_hook(&connection);
    connection.update_hook(None::<fn(Action, &str, &str, i64)>);
    assert_native_commit_hook_abort(error.code, &error.message, &evidence);
    assert!(trace.iter().any(|event| event.statement_kind == "COMMIT"));
    assert!(
        deleted_tables
            .lock()
            .expect("read commit-fault DELETE evidence")
            .iter()
            .any(|table| table == "manuscript_provisioning_operation_attempts"),
        "Attempt DELETE must execute before the COMMIT fault"
    );
    drop(connection);

    let reopened = reopen_r2_d_fixture(&path, 0);
    assert_eq!(authority_snapshot(&reopened), authority_before);
    assert_eq!(meta_snapshot(&reopened), meta_before);
    drop(reopened);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_a1_discovery_e6_ordinary_and_literature_commit_faults_roll_back() {
    let ordinary = matrix_review_input(560, "a1-e6-ordinary-commit", "owner-a1-e6-ordinary-commit");
    assert_commit_fault_rolls_back("a1-e6-ordinary-commit", &ordinary);
    let literature = matrix_aggregate_input(
        561,
        "a1-e6-literature-commit",
        "owner-a1-e6-literature-commit",
    );
    assert_commit_fault_rolls_back("a1-e6-literature-commit", &literature);
}

fn assert_stale_executor_rejection(
    connection: &mut Connection,
    operation_id: &str,
    expected_code: &str,
) {
    let authority_before = authority_snapshot(connection);
    let meta_before = meta_snapshot(connection);
    start_sql_trace(connection);
    let error = execute_progress_cleanup(connection, operation_id, CLEANUP_CUTOFF)
        .expect_err("executor must revalidate stale authority");
    let trace = finish_sql_trace(connection);
    assert_eq!(error.code, expected_code);
    assert_eq!(authority_snapshot(connection), authority_before);
    assert_eq!(meta_snapshot(connection), meta_before);
    assert!(
        trace
            .iter()
            .all(|event| event.statement_kind.as_str() != "DELETE"),
        "stale authority rejection emitted DELETE: {trace:?}"
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_e7_claim_outbox_step_and_successor_changes_are_revalidated() {
    let cases = [
        (570, "claim"),
        (571, "outbox"),
        (572, "step"),
        (573, "successor"),
    ];
    for (index, kind) in cases {
        let operation_id = format!("a1-e7-{kind}");
        let owner_id = format!("owner-a1-e7-{kind}");
        let input = matrix_review_input(index, &operation_id, &owner_id);
        let (path, mut fixture) = file_v41(&operation_id);
        setup_cleanup(&mut fixture, &input);
        assert!(
            dry_run_progress_cleanup(&fixture, &input.operation_id, CLEANUP_CUTOFF)
                .expect("eligible inspection")
                .eligible
        );
        match kind {
            "claim" => insert_active_claim_reference(
                &fixture,
                "a1-e7-claim",
                &input.operation_id,
                "channel",
                "review",
                &input.owner_id,
                Some("primary"),
            ),
            "outbox" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_audit_outbox
                         SET delivery_status='pending', revision=revision+1,
                             operation_log_id=NULL, delivered_at=NULL, updated_at=?2
                         WHERE operation_id=?1",
                        params![input.operation_id, T5],
                    )
                    .expect("make Outbox pending after inspection");
            }
            "step" => {
                fixture
                    .execute(
                        "UPDATE manuscript_provisioning_step_progress
                         SET boundary='readback-verified', converged_at=NULL,
                             progress_revision=progress_revision+1, updated_at=?2
                         WHERE operation_id=?1",
                        params![input.operation_id, T5],
                    )
                    .expect("make Step nonconverged after inspection");
            }
            "successor" => insert_successor_reference(
                &fixture,
                "a1-e7-successor-operation",
                &input.operation_id,
                "channel",
                "review",
                &input.owner_id,
                Some("primary"),
            ),
            _ => unreachable!(),
        }
        assert_stale_executor_rejection(
            &mut fixture,
            &input.operation_id,
            CLEANUP_PROGRESS_RETAINED,
        );
        drop(fixture);
        remove_isolated_v41(path);
    }
}

#[test]
fn p4_2e_r2_e_a1_discovery_e7_literature_projection_pointer_change_is_revalidated() {
    let aggregate = matrix_aggregate_input(580, "a1-e7-projection", "owner-a1-e7-projection");
    let target = matrix_review_input(581, "a1-e7-pointer-target", "owner-a1-e7-pointer-target");
    let (path, mut fixture) = file_v41("a1-e7-projection");
    setup_cleanup(&mut fixture, &aggregate);
    assert!(
        dry_run_progress_cleanup(&fixture, &aggregate.operation_id, CLEANUP_CUTOFF)
            .expect("eligible Literature inspection")
            .eligible
    );
    create_attempt_claim_plan_and_steps(&mut fixture, &target).expect("pointer target");
    fixture
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_id=?1, revision=revision+1, updated_at=?3
             WHERE aggregate_operation_id=?2 AND manuscript_channel='literature_outline'",
            params![target.operation_id, aggregate.operation_id, T5],
        )
        .expect("change Projection pointer after inspection");
    assert_stale_executor_rejection(
        &mut fixture,
        &aggregate.operation_id,
        STRUCTURAL_PROGRESS_CORRUPTION,
    );
    drop(fixture);
    remove_isolated_v41(path);
}

#[test]
fn p4_2e_r2_e_a1_discovery_cleanup_dry_run_requires_planned_row_counts() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    let decision_start = production
        .find("pub(crate) struct DurableProgressCleanupDecision")
        .expect("Cleanup decision DTO");
    let decision_end = production[decision_start..]
        .find("pub(crate) fn dry_run_progress_cleanup")
        .map(|offset| decision_start + offset)
        .expect("Cleanup dry-run entry");
    let decision = &production[decision_start..decision_end];
    assert!(
        decision.contains("planned_steps")
            && decision.contains("planned_plans")
            && decision.contains("planned_projections")
            && decision.contains("planned_outboxes")
            && decision.contains("planned_attempts"),
        "P-4-2A requires dry-run to freeze planned row counts"
    );
}

#[test]
fn p4_2e_r2_e_a1_discovery_cleanup_executor_requires_exact_counts_and_final_readback_gate() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    let executor_start = production
        .find("pub(crate) fn execute_progress_cleanup")
        .expect("Cleanup executor");
    let executor = &production[executor_start..];
    assert!(
        executor.contains("deleted_steps !=")
            && executor.contains("deleted_projections !=")
            && executor.contains("deleted_outboxes !=")
            && executor.contains("final cleanup readback"),
        "Cleanup executor must compare every delete count and perform final readback"
    );
}

#[test]
fn p4_2e_r2_e_f6_source_gate_has_one_transaction_local_planner_and_final_readback() {
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    assert_eq!(
        production.matches("fn inspect_progress_cleanup(").count(),
        1,
        "Cleanup must have exactly one internal planner"
    );
    let plan_start = production
        .find("struct ProgressCleanupExecutionPlan")
        .expect("private Cleanup execution plan");
    let references_start = production[plan_start..]
        .find("pub(crate) struct CleanupProgressReferences")
        .map(|offset| plan_start + offset)
        .expect("bounded Cleanup plan region");
    let plan_region = &production[plan_start..references_start];
    for required in [
        "operation_id",
        "plan_id",
        "owner_type",
        "owner_id",
        "scope_kind",
        "manuscript_channel",
        "expected_step_rows",
        "expected_plan_rows",
        "expected_projection_rows",
        "expected_outbox_rows",
        "expected_attempt_rows",
    ] {
        assert!(
            plan_region.contains(required),
            "Cleanup execution plan is missing {required}"
        );
    }

    let dry_run_start = production
        .find("pub(crate) fn dry_run_progress_cleanup(")
        .expect("Cleanup dry-run");
    let result_start = production[dry_run_start..]
        .find("pub(crate) struct DurableProgressCleanupResult")
        .map(|offset| dry_run_start + offset)
        .expect("bounded Cleanup dry-run region");
    let dry_run = &production[dry_run_start..result_start];
    assert!(dry_run.contains("inspect_progress_cleanup("));

    let executor_start = production
        .find("pub(crate) fn execute_progress_cleanup(")
        .expect("Cleanup executor");
    let executor = &production[executor_start..];
    let transaction = executor
        .find("transaction_with_behavior(TransactionBehavior::Immediate)")
        .expect("real Cleanup transaction");
    let inspection = executor
        .find("inspect_progress_cleanup(&transaction")
        .expect("transaction-local Cleanup inspection");
    assert!(transaction < inspection);
    assert!(!executor.contains("dry_run_progress_cleanup(&transaction"));
    for required in [
        "deleted_steps != execution_plan.expected_step_rows",
        "deleted_plans != execution_plan.expected_plan_rows",
        "deleted_projections != execution_plan.expected_projection_rows",
        "deleted_outboxes != execution_plan.expected_outbox_rows",
        "deleted_attempts != execution_plan.expected_attempt_rows",
    ] {
        assert!(
            executor.contains(required),
            "executor is missing exact affected-row comparison: {required}"
        );
    }
    let step_delete = executor
        .find("DELETE FROM manuscript_provisioning_step_progress")
        .expect("Step DELETE");
    let plan_delete = executor
        .find("DELETE FROM manuscript_provisioning_step_plans")
        .expect("Plan DELETE");
    let projection_delete = executor
        .find("DELETE FROM manuscript_provisioning_literature_child_states")
        .expect("Projection DELETE");
    let outbox_delete = executor
        .find("DELETE FROM manuscript_provisioning_audit_outbox")
        .expect("Outbox DELETE");
    let attempt_delete = executor
        .find("DELETE FROM manuscript_provisioning_operation_attempts")
        .expect("Attempt DELETE");
    let final_readback = executor
        .find("final cleanup readback")
        .expect("final Cleanup readback");
    let commit = executor.find(".commit()").expect("Cleanup COMMIT");
    assert!(
        step_delete < plan_delete
            && plan_delete < projection_delete
            && projection_delete < outbox_delete
            && outbox_delete < attempt_delete
            && attempt_delete < final_readback
            && final_readback < commit,
        "leaf-first mutation or final-readback ordering drifted"
    );
    for forbidden in [
        "CleanupPlanToken",
        "cleanup_plan_token",
        "error.message",
        ".message()",
    ] {
        assert!(
            !plan_region.contains(forbidden) && !executor.contains(forbidden),
            "Cleanup contains forbidden authority or message remapping: {forbidden}"
        );
    }
}

#[test]
fn p4_2e_r2_e_a1_discovery_source_gate_is_test_only_and_keeps_production_unchanged() {
    let discovery =
        include_str!("manuscript_provisioning_step_progress_r2_e_a1_discovery_tests.rs");
    let production =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    let cargo = include_str!("../../Cargo.toml");
    assert!(discovery.contains("connection.authorizer"));
    assert!(discovery.contains("connection.update_hook"));
    assert!(discovery.contains("execute_progress_cleanup"));
    assert!(!production.contains(".authorizer("));
    assert!(!production.contains(".update_hook("));
    assert!(!production.contains("A1"));
    let dependencies = cargo
        .split("[dev-dependencies]")
        .next()
        .expect("production dependency section");
    assert!(!dependencies.contains("\"hooks\""));
    assert!(!dependencies.contains("\"trace\""));
}

#[test]
fn p4_2e_r2_e_f5_source_gate_uses_shared_full_convergence_for_completed_recovery() {
    let progress = include_str!("manuscript_provisioning_operation_state/step_progress.rs");
    let repository =
        include_str!("manuscript_provisioning_operation_state/step_progress_repository.rs");
    let discovery =
        include_str!("manuscript_provisioning_step_progress_r2_e_a1_discovery_tests.rs");

    let convergence_start = progress
        .find("pub(crate) fn durable_step_is_fully_converged(")
        .expect("shared full-convergence predicate must exist");
    let projection_start = progress[convergence_start..]
        .find("pub(crate) fn literature_child_projection_from_row(")
        .map(|offset| convergence_start + offset)
        .expect("full-convergence predicate must have a bounded source region");
    let convergence = &progress[convergence_start..projection_start];
    for required in [
        "step.is_required",
        "DurableStepBoundary::Converged",
        "boundary_facts_are_valid(",
        "step.effect_outcome",
        "step.readback_outcome",
        "step.observed_identity_hash.is_some()",
        "step.started_at.is_some()",
        "step.effect_observed_at.is_some()",
        "step.readback_verified_at.is_some()",
        "step.converged_at.is_some()",
    ] {
        assert!(
            convergence.contains(required),
            "formal converged predicate is missing evidence: {required}"
        );
    }

    let structure_start = repository
        .find("fn validate_recovery_progress_structure(")
        .expect("Recovery Progress structure validator must exist");
    let relation_start = repository[structure_start..]
        .find("fn recovery_relation_matches(")
        .map(|offset| structure_start + offset)
        .expect("Recovery structure validator must have a bounded source region");
    let structure = &repository[structure_start..relation_start];
    for required in [
        "attempt.operation_status == \"terminal-completed\"",
        "steps.iter().all(durable_step_is_fully_converged)",
        "STRUCTURAL_PROGRESS_CORRUPTION",
    ] {
        assert!(
            structure.contains(required),
            "completed Recovery convergence gate is missing: {required}"
        );
    }
    for forbidden in [
        "RECOVERY_EVIDENCE_INVALID",
        "validate_terminal_progress(",
        "apply_terminal_attempt_cas(",
        "error.message",
        ".message()",
        "INSERT ",
        "UPDATE ",
        "DELETE ",
        "BEGIN ",
        "COMMIT ",
        "cfg!(test)",
        "#[cfg(test)]",
    ] {
        assert!(
            !structure.contains(forbidden),
            "Recovery convergence validator contains forbidden authority or mutation: {forbidden}"
        );
    }

    for remediated_f6_test in [
        "p4_2e_r2_e_a1_discovery_cleanup_dry_run_requires_planned_row_counts",
        "p4_2e_r2_e_a1_discovery_cleanup_executor_requires_exact_counts_and_final_readback_gate",
    ] {
        assert!(
            discovery.contains(remediated_f6_test),
            "F6 strict regression must remain intact: {remediated_f6_test}"
        );
    }
    let f6_ignore_marker = concat!(
        "A1 strict RED for missing Cleanup planned-count/",
        "final-readback contract"
    );
    assert_eq!(
        discovery.matches(f6_ignore_marker).count(),
        0,
        "the two remediated F6 Cleanup tests must be non-ignored"
    );
}
