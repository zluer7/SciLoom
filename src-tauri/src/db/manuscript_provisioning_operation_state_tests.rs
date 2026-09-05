use super::manuscript_provisioning_operation_state::apply_schema_migration;
use super::manuscript_provisioning_v40_migration_fixture::{
    open_v39_source_database, open_v40_source_database,
};
use super::schema;

#[test]
fn p3a2_migration_is_v40_exact_idempotent_and_upgrades_v39() {
    let connection = open_v40_source_database();
    assert_eq!(
        schema::MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
        40
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .expect("user version"),
        40
    );
    for table in [
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_literature_child_states",
        "manuscript_provisioning_audit_outbox",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .expect("table introspection");
        assert_eq!(exists, 1, "{table}");
    }
    let ledger: String = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE version=40",
            [],
            |row| row.get(0),
        )
        .expect("v40 ledger");
    assert_eq!(ledger, "manuscript_provisioning_operation_state");
    apply_schema_migration(&connection).expect("repeat v40 migration");
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=40",
                [],
                |row| row.get::<_, i64>(0)
            )
            .expect("ledger count"),
        1
    );
    assert_eq!(
        connection
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .expect("quick check"),
        "ok"
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("foreign key check"),
        0
    );
    let expected_columns = [
        (
            "manuscript_provisioning_operation_attempts",
            vec![
                "operation_id",
                "scope_kind",
                "owner_type",
                "owner_id",
                "manuscript_channel",
                "aggregate_operation_id",
                "intent",
                "trigger_kind",
                "phase",
                "operation_status",
                "result_classification",
                "next_action",
                "original_cause_code",
                "partial_kind",
                "revision",
                "previous_operation_id",
                "root_operation_id",
                "folder_effect",
                "manuscript_effect",
                "file_ref_effect",
                "binding_effect",
                "default_folder_file_ref_id",
                "default_manuscript_file_ref_id",
                "binding_id",
                "final_verification_outcome",
                "inspector_version",
                "verifier_version",
                "facts_schema_version",
                "started_at",
                "updated_at",
                "terminal_at",
            ],
        ),
        (
            "manuscript_provisioning_active_claims",
            vec![
                "claim_id",
                "scope_kind",
                "owner_type",
                "owner_id",
                "manuscript_channel",
                "operation_id",
                "claim_owner_token",
                "claim_revision",
                "claimed_at",
                "last_heartbeat_at",
                "last_progress_at",
                "stale_observed_at",
                "stale_observed_by_token",
            ],
        ),
        (
            "manuscript_provisioning_literature_child_states",
            vec![
                "aggregate_operation_id",
                "owner_type",
                "owner_id",
                "aggregate_scope_kind",
                "manuscript_channel",
                "current_child_operation_id",
                "current_child_scope_kind",
                "revision",
                "phase",
                "operation_status",
                "result_classification",
                "next_action",
                "default_readiness",
                "final_verification_outcome",
                "original_cause_code",
                "updated_at",
            ],
        ),
        (
            "manuscript_provisioning_audit_outbox",
            vec![
                "operation_id",
                "delivery_status",
                "revision",
                "delivery_attempt_count",
                "operation_log_id",
                "error_code",
                "created_at",
                "updated_at",
                "delivered_at",
            ],
        ),
    ];
    for (table, expected) in expected_columns {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info('{table}')"))
            .unwrap();
        let actual = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(actual, expected, "{table} exact columns");
    }
    for (table, expected_fk_count) in [
        ("manuscript_provisioning_operation_attempts", 3),
        ("manuscript_provisioning_active_claims", 1),
        ("manuscript_provisioning_literature_child_states", 2),
        ("manuscript_provisioning_audit_outbox", 1),
    ] {
        let count: i64 = connection
            .query_row(
                &format!("SELECT COUNT(DISTINCT id) FROM pragma_foreign_key_list('{table}')"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, expected_fk_count, "{table} exact FK count");
    }

    let upgrade = open_v39_source_database();
    apply_schema_migration(&upgrade).expect("upgrade isolated v39 fixture to v40");
    upgrade
        .pragma_update(None, "user_version", 40)
        .expect("set v40 fixture version");
    assert_eq!(
        upgrade
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        40
    );
}

#[test]
fn p3a2_migration_failure_rolls_back_new_objects_ledger_and_version() {
    let connection = open_v39_source_database();
    connection
        .execute_batch(
            "CREATE TABLE manuscript_provisioning_operation_attempts (
               operation_id TEXT PRIMARY KEY
             );",
        )
        .expect("install malformed preexisting table");
    let error = schema::run_migrations(&connection).expect_err("validation must fail");
    assert_eq!(error.code, "DB_MIGRATION_FAILED");
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        39
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=40",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    for table in [
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_literature_child_states",
        "manuscript_provisioning_audit_outbox",
    ] {
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0,
            "{table} must roll back"
        );
    }
}

#[test]
fn p3a2_schema_validation_rejects_a_malformed_same_name_index() {
    let connection = open_v40_source_database();
    connection
        .execute_batch(
            "DROP INDEX uq_manuscript_provisioning_channel_claim;
             CREATE UNIQUE INDEX uq_manuscript_provisioning_channel_claim
             ON manuscript_provisioning_active_claims(operation_id);",
        )
        .expect("replace required index with malformed same-name definition");
    let error = schema::run_migrations(&connection)
        .expect_err("same-name index with wrong columns and predicate must fail validation");
    assert_eq!(error.code, "source-schema-invalid");
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        40
    );
}
