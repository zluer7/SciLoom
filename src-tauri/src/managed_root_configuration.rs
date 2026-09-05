use crate::db;
use crate::manuscript_provisioning_contract::StableErrorCode;
use crate::physical_freshness::{
    inspect_existing_directory_identity, ExistingDirectoryIdentity, PhysicalFailure,
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SETTING_ID: &str = "managed-root";
const PROBE_MARKER: &[u8] = b"LabPod managed-root writability probe v1";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum DurableConfigurationState {
    NotConfigured,
    Configured,
    ReadFailed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum RuntimeReadinessState {
    Ready,
    Unavailable,
    NotWritable,
    InvalidPath,
    ReadFailed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedRootConfigurationSnapshot {
    durable_state: DurableConfigurationState,
    readiness_state: RuntimeReadinessState,
    configured_path: Option<String>,
    normalized_path: Option<String>,
    path_identity_key: Option<String>,
    physical_identity_hash: Option<String>,
    error_code: Option<String>,
    checked_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ConfigurationOperationStatus {
    Completed,
    Idempotent,
    Failed,
    PersistedRefreshFailed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedRootConfigurationResult {
    status: ConfigurationOperationStatus,
    attempt_id: String,
    previous_durable_state: DurableConfigurationState,
    target_path_identity: Option<String>,
    error_code: Option<String>,
    snapshot: ManagedRootConfigurationSnapshot,
}

#[derive(Debug, Clone)]
struct StoredManagedRoot {
    configured_root: String,
}

#[derive(Debug, Clone)]
struct ValidationContext {
    database_path: PathBuf,
    app_data_path: PathBuf,
    resource_path: Option<PathBuf>,
}

#[derive(Debug)]
struct ValidationFailure {
    code: &'static str,
}

impl ValidationFailure {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn unconfigured_snapshot() -> ManagedRootConfigurationSnapshot {
    ManagedRootConfigurationSnapshot {
        durable_state: DurableConfigurationState::NotConfigured,
        readiness_state: RuntimeReadinessState::Unavailable,
        configured_path: None,
        normalized_path: None,
        path_identity_key: None,
        physical_identity_hash: None,
        error_code: Some("MANAGED_ROOT_UNCONFIGURED".to_string()),
        checked_at: now(),
    }
}

fn read_failed_snapshot(code: impl Into<String>) -> ManagedRootConfigurationSnapshot {
    ManagedRootConfigurationSnapshot {
        durable_state: DurableConfigurationState::ReadFailed,
        readiness_state: RuntimeReadinessState::ReadFailed,
        configured_path: None,
        normalized_path: None,
        path_identity_key: None,
        physical_identity_hash: None,
        error_code: Some(code.into()),
        checked_at: now(),
    }
}

fn physical_failure_code(error: PhysicalFailure) -> &'static str {
    match error.code {
        StableErrorCode::OperationInvalidInput => "MANAGED_ROOT_INVALID_PATH",
        StableErrorCode::PhysicalWrongType => "MANAGED_ROOT_NOT_DIRECTORY",
        StableErrorCode::PhysicalReparseBlocked => "MANAGED_ROOT_REPARSE_BLOCKED",
        StableErrorCode::PhysicalAuthorityUnavailable => "MANAGED_ROOT_UNAVAILABLE",
        _ => "MANAGED_ROOT_INVALID_PATH",
    }
}

fn canonical_existing_directory(
    path: &Path,
) -> Result<ExistingDirectoryIdentity, ValidationFailure> {
    inspect_existing_directory_identity(path)
        .map_err(|error| ValidationFailure::new(physical_failure_code(error)))
}

fn identity_if_existing(path: &Path) -> Option<String> {
    canonical_existing_directory(path)
        .ok()
        .map(|identity| identity.path_identity_key)
}

fn same_or_within(candidate: &str, directory: &str) -> bool {
    crate::physical_freshness::is_contained(directory, candidate)
}

fn validate_critical_path_boundaries(
    selected: &ExistingDirectoryIdentity,
    context: &ValidationContext,
) -> Result<(), ValidationFailure> {
    let selected_identity = selected.path_identity_key.as_str();
    let app_data_identity = identity_if_existing(&context.app_data_path)
        .ok_or_else(|| ValidationFailure::new("MANAGED_ROOT_APP_DATA_UNAVAILABLE"))?;
    if same_or_within(selected_identity, &app_data_identity)
        || same_or_within(&app_data_identity, selected_identity)
    {
        return Err(ValidationFailure::new("MANAGED_ROOT_APP_DATA_CONFLICT"));
    }

    if let Some(resource_path) = context.resource_path.as_deref() {
        if let Some(resource_identity) = identity_if_existing(resource_path) {
            if same_or_within(selected_identity, &resource_identity)
                || same_or_within(&resource_identity, selected_identity)
            {
                return Err(ValidationFailure::new("MANAGED_ROOT_APP_RESOURCE_CONFLICT"));
            }
        }
    }

    let database_parent = context
        .database_path
        .parent()
        .ok_or_else(|| ValidationFailure::new("MANAGED_ROOT_DATABASE_CONFLICT"))?;
    if let Some(database_parent_identity) = identity_if_existing(database_parent) {
        if same_or_within(selected_identity, &database_parent_identity)
            || same_or_within(&database_parent_identity, selected_identity)
        {
            return Err(ValidationFailure::new("MANAGED_ROOT_DATABASE_CONFLICT"));
        }
    }
    Ok(())
}

fn validate_reserved_layout(root: &Path) -> Result<(), ValidationFailure> {
    let projects = root.join("projects");
    match fs::symlink_metadata(&projects) {
        Ok(metadata) if !metadata.is_dir() => Err(ValidationFailure::new(
            "MANAGED_ROOT_RESERVED_LAYOUT_CONFLICT",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ValidationFailure::new(
            "MANAGED_ROOT_RESERVED_LAYOUT_UNAVAILABLE",
        )),
    }
}

fn writability_probe(root: &Path) -> Result<(), ValidationFailure> {
    let probe_path = root.join(format!(".labpod-managed-root-probe-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe_path)
        .map_err(|_| ValidationFailure::new("MANAGED_ROOT_NOT_WRITABLE"))?;
    let write_result = file.write_all(PROBE_MARKER).and_then(|_| file.sync_all());
    drop(file);
    if write_result.is_err() {
        return match fs::remove_file(&probe_path) {
            Ok(()) => Err(ValidationFailure::new("MANAGED_ROOT_NOT_WRITABLE")),
            Err(_) => Err(ValidationFailure::new("MANAGED_ROOT_PROBE_CLEANUP_FAILED")),
        };
    }

    let mut readback = Vec::new();
    let read_result =
        fs::File::open(&probe_path).and_then(|mut file| file.read_to_end(&mut readback));
    let cleanup_result = fs::remove_file(&probe_path);
    if cleanup_result.is_err() {
        return Err(ValidationFailure::new("MANAGED_ROOT_PROBE_CLEANUP_FAILED"));
    }
    if read_result.is_err() || readback != PROBE_MARKER {
        return Err(ValidationFailure::new(
            "MANAGED_ROOT_PROBE_READBACK_MISMATCH",
        ));
    }
    Ok(())
}

fn validate_selected_root(
    selected_path: &str,
    context: &ValidationContext,
    run_probe: bool,
) -> Result<ExistingDirectoryIdentity, ValidationFailure> {
    let trimmed = selected_path.trim();
    if trimmed.is_empty() {
        return Err(ValidationFailure::new("MANAGED_ROOT_PATH_EMPTY"));
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(ValidationFailure::new("MANAGED_ROOT_NOT_ABSOLUTE"));
    }
    let selected = canonical_existing_directory(path)?;
    fs::read_dir(Path::new(&selected.normalized_path))
        .map_err(|_| ValidationFailure::new("MANAGED_ROOT_UNAVAILABLE"))?;
    validate_critical_path_boundaries(&selected, context)?;
    validate_reserved_layout(Path::new(&selected.normalized_path))?;
    if run_probe {
        writability_probe(Path::new(&selected.normalized_path))?;
    }
    Ok(selected)
}

fn read_stored_root(connection: &Connection) -> Result<Option<StoredManagedRoot>, String> {
    connection
        .query_row(
            "SELECT configured_root
             FROM managed_root_settings
             WHERE id = ?1 AND deleted_at IS NULL",
            [SETTING_ID],
            |row| {
                Ok(StoredManagedRoot {
                    configured_root: row.get(0)?,
                })
            },
        )
        .optional()
        .map_err(|_| "MANAGED_ROOT_DURABLE_READ_FAILED".to_string())
}

fn configured_snapshot(
    stored_path: String,
    context: &ValidationContext,
) -> ManagedRootConfigurationSnapshot {
    match validate_selected_root(&stored_path, context, true) {
        Ok(identity) => ManagedRootConfigurationSnapshot {
            durable_state: DurableConfigurationState::Configured,
            readiness_state: RuntimeReadinessState::Ready,
            configured_path: Some(stored_path),
            normalized_path: Some(identity.normalized_path),
            path_identity_key: Some(identity.path_identity_key),
            physical_identity_hash: Some(identity.physical_identity_hash),
            error_code: None,
            checked_at: now(),
        },
        Err(error) => {
            let readiness_state = match error.code {
                "MANAGED_ROOT_NOT_WRITABLE"
                | "MANAGED_ROOT_PROBE_CLEANUP_FAILED"
                | "MANAGED_ROOT_PROBE_READBACK_MISMATCH" => RuntimeReadinessState::NotWritable,
                "MANAGED_ROOT_UNAVAILABLE" => RuntimeReadinessState::Unavailable,
                _ => RuntimeReadinessState::InvalidPath,
            };
            ManagedRootConfigurationSnapshot {
                durable_state: DurableConfigurationState::Configured,
                readiness_state,
                configured_path: Some(stored_path.clone()),
                normalized_path: Some(stored_path),
                path_identity_key: None,
                physical_identity_hash: None,
                error_code: Some(error.code.to_string()),
                checked_at: now(),
            }
        }
    }
}

fn read_snapshot_at(
    connection: &Connection,
    context: &ValidationContext,
) -> ManagedRootConfigurationSnapshot {
    match read_stored_root(connection) {
        Ok(None) => unconfigured_snapshot(),
        Ok(Some(stored)) => configured_snapshot(stored.configured_root, context),
        Err(code) => read_failed_snapshot(code),
    }
}

fn failed_result(
    attempt_id: String,
    previous_durable_state: DurableConfigurationState,
    target_path_identity: Option<String>,
    error_code: impl Into<String>,
    snapshot: ManagedRootConfigurationSnapshot,
) -> ManagedRootConfigurationResult {
    ManagedRootConfigurationResult {
        status: ConfigurationOperationStatus::Failed,
        attempt_id,
        previous_durable_state,
        target_path_identity,
        error_code: Some(error_code.into()),
        snapshot,
    }
}

fn configure_first_root_at(
    connection: &mut Connection,
    selected_path: &str,
    context: &ValidationContext,
) -> ManagedRootConfigurationResult {
    let attempt_id = format!("managed-root-{}", Uuid::new_v4());
    let before = read_snapshot_at(connection, context);
    let previous_durable_state = before.durable_state;
    if previous_durable_state == DurableConfigurationState::ReadFailed {
        return failed_result(
            attempt_id,
            previous_durable_state,
            None,
            "MANAGED_ROOT_DURABLE_READ_FAILED",
            before,
        );
    }

    let target = match validate_selected_root(selected_path, context, true) {
        Ok(target) => target,
        Err(error) => {
            return failed_result(attempt_id, previous_durable_state, None, error.code, before)
        }
    };
    let target_path_identity = Some(target.physical_identity_hash.clone());

    let transaction = match connection.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(transaction) => transaction,
        Err(_) => {
            return failed_result(
                attempt_id,
                previous_durable_state,
                target_path_identity,
                "MANAGED_ROOT_DURABLE_WRITE_FAILED",
                before,
            )
        }
    };
    let current = match read_stored_root(&transaction) {
        Ok(current) => current,
        Err(code) => {
            return failed_result(
                attempt_id,
                previous_durable_state,
                target_path_identity,
                code,
                before,
            )
        }
    };

    if let Some(current) = current {
        let current_identity = canonical_existing_directory(Path::new(&current.configured_root));
        if current_identity
            .as_ref()
            .is_ok_and(|identity| identity.path_identity_key == target.path_identity_key)
        {
            let _ = transaction.commit();
            let snapshot = read_snapshot_at(connection, context);
            return ManagedRootConfigurationResult {
                status: ConfigurationOperationStatus::Idempotent,
                attempt_id,
                previous_durable_state,
                target_path_identity,
                error_code: None,
                snapshot,
            };
        }
        return failed_result(
            attempt_id,
            previous_durable_state,
            target_path_identity,
            "MANAGED_ROOT_ALREADY_CONFIGURED",
            before,
        );
    }

    let timestamp = now();
    if transaction
        .execute(
            "INSERT INTO managed_root_settings (
               id, configured_root, schema_version, created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, 1, ?3, ?3, NULL)",
            params![SETTING_ID, target.normalized_path, timestamp],
        )
        .is_err()
    {
        return failed_result(
            attempt_id,
            previous_durable_state,
            target_path_identity,
            "MANAGED_ROOT_DURABLE_WRITE_FAILED",
            before,
        );
    }
    let readback = match read_stored_root(&transaction) {
        Ok(Some(readback)) => readback,
        _ => {
            return failed_result(
                attempt_id,
                previous_durable_state,
                target_path_identity,
                "MANAGED_ROOT_DURABLE_READBACK_FAILED",
                before,
            )
        }
    };
    let readback_identity = canonical_existing_directory(Path::new(&readback.configured_root));
    if readback.configured_root != target.normalized_path
        || !readback_identity
            .as_ref()
            .is_ok_and(|identity| identity.path_identity_key == target.path_identity_key)
    {
        return failed_result(
            attempt_id,
            previous_durable_state,
            target_path_identity,
            "MANAGED_ROOT_DURABLE_READBACK_MISMATCH",
            before,
        );
    }
    if transaction.commit().is_err() {
        return failed_result(
            attempt_id,
            previous_durable_state,
            target_path_identity,
            "MANAGED_ROOT_DURABLE_COMMIT_FAILED",
            read_snapshot_at(connection, context),
        );
    }

    let snapshot = read_snapshot_at(connection, context);
    if snapshot.durable_state != DurableConfigurationState::Configured
        || snapshot.normalized_path.as_deref() != Some(target.normalized_path.as_str())
    {
        return ManagedRootConfigurationResult {
            status: ConfigurationOperationStatus::PersistedRefreshFailed,
            attempt_id,
            previous_durable_state,
            target_path_identity,
            error_code: Some("MANAGED_ROOT_RUNTIME_REFRESH_FAILED".to_string()),
            snapshot: if snapshot.durable_state == DurableConfigurationState::ReadFailed {
                ManagedRootConfigurationSnapshot {
                    durable_state: DurableConfigurationState::Configured,
                    readiness_state: RuntimeReadinessState::ReadFailed,
                    configured_path: Some(target.normalized_path.clone()),
                    normalized_path: Some(target.normalized_path),
                    path_identity_key: Some(target.path_identity_key),
                    physical_identity_hash: Some(target.physical_identity_hash),
                    error_code: Some("MANAGED_ROOT_RUNTIME_REFRESH_FAILED".to_string()),
                    checked_at: now(),
                }
            } else {
                snapshot
            },
        };
    }
    ManagedRootConfigurationResult {
        status: ConfigurationOperationStatus::Completed,
        attempt_id,
        previous_durable_state,
        target_path_identity,
        error_code: None,
        snapshot,
    }
}

fn command_context(app_handle: &AppHandle) -> Result<ValidationContext, String> {
    let database_path = db::database_path(app_handle)?;
    let app_data_path = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| "MANAGED_ROOT_APP_DATA_UNAVAILABLE".to_string())?;
    let resource_path = app_handle.path().resource_dir().ok();
    Ok(ValidationContext {
        database_path,
        app_data_path,
        resource_path,
    })
}

#[tauri::command]
pub(crate) fn read_managed_root_configuration(
    app_handle: AppHandle,
) -> ManagedRootConfigurationSnapshot {
    let context = match command_context(&app_handle) {
        Ok(context) => context,
        Err(code) => return read_failed_snapshot(code),
    };
    let connection = match db::open_connection(&app_handle) {
        Ok(connection) => connection,
        Err(_) => return read_failed_snapshot("MANAGED_ROOT_DURABLE_READ_FAILED"),
    };
    read_snapshot_at(&connection, &context)
}

#[tauri::command]
pub(crate) fn configure_managed_root_first_time(
    app_handle: AppHandle,
    selected_path: String,
) -> ManagedRootConfigurationResult {
    let context = match command_context(&app_handle) {
        Ok(context) => context,
        Err(code) => {
            return failed_result(
                format!("managed-root-{}", Uuid::new_v4()),
                DurableConfigurationState::ReadFailed,
                None,
                code.clone(),
                read_failed_snapshot(code),
            )
        }
    };
    let mut connection = match db::open_connection(&app_handle) {
        Ok(connection) => connection,
        Err(_) => {
            return failed_result(
                format!("managed-root-{}", Uuid::new_v4()),
                DurableConfigurationState::ReadFailed,
                None,
                "MANAGED_ROOT_DURABLE_READ_FAILED",
                read_failed_snapshot("MANAGED_ROOT_DURABLE_READ_FAILED"),
            )
        }
    };
    configure_first_root_at(&mut connection, &selected_path, &context)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("labpod-managed-root-r1-{label}-{}", Uuid::new_v4()));
        let app_data = base.join("app-data");
        let managed = base.join("managed-root");
        fs::create_dir_all(&app_data).expect("create app data");
        fs::create_dir_all(&managed).expect("create managed root");
        (base, app_data, managed)
    }

    fn initialized(label: &str) -> (PathBuf, Connection, ValidationContext, PathBuf) {
        let (base, app_data, managed) = test_paths(label);
        let database_path = app_data.join("labpod.sqlite3");
        db::initialize_test_database_at(&database_path).expect("initialize database");
        let connection = Connection::open(&database_path).expect("open database");
        let context = ValidationContext {
            database_path,
            app_data_path: app_data,
            resource_path: None,
        };
        (base, connection, context, managed)
    }

    #[test]
    fn fresh_first_configuration_is_atomic_and_idempotent() {
        let (base, mut connection, context, managed) = initialized("first");
        assert_eq!(
            read_snapshot_at(&connection, &context).durable_state,
            DurableConfigurationState::NotConfigured
        );
        let first = configure_first_root_at(
            &mut connection,
            managed.to_string_lossy().as_ref(),
            &context,
        );
        assert_eq!(first.status, ConfigurationOperationStatus::Completed);
        assert_eq!(first.snapshot.readiness_state, RuntimeReadinessState::Ready);
        let second = configure_first_root_at(
            &mut connection,
            managed.to_string_lossy().as_ref(),
            &context,
        );
        assert_eq!(second.status, ConfigurationOperationStatus::Idempotent);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM managed_root_settings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        let database_path = context.database_path.clone();
        drop(connection);
        let reopened = Connection::open(database_path).unwrap();
        let after_restart = read_snapshot_at(&reopened, &context);
        assert_eq!(
            after_restart.durable_state,
            DurableConfigurationState::Configured
        );
        assert_eq!(after_restart.readiness_state, RuntimeReadinessState::Ready);
        drop(reopened);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn invalid_target_and_app_data_conflict_do_not_persist() {
        let (base, mut connection, context, _managed) = initialized("invalid");
        let relative = configure_first_root_at(&mut connection, "relative/root", &context);
        assert_eq!(relative.status, ConfigurationOperationStatus::Failed);
        assert_eq!(
            relative.error_code.as_deref(),
            Some("MANAGED_ROOT_NOT_ABSOLUTE")
        );
        let app_data_path = context.app_data_path.to_string_lossy().to_string();
        let conflict = configure_first_root_at(&mut connection, &app_data_path, &context);
        assert_eq!(conflict.status, ConfigurationOperationStatus::Failed);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM managed_root_settings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn different_root_is_rejected_and_original_remains() {
        let (base, mut connection, context, managed) = initialized("guard");
        let other = base.join("other-root");
        fs::create_dir_all(&other).unwrap();
        let first = configure_first_root_at(
            &mut connection,
            managed.to_string_lossy().as_ref(),
            &context,
        );
        assert_eq!(first.status, ConfigurationOperationStatus::Completed);
        let changed =
            configure_first_root_at(&mut connection, other.to_string_lossy().as_ref(), &context);
        assert_eq!(changed.status, ConfigurationOperationStatus::Failed);
        assert_eq!(
            changed.error_code.as_deref(),
            Some("MANAGED_ROOT_ALREADY_CONFIGURED")
        );
        let stored: String = connection
            .query_row(
                "SELECT configured_root FROM managed_root_settings WHERE id = ?1",
                [SETTING_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            canonical_existing_directory(Path::new(&stored))
                .unwrap()
                .path_identity_key,
            canonical_existing_directory(&managed)
                .unwrap()
                .path_identity_key
        );
        drop(connection);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unavailable_configured_root_stays_durably_configured() {
        let (base, mut connection, context, managed) = initialized("unavailable");
        let first = configure_first_root_at(
            &mut connection,
            managed.to_string_lossy().as_ref(),
            &context,
        );
        assert_eq!(first.status, ConfigurationOperationStatus::Completed);
        fs::remove_dir_all(&managed).unwrap();
        let snapshot = read_snapshot_at(&connection, &context);
        assert_eq!(
            snapshot.durable_state,
            DurableConfigurationState::Configured
        );
        assert_eq!(snapshot.readiness_state, RuntimeReadinessState::Unavailable);
        drop(connection);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn successful_probe_leaves_no_residual_file() {
        let (base, connection, context, managed) = initialized("probe");
        let before = fs::read_dir(&managed).unwrap().count();
        validate_selected_root(managed.to_string_lossy().as_ref(), &context, true).unwrap();
        let after = fs::read_dir(&managed).unwrap().count();
        assert_eq!(before, after);
        drop(connection);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn readback_mismatch_rolls_back_without_success() {
        let (base, mut connection, context, managed) = initialized("readback-mismatch");
        connection
            .execute_batch(
                "CREATE TRIGGER corrupt_managed_root_readback
                 AFTER INSERT ON managed_root_settings
                 BEGIN
                   UPDATE managed_root_settings
                   SET configured_root = configured_root || '-corrupt'
                   WHERE id = NEW.id;
                 END;",
            )
            .unwrap();
        let result = configure_first_root_at(
            &mut connection,
            managed.to_string_lossy().as_ref(),
            &context,
        );
        assert_eq!(result.status, ConfigurationOperationStatus::Failed);
        assert_eq!(
            result.error_code.as_deref(),
            Some("MANAGED_ROOT_DURABLE_READBACK_MISMATCH")
        );
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM managed_root_settings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod lp15_f2_path_tests {
    use super::*;
    #[test]
    fn critical_boundaries_keep_posix_separator_and_case() {
        assert!(same_or_within("/Users/Ada/Data/child", "/Users/Ada/Data"));
        assert!(!same_or_within("/Users/Ada/Database", "/Users/Ada/Data"));
        assert!(!same_or_within("/Users/Ada/data", "/Users/Ada/Data"));
        assert!(same_or_within("/Users/Ada", "/"));
        assert!(same_or_within(r"c:\data\child", r"c:\data"));
        assert!(!same_or_within(r"c:\database", r"c:\data"));
    }
}
