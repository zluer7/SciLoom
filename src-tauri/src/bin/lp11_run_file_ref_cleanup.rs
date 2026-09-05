use labpod_lib::db::experiment_run_file_ref_cleanup::{
    cleanup_at_path, ExperimentRunFileRefCleanupInput,
};
use rusqlite::Connection;
use std::env;
use std::path::{Path, PathBuf};

const RUN_ID: &str = "experiment-run-24eec786-7ca9-41a7-a1cf-790e6fd0264d";
const PARENT_ID: &str = "experiment-13af5adf-6d06-4525-8561-7040ffae5007";
const TARGET_IDS: [&str; 2] = [
    "file-ref-daacbfc6-e698-4140-b8ee-2bd7f8812ae6",
    "file-ref-3b3ec41d-c080-4a16-b78d-6a1aeba482a3",
];
const OPERATION_ID: &str = "operation-log-lp11-8-i-3-b-2-c-file-ref-cleanup";

fn value(args: &[String], flag: &str) -> Result<String, String> {
    let index = args.iter().position(|item| item == flag)
        .ok_or_else(|| format!("missing required argument {flag}"))?;
    args.get(index + 1).cloned().ok_or_else(|| format!("missing value for {flag}"))
}

fn create_verified_backup(database: &Path, backup: &Path) -> Result<(), String> {
    if backup.exists() {
        return Err("backup target already exists; refusing to overwrite".to_string());
    }
    let source = Connection::open(database).map_err(|error| format!("source database open failed: {error}"))?;
    source.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
        .map_err(|error| format!("SQLite backup failed: {error}"))?;
    let copy = Connection::open(backup).map_err(|error| format!("backup database open failed: {error}"))?;
    let check: String = copy.query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("backup quick_check failed: {error}"))?;
    if check != "ok" { return Err(format!("backup quick_check returned {check}")); }
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if !args.iter().any(|item| item == "--apply") {
        return Err("refusing cleanup without explicit --apply".to_string());
    }
    let database = PathBuf::from(value(&args, "--database")?);
    let backup = PathBuf::from(value(&args, "--backup")?);
    let occurred_at = value(&args, "--occurred-at")?;
    create_verified_backup(&database, &backup)?;
    let result = cleanup_at_path(&database, ExperimentRunFileRefCleanupInput {
        run_id: RUN_ID.to_string(),
        parent_experiment_id: PARENT_ID.to_string(),
        target_file_ref_ids: [TARGET_IDS[0].to_string(), TARGET_IDS[1].to_string()],
        operation_id: OPERATION_ID.to_string(),
        occurred_at,
    })?;
    println!("{}", serde_json::to_string(&result).map_err(|error| error.to_string())?);
    println!("backup={}", backup.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
