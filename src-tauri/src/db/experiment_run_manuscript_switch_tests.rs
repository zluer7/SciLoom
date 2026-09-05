use super::experiment_run_manuscript_switch::{
    commit_experiment_run_switch_in_connection, ExperimentRunOutlineReplacement,
    ExperimentRunSwitchAudit, ExperimentRunSwitchTransactionInput,
};
use rusqlite::{params, Connection};
use std::path::PathBuf;

fn temporary_database_path(label: &str) -> PathBuf {
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    );
    std::env::temp_dir()
        .join(format!("labpod-run-switch-{label}-{nonce}"))
        .join("run-switch.sqlite")
}

fn schema(connection: &Connection) {
    connection
        .execute_batch(
            "CREATE TABLE experiments (
               id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
               updated_at TEXT NOT NULL, deleted_at TEXT
             );
             CREATE TABLE experiment_runs (
               id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, project_id TEXT NOT NULL,
               condition_summary TEXT, variable_parameter_summary TEXT, method_summary TEXT,
               result_summary TEXT, conclusion TEXT, summary_other TEXT,
               updated_at TEXT NOT NULL, deleted_at TEXT
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
        )
        .expect("schema");
}

fn seed(connection: &Connection) {
    connection.execute(
        "INSERT INTO experiments (id,project_id,title,updated_at,deleted_at)
         VALUES ('experiment-1','project-1','Parent','parent-rev-1',NULL)",
        [],
    ).expect("parent");
    connection.execute(
        "INSERT INTO experiment_runs (
           id,experiment_id,project_id,condition_summary,variable_parameter_summary,
           method_summary,result_summary,conclusion,summary_other,updated_at,deleted_at
         ) VALUES ('run-1','experiment-1','project-1','old-c','old-v','old-m','old-r','old-k','old-o','run-rev-1',NULL)",
        [],
    ).expect("run");
    connection.execute(
        "INSERT INTO manuscript_bindings (
           id,owner_type,owner_id,manuscript_channel,current_file_ref_id,
           default_manuscript_file_ref_id,updated_at,deleted_at
         ) VALUES ('binding-1','experimentRun','run-1','primary','old','default','binding-rev-1',NULL)",
        [],
    ).expect("binding");
    for (id, path) in [("old", "c:/old.md"), ("default", "c:/default.md"), ("target", "c:/target.md")] {
        connection.execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,path_identity_key,updated_at,deleted_at
             ) VALUES (?1,'experimentRun','run-1','primary','file','manuscript','managed',?2,?3,NULL)",
            params![id, path, format!("{id}-rev-1")],
        ).expect("file ref");
    }
}

fn replacement(key: &str, value: Option<&str>) -> ExperimentRunOutlineReplacement {
    ExperimentRunOutlineReplacement {
        key: key.into(),
        action: if value.is_some() { "set".into() } else { "clear".into() },
        value: value.map(str::to_owned),
    }
}

fn input(operation_id: &str) -> ExperimentRunSwitchTransactionInput {
    ExperimentRunSwitchTransactionInput {
        operation_id: operation_id.into(),
        owner_type: "experimentRun".into(),
        run_id: "run-1".into(),
        experiment_id: "experiment-1".into(),
        project_id: "project-1".into(),
        manuscript_channel: "primary".into(),
        binding_id: "binding-1".into(),
        expected_binding_updated_at: "binding-rev-1".into(),
        expected_current_file_ref_id: "old".into(),
        expected_current_path_identity: "c:/old.md".into(),
        expected_default_manuscript_file_ref_id: "default".into(),
        expected_default_path_identity: "c:/default.md".into(),
        target_file_ref_id: "target".into(),
        target_path_identity: "c:/target.md".into(),
        target_location_mode: "managed".into(),
        outline_replacements: vec![
            replacement("conditionSummary", Some("new-c")),
            replacement("variableParameterSummary", None),
            replacement("methodSummary", Some("new-m")),
            replacement("resultSummary", Some("new-r")),
            replacement("conclusion", None),
            replacement("summaryOther", Some("new-o")),
        ],
        old_current_writeback_completed: true,
        old_current_post_revision: "old-physical-rev-2".into(),
        target_physical_revision: "target-physical-rev-1".into(),
        occurred_at: "2026-07-20T03:00:00.000Z".into(),
        log_summary: "ExperimentRun formal manuscript switch".into(),
        audit: ExperimentRunSwitchAudit {
            actor_id: "local_user".into(),
            actor_label: "Local user".into(),
            source: "user".into(),
        },
    }
}

fn state(connection: &Connection) -> (Vec<Option<String>>, String, String, i64) {
    let outline = connection.query_row(
        "SELECT condition_summary,variable_parameter_summary,method_summary,
                result_summary,conclusion,summary_other FROM experiment_runs WHERE id='run-1'",
        [],
        |row| Ok((0..6).map(|index| row.get(index)).collect::<rusqlite::Result<Vec<Option<String>>>>()?),
    ).expect("outline");
    let (current, default): (String, String) = connection.query_row(
        "SELECT current_file_ref_id,default_manuscript_file_ref_id FROM manuscript_bindings WHERE id='binding-1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).expect("binding");
    let logs = connection.query_row(
        "SELECT COUNT(*) FROM operation_logs WHERE module='experiment'",
        [],
        |row| row.get(0),
    ).expect("logs");
    (outline, current, default, logs)
}

#[test]
fn temp_sqlite_commits_six_field_replacement_current_and_log_without_changing_default() {
    let path = temporary_database_path("success");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("temp directory");
    let mut connection = Connection::open(&path).expect("open temp sqlite");
    schema(&connection);
    seed(&connection);
    let result = commit_experiment_run_switch_in_connection(&mut connection, &input("operation-1"))
        .expect("formal switch");
    assert_eq!(result.current_file_ref_id, "target");
    assert_eq!(result.default_manuscript_file_ref_id, "default");
    assert_eq!(state(&connection), (
        vec![Some("new-c".into()), None, Some("new-m".into()), Some("new-r".into()), None, Some("new-o".into())],
        "target".into(), "default".into(), 1
    ));
    drop(connection);
    std::fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
}

#[test]
fn every_database_writer_fault_rolls_back_outline_current_and_operation_log() {
    for (label, trigger) in [
        ("outline", "CREATE TRIGGER fail_run BEFORE UPDATE ON experiment_runs BEGIN SELECT RAISE(FAIL,'fault'); END;"),
        ("binding", "CREATE TRIGGER fail_binding BEFORE UPDATE ON manuscript_bindings BEGIN SELECT RAISE(FAIL,'fault'); END;"),
        ("log", "CREATE TRIGGER fail_log BEFORE INSERT ON operation_logs BEGIN SELECT RAISE(FAIL,'fault'); END;"),
    ] {
        let mut connection = Connection::open_in_memory().expect("memory sqlite");
        schema(&connection);
        seed(&connection);
        let before = state(&connection);
        connection.execute_batch(trigger).expect("fault trigger");
        assert!(commit_experiment_run_switch_in_connection(&mut connection, &input(&format!("operation-{label}"))).is_err());
        assert_eq!(state(&connection), before, "{label} fault must roll back every DB writer");
    }
}

#[test]
fn transaction_revalidates_parent_run_binding_default_and_target_owner() {
    for (label, mutation, expected_code) in [
        ("parent-deleted", "UPDATE experiments SET deleted_at='x' WHERE id='experiment-1'", "RUN_SWITCH_PARENT_DELETED"),
        ("run-deleted", "UPDATE experiment_runs SET deleted_at='x' WHERE id='run-1'", "RUN_SWITCH_OWNER_DELETED"),
        ("current-stale", "UPDATE manuscript_bindings SET current_file_ref_id='default' WHERE id='binding-1'", "RUN_SWITCH_CURRENT_MISMATCH"),
        ("default-stale", "UPDATE manuscript_bindings SET default_manuscript_file_ref_id='old' WHERE id='binding-1'", "RUN_SWITCH_DEFAULT_MISMATCH"),
        ("cross-owner", "UPDATE file_refs SET owner_id='run-2' WHERE id='target'", "RUN_SWITCH_TARGET_OWNER_MISMATCH"),
    ] {
        let mut connection = Connection::open_in_memory().expect("memory sqlite");
        schema(&connection);
        seed(&connection);
        connection.execute(mutation, []).expect("mutate");
        let error = commit_experiment_run_switch_in_connection(&mut connection, &input(&format!("operation-{label}")))
            .expect_err("guard must reject");
        assert!(error.contains(expected_code), "{label}: {error}");
        assert_eq!(state(&connection).3, 0);
    }
}
