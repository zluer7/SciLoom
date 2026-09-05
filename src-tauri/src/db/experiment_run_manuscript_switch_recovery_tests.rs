use super::experiment_run_manuscript_switch_recovery::{
    complete_experiment_run_switch_recovery_in_connection,
    prepare_experiment_run_switch_recovery_in_connection,
    post_verify_experiment_run_switch_recovery_in_connection,
    ExperimentRunSwitchRecoveryPrepareInput,
};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::process::Command;

fn temporary_database_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "labpod-run-recovery-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .expect("clock").as_nanos()
    ))
}

fn schema(connection: &Connection) {
    connection.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE experiments (
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
           updated_at TEXT NOT NULL, deleted_at TEXT
         );
         CREATE TABLE experiment_runs (
           id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, project_id TEXT NOT NULL,
           title TEXT NOT NULL, run_label TEXT NOT NULL, created_local_date TEXT NOT NULL,
           created_local_time TEXT NOT NULL, condition_summary TEXT,
           variable_parameter_summary TEXT, method_summary TEXT, result_summary TEXT,
           conclusion TEXT, summary_other TEXT, updated_at TEXT NOT NULL, deleted_at TEXT
         );
         CREATE TABLE manuscript_bindings (
           id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
           manuscript_channel TEXT NOT NULL, current_file_ref_id TEXT,
           default_manuscript_file_ref_id TEXT, updated_at TEXT NOT NULL, deleted_at TEXT
         );
         CREATE TABLE file_refs (
           id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
           manuscript_channel TEXT NOT NULL, resource_kind TEXT NOT NULL,
           file_role TEXT NOT NULL, location_mode TEXT NOT NULL,
           path_identity_key TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
         );
         CREATE TABLE operation_logs (
           id TEXT PRIMARY KEY, operation_type TEXT NOT NULL, source TEXT NOT NULL,
           module TEXT NOT NULL, status TEXT NOT NULL, risk_level TEXT NOT NULL,
           target TEXT NOT NULL, summary TEXT NOT NULL, related_entities TEXT NOT NULL DEFAULT '[]',
           impact_summary TEXT, confirmation TEXT NOT NULL DEFAULT '{}', feedback TEXT NOT NULL DEFAULT '{}',
           warnings TEXT NOT NULL DEFAULT '[]', errors TEXT NOT NULL DEFAULT '[]', skipped TEXT NOT NULL DEFAULT '[]',
           is_recoverable INTEGER NOT NULL DEFAULT 0, actor_id TEXT NOT NULL,
           actor_label TEXT NOT NULL, refresh_keys TEXT NOT NULL DEFAULT '[]',
           schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL, deleted_at TEXT
         );",
    ).expect("base schema");
    super::experiment_run_manuscript_switch_recovery::ensure_recovery_schema_in_connection(connection)
        .expect("recovery schema");
}

fn seed(connection: &Connection) {
    connection.execute_batch(
        "INSERT INTO experiments VALUES ('experiment-1','project-1','Parent','parent-r1',NULL);
         INSERT INTO experiment_runs VALUES (
           'run-1','experiment-1','project-1','Run','R-1','2026-07-20','0900',
           'old-c','old-v','old-m','old-r','old-k','old-o','run-r1',NULL
         );
         INSERT INTO manuscript_bindings VALUES (
           'binding-1','experimentRun','run-1','primary','old','default','binding-r1',NULL
         );",
    ).expect("owners");
    for (id, mode, identity) in [
        ("old", "managed", "old-identity"),
        ("default", "managed", "default-identity"),
        ("target", "external", "target-identity"),
    ] {
        connection.execute(
            "INSERT INTO file_refs VALUES (?1,'experimentRun','run-1','primary','file','manuscript',?2,?3,?4,NULL)",
            params![id, mode, identity, format!("{id}-r1")],
        ).expect("file ref");
    }
}

fn prepared(operation_id: &str) -> ExperimentRunSwitchRecoveryPrepareInput {
    ExperimentRunSwitchRecoveryPrepareInput {
        recovery_id: format!("recovery-{operation_id}"),
        operation_id: operation_id.into(),
        run_id: "run-1".into(),
        experiment_id: "experiment-1".into(),
        project_id: "project-1".into(),
        binding_id: "binding-1".into(),
        expected_run_updated_at: "run-r1".into(),
        expected_parent_updated_at: "parent-r1".into(),
        expected_binding_updated_at: "binding-r1".into(),
        old_current_file_ref_id: "old".into(),
        old_current_file_ref_updated_at: "old-r1".into(),
        old_current_path_identity: "old-identity".into(),
        old_current_location_mode: "managed".into(),
        default_file_ref_id: "default".into(),
        default_file_ref_updated_at: "default-r1".into(),
        default_path_identity: "default-identity".into(),
        default_location_mode: "managed".into(),
        target_file_ref_id: "target".into(),
        target_file_ref_updated_at: "target-r1".into(),
        target_path_identity: "target-identity".into(),
        target_location_mode: "external".into(),
        before_condition_summary: Some("old-c".into()),
        before_variable_parameter_summary: Some("old-v".into()),
        before_method_summary: Some("old-m".into()),
        before_result_summary: Some("old-r".into()),
        before_conclusion: Some("old-k".into()),
        before_summary_other: Some("old-o".into()),
        outline_replacements_json: r#"[{"key":"conditionSummary","action":"set","value":"new-c"},{"key":"variableParameterSummary","action":"clear"},{"key":"methodSummary","action":"set","value":"new-m"},{"key":"resultSummary","action":"clear"},{"key":"conclusion","action":"set","value":"new-k"},{"key":"summaryOther","action":"clear"}]"#.into(),
        run_title_snapshot: "Run".into(),
        parent_title_snapshot: "Parent".into(),
        project_title_snapshot: "Project".into(),
        rating_snapshot: Some("good".into()),
        tags_json: r#"["tag-a"]"#.into(),
        run_date_snapshot: "2026-07-20".into(),
        run_time_snapshot: "0900".into(),
        deterministic_writeback_version: 1,
        recorded_at: "2026-07-20T09:30:00.000Z".into(),
        writeback_digest: "fnv1a64:writeback".into(),
        writeback_byte_length: 123,
        old_current_pre_revision: "physical-old-r1".into(),
        target_physical_revision: "physical-target-r1".into(),
        target_digest: "fnv1a64:target".into(),
        target_byte_length: 456,
        old_current_pre_digest: "fnv1a64:old".into(),
        old_current_expected_post_digest: "fnv1a64:expected".into(),
        old_current_file_name: "old.md".into(),
        target_file_name: "target.md".into(),
        default_file_name: "default.md".into(),
        created_at: "2026-07-20T09:30:00.000Z".into(),
    }
}

#[test]
fn prepared_is_durable_and_unresolved_is_unique_per_run_channel() {
    let connection = Connection::open_in_memory().expect("db");
    schema(&connection);
    seed(&connection);
    let created = prepare_experiment_run_switch_recovery_in_connection(&connection, &prepared("op-1"))
        .expect("prepared");
    assert_eq!(created.phase, "prepared");
    assert_eq!(created.operation_id, "op-1");
    let context_snapshot: (String, Option<String>, String) = connection
        .query_row(
            "SELECT project_title_snapshot, rating_snapshot, tags_json
             FROM experiment_run_manuscript_switch_recoveries
             WHERE operation_id='op-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("context snapshot");
    assert_eq!(context_snapshot.0, "Project");
    assert_eq!(context_snapshot.1.as_deref(), Some("good"));
    assert_eq!(context_snapshot.2, r#"["tag-a"]"#);
    let duplicate = prepare_experiment_run_switch_recovery_in_connection(&connection, &prepared("op-2"))
        .expect_err("second unresolved operation must fail");
    assert!(duplicate.contains("RUN_SWITCH_RECOVERY_ALREADY_ACTIVE"));
    drop(connection);
}

#[test]
fn direct_post_verify_classifies_not_committed_exact_and_mismatch() {
    let mut connection = Connection::open_in_memory().expect("db");
    schema(&connection);
    seed(&connection);
    prepare_experiment_run_switch_recovery_in_connection(&connection, &prepared("op-verify"))
        .expect("prepared");
    connection.execute(
        "UPDATE experiment_run_manuscript_switch_recoveries SET phase='writeback_applied', old_current_post_revision='physical-old-r2' WHERE operation_id='op-verify'",
        [],
    ).expect("writeback evidence");
    let before = post_verify_experiment_run_switch_recovery_in_connection(&connection, "op-verify")
        .expect("verify old state");
    assert_eq!(before.status, "not_committed");

    let completed = complete_experiment_run_switch_recovery_in_connection(
        &mut connection,
        "op-verify",
        "physical-old-r2",
        "2026-07-20T09:31:00.000Z",
    ).expect("db-only completion");
    assert_eq!(completed.status, "committed_exact");
    let exact = post_verify_experiment_run_switch_recovery_in_connection(&connection, "op-verify")
        .expect("verify committed");
    assert_eq!(exact.status, "committed_exact");
    connection.execute_batch(
        "UPDATE experiment_runs SET updated_at='later-owner-metadata';
         UPDATE manuscript_bindings SET updated_at='later-binding-metadata';",
    ).expect("metadata drift");
    let exact_after_metadata_drift = post_verify_experiment_run_switch_recovery_in_connection(
        &connection,
        "op-verify",
    ).expect("verify committed after metadata drift");
    assert_eq!(exact_after_metadata_drift.status, "committed_exact");
    let logs: i64 = connection.query_row(
        "SELECT COUNT(*) FROM operation_logs WHERE id='op-verify'", [], |row| row.get(0)
    ).expect("logs");
    assert_eq!(logs, 1);

    connection.execute(
        "UPDATE manuscript_bindings SET default_manuscript_file_ref_id='old' WHERE id='binding-1'",
        [],
    ).expect("corrupt default");
    let mismatch = post_verify_experiment_run_switch_recovery_in_connection(&connection, "op-verify")
        .expect("verify mismatch");
    assert_eq!(mismatch.status, "committed_mismatch");
}

#[test]
fn unresolved_recovery_survives_real_test_process_restart() {
    const CHILD_STAGE_ENV: &str = "LABPOD_RUN_RECOVERY_CHILD_STAGE";
    const CHILD_PATH_ENV: &str = "LABPOD_RUN_RECOVERY_CHILD_PATH";

    if let Ok(stage) = std::env::var(CHILD_STAGE_ENV) {
        let path = PathBuf::from(std::env::var(CHILD_PATH_ENV).expect("child database path"));
        let connection = Connection::open(path).expect("child process connection");
        match stage.as_str() {
            "prepare" => {
                schema(&connection);
                seed(&connection);
                prepare_experiment_run_switch_recovery_in_connection(
                    &connection,
                    &prepared("op-restart"),
                )
                .expect("persist before process exit");
            }
            "rediscover" => {
                let phase: String = connection
                    .query_row(
                        "SELECT phase FROM experiment_run_manuscript_switch_recoveries WHERE operation_id='op-restart'",
                        [],
                        |row| row.get(0),
                    )
                    .expect("rediscover durable row in new process");
                assert_eq!(phase, "prepared");
                let verified = post_verify_experiment_run_switch_recovery_in_connection(
                    &connection,
                    "op-restart",
                )
                .expect("direct sqlite verify after process restart");
                assert_eq!(verified.status, "not_committed");
            }
            _ => panic!("unexpected child stage"),
        }
        return;
    }

    let path = temporary_database_path();
    let current_test_binary = std::env::current_exe().expect("current test binary");
    let exact_test_name =
        "db::experiment_run_manuscript_switch_recovery_tests::unresolved_recovery_survives_real_test_process_restart";
    for stage in ["prepare", "rediscover"] {
        let status = Command::new(&current_test_binary)
            .args(["--exact", exact_test_name, "--nocapture"])
            .env(CHILD_STAGE_ENV, stage)
            .env(CHILD_PATH_ENV, &path)
            .status()
            .expect("spawn isolated recovery test process");
        assert!(status.success(), "{stage} child process failed");
    }
    std::fs::remove_file(path).expect("cleanup temp sqlite");
}
