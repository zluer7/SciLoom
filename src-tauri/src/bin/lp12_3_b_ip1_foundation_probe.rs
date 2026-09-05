use rusqlite::Connection;
use std::collections::HashMap;
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const ISOLATION_ERROR: &str = "SAVE_AS_FORMAL_RESOURCE_ISOLATION_VIOLATION";

fn fail(code: &str) -> ! {
    eprintln!("{code}");
    std::process::exit(2);
}

fn arguments() -> HashMap<String, String> {
    let mut values = HashMap::new();
    let mut arguments = env::args().skip(1);
    while let Some(key) = arguments.next() {
        let Some(value) = arguments.next() else {
            fail(ISOLATION_ERROR);
        };
        values.insert(key, value);
    }
    values
}

fn required(values: &HashMap<String, String>, key: &str) -> PathBuf {
    let Some(value) = values.get(key) else {
        fail(ISOLATION_ERROR);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.trim().is_empty() {
        fail(ISOLATION_ERROR);
    }
    path
}

fn contained(root: &Path, target: &Path) -> bool {
    target.parent().is_some_and(|parent| parent == root)
}

fn main() {
    let values = arguments();
    let database = required(&values, "--database");
    let managed_root = required(&values, "--managed-root");
    let external_root = required(&values, "--external-root");
    let target = required(&values, "--target");
    if !managed_root.is_dir()
        || !external_root.is_dir()
        || !contained(&external_root, &target)
        || database == target
        || database.starts_with(&managed_root)
        || target.starts_with(&managed_root)
    {
        fail(ISOLATION_ERROR);
    }
    if target.exists() {
        fail("SAVE_AS_TARGET_ALREADY_EXISTS");
    }

    let connection = Connection::open(&database).unwrap_or_else(|_| fail(ISOLATION_ERROR));
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ip1_probe_j0 (
               target_path TEXT PRIMARY KEY,
               created_at TEXT NOT NULL
             );",
        )
        .unwrap_or_else(|_| fail(ISOLATION_ERROR));
    if connection
        .execute(
            "INSERT INTO ip1_probe_j0(target_path, created_at) VALUES (?1, datetime('now'))",
            [target.to_string_lossy().as_ref()],
        )
        .is_err()
    {
        fail("SAVE_AS_J0_CLAIM_CONFLICT");
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .unwrap_or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                fail("SAVE_AS_TARGET_ALREADY_EXISTS");
            }
            fail("SAVE_AS_D1_WRITE_FAILED");
        });
    file.write_all(b"# isolated IP-1 probe\n")
        .unwrap_or_else(|_| fail("SAVE_AS_D1_WRITE_FAILED"));
    file.flush()
        .unwrap_or_else(|_| fail("SAVE_AS_D1_FLUSH_FAILED"));
    file.sync_all()
        .unwrap_or_else(|_| fail("SAVE_AS_D1_SYNC_FAILED"));
    println!("PASS isolated_probe target={}", target.display());
}
