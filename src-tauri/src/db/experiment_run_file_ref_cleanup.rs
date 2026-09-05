use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::SystemTime;
use tauri::AppHandle;

const REFERENCE_CONFLICT: &str = "RUN_FILE_REF_CLEANUP_REFERENCE_CONFLICT";
const IDENTITY_MISMATCH: &str = "RUN_FILE_REF_CLEANUP_IDENTITY_MISMATCH";
const FAILED: &str = "RUN_FILE_REF_CLEANUP_FAILED";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRunFileRefCleanupInput {
    pub run_id: String,
    pub parent_experiment_id: String,
    pub target_file_ref_ids: [String; 2],
    pub operation_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRunFileRefCleanupSuccess {
    status: &'static str,
    run_id: String,
    parent_experiment_id: String,
    deleted_file_ref_ids: Vec<String>,
    operation_log_id: String,
    physical_file_action_count: u8,
    parent_physical_files_unchanged: bool,
}

#[derive(Debug, Clone)]
struct TargetRecord {
    id: String,
    path: String,
    path_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PhysicalSnapshot {
    bytes: Vec<u8>,
    modified: Option<SystemTime>,
}

fn coded(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

fn read_target(
    connection: &Connection,
    id: &str,
    run_id: &str,
) -> Result<TargetRecord, String> {
    connection.query_row(
        "SELECT id, path, path_identity_key, owner_type, owner_id, resource_kind, file_role, location_mode, manuscript_channel, deleted_at
         FROM file_refs WHERE id = ?1",
        [id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
        )),
    ).optional().map_err(|_| coded(FAILED, "Target FileRef readback failed."))?
        .and_then(|record| {
            let (record_id, path, identity, owner_type, owner_id, kind, role, location, channel, deleted_at) = record;
            if owner_type == "experimentRun" && owner_id == run_id && kind == "file" &&
                role == "manuscript" && location == "managed" && channel == "primary" &&
                deleted_at.is_none() && !identity.trim().is_empty() {
                Some(TargetRecord { id: record_id, path, path_identity: identity })
            } else { None }
        })
        .ok_or_else(|| coded(IDENTITY_MISMATCH, "Target FileRef identity is not the exact active Run managed manuscript contract."))
}

fn snapshot(path: &str) -> Result<PhysicalSnapshot, String> {
    let metadata = fs::metadata(path)
        .map_err(|_| coded(IDENTITY_MISMATCH, "Parent manuscript physical file is unavailable."))?;
    if !metadata.is_file() {
        return Err(coded(IDENTITY_MISMATCH, "Parent manuscript physical path is not a file."));
    }
    Ok(PhysicalSnapshot {
        bytes: fs::read(path).map_err(|_| coded(IDENTITY_MISMATCH, "Parent manuscript bytes could not be read for safety comparison."))?,
        modified: metadata.modified().ok(),
    })
}

pub fn cleanup_at_path(
    database_path: &Path,
    input: ExperimentRunFileRefCleanupInput,
) -> Result<ExperimentRunFileRefCleanupSuccess, String> {
    if input.target_file_ref_ids[0] == input.target_file_ref_ids[1] {
        return Err(coded(IDENTITY_MISMATCH, "Cleanup requires two distinct exact FileRef ids."));
    }
    let mut connection = Connection::open(database_path)
        .map_err(|_| coded(FAILED, "Development SQLite could not be opened."))?;
    connection.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|_| coded(FAILED, "Foreign-key enforcement could not be enabled."))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| coded(FAILED, "Cleanup transaction could not start."))?;

    let parent_id: String = transaction.query_row(
        "SELECT experiment_id FROM experiment_runs WHERE id = ?1 AND deleted_at IS NULL",
        [&input.run_id],
        |row| row.get(0),
    ).optional().map_err(|_| coded(FAILED, "Run readback failed."))?
        .ok_or_else(|| coded(IDENTITY_MISMATCH, "Target Run is missing or deleted."))?;
    if parent_id != input.parent_experiment_id {
        return Err(coded(IDENTITY_MISMATCH, "Target Run parent identity changed."));
    }
    let parent_workspace: String = transaction.query_row(
        "SELECT folder.path_identity_key
         FROM manuscript_bindings binding
         JOIN file_refs folder ON folder.id = binding.default_folder_file_ref_id
         WHERE binding.owner_type = 'experiment' AND binding.owner_id = ?1
           AND binding.manuscript_channel = 'primary' AND binding.deleted_at IS NULL
           AND folder.owner_type = 'experiment' AND folder.owner_id = ?1
           AND folder.resource_kind = 'folder' AND folder.file_role = 'defaultFolder'
           AND folder.location_mode = 'managed' AND folder.deleted_at IS NULL",
        [&input.parent_experiment_id],
        |row| row.get(0),
    ).optional().map_err(|_| coded(FAILED, "Parent workspace readback failed."))?
        .ok_or_else(|| coded(IDENTITY_MISMATCH, "Parent canonical workspace metadata is missing."))?;

    let mut targets = Vec::new();
    let mut physical_before = Vec::new();
    for id in &input.target_file_ref_ids {
        let target = read_target(&transaction, id, &input.run_id)?;
        let parent_prefix = format!("{}/", parent_workspace.trim_end_matches('/'));
        if !target.path_identity.starts_with(&parent_prefix) {
            return Err(coded(IDENTITY_MISMATCH, "Target path is outside the parent Experiment workspace."));
        }
        let parent_matches: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM file_refs
             WHERE owner_type = 'experiment' AND owner_id = ?1
               AND resource_kind = 'file' AND file_role = 'manuscript'
               AND location_mode = 'managed' AND manuscript_channel = 'primary'
               AND path_identity_key = ?2 AND deleted_at IS NULL",
            params![input.parent_experiment_id, target.path_identity],
            |row| row.get(0),
        ).map_err(|_| coded(FAILED, "Parent FileRef identity readback failed."))?;
        if parent_matches != 1 {
            return Err(coded(IDENTITY_MISMATCH, "Target path does not have exactly one active parent Experiment managed manuscript FileRef."));
        }
        let binding_refs: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM manuscript_bindings
             WHERE default_folder_file_ref_id = ?1 OR default_manuscript_file_ref_id = ?1 OR current_file_ref_id = ?1",
            [id], |row| row.get(0),
        ).map_err(|_| coded(FAILED, "Binding reference preflight failed."))?;
        let result_refs: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM result_items WHERE file_ref_id = ?1",
            [id], |row| row.get(0),
        ).map_err(|_| coded(FAILED, "Result reference preflight failed."))?;
        if binding_refs != 0 || result_refs != 0 {
            return Err(coded(REFERENCE_CONFLICT, "Target FileRef is still referenced."));
        }
        physical_before.push(snapshot(&target.path)?);
        targets.push(target);
    }

    for target in &targets {
        let current = read_target(&transaction, &target.id, &input.run_id)?;
        if current.path_identity != target.path_identity || current.path != target.path {
            return Err(coded(IDENTITY_MISMATCH, "Target FileRef changed before deletion."));
        }
        let changed = transaction.execute("DELETE FROM file_refs WHERE id = ?1", [&target.id])
            .map_err(|_| coded(FAILED, "Exact FileRef metadata delete failed."))?;
        if changed != 1 {
            return Err(coded(FAILED, "Exact FileRef metadata delete count was not one."));
        }
    }

    let related = serde_json::json!([
        {"type":"experimentRun","id":input.run_id,"relation":"corrected"},
        {"type":"experiment","id":input.parent_experiment_id,"relation":"preserved"},
        {"type":"fileRef","id":input.target_file_ref_ids[0],"relation":"hard_deleted_metadata"},
        {"type":"fileRef","id":input.target_file_ref_ids[1],"relation":"hard_deleted_metadata"}
    ]).to_string();
    transaction.execute(
        "INSERT INTO operation_logs (
           id, operation_type, source, module, status, risk_level, target, summary,
           related_entities, impact_summary, confirmation, feedback, warnings, errors,
           skipped, is_recoverable, recycle_entry_id, actor_id, actor_label, refresh_keys,
           schema_version, created_at, updated_at, deleted_at
         ) VALUES (?1,'custom','system','experiment','success','high',?2,?3,?4,?5,?6,?7,'[]','[]','[]',0,NULL,'system','LabPod maintenance',?8,1,?9,?9,NULL)",
        params![
            input.operation_id,
            serde_json::json!({"entityType":"experimentRun","entityId":input.run_id,"title":"ExperimentRun FileRef metadata correction"}).to_string(),
            "Removed two incorrect ExperimentRun FileRef metadata rows; parent metadata and physical manuscripts were preserved.",
            related,
            serde_json::json!({"affectedEntityCount":2,"affectedItems":[]}).to_string(),
            "Exact identity, reference, Session and physical-file safety preflight passed.",
            "Two incorrect Run-owned metadata rows removed; no physical file action performed.",
            serde_json::json!(["fileRef.changed","operationLog.changed"]).to_string(),
            input.occurred_at
        ],
    ).map_err(|_| coded(FAILED, "Corrective OperationLog write failed."))?;

    for target in &targets {
        let remaining: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM file_refs WHERE id = ?1", [&target.id], |row| row.get(0)
        ).map_err(|_| coded(FAILED, "Delete readback failed."))?;
        if remaining != 0 { return Err(coded(FAILED, "Deleted FileRef remained after transaction write.")); }
    }
    transaction.commit().map_err(|_| coded(FAILED, "Cleanup transaction commit failed."))?;

    for (index, target) in targets.iter().enumerate() {
        if snapshot(&target.path)? != physical_before[index] {
            return Err(coded(FAILED, "Parent manuscript bytes or mtime changed during metadata cleanup."));
        }
    }
    Ok(ExperimentRunFileRefCleanupSuccess {
        status: "success",
        run_id: input.run_id,
        parent_experiment_id: input.parent_experiment_id,
        deleted_file_ref_ids: input.target_file_ref_ids.to_vec(),
        operation_log_id: input.operation_id,
        physical_file_action_count: 0,
        parent_physical_files_unchanged: true,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_cleanup_experiment_run_file_refs(
    app_handle: AppHandle,
    input: ExperimentRunFileRefCleanupInput,
) -> Result<ExperimentRunFileRefCleanupSuccess, String> {
    let path = super::database_path(&app_handle)?;
    cleanup_at_path(&path, input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const RUN: &str = "run-a";
    const PARENT: &str = "experiment-a";
    const TARGET_A: &str = "wrong-a";
    const TARGET_B: &str = "wrong-b";

    fn identity(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/").to_lowercase()
    }

    fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("labpod-run-file-ref-cleanup-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("cleanup.sqlite3");
        let workspace = root.join("experiment-workspace");
        fs::create_dir_all(&workspace).unwrap();
        let file_a = workspace.join("experiment.md");
        let file_b = workspace.join("experiment-copy.md");
        fs::write(&file_a, b"parent-a\r\n").unwrap();
        fs::write(&file_b, b"parent-b\n").unwrap();
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(
            "CREATE TABLE experiment_runs (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, deleted_at TEXT);
             CREATE TABLE file_refs (
               id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
               resource_kind TEXT NOT NULL, file_role TEXT NOT NULL, location_mode TEXT NOT NULL,
               manuscript_channel TEXT NOT NULL, path TEXT NOT NULL, path_identity_key TEXT NOT NULL,
               deleted_at TEXT
             );
             CREATE TABLE manuscript_bindings (
               id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
               manuscript_channel TEXT NOT NULL, default_folder_file_ref_id TEXT,
               default_manuscript_file_ref_id TEXT, current_file_ref_id TEXT, deleted_at TEXT
             );
             CREATE TABLE result_items (id TEXT PRIMARY KEY, file_ref_id TEXT);
             CREATE TABLE operation_logs (
               id TEXT PRIMARY KEY, operation_type TEXT, source TEXT, module TEXT, status TEXT,
               risk_level TEXT, target TEXT, summary TEXT, related_entities TEXT, impact_summary TEXT,
               confirmation TEXT, feedback TEXT, warnings TEXT, errors TEXT, skipped TEXT,
               is_recoverable INTEGER, recycle_entry_id TEXT, actor_id TEXT, actor_label TEXT,
               refresh_keys TEXT, schema_version INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT
             );"
        ).unwrap();
        connection.execute(
            "INSERT INTO experiment_runs (id,experiment_id,deleted_at) VALUES (?1,?2,NULL)",
            params![RUN, PARENT]
        ).unwrap();
        let workspace_identity = identity(&workspace);
        connection.execute(
            "INSERT INTO file_refs VALUES ('folder','experiment',?1,'folder','defaultFolder','managed','primary',?2,?3,NULL)",
            params![PARENT, workspace.to_string_lossy(), workspace_identity]
        ).unwrap();
        connection.execute(
            "INSERT INTO manuscript_bindings VALUES ('binding','experiment',?1,'primary','folder','parent-a','parent-b',NULL)",
            [PARENT]
        ).unwrap();
        for (parent_id, target_id, path) in [
            ("parent-a", TARGET_A, &file_a),
            ("parent-b", TARGET_B, &file_b),
        ] {
            let path_identity = identity(path);
            connection.execute(
                "INSERT INTO file_refs VALUES (?1,'experiment',?2,'file','manuscript','managed','primary',?3,?4,NULL)",
                params![parent_id, PARENT, path.to_string_lossy(), path_identity]
            ).unwrap();
            connection.execute(
                "INSERT INTO file_refs VALUES (?1,'experimentRun',?2,'file','manuscript','managed','primary',?3,?4,NULL)",
                params![target_id, RUN, path.to_string_lossy(), path_identity]
            ).unwrap();
        }
        (database, root)
    }

    fn input(operation_id: &str) -> ExperimentRunFileRefCleanupInput {
        ExperimentRunFileRefCleanupInput {
            run_id: RUN.to_string(),
            parent_experiment_id: PARENT.to_string(),
            target_file_ref_ids: [TARGET_A.to_string(), TARGET_B.to_string()],
            operation_id: operation_id.to_string(),
            occurred_at: "2026-07-20T10:45:00+08:00".to_string(),
        }
    }

    #[test]
    fn exact_cleanup_preserves_parent_metadata_and_physical_files() {
        let (database, root) = fixture();
        let result = cleanup_at_path(&database, input("cleanup-success")).unwrap();
        assert_eq!(result.deleted_file_ref_ids, vec![TARGET_A, TARGET_B]);
        assert!(result.parent_physical_files_unchanged);
        let connection = Connection::open(&database).unwrap();
        let targets: i64 = connection.query_row(
            "SELECT COUNT(*) FROM file_refs WHERE id IN (?1,?2)",
            params![TARGET_A, TARGET_B], |row| row.get(0)
        ).unwrap();
        let parents: i64 = connection.query_row(
            "SELECT COUNT(*) FROM file_refs WHERE id IN ('folder','parent-a','parent-b')",
            [], |row| row.get(0)
        ).unwrap();
        let logs: i64 = connection.query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id='cleanup-success'",
            [], |row| row.get(0)
        ).unwrap();
        assert_eq!((targets, parents, logs), (0, 3, 1));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn referenced_target_blocks_and_rolls_back_every_metadata_write() {
        let (database, root) = fixture();
        let connection = Connection::open(&database).unwrap();
        connection.execute(
            "INSERT INTO result_items (id,file_ref_id) VALUES ('result-a',?1)", [TARGET_A]
        ).unwrap();
        drop(connection);
        let error = cleanup_at_path(&database, input("cleanup-blocked")).unwrap_err();
        assert!(error.starts_with(REFERENCE_CONFLICT));
        let connection = Connection::open(&database).unwrap();
        let targets: i64 = connection.query_row(
            "SELECT COUNT(*) FROM file_refs WHERE id IN (?1,?2)",
            params![TARGET_A, TARGET_B], |row| row.get(0)
        ).unwrap();
        let logs: i64 = connection.query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id='cleanup-blocked'",
            [], |row| row.get(0)
        ).unwrap();
        assert_eq!((targets, logs), (2, 0));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
