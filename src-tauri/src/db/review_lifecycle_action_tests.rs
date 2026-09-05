use super::{review_lifecycle_action, schema};
use rusqlite::Connection;
use std::fs;

fn initialized() -> Connection {
    let connection = Connection::open_in_memory().expect("open task-owned in-memory database");
    schema::run_migrations(&connection).expect("initialize fresh schema");
    connection
}

fn delete_input(action_id: &str, review_id: &str) -> review_lifecycle_action::PrepareActionInput {
    review_lifecycle_action::PrepareActionInput {
        lifecycle_action_id: action_id.to_string(),
        operation_type: "review_soft_delete".to_string(),
        review_id: review_id.to_string(),
        project_id: "project-1".to_string(),
        expected_review_source_state: "active".to_string(),
        expected_review_updated_at: "2026-08-07T00:00:00.000Z".to_string(),
        expected_review_deleted_at: None,
        target_review_updated_at: "2026-08-07T00:01:00.000Z".to_string(),
        target_review_deleted_at: Some("2026-08-07T00:01:00.000Z".to_string()),
        expected_planning_epoch: "epoch-1".to_string(),
        expected_planning_revision: "7".to_string(),
        planned_committed_planning_revision: "8".to_string(),
        planning_effect_id: format!("review-lifecycle:{action_id}:planning"),
        source_delete_action_id: None,
        exact_recycle_entry_id: format!("review-lifecycle:{action_id}:recycle-entry"),
        operation_log_effect_id: format!("review-lifecycle:{action_id}:operation-log"),
        recycle_effect_id: format!("review-lifecycle:{action_id}:recycle-create"),
    }
}

fn restore_input(
    action_id: &str,
    review_id: &str,
    source_delete_action_id: &str,
    recycle_entry_id: &str,
) -> review_lifecycle_action::PrepareActionInput {
    review_lifecycle_action::PrepareActionInput {
        lifecycle_action_id: action_id.to_string(),
        operation_type: "review_restore".to_string(),
        review_id: review_id.to_string(),
        project_id: "project-1".to_string(),
        expected_review_source_state: "deleted".to_string(),
        expected_review_updated_at: "2026-08-07T00:01:00.000Z".to_string(),
        expected_review_deleted_at: Some("2026-08-07T00:01:00.000Z".to_string()),
        target_review_updated_at: "2026-08-07T00:03:00.000Z".to_string(),
        target_review_deleted_at: None,
        expected_planning_epoch: "epoch-1".to_string(),
        expected_planning_revision: "8".to_string(),
        planned_committed_planning_revision: "9".to_string(),
        planning_effect_id: format!("review-lifecycle:{action_id}:planning"),
        source_delete_action_id: Some(source_delete_action_id.to_string()),
        exact_recycle_entry_id: recycle_entry_id.to_string(),
        operation_log_effect_id: format!("review-lifecycle:{action_id}:operation-log"),
        recycle_effect_id: format!(
            "review-lifecycle:{action_id}:recycle-terminal:{recycle_entry_id}"
        ),
    }
}

#[test]
fn fresh_schema_contains_review_lifecycle_v51_contract() {
    let connection = initialized();

    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read schema version");
    assert_eq!(version, schema::CURRENT_SCHEMA_VERSION);

    let action_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='review_lifecycle_actions'",
            [],
            |row| row.get(0),
        )
        .expect("read action table");
    assert_eq!(action_table, 1);

    let operation_columns: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('operation_logs') WHERE name IN ('lifecycle_action_id','effect_type')",
            [],
            |row| row.get(0),
        )
        .expect("read operation log columns");
    assert_eq!(operation_columns, 2);

    let recycle_columns: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('recycle_entries') WHERE name IN ('created_by_lifecycle_action_id','terminal_lifecycle_action_id','revision')",
            [],
            |row| row.get(0),
        )
        .expect("read recycle entry columns");
    assert_eq!(recycle_columns, 3);

    let lifecycle_indexes: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
               'uq_review_lifecycle_actions_pending_review',
               'uq_operation_logs_review_lifecycle_effect',
               'uq_recycle_entries_created_by_review_lifecycle_action',
               'uq_recycle_entries_terminal_review_lifecycle_action'
             )",
            [],
            |row| row.get(0),
        )
        .expect("read lifecycle indexes");
    assert_eq!(lifecycle_indexes, 4);

    assert!(
        super::review_permanent_delete::schema_is_current(&connection)
            .expect("validate permanent-delete foundation")
    );
}

#[test]
fn action_prepare_is_exactly_reusable_and_pending_is_unique_per_review() {
    let mut connection = initialized();
    let input = delete_input("action-1", "review-1");
    let first = review_lifecycle_action::prepare_in_connection(&mut connection, &input)
        .expect("prepare action");
    let repeated = review_lifecycle_action::prepare_in_connection(&mut connection, &input)
        .expect("reuse exact action");
    assert_eq!(first, repeated);
    assert_eq!(first.current_stage, "prepared");
    assert_eq!(first.revision, 0);

    let mut mismatch = input.clone();
    mismatch.project_id = "project-other".to_string();
    let mismatch_error = review_lifecycle_action::prepare_in_connection(&mut connection, &mismatch)
        .expect_err("same action payload mismatch must fail");
    assert_eq!(mismatch_error.code, "review_lifecycle_identity_conflict");

    let pending_error = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("action-2", "review-1"),
    )
    .expect_err("different pending action for same Review must fail");
    assert_eq!(pending_error.code, "review_lifecycle_pending_conflict");
}

#[test]
fn pending_list_is_read_only_stably_ordered_and_excludes_terminal_actions() {
    let mut connection = initialized();
    review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("action-b", "review-b"),
    )
    .expect("prepare first pending action");
    review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("action-a", "review-a"),
    )
    .expect("prepare second pending action");
    let terminal = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("action-terminal", "review-terminal"),
    )
    .expect("prepare terminal candidate");
    review_lifecycle_action::record_failure_in_connection(
        &mut connection,
        &review_lifecycle_action::RecordActionFailureInput {
            lifecycle_action_id: terminal.lifecycle_action_id,
            expected_revision: terminal.revision,
            expected_stage: terminal.current_stage,
            error_code: "terminal-test".to_string(),
            retryable: false,
            terminal_result: Some("non_retryable_failure".to_string()),
        },
    )
    .expect("terminalize excluded action");
    connection
        .execute(
            "INSERT INTO review_lifecycle_actions (
               lifecycle_action_id,revision,operation_type,review_id,project_id,
               expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,
               target_review_updated_at,target_review_deleted_at,expected_planning_epoch,
               expected_planning_revision,planned_committed_planning_revision,planning_effect_id,
               source_delete_action_id,exact_recycle_entry_id,expected_recycle_entry_revision,
               impact_plan_version,impact_digest,impact_plan_json,confirmed_at,
               operation_log_effect_id,recycle_effect_id,binding_cleanup_effect_id,
               file_ref_cleanup_effect_id,recycle_terminal_effect_id,current_stage,
               last_error_retryable,created_at,updated_at
             ) VALUES (
               'action-permanent',0,'review_permanent_delete','review-permanent','project-1',
               'deleted','review-revision','review-deleted-at','review-revision','review-deleted-at',
               'epoch-1','7','8','permanent-planning-effect','source-delete-action','entry-permanent',0,
               1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','confirmed-at',
               'permanent-log-effect','permanent-recycle-effect','permanent-binding-effect',
               'permanent-file-effect','permanent-terminal-effect','prepared',0,'created-at','created-at'
             )",
            [],
        )
        .expect("seed pending permanent-delete action");
    connection
        .execute(
            "UPDATE review_lifecycle_actions SET created_at='2026-08-07T00:00:00.000Z',updated_at='2026-08-07T01:00:00.000Z' WHERE lifecycle_action_id IN ('action-a','action-b','action-permanent')",
            [],
        )
        .expect("freeze deterministic list order");

    let before = connection.total_changes();
    let listed = review_lifecycle_action::list_pending_in_connection(&connection)
        .expect("list pending actions");
    let after = connection.total_changes();

    assert_eq!(
        listed
            .iter()
            .map(|record| record.lifecycle_action_id.as_str())
            .collect::<Vec<_>>(),
        vec!["action-a", "action-b", "action-permanent"]
    );
    assert_eq!(listed[2].operation_type, "review_permanent_delete");
    assert_eq!(before, after, "pending discovery must not mutate SQLite");
}

#[test]
fn action_stage_uses_revision_and_stage_cas_and_terminal_readback_is_stable() {
    let mut connection = initialized();
    let prepared = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("action-stage", "review-stage"),
    )
    .expect("prepare action");
    let planning = review_lifecycle_action::record_planning_commit_in_connection(
        &mut connection,
        &review_lifecycle_action::RecordPlanningCommitInput {
            lifecycle_action_id: prepared.lifecycle_action_id.clone(),
            expected_revision: 0,
            expected_stage: "prepared".to_string(),
            committed_planning_epoch: "epoch-1".to_string(),
            committed_planning_revision: "8".to_string(),
        },
    )
    .expect("record Planning commit");
    assert_eq!(planning.revision, 1);
    assert_eq!(planning.current_stage, "planning_committed");

    let stale = review_lifecycle_action::record_planning_commit_in_connection(
        &mut connection,
        &review_lifecycle_action::RecordPlanningCommitInput {
            lifecycle_action_id: prepared.lifecycle_action_id.clone(),
            expected_revision: 0,
            expected_stage: "prepared".to_string(),
            committed_planning_epoch: "epoch-other".to_string(),
            committed_planning_revision: "8".to_string(),
        },
    )
    .expect_err("mismatched response-loss claim must fail");
    assert_eq!(stale.code, "review_lifecycle_identity_conflict");
}

#[test]
fn operation_log_and_recycle_create_are_exactly_once_with_atomic_stage_promotion() {
    let mut connection = initialized();
    let prepared = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("action-effects", "review-effects"),
    )
    .expect("prepare action");
    let planning = review_lifecycle_action::record_planning_commit_in_connection(
        &mut connection,
        &review_lifecycle_action::RecordPlanningCommitInput {
            lifecycle_action_id: prepared.lifecycle_action_id.clone(),
            expected_revision: prepared.revision,
            expected_stage: prepared.current_stage.clone(),
            committed_planning_epoch: "epoch-1".to_string(),
            committed_planning_revision: "8".to_string(),
        },
    )
    .expect("record Planning commit");
    let log_input =
        review_lifecycle_action::OperationLogEffectInput::for_test(&planning, "Review deleted");
    let logged = review_lifecycle_action::record_operation_log_effect_in_connection(
        &mut connection,
        &log_input,
    )
    .expect("record log");
    assert_eq!(logged.current_stage, "operation_log_recorded");

    let repeated_log = review_lifecycle_action::record_operation_log_effect_in_connection(
        &mut connection,
        &log_input,
    )
    .expect("reuse response-loss log");
    assert_eq!(repeated_log, logged);

    let recycle_input =
        review_lifecycle_action::RecycleCreateEffectInput::for_test(&logged, "Review title");
    let recycled = review_lifecycle_action::record_recycle_create_effect_in_connection(
        &mut connection,
        &recycle_input,
    )
    .expect("record recycle entry");
    let repeated_recycle = review_lifecycle_action::record_recycle_create_effect_in_connection(
        &mut connection,
        &recycle_input,
    )
    .expect("reuse response-loss recycle entry");
    assert_eq!(repeated_recycle, recycled);

    let log_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='action-effects'",
            [],
            |row| row.get(0),
        )
        .expect("count log");
    let recycle_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM recycle_entries WHERE created_by_lifecycle_action_id='action-effects'",
        [],
        |row| row.get(0),
    ).expect("count recycle");
    assert_eq!((log_count, recycle_count), (1, 1));
}

#[test]
fn restore_terminalizes_only_the_exact_bound_entry_with_revision_cas() {
    let mut connection = initialized();
    let delete = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &delete_input("delete-source", "review-restore"),
    )
    .expect("prepare source delete");
    let delete = review_lifecycle_action::record_planning_commit_in_connection(
        &mut connection,
        &review_lifecycle_action::RecordPlanningCommitInput {
            lifecycle_action_id: delete.lifecycle_action_id.clone(),
            expected_revision: delete.revision,
            expected_stage: delete.current_stage.clone(),
            committed_planning_epoch: "epoch-1".to_string(),
            committed_planning_revision: "8".to_string(),
        },
    )
    .expect("source Planning");
    let delete = review_lifecycle_action::record_operation_log_effect_in_connection(
        &mut connection,
        &review_lifecycle_action::OperationLogEffectInput::for_test(&delete, "Review deleted"),
    )
    .expect("source log");
    let delete = review_lifecycle_action::record_recycle_create_effect_in_connection(
        &mut connection,
        &review_lifecycle_action::RecycleCreateEffectInput::for_test(&delete, "Review title"),
    )
    .expect("source recycle");
    let completion_input = review_lifecycle_action::CompleteActionInput::from_record(&delete);
    let completed =
        review_lifecycle_action::complete_in_connection(&mut connection, &completion_input)
            .expect("complete source delete");
    let completed_readback =
        review_lifecycle_action::complete_in_connection(&mut connection, &completion_input)
            .expect("same-action completed response loss must read back terminal success");
    assert_eq!(
        completed_readback.lifecycle_action_id,
        completed.lifecycle_action_id
    );
    assert_eq!(
        completed_readback.terminal_result.as_deref(),
        Some("completed")
    );

    connection
        .execute(
            "INSERT INTO recycle_entries (
           id,entity_type,entity_id,title,module,entity_deleted_at,deleted_by,
           can_restore,restore_status,refresh_keys,schema_version,created_at,updated_at,revision
         ) VALUES ('legacy-other','review','review-restore','Other','review',
           '2026-08-07T00:02:00.000Z','user',1,'not_started','[]',1,
           '2026-08-07T00:02:00.000Z','2026-08-07T00:02:00.000Z',0)",
            [],
        )
        .expect("insert unrelated same-Review entry");

    let exact_entry = "review-lifecycle:delete-source:recycle-entry";
    let restore = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &restore_input(
            "restore-action",
            "review-restore",
            "delete-source",
            exact_entry,
        ),
    )
    .expect("prepare restore");
    let restore = review_lifecycle_action::record_planning_commit_in_connection(
        &mut connection,
        &review_lifecycle_action::RecordPlanningCommitInput {
            lifecycle_action_id: restore.lifecycle_action_id.clone(),
            expected_revision: restore.revision,
            expected_stage: restore.current_stage.clone(),
            committed_planning_epoch: "epoch-1".to_string(),
            committed_planning_revision: "9".to_string(),
        },
    )
    .expect("restore Planning");
    let restore = review_lifecycle_action::record_operation_log_effect_in_connection(
        &mut connection,
        &review_lifecycle_action::OperationLogEffectInput::for_test(&restore, "Review restored"),
    )
    .expect("restore log");
    let terminal_input = review_lifecycle_action::RecycleRestoreEffectInput {
        lifecycle_action_id: restore.lifecycle_action_id.clone(),
        expected_action_revision: restore.revision,
        expected_action_stage: restore.current_stage.clone(),
        exact_recycle_entry_id: exact_entry.to_string(),
        expected_entry_revision: 0,
        source_delete_action_id: "delete-source".to_string(),
        restored_at: "2026-08-07T00:03:00.000Z".to_string(),
    };
    let restored = review_lifecycle_action::record_recycle_restore_effect_in_connection(
        &mut connection,
        &terminal_input,
    )
    .expect("terminalize exact entry");
    let repeated = review_lifecycle_action::record_recycle_restore_effect_in_connection(
        &mut connection,
        &terminal_input,
    )
    .expect("reuse restore response-loss readback");
    assert_eq!(restored, repeated);

    let exact: (i64, String, i64, Option<String>) = connection.query_row(
        "SELECT can_restore,restore_status,revision,terminal_lifecycle_action_id FROM recycle_entries WHERE id=?1",
        [exact_entry],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).expect("read exact entry");
    let other: (i64, String, i64, Option<String>) = connection.query_row(
        "SELECT can_restore,restore_status,revision,terminal_lifecycle_action_id FROM recycle_entries WHERE id='legacy-other'",
        [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).expect("read unrelated entry");
    assert_eq!(
        exact,
        (
            0,
            "restored".to_string(),
            1,
            Some("restore-action".to_string())
        )
    );
    assert_eq!(other, (1, "not_started".to_string(), 0, None));
}

#[test]
fn restore_rejects_legacy_unbound_entry_before_any_effect() {
    let mut connection = initialized();
    connection
        .execute(
            "INSERT INTO recycle_entries (
           id,entity_type,entity_id,title,module,entity_deleted_at,deleted_by,
           can_restore,restore_status,refresh_keys,schema_version,created_at,updated_at,revision
         ) VALUES ('legacy-unbound','review','review-legacy','Legacy','review',
           '2026-08-07T00:01:00.000Z','user',1,'not_started','[]',1,
           '2026-08-07T00:01:00.000Z','2026-08-07T00:01:00.000Z',0)",
            [],
        )
        .expect("insert legacy entry");
    let error = review_lifecycle_action::prepare_in_connection(
        &mut connection,
        &restore_input(
            "restore-legacy",
            "review-legacy",
            "unknown-delete",
            "legacy-unbound",
        ),
    )
    .expect_err("legacy entry must fail closed");
    assert_eq!(error.code, "recycle_entry_legacy_unbound");
    let action_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM review_lifecycle_actions", [], |row| {
            row.get(0)
        })
        .expect("count actions");
    assert_eq!(action_count, 0);
}

#[test]
fn v50_rows_migrate_to_v51_without_backfill_and_restart_reads_pending_action() {
    let path = std::env::temp_dir().join(format!(
        "labpod-review-lifecycle-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    {
        let mut connection = Connection::open(&path).expect("open task-owned database");
        schema::run_migrations(&connection).expect("initialize current schema");
        super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(
            &connection,
        )
        .expect("remove v53 foundation from isolated v50 fixture");
        connection
            .execute_batch(
                "INSERT INTO operation_logs (
               id,operation_type,source,module,status,risk_level,target,summary,
               related_entities,warnings,errors,skipped,is_recoverable,actor_id,actor_label,
               refresh_keys,schema_version,created_at,updated_at
             ) VALUES ('legacy-log','delete','user','review','success','high','{}','legacy',
               '[]','[]','[]','[]',1,'user','User','[]',1,'t','t');
             INSERT INTO recycle_entries (
               id,entity_type,entity_id,title,module,entity_deleted_at,deleted_by,can_restore,
               restore_status,refresh_keys,schema_version,created_at,updated_at
             ) VALUES ('legacy-entry','review','legacy-review','Legacy','review','t','user',1,
               'not_started','[]',1,'t','t');
             DROP TABLE review_lifecycle_action_targets;
             DROP TRIGGER file_refs_revision_guard;
             DROP TRIGGER manuscript_bindings_revision_guard;
             DROP TRIGGER manuscript_bindings_permanent_file_ref_reference_insert;
             DROP TRIGGER manuscript_bindings_permanent_file_ref_reference_update;
             DROP TRIGGER file_refs_permanent_terminal_immutable;
             DROP TRIGGER file_refs_permanent_terminal_binding_guard;
             DROP TRIGGER file_refs_permanent_terminal_delete_blocked;
             DROP TRIGGER file_refs_permanent_terminal_shape_insert;
             DROP TRIGGER file_refs_permanent_terminal_shape_update;
             DROP TRIGGER file_refs_permanent_identity_reuse_insert;
             DROP TRIGGER file_refs_permanent_identity_reuse_update;
             DROP TRIGGER recycle_entries_permanent_terminal_immutable;
             DROP TRIGGER recycle_entries_permanent_terminal_delete_blocked;
             DROP TRIGGER recycle_entries_permanent_terminal_shape_insert;
             DROP TRIGGER recycle_entries_permanent_terminal_shape_update;
             DROP TABLE review_lifecycle_actions;
             ALTER TABLE file_refs DROP COLUMN revision;
             ALTER TABLE file_refs DROP COLUMN permanent_delete_status;
             ALTER TABLE file_refs DROP COLUMN permanent_delete_lifecycle_action_id;
             ALTER TABLE file_refs DROP COLUMN permanently_deleted_at;
             ALTER TABLE manuscript_bindings DROP COLUMN revision;
             ALTER TABLE recycle_entries DROP COLUMN terminal_at;
             DELETE FROM schema_migrations WHERE version=51;",
            )
            .expect("remove v51-only foundation");
        review_lifecycle_action::apply_schema_migration(&connection)
            .expect("recreate exact v50 action authority");
        connection
            .pragma_update(None, "user_version", 50)
            .expect("mark v50");
        assert!(
            review_lifecycle_action::legacy_v50_schema_is_current(&connection)
                .expect("validate v50 source")
        );
        schema::run_migrations(&connection).expect("migrate v50 to v51");
        let nullable: (Option<String>, Option<String>, i64) = connection.query_row(
            "SELECT created_by_lifecycle_action_id,terminal_lifecycle_action_id,revision FROM recycle_entries WHERE id='legacy-entry'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).expect("read migrated legacy entry");
        assert_eq!(nullable, (None, None, 0));
        review_lifecycle_action::prepare_in_connection(
            &mut connection,
            &delete_input("restart-action", "restart-review"),
        )
        .expect("prepare durable action");
    }
    {
        let connection = Connection::open(&path).expect("reopen task-owned database");
        let pending = review_lifecycle_action::pending_for_review_in_connection(
            &connection,
            "restart-review",
        )
        .expect("read pending after restart")
        .expect("pending action exists");
        assert_eq!(pending.lifecycle_action_id, "restart-action");
        assert_eq!(pending.current_stage, "prepared");
    }
    fs::remove_file(&path).expect("remove task-owned database");
}
