use super::{assert_experiment_run_writable, open_connection, open_read_only_connection};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const BINDING_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptBindingRecord {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub default_folder_file_ref_id: Option<String>,
    pub default_manuscript_file_ref_id: Option<String>,
    pub current_file_ref_id: Option<String>,
    pub schema_version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingFileRefIdentityRecord {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub resource_kind: String,
    pub file_role: String,
    pub location_mode: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptBindingIdentityRecords {
    pub binding: Option<ManuscriptBindingRecord>,
    pub file_refs: Vec<BindingFileRefIdentityRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedManuscriptBindingState {
    pub exists: bool,
    pub updated_at: Option<String>,
    pub default_folder_file_ref_id: Option<String>,
    pub default_manuscript_file_ref_id: Option<String>,
    pub current_file_ref_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteManuscriptBindingInput {
    pub operation: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub binding_id: Option<String>,
    pub file_ref_id: Option<String>,
    pub default_folder_file_ref_id: Option<String>,
    pub default_manuscript_file_ref_id: Option<String>,
    pub expected: ExpectedManuscriptBindingState,
    pub occurred_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteManuscriptBindingResult {
    pub changed: bool,
    pub binding: Option<ManuscriptBindingRecord>,
}

pub(crate) fn read_manuscript_binding_record_in_connection(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: &str,
) -> Result<Option<ManuscriptBindingRecord>, String> {
    validate_owner_channel(owner_type, manuscript_channel)?;
    read_binding(connection, owner_type, owner_id, manuscript_channel)
}

fn read_binding(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: &str,
) -> Result<Option<ManuscriptBindingRecord>, String> {
    connection
        .query_row(
            "SELECT id, owner_type, owner_id, manuscript_channel,
                    default_folder_file_ref_id, default_manuscript_file_ref_id,
                    current_file_ref_id, schema_version, created_at, updated_at, deleted_at
             FROM manuscript_bindings
             WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel=?3
             LIMIT 1",
            params![owner_type, owner_id, manuscript_channel],
            |row| {
                Ok(ManuscriptBindingRecord {
                    id: row.get(0)?,
                    owner_type: row.get(1)?,
                    owner_id: row.get(2)?,
                    manuscript_channel: row.get(3)?,
                    default_folder_file_ref_id: row.get(4)?,
                    default_manuscript_file_ref_id: row.get(5)?,
                    current_file_ref_id: row.get(6)?,
                    schema_version: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    deleted_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("MANUSCRIPT_BINDING_READ_FAILED: {error}"))
}

fn read_file_ref(
    connection: &Connection,
    id: &str,
) -> Result<Option<BindingFileRefIdentityRecord>, String> {
    connection
        .query_row(
            "SELECT id, owner_type, owner_id, manuscript_channel,
                    resource_kind, file_role, location_mode, deleted_at
             FROM file_refs WHERE id=?1 LIMIT 1",
            [id],
            |row| {
                Ok(BindingFileRefIdentityRecord {
                    id: row.get(0)?,
                    owner_type: row.get(1)?,
                    owner_id: row.get(2)?,
                    manuscript_channel: row.get(3)?,
                    resource_kind: row.get(4)?,
                    file_role: row.get(5)?,
                    location_mode: row.get(6)?,
                    deleted_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("MANUSCRIPT_BINDING_FILE_REF_READ_FAILED: {error}"))
}

pub(crate) fn read_manuscript_binding_identity_records_in_connection(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: &str,
) -> Result<ManuscriptBindingIdentityRecords, String> {
    validate_owner_channel(owner_type, manuscript_channel)?;
    let binding = read_binding(connection, owner_type, owner_id, manuscript_channel)?;
    let mut file_refs = Vec::new();
    if let Some(binding) = &binding {
        for id in [
            binding.default_folder_file_ref_id.as_deref(),
            binding.default_manuscript_file_ref_id.as_deref(),
            binding.current_file_ref_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if file_refs
                .iter()
                .any(|file_ref: &BindingFileRefIdentityRecord| file_ref.id == id)
            {
                continue;
            }
            if let Some(file_ref) = read_file_ref(connection, id)? {
                file_refs.push(file_ref);
            }
        }
    }
    Ok(ManuscriptBindingIdentityRecords { binding, file_refs })
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_read_manuscript_binding_identity(
    app_handle: AppHandle,
    owner_type: String,
    owner_id: String,
    manuscript_channel: String,
) -> Result<ManuscriptBindingIdentityRecords, String> {
    let connection = open_read_only_connection(&app_handle)?;
    read_manuscript_binding_identity_records_in_connection(
        &connection,
        &owner_type,
        &owner_id,
        &manuscript_channel,
    )
}

fn validate_owner_channel(owner_type: &str, channel: &str) -> Result<(), String> {
    let supported_owner = matches!(
        owner_type,
        "experiment"
            | "experimentRun"
            | "literature"
            | "review"
            | "resultItem"
            | "finding"
            | "outputCandidate"
            | "outputGap"
            | "researchOutput"
    );
    if !supported_owner {
        return Err(format!(
            "MANUSCRIPT_BINDING_OWNER_UNSUPPORTED: {owner_type}"
        ));
    }
    let valid = if owner_type == "literature" {
        matches!(channel, "literature_outline" | "dedicated_notes")
    } else {
        channel == "primary"
    };
    if !valid {
        return Err(format!(
            "MANUSCRIPT_BINDING_CHANNEL_INVALID: {owner_type}/{channel}"
        ));
    }
    Ok(())
}

fn validate_file_ref_for_slot(
    connection: &Connection,
    binding: &ManuscriptBindingRecord,
    slot: &str,
    file_ref_id: &str,
) -> Result<(), String> {
    let file_ref = read_file_ref(connection, file_ref_id)?
        .ok_or_else(|| format!("MANUSCRIPT_BINDING_FILE_REF_NOT_FOUND: {slot}/{file_ref_id}"))?;
    if file_ref.deleted_at.is_some() {
        return Err(format!(
            "MANUSCRIPT_BINDING_FILE_REF_DELETED: {slot}/{file_ref_id}"
        ));
    }
    if file_ref.owner_type != binding.owner_type || file_ref.owner_id != binding.owner_id {
        return Err(format!(
            "MANUSCRIPT_BINDING_OWNER_MISMATCH: {slot}/{file_ref_id}"
        ));
    }
    if slot != "defaultFolderFileRefId" && file_ref.manuscript_channel != binding.manuscript_channel
    {
        return Err(format!(
            "MANUSCRIPT_BINDING_CHANNEL_MISMATCH: {slot}/{file_ref_id}"
        ));
    }
    match slot {
        "defaultFolderFileRefId" => {
            if file_ref.resource_kind != "folder" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_RESOURCE_KIND_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
            if file_ref.file_role != "defaultFolder" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_FILE_ROLE_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
            if file_ref.location_mode != "managed" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_LOCATION_MODE_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
        }
        "defaultManuscriptFileRefId" => {
            if file_ref.resource_kind != "file" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_RESOURCE_KIND_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
            if file_ref.file_role != "manuscript" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_FILE_ROLE_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
            if file_ref.location_mode != "managed" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_LOCATION_MODE_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
        }
        "currentFileRefId" => {
            if file_ref.resource_kind != "file" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_RESOURCE_KIND_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
            if file_ref.file_role != "manuscript" {
                return Err(format!(
                    "MANUSCRIPT_BINDING_FILE_ROLE_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
            if !matches!(file_ref.location_mode.as_str(), "managed" | "external") {
                return Err(format!(
                    "MANUSCRIPT_BINDING_LOCATION_MODE_MISMATCH: {slot}/{file_ref_id}"
                ));
            }
        }
        _ => return Err(format!("MANUSCRIPT_BINDING_SLOT_UNSUPPORTED: {slot}")),
    }
    Ok(())
}

fn validate_binding_references(
    connection: &Connection,
    binding: &ManuscriptBindingRecord,
) -> Result<(), String> {
    for (slot, id) in [
        (
            "defaultFolderFileRefId",
            binding.default_folder_file_ref_id.as_deref(),
        ),
        (
            "defaultManuscriptFileRefId",
            binding.default_manuscript_file_ref_id.as_deref(),
        ),
        ("currentFileRefId", binding.current_file_ref_id.as_deref()),
    ] {
        if let Some(id) = id {
            validate_file_ref_for_slot(connection, binding, slot, id)?;
        }
    }
    Ok(())
}

fn expected_state_matches(
    current: Option<&ManuscriptBindingRecord>,
    expected: &ExpectedManuscriptBindingState,
) -> bool {
    match (current, expected.exists) {
        (None, false) => true,
        (Some(binding), true) => {
            expected.updated_at.as_deref() == Some(binding.updated_at.as_str())
                && expected.default_folder_file_ref_id == binding.default_folder_file_ref_id
                && expected.default_manuscript_file_ref_id == binding.default_manuscript_file_ref_id
                && expected.current_file_ref_id == binding.current_file_ref_id
        }
        _ => false,
    }
}

fn require_binding_id(input: &WriteManuscriptBindingInput) -> Result<String, String> {
    input
        .binding_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "MANUSCRIPT_BINDING_ID_REQUIRED".to_string())
}

fn require_file_ref_id(input: &WriteManuscriptBindingInput) -> Result<String, String> {
    input
        .file_ref_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "MANUSCRIPT_BINDING_FILE_REF_ID_REQUIRED".to_string())
}

pub(crate) fn write_manuscript_binding_in_connection(
    connection: &mut Connection,
    input: &WriteManuscriptBindingInput,
) -> Result<WriteManuscriptBindingResult, String> {
    validate_owner_channel(&input.owner_type, &input.manuscript_channel)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("MANUSCRIPT_BINDING_TRANSACTION_BEGIN_FAILED: {error}"))?;
    if input.owner_type == "experimentRun" {
        assert_experiment_run_writable(&transaction, &input.owner_id)?;
    }
    let existing = read_binding(
        &transaction,
        &input.owner_type,
        &input.owner_id,
        &input.manuscript_channel,
    )?;
    if !expected_state_matches(existing.as_ref(), &input.expected) {
        return Err("MANUSCRIPT_BINDING_STALE_EXPECTED_STATE".to_string());
    }

    let mut changed = false;
    match input.operation.as_str() {
        "ensure" => {
            if existing.is_none() {
                let id = require_binding_id(input)?;
                transaction
                    .execute(
                        "INSERT INTO manuscript_bindings (
                           id, owner_type, owner_id, manuscript_channel,
                           default_folder_file_ref_id, default_manuscript_file_ref_id,
                           current_file_ref_id, schema_version, created_at, updated_at, deleted_at
                         ) VALUES (?1,?2,?3,?4,NULL,NULL,NULL,?5,?6,?6,NULL)",
                        params![
                            id,
                            input.owner_type,
                            input.owner_id,
                            input.manuscript_channel,
                            BINDING_SCHEMA_VERSION,
                            input.occurred_at
                        ],
                    )
                    .map_err(|error| format!("MANUSCRIPT_BINDING_CREATE_FAILED: {error}"))?;
                changed = true;
            }
        }
        "upsertDefaults" => {
            let folder_id = input
                .default_folder_file_ref_id
                .clone()
                .ok_or_else(|| "MANUSCRIPT_BINDING_DEFAULT_FOLDER_REQUIRED".to_string())?;
            let manuscript_id = input
                .default_manuscript_file_ref_id
                .clone()
                .ok_or_else(|| "MANUSCRIPT_BINDING_DEFAULT_MANUSCRIPT_REQUIRED".to_string())?;
            let mut next = existing.clone().unwrap_or(ManuscriptBindingRecord {
                id: require_binding_id(input)?,
                owner_type: input.owner_type.clone(),
                owner_id: input.owner_id.clone(),
                manuscript_channel: input.manuscript_channel.clone(),
                default_folder_file_ref_id: None,
                default_manuscript_file_ref_id: None,
                current_file_ref_id: None,
                schema_version: BINDING_SCHEMA_VERSION,
                created_at: input.occurred_at.clone(),
                updated_at: input.occurred_at.clone(),
                deleted_at: None,
            });
            if next
                .default_folder_file_ref_id
                .as_ref()
                .is_some_and(|id| id != &folder_id)
                || next
                    .default_manuscript_file_ref_id
                    .as_ref()
                    .is_some_and(|id| id != &manuscript_id)
            {
                return Err("MANUSCRIPT_BINDING_DEFAULT_IDENTITY_CONFLICT".to_string());
            }
            next.default_folder_file_ref_id = Some(folder_id);
            next.default_manuscript_file_ref_id = Some(manuscript_id.clone());
            if next.current_file_ref_id.is_none() {
                next.current_file_ref_id = Some(manuscript_id);
            }
            validate_binding_references(&transaction, &next)?;
            if let Some(previous) = &existing {
                if previous.default_folder_file_ref_id != next.default_folder_file_ref_id
                    || previous.default_manuscript_file_ref_id
                        != next.default_manuscript_file_ref_id
                    || previous.current_file_ref_id != next.current_file_ref_id
                {
                    let count = transaction
                        .execute(
                            "UPDATE manuscript_bindings SET
                               default_folder_file_ref_id=?1,
                               default_manuscript_file_ref_id=?2,
                               current_file_ref_id=?3, updated_at=?4
                             WHERE id=?5 AND updated_at=?6 AND deleted_at IS NULL",
                            params![
                                next.default_folder_file_ref_id,
                                next.default_manuscript_file_ref_id,
                                next.current_file_ref_id,
                                input.occurred_at,
                                previous.id,
                                previous.updated_at
                            ],
                        )
                        .map_err(|error| format!("MANUSCRIPT_BINDING_UPDATE_FAILED: {error}"))?;
                    if count != 1 {
                        return Err("MANUSCRIPT_BINDING_STALE_EXPECTED_STATE".to_string());
                    }
                    changed = true;
                }
            } else {
                transaction
                    .execute(
                        "INSERT INTO manuscript_bindings (
                           id, owner_type, owner_id, manuscript_channel,
                           default_folder_file_ref_id, default_manuscript_file_ref_id,
                           current_file_ref_id, schema_version, created_at, updated_at, deleted_at
                         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,NULL)",
                        params![
                            next.id,
                            next.owner_type,
                            next.owner_id,
                            next.manuscript_channel,
                            next.default_folder_file_ref_id,
                            next.default_manuscript_file_ref_id,
                            next.current_file_ref_id,
                            BINDING_SCHEMA_VERSION,
                            input.occurred_at
                        ],
                    )
                    .map_err(|error| format!("MANUSCRIPT_BINDING_CREATE_FAILED: {error}"))?;
                changed = true;
            }
        }
        "setDefaultFolder"
        | "setDefaultManuscript"
        | "setCurrent"
        | "clearDefaultFolder"
        | "clearDefaultManuscript"
        | "clearCurrent" => {
            let previous = existing
                .as_ref()
                .ok_or_else(|| "MANUSCRIPT_BINDING_NOT_FOUND".to_string())?;
            let mut next = previous.clone();
            match input.operation.as_str() {
                "setDefaultFolder" => {
                    next.default_folder_file_ref_id = Some(require_file_ref_id(input)?)
                }
                "setDefaultManuscript" => {
                    next.default_manuscript_file_ref_id = Some(require_file_ref_id(input)?)
                }
                "setCurrent" => next.current_file_ref_id = Some(require_file_ref_id(input)?),
                "clearDefaultFolder" => next.default_folder_file_ref_id = None,
                "clearDefaultManuscript" => next.default_manuscript_file_ref_id = None,
                "clearCurrent" => next.current_file_ref_id = None,
                _ => unreachable!(),
            }
            validate_binding_references(&transaction, &next)?;
            if next.default_folder_file_ref_id != previous.default_folder_file_ref_id
                || next.default_manuscript_file_ref_id != previous.default_manuscript_file_ref_id
                || next.current_file_ref_id != previous.current_file_ref_id
            {
                let count = transaction
                    .execute(
                        "UPDATE manuscript_bindings SET
                           default_folder_file_ref_id=?1,
                           default_manuscript_file_ref_id=?2,
                           current_file_ref_id=?3, updated_at=?4
                         WHERE id=?5 AND updated_at=?6 AND deleted_at IS NULL",
                        params![
                            next.default_folder_file_ref_id,
                            next.default_manuscript_file_ref_id,
                            next.current_file_ref_id,
                            input.occurred_at,
                            previous.id,
                            previous.updated_at
                        ],
                    )
                    .map_err(|error| format!("MANUSCRIPT_BINDING_UPDATE_FAILED: {error}"))?;
                if count != 1 {
                    return Err("MANUSCRIPT_BINDING_STALE_EXPECTED_STATE".to_string());
                }
                changed = true;
            }
        }
        "remove" => {
            if let Some(previous) = &existing {
                if input.owner_type == "experimentRun" {
                    let recovery_count: i64 = transaction
                        .query_row(
                            "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries
                             WHERE run_id=?1 AND manuscript_channel=?2
                               AND phase NOT IN ('resolved','cancelled_safe')",
                            params![input.owner_id, input.manuscript_channel],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("RUN_SWITCH_RECOVERY_PERSIST_FAILED: {error}"))?;
                    if recovery_count > 0 {
                        return Err("RUN_SWITCH_RECOVERY_BLOCKED".to_string());
                    }
                }
                let count = transaction
                    .execute(
                        "DELETE FROM manuscript_bindings WHERE id=?1 AND updated_at=?2",
                        params![previous.id, previous.updated_at],
                    )
                    .map_err(|error| format!("MANUSCRIPT_BINDING_REMOVE_FAILED: {error}"))?;
                if count != 1 {
                    return Err("MANUSCRIPT_BINDING_STALE_EXPECTED_STATE".to_string());
                }
                changed = true;
            }
        }
        operation => {
            return Err(format!(
                "MANUSCRIPT_BINDING_OPERATION_UNSUPPORTED: {operation}"
            ))
        }
    }

    let binding = read_binding(
        &transaction,
        &input.owner_type,
        &input.owner_id,
        &input.manuscript_channel,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("MANUSCRIPT_BINDING_TRANSACTION_COMMIT_FAILED: {error}"))?;
    Ok(WriteManuscriptBindingResult { changed, binding })
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_write_manuscript_binding(
    app_handle: AppHandle,
    input: WriteManuscriptBindingInput,
) -> Result<WriteManuscriptBindingResult, String> {
    let mut connection = open_connection(&app_handle)?;
    write_manuscript_binding_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_is_file_ref_referenced_by_binding(
    app_handle: AppHandle,
    file_ref_id: String,
) -> Result<bool, String> {
    let connection = open_read_only_connection(&app_handle)?;
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM manuscript_bindings
               WHERE deleted_at IS NULL AND (
                 default_folder_file_ref_id=?1 OR
                 default_manuscript_file_ref_id=?1 OR
                 current_file_ref_id=?1
               )
             )",
            [file_ref_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("MANUSCRIPT_BINDING_REFERENCE_READ_FAILED: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE file_refs (
                   id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
                   manuscript_channel TEXT NOT NULL, resource_kind TEXT NOT NULL,
                   file_role TEXT NOT NULL, location_mode TEXT NOT NULL, deleted_at TEXT
                 );
                 CREATE TABLE manuscript_bindings (
                   id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
                   manuscript_channel TEXT NOT NULL, default_folder_file_ref_id TEXT,
                   default_manuscript_file_ref_id TEXT, current_file_ref_id TEXT,
                   schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL, deleted_at TEXT,
                   UNIQUE(owner_type,owner_id,manuscript_channel),
                   FOREIGN KEY(default_folder_file_ref_id) REFERENCES file_refs(id),
                   FOREIGN KEY(default_manuscript_file_ref_id) REFERENCES file_refs(id),
                   FOREIGN KEY(current_file_ref_id) REFERENCES file_refs(id)
                 );
                 CREATE TABLE experiment_run_manuscript_switch_recoveries (
                   run_id TEXT, manuscript_channel TEXT, phase TEXT
                 );",
            )
            .expect("create test schema");
        connection
    }

    fn seed_refs(connection: &Connection) {
        connection
            .execute_batch(
                "INSERT INTO file_refs VALUES
                 ('folder','review','owner','primary','folder','defaultFolder','managed',NULL),
                 ('default','review','owner','primary','file','manuscript','managed',NULL),
                 ('default-two','review','owner','primary','file','manuscript','managed',NULL),
                 ('external','review','owner','primary','file','manuscript','external',NULL),
                 ('deleted','review','owner','primary','file','manuscript','managed','2026-01-01');",
            )
            .expect("seed refs");
    }

    fn absent_expected() -> ExpectedManuscriptBindingState {
        ExpectedManuscriptBindingState {
            exists: false,
            updated_at: None,
            default_folder_file_ref_id: None,
            default_manuscript_file_ref_id: None,
            current_file_ref_id: None,
        }
    }

    fn input(
        operation: &str,
        expected: ExpectedManuscriptBindingState,
    ) -> WriteManuscriptBindingInput {
        WriteManuscriptBindingInput {
            operation: operation.into(),
            owner_type: "review".into(),
            owner_id: "owner".into(),
            manuscript_channel: "primary".into(),
            binding_id: Some("binding".into()),
            file_ref_id: None,
            default_folder_file_ref_id: None,
            default_manuscript_file_ref_id: None,
            expected,
            occurred_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn expected(binding: &ManuscriptBindingRecord) -> ExpectedManuscriptBindingState {
        ExpectedManuscriptBindingState {
            exists: true,
            updated_at: Some(binding.updated_at.clone()),
            default_folder_file_ref_id: binding.default_folder_file_ref_id.clone(),
            default_manuscript_file_ref_id: binding.default_manuscript_file_ref_id.clone(),
            current_file_ref_id: binding.current_file_ref_id.clone(),
        }
    }

    #[test]
    fn read_is_owner_channel_scoped_and_path_free() {
        let connection = setup();
        seed_refs(&connection);
        connection
            .execute_batch(
                "INSERT INTO manuscript_bindings VALUES
             ('binding','review','owner','primary','folder','default','default',2,'t','t',NULL);",
            )
            .expect("seed binding");
        let result = read_manuscript_binding_identity_records_in_connection(
            &connection,
            "review",
            "owner",
            "primary",
        )
        .expect("read identity records");
        assert_eq!(
            result
                .binding
                .expect("binding")
                .current_file_ref_id
                .as_deref(),
            Some("default")
        );
        assert_eq!(result.file_refs.len(), 2);
    }

    #[test]
    fn upsert_defaults_and_set_current_use_cas_and_readback() {
        let mut connection = setup();
        seed_refs(&connection);
        let mut create = input("upsertDefaults", absent_expected());
        create.default_folder_file_ref_id = Some("folder".into());
        create.default_manuscript_file_ref_id = Some("default".into());
        let created = write_manuscript_binding_in_connection(&mut connection, &create)
            .expect("create binding");
        let binding = created.binding.expect("binding readback");
        assert_eq!(binding.current_file_ref_id.as_deref(), Some("default"));

        let mut set_current = input("setCurrent", expected(&binding));
        set_current.file_ref_id = Some("external".into());
        set_current.occurred_at = "2026-01-02T00:00:00Z".into();
        let changed = write_manuscript_binding_in_connection(&mut connection, &set_current)
            .expect("set current");
        let readback = changed.binding.expect("updated readback");
        assert_eq!(readback.current_file_ref_id.as_deref(), Some("external"));
        assert_eq!(
            readback.default_manuscript_file_ref_id.as_deref(),
            Some("default")
        );

        let stale = write_manuscript_binding_in_connection(&mut connection, &set_current)
            .expect_err("stale state must fail");
        assert_eq!(stale, "MANUSCRIPT_BINDING_STALE_EXPECTED_STATE");
    }

    #[test]
    fn invalid_or_deleted_reference_rolls_back_without_partial_state() {
        let mut connection = setup();
        seed_refs(&connection);
        let mut create = input("upsertDefaults", absent_expected());
        create.default_folder_file_ref_id = Some("folder".into());
        create.default_manuscript_file_ref_id = Some("default".into());
        let binding = write_manuscript_binding_in_connection(&mut connection, &create)
            .expect("create")
            .binding
            .expect("binding");

        let mut invalid = input("setCurrent", expected(&binding));
        invalid.file_ref_id = Some("deleted".into());
        invalid.occurred_at = "2026-01-02T00:00:00Z".into();
        let error = write_manuscript_binding_in_connection(&mut connection, &invalid)
            .expect_err("deleted ref must fail");
        assert!(error.starts_with("MANUSCRIPT_BINDING_FILE_REF_DELETED"));
        let after = read_binding(&connection, "review", "owner", "primary")
            .expect("read after rollback")
            .expect("binding after rollback");
        assert_eq!(after.current_file_ref_id.as_deref(), Some("default"));
        assert_eq!(after.updated_at, binding.updated_at);
    }

    #[test]
    fn competing_create_is_cas_protected_and_never_duplicates_binding() {
        let mut connection = setup();
        seed_refs(&connection);
        let mut first = input("upsertDefaults", absent_expected());
        first.default_folder_file_ref_id = Some("folder".into());
        first.default_manuscript_file_ref_id = Some("default".into());
        write_manuscript_binding_in_connection(&mut connection, &first).expect("first create wins");

        let mut stale_competitor = input("upsertDefaults", absent_expected());
        stale_competitor.binding_id = Some("binding-competitor".into());
        stale_competitor.default_folder_file_ref_id = Some("folder".into());
        stale_competitor.default_manuscript_file_ref_id = Some("default".into());
        let error = write_manuscript_binding_in_connection(&mut connection, &stale_competitor)
            .expect_err("stale competing create must fail");
        assert_eq!(error, "MANUSCRIPT_BINDING_STALE_EXPECTED_STATE");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_bindings
                 WHERE owner_type='review' AND owner_id='owner' AND manuscript_channel='primary'",
                [],
                |row| row.get(0),
            )
            .expect("count bindings");
        assert_eq!(count, 1);
    }

    #[test]
    fn default_current_clear_and_controlled_remove_remain_independent() {
        let mut connection = setup();
        seed_refs(&connection);
        let mut create = input("upsertDefaults", absent_expected());
        create.default_folder_file_ref_id = Some("folder".into());
        create.default_manuscript_file_ref_id = Some("default".into());
        let initial = write_manuscript_binding_in_connection(&mut connection, &create)
            .expect("create")
            .binding
            .expect("initial binding");

        let mut set_current = input("setCurrent", expected(&initial));
        set_current.file_ref_id = Some("external".into());
        set_current.occurred_at = "2026-01-02T00:00:00Z".into();
        let external_current =
            write_manuscript_binding_in_connection(&mut connection, &set_current)
                .expect("set external current")
                .binding
                .expect("external current binding");
        assert_eq!(
            external_current.current_file_ref_id.as_deref(),
            Some("external")
        );
        assert_eq!(
            external_current.default_manuscript_file_ref_id.as_deref(),
            Some("default")
        );

        let mut set_default = input("setDefaultManuscript", expected(&external_current));
        set_default.file_ref_id = Some("default-two".into());
        set_default.occurred_at = "2026-01-03T00:00:00Z".into();
        let new_default = write_manuscript_binding_in_connection(&mut connection, &set_default)
            .expect("set default")
            .binding
            .expect("new default binding");
        assert_eq!(
            new_default.default_manuscript_file_ref_id.as_deref(),
            Some("default-two")
        );
        assert_eq!(new_default.current_file_ref_id.as_deref(), Some("external"));

        let mut clear_current = input("clearCurrent", expected(&new_default));
        clear_current.occurred_at = "2026-01-04T00:00:00Z".into();
        let cleared = write_manuscript_binding_in_connection(&mut connection, &clear_current)
            .expect("clear current")
            .binding
            .expect("cleared binding");
        assert_eq!(cleared.current_file_ref_id, None);
        assert_eq!(
            cleared.default_folder_file_ref_id.as_deref(),
            Some("folder")
        );
        assert_eq!(
            cleared.default_manuscript_file_ref_id.as_deref(),
            Some("default-two")
        );

        let mut remove = input("remove", expected(&cleared));
        remove.occurred_at = "2026-01-05T00:00:00Z".into();
        let removed = write_manuscript_binding_in_connection(&mut connection, &remove)
            .expect("controlled remove");
        assert!(removed.changed);
        assert!(removed.binding.is_none());
        let file_ref_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM file_refs", [], |row| row.get(0))
            .expect("count FileRefs");
        assert_eq!(
            file_ref_count, 5,
            "Binding remove must not mutate FileRef metadata"
        );
    }
}
