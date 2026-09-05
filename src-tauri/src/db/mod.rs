pub(crate) mod schema;
pub(crate) mod ai_durable_foundation;
pub(crate) mod representative_runs;
pub(crate) mod manuscript_save_as_operation;
pub(crate) mod manuscript_save_as_candidate_custody;
pub(crate) mod manuscript_save_as_finalization;
pub(crate) mod experiment_manuscript_switch;
pub(crate) mod experiment_manuscript_switch_recovery;
pub(crate) mod experiment_six_field_schema;
pub(crate) mod experiment_planning_relation;
pub(crate) mod formal_switch_recovery;
// F1 deliberately seals the new foundation from production owners until successor admission.
#[allow(dead_code)]
pub(crate) mod formal_switch_foundation;
// F2-1 implements the sealed shared execution foundation. It remains
// crate-private; F2-2 reaches it only through the typed reference-owner bridge.
#[allow(dead_code)]
pub(crate) mod formal_switch_execution;
pub(crate) mod formal_switch_reference_owner_bridge;
pub(crate) mod experiment_run_lifecycle;
pub mod experiment_run_file_ref_cleanup;
pub(crate) mod experiment_run_manuscript_switch;
pub(crate) mod experiment_run_manuscript_switch_recovery;
pub(crate) mod manuscript_binding;
pub(crate) mod manuscript_provisioning_operation_state;
pub(crate) mod review_lifecycle_action;
pub(crate) mod review_permanent_delete;
pub(crate) mod review_structured_state;
#[cfg(test)]
mod experiment_run_manuscript_switch_tests;
#[cfg(test)]
mod experiment_run_manuscript_switch_recovery_tests;
#[cfg(test)]
mod experiment_manuscript_switch_recovery_tests;
#[cfg(test)]
mod formal_switch_foundation_tests;
#[cfg(test)]
mod formal_switch_execution_tests;
#[cfg(test)]
mod manuscript_provisioning_operation_state_tests;
#[cfg(test)]
mod manuscript_provisioning_v40_migration_fixture;
#[cfg(test)]
mod manuscript_provisioning_commit_failure_test_support;
#[cfg(test)]
pub(crate) use manuscript_provisioning_commit_failure_test_support::arm_native_commit_hook_abort;
#[cfg(test)]
mod manuscript_provisioning_step_progress_tests;
#[cfg(test)]
mod manuscript_provisioning_step_progress_p4_2c_tests;
#[cfg(test)]
mod manuscript_provisioning_step_progress_p4_2e_tests;
#[cfg(test)]
mod review_lifecycle_action_tests;

use rusqlite::{
    params, params_from_iter, types::Value as SQLiteValue, types::ValueRef, Connection,
    OpenFlags, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DATABASE_FILE_NAME: &str = "labpod.sqlite3";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRuntimeIdentity {
    source: &'static str,
    database_path: String,
    database_file_name: &'static str,
}

pub(crate) fn database_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("failed to create app data directory: {error}"))?;

    Ok(app_data_dir.join(DATABASE_FILE_NAME))
}

#[tauri::command]
pub fn db_get_runtime_identity(app_handle: AppHandle) -> Result<DatabaseRuntimeIdentity, String> {
    let path = database_path(&app_handle)?;
    Ok(DatabaseRuntimeIdentity {
        source: "sqlite",
        database_path: path.to_string_lossy().into_owned(),
        database_file_name: DATABASE_FILE_NAME,
    })
}

fn open_database_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create database directory: {error}"))?;
    }

    Connection::open(path).map_err(|error| {
        format!(
            "code=DB_INITIALIZATION_FAILED stage=open version={} table=none retryable=false database_path={} message={error}",
            schema::CURRENT_SCHEMA_VERSION,
            path.display()
        )
    })
}

pub(crate) fn open_connection(app_handle: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app_handle).map_err(|error| {
        format!(
            "code=DB_INITIALIZATION_FAILED stage=path version={} table=none retryable=false database_path=unresolved message={error}",
            schema::CURRENT_SCHEMA_VERSION
        )
    })?;
    let connection = open_database_at(&path)?;

    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| {
            format!(
                "code=DB_INITIALIZATION_FAILED stage=pragma version={} table=none retryable=false database_path={} message={error}",
                schema::CURRENT_SCHEMA_VERSION,
                path.display()
            )
        })?;

    Ok(connection)
}

fn open_read_only_connection(app_handle: &AppHandle) -> Result<Connection, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("MANUSCRIPT_BINDING_READ_FAILED: {error}"))?;
    let path = app_data_dir.join(DATABASE_FILE_NAME);
    if !path.is_file() {
        return Err(format!(
            "MANUSCRIPT_BINDING_READ_FAILED: database not found at {}",
            path.display()
        ));
    }
    Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
        format!(
            "MANUSCRIPT_BINDING_READ_FAILED: database_path={} message={error}",
            path.display()
        )
    })
}

fn initialize_database_at(path: &Path) -> Result<(), String> {
    let connection = open_database_at(path)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| {
            format!(
                "code=DB_INITIALIZATION_FAILED stage=pragma version={} table=none retryable=false database_path={} message={error}",
                schema::CURRENT_SCHEMA_VERSION,
                path.display()
            )
        })?;
    schema::run_migrations(&connection)
        .map_err(|error| format!("{error} database_path={}", path.display()))?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn initialize_test_database_at(path: &Path) -> Result<(), String> {
    initialize_database_at(path)
}

pub fn initialize_database(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let path = database_path(app_handle).map_err(|error| {
        format!(
            "code=DB_INITIALIZATION_FAILED stage=path version={} table=none retryable=false database_path=unresolved message={error}",
            schema::CURRENT_SCHEMA_VERSION
        )
    })?;
    eprintln!("SQLite database path: {}", path.display());
    initialize_database_at(&path)?;
    Ok(path)
}

fn allowed_columns(table_name: &str) -> Option<&'static [&'static str]> {
    match table_name {
        "milestones" => Some(&[
            "id",
            "project_id",
            "title",
            "description",
            "time_scale",
            "start_date",
            "end_date",
            "expected_output",
            "status",
            "progress",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "tasks" => Some(&[
            "id",
            "project_id",
            "milestone_id",
            "title",
            "description",
            "task_type",
            "priority",
            "status",
            "start_date",
            "due_date",
            "estimated_hours",
            "actual_hours",
            "acceptance_criteria",
            "blocker",
            "review",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "experiments" => Some(&[
            "id",
            "project_id",
            "route_id",
            "task_id",
            "title",
            "purpose_and_question",
            "condition_summary",
            "method_summary",
            "conclusion_and_next_steps",
            "other",
            "status",
            "rating",
            "tags",
            "usable_for_paper",
            "usable_for_report",
            "usable_for_patent",
            "schema_version",
            "source",
            "condition_items",
            "method_steps",
            "variables",
            "materials",
            "custom_fields",
            "legacy",
            "migrated_from_legacy",
            "experiment_name",
            "machine_object",
            "fault_type",
            "speed",
            "load",
            "sensor_config",
            "data_path",
            "sampling_rate",
            "duration",
            "result_summary",
            "problem_notes",
            "next_action",
            "created_local_date",
            "created_local_time",
            "workspace_title_identity",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "experiment_runs" => Some(&[
            "id",
            "experiment_id",
            "project_id",
            "route_id",
            "task_id",
            "title",
            "run_label",
            "status",
            "started_at",
            "completed_at",
            "condition_summary",
            "variable_parameter_summary",
            "method_summary",
            "result_summary",
            "conclusion",
            "summary_other",
            "rating",
            "tags",
            "schema_version",
            "source",
            "condition_items",
            "method_steps",
            "variables",
            "materials",
            "custom_fields",
            "legacy",
            "created_local_date",
            "created_local_time",
            "workspace_title_identity",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "result_metrics" => Some(&[
            "id",
            "run_id",
            "experiment_id",
            "name",
            "value",
            "unit",
            "description",
            "metric_group",
            "higher_is_better",
            "value_type",
            "baseline_value",
            "target_value",
            "order_index",
            "tags",
            "schema_version",
            "source",
            "custom_fields",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "file_refs" => Some(&[
            "id",
            "owner_type",
            "owner_id",
            "manuscript_channel",
            "resource_kind",
            "file_role",
            "location_mode",
            "file_type",
            "path",
            "path_identity_key",
            "title",
            "description",
            "candidate_request_id",
            "candidate_occurred_at",
            "schema_version",
            "source",
            "custom_fields",
            "created_at",
            "updated_at",
            "deleted_at",
            "revision",
            "permanent_delete_status",
            "permanent_delete_lifecycle_action_id",
            "permanently_deleted_at",
        ]),
        "manuscript_bindings" => Some(&[
            "id",
            "owner_type",
            "owner_id",
            "manuscript_channel",
            "default_folder_file_ref_id",
            "default_manuscript_file_ref_id",
            "current_file_ref_id",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
            "revision",
        ]),
        "result_items" => Some(&[
            "id",
            "project_id",
            "route_id",
            "task_id",
            "experiment_id",
            "experiment_run_id",
            "source_type",
            "source_id",
            "title",
            "result_type",
            "status",
            "structured_summary",
            "summary",
            "value_json",
            "unit",
            "file_ref_id",
            "tags",
            "is_asset",
            "asset_marked_at",
            "asset_reason",
            "asset_quality",
            "usable_for",
            "schema_version",
            "custom_fields",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "findings" => Some(&[
            "id",
            "project_id",
            "route_id",
            "task_id",
            "experiment_id",
            "title",
            "summary",
            "status",
            "structured_summary",
            "finding_type",
            "confidence",
            "maturity",
            "tags",
            "schema_version",
            "custom_fields",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "output_candidates" => Some(&[
            "id",
            "project_id",
            "route_id",
            "task_id",
            "title",
            "description",
            "candidate_type",
            "status",
            "structured_summary",
            "maturity",
            "priority",
            "tags",
            "schema_version",
            "custom_fields",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "output_gaps" => Some(&[
            "id",
            "project_id",
            "title",
            "description",
            "gap_type",
            "status",
            "structured_summary",
            "priority",
            "related_task_id",
            "related_route_node_id",
            "resolved_at",
            "schema_version",
            "custom_fields",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "output_gap_feedback_cards" => Some(&[
            "id",
            "project_id",
            "output_gap_id",
            "card_type",
            "title",
            "description",
            "status",
            "priority",
            "archived_at",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "research_trace_event_preferences" => Some(&[
            "id",
            "project_id",
            "target_type",
            "target_id",
            "visibility",
            "note",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "output_conversion_relations" => Some(&[
            "id",
            "project_id",
            "source_type",
            "source_id",
            "target_type",
            "target_id",
            "relation_type",
            "note",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "output_source_links" => Some(&[
            "id",
            "project_id",
            "owner_type",
            "owner_id",
            "source_type",
            "source_id",
            "source_title_snapshot",
            "source_summary_snapshot",
            "source_note",
            "relation_type",
            "order_index",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "literatures" => Some(&[
            "id",
            "title",
            "authors",
            "year",
            "venue",
            "publication_type",
            "abstract",
            "keywords",
            "doi",
            "url",
            "pdf_path",
            "local_file_path",
            "bibtex_key",
            "citation_key",
            "external_ids",
            "reading_status",
            "importance",
            "primary_project_id",
            "tags",
            "is_archived",
            "archived_at",
            "schema_version",
            "source",
            "custom_fields",
            "ai_metadata",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "literature_links" => Some(&[
            "id",
            "literature_id",
            "target_type",
            "target_id",
            "project_id",
            "relation_type",
            "role",
            "description",
            "note",
            "strength",
            "confidence",
            "schema_version",
            "tags",
            "custom_fields",
            "ai_metadata",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "outputs" => Some(&[
            "id",
            "project_id",
            "task_id",
            "experiment_id",
            "output_name",
            "output_type",
            "status",
            "structured_summary",
            "usable_for_paper",
            "description",
            "provenance",
            "created_at",
            "updated_at",
            "deleted_at",
        ]),
        "operation_logs" => Some(&[
            "id",
            "operation_type",
            "source",
            "module",
            "status",
            "risk_level",
            "target",
            "summary",
            "related_entities",
            "impact_summary",
            "confirmation",
            "feedback",
            "warnings",
            "errors",
            "skipped",
            "is_recoverable",
            "recycle_entry_id",
            "actor_id",
            "actor_label",
            "refresh_keys",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
            "lifecycle_action_id",
            "effect_type",
        ]),
        "recycle_entries" => Some(&[
            "id",
            "entity_type",
            "entity_id",
            "title",
            "summary",
            "module",
            "entity_deleted_at",
            "deleted_by",
            "operation_log_id",
            "can_restore",
            "cannot_restore_reason",
            "known_impact_summary",
            "restore_status",
            "refresh_keys",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
            "created_by_lifecycle_action_id",
            "terminal_lifecycle_action_id",
            "revision",
            "terminal_at",
        ]),
        _ => None,
    }
}

fn validate_table_name(table_name: &str) -> Result<(), String> {
    allowed_columns(table_name)
        .map(|_| ())
        .ok_or_else(|| format!("unsupported SQLite table: {table_name}"))
}

fn is_valid_created_local_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day >= 1 && day <= max_day
}

fn is_valid_created_local_time(value: &str) -> bool {
    value.len() == 4
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value[0..2].parse::<u32>().is_ok_and(|hour| hour <= 23)
        && value[2..4].parse::<u32>().is_ok_and(|minute| minute <= 59)
}

fn validate_created_local_time_record(
    table_name: &str,
    record: &Map<String, Value>,
) -> Result<(), String> {
    if !["experiments", "experiment_runs"].contains(&table_name) {
        return Ok(());
    }
    record
        .get("created_local_date")
        .and_then(Value::as_str)
        .filter(|value| is_valid_created_local_date(value))
        .ok_or_else(|| format!("{table_name} created local date must be a valid YYYY-MM-DD value"))?;
    record
        .get("created_local_time")
        .and_then(Value::as_str)
        .filter(|value| is_valid_created_local_time(value))
        .ok_or_else(|| format!("{table_name} created local time must be a valid HHmm value"))?;
    Ok(())
}

fn validate_workspace_title_identity_record(
    table_name: &str,
    record: &Map<String, Value>,
) -> Result<(), String> {
    if !matches!(table_name, "experiments" | "experiment_runs") {
        return Ok(());
    }
    let identity = record
        .get("workspace_title_identity")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{table_name} workspace-title identity is required"))?;
    let reserved_windows_slug = identity
        .strip_prefix('_')
        .filter(|value| !value.contains('_'))
        .is_some_and(is_windows_reserved_path_name);
    if identity.chars().count() > 120
        || identity.trim() != identity
        || identity.to_lowercase() != identity
        || identity.ends_with('.')
        || identity.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        || identity.starts_with('-')
        || identity.ends_with('-')
        || identity.contains("--")
        || (identity.contains('_') && !reserved_windows_slug)
    {
        return Err(format!(
            "{table_name} workspace-title identity must already be frozen and safe"
        ));
    }
    Ok(())
}

fn is_windows_reserved_path_name(value: &str) -> bool {
    let base = value.split('.').next().unwrap_or(value);
    matches!(base, "con" | "prn" | "aux" | "nul")
        || base
            .strip_prefix("com")
            .or_else(|| base.strip_prefix("lpt"))
            .is_some_and(|suffix| {
                suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
            })
}

fn validate_created_local_time_value(table_name: &str, value: &Value) -> Result<(), String> {
    let record = value
        .as_object()
        .ok_or_else(|| format!("{table_name} SQLite row must be an object"))?;
    validate_created_local_time_record(table_name, record)?;
    validate_workspace_title_identity_record(table_name, record)
}

const EXPERIMENT_RUN_NOT_FOUND: &str = "EXPERIMENT_RUN_NOT_FOUND";
const EXPERIMENT_RUN_DELETED: &str = "EXPERIMENT_RUN_DELETED";
const EXPERIMENT_RUN_PARENT_NOT_FOUND: &str = "EXPERIMENT_RUN_PARENT_NOT_FOUND";
const EXPERIMENT_RUN_PARENT_DELETED: &str = "EXPERIMENT_RUN_PARENT_DELETED";
const EXPERIMENT_RUN_PROJECT_MISMATCH: &str = "EXPERIMENT_RUN_PROJECT_MISMATCH";

fn assert_experiment_run_parent_writable(
    connection: &Connection,
    experiment_id: &str,
    run_project_id: &str,
) -> Result<(), String> {
    let parent: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT project_id, deleted_at FROM experiments WHERE id = ?1",
            [experiment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to validate ExperimentRun parent state: {error}"))?;
    let Some((parent_project_id, parent_deleted_at)) = parent else {
        return Err(EXPERIMENT_RUN_PARENT_NOT_FOUND.to_string());
    };
    if parent_project_id != run_project_id {
        return Err(EXPERIMENT_RUN_PROJECT_MISMATCH.to_string());
    }
    if parent_deleted_at.is_some() {
        return Err(EXPERIMENT_RUN_PARENT_DELETED.to_string());
    }
    Ok(())
}

fn assert_experiment_run_writable(connection: &Connection, run_id: &str) -> Result<(), String> {
    let run: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT experiment_id, project_id, deleted_at FROM experiment_runs WHERE id = ?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("failed to validate ExperimentRun state: {error}"))?;
    let Some((experiment_id, project_id, deleted_at)) = run else {
        return Err(EXPERIMENT_RUN_NOT_FOUND.to_string());
    };
    if deleted_at.is_some() {
        return Err(EXPERIMENT_RUN_DELETED.to_string());
    }
    assert_experiment_run_parent_writable(connection, &experiment_id, &project_id)
}

fn owned_record_experiment_run_id(
    connection: &Connection,
    table_name: &str,
    id: &str,
) -> Result<Option<String>, String> {
    match table_name {
        "result_metrics" => connection
            .query_row("SELECT run_id FROM result_metrics WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(|error| format!("failed to resolve ResultMetric Run owner: {error}")),
        "file_refs" | "manuscript_bindings" => {
            let sql = format!("SELECT owner_type, owner_id FROM {table_name} WHERE id = ?1");
            let owner: Option<(String, String)> = connection
                .query_row(&sql, [id], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()
                .map_err(|error| format!("failed to resolve {table_name} owner: {error}"))?;
            Ok(owner.and_then(|(owner_type, owner_id)| {
                (owner_type == "experimentRun").then_some(owner_id)
            }))
        }
        _ => Ok(None),
    }
}

fn payload_experiment_run_id(table_name: &str, record: &Map<String, Value>) -> Option<String> {
    match table_name {
        "result_metrics" => record
            .get("run_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        "file_refs" | "manuscript_bindings"
            if record.get("owner_type").and_then(Value::as_str) == Some("experimentRun") =>
        {
            record
                .get("owner_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        _ => None,
    }
}

fn assert_owned_record_experiment_run_writable(
    connection: &Connection,
    table_name: &str,
    id: &str,
) -> Result<(), String> {
    if let Some(run_id) = owned_record_experiment_run_id(connection, table_name, id)? {
        assert_experiment_run_writable(connection, &run_id)?;
    }
    Ok(())
}

fn assert_payload_experiment_run_writable(
    connection: &Connection,
    table_name: &str,
    record: &Map<String, Value>,
) -> Result<(), String> {
    if let Some(run_id) = payload_experiment_run_id(table_name, record) {
        assert_experiment_run_writable(connection, &run_id)?;
    }
    Ok(())
}

fn json_to_sqlite_value(value: &Value) -> SQLiteValue {
    match value {
        Value::Null => SQLiteValue::Null,
        Value::Bool(value) => SQLiteValue::Integer(i64::from(*value)),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                SQLiteValue::Integer(value)
            } else if let Some(value) = value.as_f64() {
                SQLiteValue::Real(value)
            } else {
                SQLiteValue::Null
            }
        }
        Value::String(value) => SQLiteValue::Text(value.clone()),
        Value::Array(_) | Value::Object(_) => SQLiteValue::Text(value.to_string()),
    }
}

fn sqlite_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => Value::String(String::from_utf8_lossy(value).to_string()),
    }
}

fn query_records(
    connection: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare SQLite query: {error}"))?;
    let column_names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();

    let rows = statement
        .query_map(params, |row| {
            let mut record = Map::new();
            for (index, column_name) in column_names.iter().enumerate() {
                record.insert(
                    column_name.clone(),
                    sqlite_value_to_json(row.get_ref(index)?),
                );
            }
            Ok(Value::Object(record))
        })
        .map_err(|error| format!("failed to query SQLite records: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read SQLite records: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_count_records(app_handle: AppHandle, table_name: String) -> Result<i64, String> {
    validate_table_name(&table_name)?;
    let connection = open_connection(&app_handle)?;
    let sql = format!("SELECT COUNT(*) FROM {table_name}");

    connection
        .query_row(&sql, [], |row| row.get(0))
        .map_err(|error| format!("failed to count SQLite records: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_list_records(app_handle: AppHandle, table_name: String) -> Result<Vec<Value>, String> {
    validate_table_name(&table_name)?;
    let connection = open_connection(&app_handle)?;
    let sql =
        format!("SELECT * FROM {table_name} WHERE deleted_at IS NULL ORDER BY updated_at DESC");

    let records = query_records(&connection, &sql, &[])?;
    for record in &records {
        validate_created_local_time_value(&table_name, record)?;
    }
    Ok(records)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_get_record(
    app_handle: AppHandle,
    table_name: String,
    id: String,
) -> Result<Option<Value>, String> {
    validate_table_name(&table_name)?;
    let connection = open_connection(&app_handle)?;
    let sql = format!("SELECT * FROM {table_name} WHERE id = ?1 AND deleted_at IS NULL LIMIT 1");
    let mut records = query_records(&connection, &sql, &[&id])?;
    if let Some(record) = records.last() {
        validate_created_local_time_value(&table_name, record)?;
    }
    Ok(records.pop())
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_list_deleted_records(
    app_handle: AppHandle,
    table_name: String,
) -> Result<Vec<Value>, String> {
    validate_table_name(&table_name)?;
    let connection = open_connection(&app_handle)?;
    let sql =
        format!("SELECT * FROM {table_name} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");

    let records = query_records(&connection, &sql, &[])?;
    for record in &records {
        validate_created_local_time_value(&table_name, record)?;
    }
    Ok(records)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_get_deleted_record(
    app_handle: AppHandle,
    table_name: String,
    id: String,
) -> Result<Option<Value>, String> {
    validate_table_name(&table_name)?;
    let connection = open_connection(&app_handle)?;
    let sql =
        format!("SELECT * FROM {table_name} WHERE id = ?1 AND deleted_at IS NOT NULL LIMIT 1");
    let mut records = query_records(&connection, &sql, &[&id])?;
    if let Some(record) = records.last() {
        validate_created_local_time_value(&table_name, record)?;
    }
    Ok(records.pop())
}

fn save_record(
    connection: &Connection,
    table_name: &str,
    record: &Map<String, Value>,
) -> Result<(), String> {
    let allowed = allowed_columns(table_name)
        .ok_or_else(|| format!("unsupported SQLite table: {table_name}"))?;
    if !record.contains_key("id") {
        return Err("SQLite record payload must include id".to_string());
    }
    if matches!(table_name, "experiments" | "experiment_runs") {
        let id = record.get("id").and_then(Value::as_str).unwrap_or_default();
        let existing_deleted_at: Option<Option<String>> = connection
            .query_row(
                &format!("SELECT deleted_at FROM {table_name} WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("failed to validate Experiment lifecycle state: {error}"))?;
        if existing_deleted_at.flatten().is_some()
            || record.get("deleted_at").is_some_and(|value| !value.is_null())
        {
            return Err(
                "ordinary save cannot change Experiment lifecycle state; use experimentRunLifecycleService"
                    .to_string(),
            );
        }
    }
    validate_created_local_time_record(table_name, record)?;
    validate_workspace_title_identity_record(table_name, record)?;

    let record_id = record.get("id").and_then(Value::as_str).unwrap_or_default();
    if ["result_metrics", "file_refs", "manuscript_bindings"].contains(&table_name) {
        assert_owned_record_experiment_run_writable(connection, table_name, record_id)?;
        assert_payload_experiment_run_writable(connection, table_name, record)?;
    }

    if table_name == "experiments" {
        let id = record.get("id").and_then(Value::as_str).unwrap_or_default();
        let existing: Option<(String, String, String)> = connection
            .query_row(
                "SELECT created_local_date, created_local_time, workspace_title_identity
                 FROM experiments WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("failed to validate Experiment creation local time: {error}"))?;
        if let Some((date, time, workspace_title_identity)) = existing {
            if record.get("created_local_date").and_then(Value::as_str) != Some(date.as_str())
                || record.get("created_local_time").and_then(Value::as_str) != Some(time.as_str())
            {
                return Err(
                    "immutable Experiment creation-local-time column cannot be changed by ordinary save"
                        .to_string(),
                );
            }
            if record
                .get("workspace_title_identity")
                .and_then(Value::as_str)
                .is_some_and(|value| value != workspace_title_identity)
            {
                return Err(
                    "immutable workspace-title identity cannot be changed by ordinary Experiment save"
                        .to_string(),
                );
            }
        }
    }

    if table_name == "experiment_runs" {
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ExperimentRun SQLite payload must include a non-empty id".to_string())?;
        let experiment_id = record
            .get("experiment_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ExperimentRun parent experiment is required".to_string())?;
        let project_id = record
            .get("project_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ExperimentRun project must be fixed by its parent experiment".to_string())?;

        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM experiment_runs WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to inspect ExperimentRun write state: {error}"))?;
        if exists {
            assert_experiment_run_writable(connection, id)?;
        } else {
            assert_experiment_run_parent_writable(connection, experiment_id, project_id)?;
        }

        let existing: Option<(String, String, String, String, String)> = connection
            .query_row(
                "SELECT experiment_id, project_id, created_local_date, created_local_time,
                        workspace_title_identity
                 FROM experiment_runs WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|error| format!("failed to validate ExperimentRun identity: {error}"))?;
        if let Some((
            existing_experiment_id,
            existing_project_id,
            existing_date,
            existing_time,
            existing_workspace_title_identity,
        )) = existing
        {
            if existing_experiment_id != experiment_id || existing_project_id != project_id {
                return Err(
                    "immutable ExperimentRun column cannot be changed by ordinary save".to_string(),
                );
            }
            if record.get("created_local_date").and_then(Value::as_str)
                != Some(existing_date.as_str())
                || record.get("created_local_time").and_then(Value::as_str)
                    != Some(existing_time.as_str())
            {
                return Err(
                    "immutable ExperimentRun creation-local-time column cannot be changed by ordinary save"
                        .to_string(),
                );
            }
            if record
                .get("workspace_title_identity")
                .and_then(Value::as_str)
                .is_some_and(|value| value != existing_workspace_title_identity)
            {
                return Err(
                    "immutable workspace-title identity cannot be changed by ordinary ExperimentRun save"
                        .to_string(),
                );
            }
        }

    }

    let columns: Vec<&str> = allowed
        .iter()
        .copied()
        .filter(|column| record.contains_key(*column))
        .collect();

    let values: Vec<SQLiteValue> = columns
        .iter()
        .map(|column| json_to_sqlite_value(&record[*column]))
        .collect();

    let placeholders = vec!["?"; columns.len()].join(", ");
    let update_clause = columns
        .iter()
        .copied()
        .filter(|column| {
            *column != "id"
                && !(table_name == "experiment_runs"
                    && ["experiment_id", "project_id"].contains(column))
                && !(["experiments", "experiment_runs"].contains(&table_name)
                    && ["created_local_date", "created_local_time", "workspace_title_identity"]
                        .contains(column))
        })
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {table_name} ({}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {}",
        columns.join(", "),
        placeholders,
        update_clause
    );

    connection
        .execute(&sql, params_from_iter(values.iter()))
        .map_err(|error| format!("failed to save SQLite record: {error}"))?;

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_save_record(
    app_handle: AppHandle,
    table_name: String,
    record: Value,
) -> Result<(), String> {
    let record = record
        .as_object()
        .ok_or_else(|| "SQLite record payload must be an object".to_string())?;
    let connection = open_connection(&app_handle)?;
    save_record(&connection, &table_name, record)
}

fn insert_record_if_absent(
    connection: &Connection,
    table_name: &str,
    record: &Map<String, Value>,
) -> Result<bool, String> {
    if table_name != "literatures" {
        return Err("atomic create-if-absent is bounded to Literature creation".to_string());
    }
    let allowed = allowed_columns(table_name)
        .ok_or_else(|| format!("unsupported SQLite table: {table_name}"))?;
    let id = record
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Literature atomic create payload must include a non-empty id".to_string())?;
    if record.get("deleted_at").is_some_and(|value| !value.is_null()) {
        return Err("Literature atomic create cannot start deleted".to_string());
    }
    if id.len() > 200 {
        return Err("Literature atomic create identity is too long".to_string());
    }
    let columns: Vec<&str> = allowed
        .iter()
        .copied()
        .filter(|column| record.contains_key(*column))
        .collect();
    let values: Vec<SQLiteValue> = columns
        .iter()
        .map(|column| json_to_sqlite_value(&record[*column]))
        .collect();
    let placeholders = vec!["?"; columns.len()].join(", ");
    let sql = format!(
        "INSERT INTO {table_name} ({}) VALUES ({}) ON CONFLICT(id) DO NOTHING",
        columns.join(", "),
        placeholders
    );
    let changed = connection
        .execute(&sql, params_from_iter(values.iter()))
        .map_err(|error| format!("failed to atomically create Literature record: {error}"))?;
    Ok(changed == 1)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_insert_record_if_absent(
    app_handle: AppHandle,
    table_name: String,
    record: Value,
) -> Result<bool, String> {
    let record = record
        .as_object()
        .ok_or_else(|| "SQLite atomic create payload must be an object".to_string())?;
    let connection = open_connection(&app_handle)?;
    insert_record_if_absent(&connection, &table_name, record)
}

#[cfg(test)]
fn update_record(
    connection: &Connection,
    table_name: &str,
    id: &str,
    record: &Map<String, Value>,
) -> Result<bool, String> {
    update_record_with_expected_updated_at(connection, table_name, id, record, None)
}

fn update_record_with_expected_updated_at(
    connection: &Connection,
    table_name: &str,
    id: &str,
    record: &Map<String, Value>,
    expected_updated_at: Option<&str>,
) -> Result<bool, String> {
    let allowed = allowed_columns(table_name)
        .ok_or_else(|| format!("unsupported SQLite table: {table_name}"))?;

    if expected_updated_at.is_some()
        && table_name != "experiment_runs"
        && table_name != "literatures"
    {
        return Err(
            "atomic updatedAt guards are bounded to ExperimentRun and Literature updates"
                .to_string(),
        );
    }
    if expected_updated_at.is_some_and(|value| value.trim().is_empty()) {
        return Err("expectedUpdatedAt must be one exact non-empty instant".to_string());
    }
    if let Some(expected) = expected_updated_at {
        let next = record
            .get("updated_at")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "an atomic updatedAt write must provide one exact next updatedAt token".to_string()
            })?;
        if next <= expected {
            return Err("the atomic next updatedAt token must be strictly newer".to_string());
        }
    }

    if matches!(table_name, "experiments" | "experiment_runs")
        && record.contains_key("deleted_at")
    {
        return Err(
            "ordinary update cannot change Experiment lifecycle state; use experimentRunLifecycleService"
                .to_string(),
        );
    }

    if table_name == "experiment_runs" {
        assert_experiment_run_writable(connection, id)?;
    } else {
        assert_owned_record_experiment_run_writable(connection, table_name, id)?;
        assert_payload_experiment_run_writable(connection, table_name, record)?;
    }

    if table_name == "experiments" || table_name == "experiment_runs" {
        for column in ["created_local_date", "created_local_time"] {
            if record.contains_key(column) {
                return Err(format!(
                    "immutable creation-local-time column cannot be changed by ordinary update: {column}"
                ));
            }
        }
        if record.contains_key("workspace_title_identity") {
            return Err(
                "immutable workspace-title identity cannot be changed by ordinary update"
                    .to_string(),
            );
        }
    }

    if table_name == "experiment_runs" {
        for column in ["experiment_id", "project_id"] {
            if record.contains_key(column) {
                return Err(format!(
                    "immutable ExperimentRun column cannot be changed by ordinary update: {column}"
                ));
            }
        }
    }

    let columns: Vec<&str> = allowed
        .iter()
        .copied()
        .filter(|column| *column != "id" && record.contains_key(*column))
        .collect();
    if columns.is_empty() {
        return Err("SQLite update payload must include at least one mutable column".to_string());
    }

    let mut values: Vec<SQLiteValue> = columns
        .iter()
        .map(|column| json_to_sqlite_value(&record[*column]))
        .collect();
    values.push(SQLiteValue::Text(id.to_string()));
    if let Some(expected) = expected_updated_at {
        values.push(SQLiteValue::Text(expected.to_string()));
    }
    let assignments = columns
        .iter()
        .map(|column| format!("{column} = ?"))
        .collect::<Vec<_>>()
        .join(", ");
    let expected_clause = if expected_updated_at.is_some() {
        " AND updated_at = ?"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE {table_name} SET {assignments} WHERE id = ? AND deleted_at IS NULL{expected_clause}"
    );
    let changed = connection
        .execute(&sql, params_from_iter(values.iter()))
        .map_err(|error| format!("failed to update SQLite record: {error}"))?;
    Ok(changed > 0)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_update_record(
    app_handle: AppHandle,
    table_name: String,
    id: String,
    record: Value,
    expected_updated_at: Option<String>,
) -> Result<bool, String> {
    let record = record
        .as_object()
        .ok_or_else(|| "SQLite update payload must be an object".to_string())?;
    let connection = open_connection(&app_handle)?;
    update_record_with_expected_updated_at(
        &connection,
        &table_name,
        &id,
        record,
        expected_updated_at.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_soft_delete_record(
    app_handle: AppHandle,
    table_name: String,
    id: String,
    updated_at: String,
    deleted_at: String,
) -> Result<bool, String> {
    validate_table_name(&table_name)?;
    if matches!(table_name.as_str(), "experiments" | "experiment_runs") {
        return Err("LIFECYCLE_TRANSACTION_FAILED: use the dedicated Experiment/ExperimentRun lifecycle command".into());
    }
    let connection = open_connection(&app_handle)?;
    soft_delete_record(&connection, &table_name, &id, &updated_at, &deleted_at)
}

fn soft_delete_record(
    connection: &Connection,
    table_name: &str,
    id: &str,
    updated_at: &str,
    deleted_at: &str,
) -> Result<bool, String> {
    assert_owned_record_experiment_run_writable(connection, table_name, id)?;
    let sql = format!(
        "UPDATE {table_name} SET updated_at = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL"
    );
    let changed = connection
        .execute(&sql, params![updated_at, deleted_at, id])
        .map_err(|error| format!("failed to soft delete SQLite record: {error}"))?;

    Ok(changed > 0)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_restore_record(
    app_handle: AppHandle,
    table_name: String,
    id: String,
    updated_at: String,
) -> Result<Option<Value>, String> {
    validate_table_name(&table_name)?;
    if matches!(table_name.as_str(), "experiments" | "experiment_runs") {
        return Err("LIFECYCLE_TRANSACTION_FAILED: use the dedicated Experiment/ExperimentRun lifecycle command".into());
    }
    let connection = open_connection(&app_handle)?;
    restore_record(&connection, &table_name, &id, &updated_at)
}

fn restore_record(
    connection: &Connection,
    table_name: &str,
    id: &str,
    updated_at: &str,
) -> Result<Option<Value>, String> {
    assert_owned_record_experiment_run_writable(connection, table_name, id)?;
    if table_name == "file_refs" {
        let permanently_terminal: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM file_refs WHERE id=?1 AND permanent_delete_status='permanently_deleted'",
                [id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to validate FileRef terminal state: {error}"))?;
        if permanently_terminal != 0 {
            return Err("FILE_REF_PERMANENTLY_TERMINAL".into());
        }
    }
    let sql =
        format!("UPDATE {table_name} SET updated_at = ?1, deleted_at = NULL WHERE id = ?2 AND deleted_at IS NOT NULL");
    let changed = connection
        .execute(&sql, params![updated_at, id])
        .map_err(|error| format!("failed to restore SQLite record: {error}"))?;

    if changed == 0 {
        return Ok(None);
    }

    let sql = format!("SELECT * FROM {table_name} WHERE id = ?1 LIMIT 1");
    let mut records = query_records(&connection, &sql, &[&id])?;
    if let Some(record) = records.last() {
        validate_created_local_time_value(&table_name, record)?;
    }
    Ok(records.pop())
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_hard_delete_record(
    app_handle: AppHandle,
    table_name: String,
    id: String,
) -> Result<bool, String> {
    validate_table_name(&table_name)?;
    if matches!(table_name.as_str(), "experiments" | "experiment_runs") {
        return Err("LIFECYCLE_TRANSACTION_FAILED: use the dedicated Experiment/ExperimentRun lifecycle command".into());
    }
    let connection = open_connection(&app_handle)?;
    hard_delete_record(&connection, &table_name, &id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutputLifecycleTransactionInput {
    mode: String,
    owner_type: String,
    owner_id: String,
    occurred_at: String,
    operation_log_record: Value,
    recycle_entry_record: Option<Value>,
    recycle_entry_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutputLifecycleTransactionResult {
    committed: bool,
    owner_deleted_at: Option<String>,
    operation_log_id: String,
    recycle_entry_id: String,
    recycle_restore_status: String,
    recycle_can_restore: bool,
    durable_readback_confirmed: bool,
}

fn output_lifecycle_table(owner_type: &str) -> Result<(&'static str, &'static str), String> {
    match owner_type {
        "resultItem" => Ok(("result_items", "resultItem")),
        "finding" => Ok(("findings", "finding")),
        "outputCandidate" => Ok(("output_candidates", "outputCandidate")),
        "outputGap" => Ok(("output_gaps", "outputGap")),
        "researchOutput" => Ok(("outputs", "output")),
        _ => Err(format!("OUTPUT_LIFECYCLE_OWNER_UNSUPPORTED: {owner_type}")),
    }
}

fn commit_output_lifecycle_transaction_in_connection(
    connection: &mut Connection,
    input: &CommitOutputLifecycleTransactionInput,
) -> Result<CommitOutputLifecycleTransactionResult, String> {
    let (owner_table, recycle_entity_type) = output_lifecycle_table(&input.owner_type)?;
    let operation_log_record = input.operation_log_record.as_object().ok_or_else(|| {
        "OUTPUT_LIFECYCLE_OPERATION_LOG_RECORD_INVALID".to_string()
    })?;
    let operation_log_id = operation_log_record
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "OUTPUT_LIFECYCLE_OPERATION_LOG_ID_REQUIRED".to_string())?
        .to_string();
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| format!("OUTPUT_LIFECYCLE_TRANSACTION_BEGIN_FAILED: {error}"))?;
    assert_owned_record_experiment_run_writable(
        &transaction,
        owner_table,
        &input.owner_id,
    )?;

    let (recycle_entry_id, recycle_restore_status, recycle_can_restore) = match input.mode.as_str() {
        "softDelete" => {
            let recycle_record = input
                .recycle_entry_record
                .as_ref()
                .and_then(Value::as_object)
                .ok_or_else(|| "OUTPUT_LIFECYCLE_RECYCLE_RECORD_REQUIRED".to_string())?;
            let recycle_entry_id = recycle_record
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "OUTPUT_LIFECYCLE_RECYCLE_ID_REQUIRED".to_string())?
                .to_string();
            let record_entity_type = recycle_record
                .get("entity_type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let record_entity_id = recycle_record
                .get("entity_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let record_operation_log_id = recycle_record
                .get("operation_log_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if record_entity_type != recycle_entity_type
                || record_entity_id != input.owner_id
                || record_operation_log_id != operation_log_id
            {
                return Err("OUTPUT_LIFECYCLE_RECYCLE_IDENTITY_MISMATCH".to_string());
            }
            let changed = transaction
                .execute(
                    &format!(
                        "UPDATE {owner_table} SET updated_at = ?1, deleted_at = ?1 \
                         WHERE id = ?2 AND deleted_at IS NULL"
                    ),
                    params![input.occurred_at, input.owner_id],
                )
                .map_err(|error| format!("OUTPUT_LIFECYCLE_OWNER_DELETE_FAILED: {error}"))?;
            if changed != 1 {
                return Err("OUTPUT_LIFECYCLE_OWNER_NOT_ACTIVE".to_string());
            }
            save_record(&transaction, "operation_logs", operation_log_record)?;
            save_record(&transaction, "recycle_entries", recycle_record)?;
            (recycle_entry_id, "not_started".to_string(), true)
        }
        "restore" => {
            let recycle_entry_id = input
                .recycle_entry_id
                .as_deref()
                .ok_or_else(|| "OUTPUT_LIFECYCLE_RECYCLE_ID_REQUIRED".to_string())?;
            let exact_entry_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM recycle_entries
                     WHERE id = ?1 AND entity_type = ?2 AND entity_id = ?3
                       AND can_restore = 1 AND restore_status = 'not_started'
                       AND deleted_at IS NULL",
                    params![recycle_entry_id, recycle_entity_type, input.owner_id],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("OUTPUT_LIFECYCLE_RECYCLE_READ_FAILED: {error}")
                })?;
            if exact_entry_count != 1 {
                return Err(
                    "OUTPUT_LIFECYCLE_RECYCLE_IDENTITY_OR_STATE_MISMATCH".to_string(),
                );
            }
            let changed = transaction
                .execute(
                    &format!(
                        "UPDATE {owner_table} SET updated_at = ?1, deleted_at = NULL \
                         WHERE id = ?2 AND deleted_at IS NOT NULL"
                    ),
                    params![input.occurred_at, input.owner_id],
                )
                .map_err(|error| format!("OUTPUT_LIFECYCLE_OWNER_RESTORE_FAILED: {error}"))?;
            if changed != 1 {
                return Err("OUTPUT_LIFECYCLE_OWNER_NOT_DELETED".to_string());
            }
            save_record(&transaction, "operation_logs", operation_log_record)?;
            let recycle_changed = transaction
                .execute(
                    "UPDATE recycle_entries
                     SET can_restore = 0,
                         cannot_restore_reason = 'Entity metadata has already been restored.',
                         restore_status = 'restored',
                         operation_log_id = ?1,
                         revision = revision + 1,
                         updated_at = ?2
                     WHERE id = ?3 AND entity_type = ?4 AND entity_id = ?5
                       AND can_restore = 1 AND restore_status = 'not_started'
                       AND deleted_at IS NULL",
                    params![
                        operation_log_id,
                        input.occurred_at,
                        recycle_entry_id,
                        recycle_entity_type,
                        input.owner_id
                    ],
                )
                .map_err(|error| {
                    format!("OUTPUT_LIFECYCLE_RECYCLE_TERMINAL_FAILED: {error}")
                })?;
            if recycle_changed != 1 {
                return Err(
                    "OUTPUT_LIFECYCLE_RECYCLE_IDENTITY_OR_STATE_MISMATCH".to_string(),
                );
            }
            (recycle_entry_id.to_string(), "restored".to_string(), false)
        }
        _ => return Err("OUTPUT_LIFECYCLE_MODE_UNSUPPORTED".to_string()),
    };

    let owner_deleted_at: Option<String> = transaction
        .query_row(
            &format!("SELECT deleted_at FROM {owner_table} WHERE id = ?1 LIMIT 1"),
            [&input.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("OUTPUT_LIFECYCLE_OWNER_READBACK_FAILED: {error}"))?;
    let operation_log_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id = ?1 AND deleted_at IS NULL",
            [&operation_log_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("OUTPUT_LIFECYCLE_LOG_READBACK_FAILED: {error}"))?;
    let (readback_restore_status, readback_can_restore): (String, i64) = transaction
        .query_row(
            "SELECT restore_status, can_restore FROM recycle_entries
             WHERE id = ?1 AND deleted_at IS NULL LIMIT 1",
            [&recycle_entry_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("OUTPUT_LIFECYCLE_RECYCLE_READBACK_FAILED: {error}"))?;
    let owner_state_matches = match input.mode.as_str() {
        "softDelete" => owner_deleted_at.is_some(),
        "restore" => owner_deleted_at.is_none(),
        _ => false,
    };
    if !owner_state_matches
        || operation_log_count != 1
        || readback_restore_status != recycle_restore_status
        || (readback_can_restore != 0) != recycle_can_restore
    {
        return Err("OUTPUT_LIFECYCLE_TRANSACTION_READBACK_FAILED".to_string());
    }

    transaction
        .commit()
        .map_err(|error| format!("OUTPUT_LIFECYCLE_TRANSACTION_COMMIT_FAILED: {error}"))?;
    Ok(CommitOutputLifecycleTransactionResult {
        committed: true,
        owner_deleted_at,
        operation_log_id,
        recycle_entry_id,
        recycle_restore_status,
        recycle_can_restore,
        durable_readback_confirmed: true,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn commit_output_lifecycle_transaction(
    app_handle: AppHandle,
    input: CommitOutputLifecycleTransactionInput,
) -> Result<CommitOutputLifecycleTransactionResult, String> {
    let mut connection = open_connection(&app_handle)?;
    commit_output_lifecycle_transaction_in_connection(&mut connection, &input)
}

fn hard_delete_record(
    connection: &Connection,
    table_name: &str,
    id: &str,
) -> Result<bool, String> {
    assert_owned_record_experiment_run_writable(connection, table_name, id)?;
    if table_name == "file_refs" {
        let recovery_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries
             WHERE phase NOT IN ('resolved','cancelled_safe')
               AND (?1=old_current_file_ref_id OR ?1=target_file_ref_id OR ?1=default_file_ref_id)",
            [id], |row| row.get(0),
        ).map_err(|error| format!("RUN_SWITCH_RECOVERY_PERSIST_FAILED: {error}"))?;
        if recovery_count > 0 { return Err("RUN_SWITCH_RECOVERY_BLOCKED".into()); }
    }
    let sql = format!("DELETE FROM {table_name} WHERE id = ?1 AND deleted_at IS NOT NULL");
    let changed = connection
        .execute(&sql, params![id])
        .map_err(|error| format!("failed to permanently delete SQLite record: {error}"))?;

    Ok(changed > 0)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputManuscriptStructuredPatch {
    brief_description: String,
    structured_summary: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutputManuscriptSwitchInput {
    owner_type: String,
    owner_id: String,
    project_id: String,
    expected_current_file_ref_id: String,
    next_current_file_ref_id: String,
    structured_patch: OutputManuscriptStructuredPatch,
    source_schema_version: String,
    occurred_at: String,
    operation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutputManuscriptSwitchResult {
    owner_type: String,
    owner_id: String,
    project_id: String,
    current_file_ref_id: String,
    default_manuscript_file_ref_id: Option<String>,
    brief_description: String,
    structured_summary: Value,
    operation_log_id: String,
    operation_status: String,
    nested_duplicate_retired: bool,
    durable_readback_confirmed: bool,
}

struct OutputManuscriptOwnerContract {
    table: &'static str,
    brief_column: &'static str,
    brief_stable_key: &'static str,
    structured_keys: &'static [&'static str],
}

fn output_manuscript_owner_contract(owner_type: &str) -> Result<OutputManuscriptOwnerContract, String> {
    match owner_type {
        "resultItem" => Ok(OutputManuscriptOwnerContract { table: "result_items", brief_column: "summary", brief_stable_key: "summary", structured_keys: &["keyPhenomenon", "conditionBrief", "initialJudgement", "conversionValue", "other"] }),
        "finding" => Ok(OutputManuscriptOwnerContract { table: "findings", brief_column: "summary", brief_stable_key: "content", structured_keys: &["supportingEvidence", "noveltyDifference", "reliabilityJudgement", "boundaryOrMissingEvidence", "other"] }),
        "outputCandidate" => Ok(OutputManuscriptOwnerContract { table: "output_candidates", brief_column: "description", brief_stable_key: "coreClaim", structured_keys: &["outputType", "innovationContribution", "evidenceSummary", "risksAndGaps", "other"] }),
        "outputGap" => Ok(OutputManuscriptOwnerContract { table: "output_gaps", brief_column: "description", brief_stable_key: "gapDescription", structured_keys: &["gapType", "affectedObject", "strengtheningPlan", "completionCriteria", "other"] }),
        "researchOutput" => Ok(OutputManuscriptOwnerContract { table: "outputs", brief_column: "description", brief_stable_key: "summary", structured_keys: &["outputType", "coreContribution", "sourceChainSummary", "archiveUsage", "other"] }),
        _ => Err(format!("OUTPUT_MANUSCRIPT_OWNER_UNSUPPORTED: {owner_type}")),
    }
}

fn validate_output_structured_summary(summary: &Value, keys: &[&str]) -> Result<(), String> {
    let values = summary.as_array().ok_or_else(|| "OUTPUT_MANUSCRIPT_PATCH_INVALID: structuredSummary must be an array".to_string())?;
    if values.len() != keys.len() {
        return Err("OUTPUT_MANUSCRIPT_PATCH_INVALID: structuredSummary field count does not match owner contract".to_string());
    }
    for (index, expected_key) in keys.iter().enumerate() {
        let field = values[index].as_object().ok_or_else(|| "OUTPUT_MANUSCRIPT_PATCH_INVALID: field must be an object".to_string())?;
        if field.get("key").and_then(Value::as_str) != Some(expected_key) {
            return Err(format!("OUTPUT_MANUSCRIPT_PATCH_INVALID: expected field {expected_key}"));
        }
        if !field.get("value").is_some_and(Value::is_string) {
            return Err(format!("OUTPUT_MANUSCRIPT_PATCH_INVALID: {expected_key} must be a string"));
        }
        if field.get("order").and_then(Value::as_u64) != Some((index + 2) as u64) {
            return Err(format!("OUTPUT_MANUSCRIPT_PATCH_INVALID: {expected_key} order is invalid"));
        }
    }
    Ok(())
}

fn apply_output_structured_summary_patch(
    existing: &Value,
    patch: &Value,
    contract: &OutputManuscriptOwnerContract,
) -> Result<Value, String> {
    validate_output_structured_summary(patch, contract.structured_keys)?;
    let existing_values = existing.as_array().ok_or_else(|| {
        "OUTPUT_MANUSCRIPT_EXISTING_STRUCTURED_SUMMARY_INVALID: structuredSummary must be an array".to_string()
    })?;
    let canonical_keys: std::collections::HashSet<&str> =
        contract.structured_keys.iter().copied().collect();
    let mut unrelated = Vec::new();
    for field in existing_values {
        let object = field.as_object().ok_or_else(|| {
            "OUTPUT_MANUSCRIPT_EXISTING_STRUCTURED_SUMMARY_INVALID: field must be an object".to_string()
        })?;
        let key = object.get("key").and_then(Value::as_str).ok_or_else(|| {
            "OUTPUT_MANUSCRIPT_EXISTING_STRUCTURED_SUMMARY_INVALID: field key must be a string".to_string()
        })?;
        if key == contract.brief_stable_key || canonical_keys.contains(key) {
            continue;
        }
        unrelated.push(field.clone());
    }
    let mut applied = patch
        .as_array()
        .expect("validated Outputs structured patch")
        .clone();
    applied.extend(unrelated);
    Ok(Value::Array(applied))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputManuscriptSwitchFailurePoint {
    AfterDirectUpdate,
    BeforeDuplicateRetirement,
    DuringDuplicateRetirement,
    AfterDuplicateRetirement,
    BeforeCommit,
    DurableReadback,
}

fn injected_output_switch_failure(
    active: Option<OutputManuscriptSwitchFailurePoint>,
    expected: OutputManuscriptSwitchFailurePoint,
) -> Result<(), String> {
    if active == Some(expected) {
        return Err(format!("OUTPUT_MANUSCRIPT_TEST_FAILURE_{expected:?}"));
    }
    Ok(())
}

fn commit_output_manuscript_switch_in_connection(
    connection: &mut Connection,
    input: &CommitOutputManuscriptSwitchInput,
) -> Result<CommitOutputManuscriptSwitchResult, String> {
    commit_output_manuscript_switch_in_connection_with_failure(connection, input, None)
}

fn commit_output_manuscript_switch_in_connection_with_failure(
    connection: &mut Connection,
    input: &CommitOutputManuscriptSwitchInput,
    failure_point: Option<OutputManuscriptSwitchFailurePoint>,
) -> Result<CommitOutputManuscriptSwitchResult, String> {
    if input.source_schema_version != "outputs-manuscript@1" {
        return Err("OUTPUT_MANUSCRIPT_SCHEMA_UNSUPPORTED".to_string());
    }
    let contract = output_manuscript_owner_contract(&input.owner_type)?;
    validate_output_structured_summary(
        &input.structured_patch.structured_summary,
        contract.structured_keys,
    )?;
    let transaction = connection.transaction().map_err(|error| format!("OUTPUT_MANUSCRIPT_SWITCH_TRANSACTION_BEGIN_FAILED: {error}"))?;
    let (owner_project, existing_structured_summary_text): (String, String) = transaction.query_row(
        &format!("SELECT project_id, structured_summary FROM {} WHERE id = ?1 AND deleted_at IS NULL", contract.table),
        [&input.owner_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| "OUTPUT_MANUSCRIPT_OWNER_NOT_ACTIVE".to_string())?;
    if owner_project != input.project_id {
        return Err("OUTPUT_MANUSCRIPT_PROJECT_CONFLICT".to_string());
    }
    let existing_structured_summary: Value = serde_json::from_str(&existing_structured_summary_text)
        .map_err(|error| format!("OUTPUT_MANUSCRIPT_EXISTING_STRUCTURED_SUMMARY_INVALID: {error}"))?;
    let applied_structured_summary = apply_output_structured_summary_patch(
        &existing_structured_summary,
        &input.structured_patch.structured_summary,
        &contract,
    )?;
    let (binding_id, current_file_ref_id, _default_manuscript_file_ref_id): (String, Option<String>, Option<String>) = transaction.query_row(
        "SELECT id, current_file_ref_id, default_manuscript_file_ref_id FROM manuscript_bindings
         WHERE owner_type = ?1 AND owner_id = ?2 AND manuscript_channel = 'primary' AND deleted_at IS NULL",
        params![input.owner_type, input.owner_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "OUTPUT_MANUSCRIPT_BINDING_NOT_FOUND".to_string())?;
    if current_file_ref_id.as_deref() != Some(input.expected_current_file_ref_id.as_str()) {
        return Err("OUTPUT_MANUSCRIPT_CURRENT_STALE".to_string());
    }
    let target_valid: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM file_refs WHERE id = ?1 AND owner_type = ?2 AND owner_id = ?3
         AND manuscript_channel = 'primary' AND resource_kind = 'file' AND file_role = 'manuscript' AND deleted_at IS NULL",
        params![input.next_current_file_ref_id, input.owner_type, input.owner_id],
        |row| row.get(0),
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_TARGET_VALIDATION_FAILED: {error}"))?;
    if target_valid != 1 {
        return Err("OUTPUT_MANUSCRIPT_TARGET_INVALID".to_string());
    }
    let direct_update_sql = format!(
        "UPDATE {} SET {} = ?1, updated_at = ?2
         WHERE id = ?3 AND project_id = ?4 AND deleted_at IS NULL",
        contract.table,
        contract.brief_column
    );
    let owner_changed = transaction.execute(
        &direct_update_sql,
        params![input.structured_patch.brief_description, input.occurred_at, input.owner_id, input.project_id],
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_OWNER_UPDATE_FAILED: {error}"))?;
    if owner_changed != 1 {
        return Err("OUTPUT_MANUSCRIPT_OWNER_UPDATE_FAILED".to_string());
    }
    injected_output_switch_failure(failure_point, OutputManuscriptSwitchFailurePoint::AfterDirectUpdate)?;
    injected_output_switch_failure(failure_point, OutputManuscriptSwitchFailurePoint::BeforeDuplicateRetirement)?;
    let structured_update_sql = format!(
        "UPDATE {} SET structured_summary = ?1 WHERE id = ?2 AND project_id = ?3 AND deleted_at IS NULL",
        contract.table
    );
    let structured_changed = transaction.execute(
        &structured_update_sql,
        params![applied_structured_summary.to_string(), input.owner_id, input.project_id],
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_DUPLICATE_RETIREMENT_FAILED: {error}"))?;
    if structured_changed != 1 {
        return Err("OUTPUT_MANUSCRIPT_DUPLICATE_RETIREMENT_FAILED".to_string());
    }
    injected_output_switch_failure(failure_point, OutputManuscriptSwitchFailurePoint::DuringDuplicateRetirement)?;
    injected_output_switch_failure(failure_point, OutputManuscriptSwitchFailurePoint::AfterDuplicateRetirement)?;
    let binding_changed = transaction.execute(
        "UPDATE manuscript_bindings SET current_file_ref_id = ?1, updated_at = ?2
         WHERE id = ?3 AND current_file_ref_id = ?4 AND deleted_at IS NULL",
        params![input.next_current_file_ref_id, input.occurred_at, binding_id, input.expected_current_file_ref_id],
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_BINDING_UPDATE_FAILED: {error}"))?;
    if binding_changed != 1 {
        return Err("OUTPUT_MANUSCRIPT_CURRENT_STALE".to_string());
    }
    let target_json = serde_json::json!({"entityType": input.owner_type, "entityId": input.owner_id});
    let confirmation_json = serde_json::json!({
        "required": true,
        "confirmedByUser": true,
        "confirmedAt": input.occurred_at,
        "metadataOnly": false
    });
    let feedback_json = serde_json::json!({
        "status": "success",
        "warnings": [],
        "errors": [],
        "skipped": [],
        "affectedEntities": [],
        "refreshKeys": ["operationLog.changed"]
    });
    transaction.execute(
        "INSERT INTO operation_logs (
           id, operation_type, source, module, status, risk_level, target, summary,
           related_entities, confirmation, feedback, warnings, errors, skipped,
           is_recoverable, actor_id, actor_label, refresh_keys, schema_version,
           created_at, updated_at, deleted_at
         ) VALUES (?1, 'custom', 'user', 'output', 'success', 'medium', ?2, ?3,
           '[]', ?4, ?5, '[]', '[]', '[]', 0, 'local-user', 'Local user',
           ?6, 1, ?7, ?7, NULL)",
        params![
            input.operation_id,
            target_json.to_string(),
            format!("Switched current {} manuscript and imported its structured snapshot.", input.owner_type),
            confirmation_json.to_string(),
            feedback_json.to_string(),
            serde_json::json!(["operationLog.changed"]).to_string(),
            input.occurred_at
        ],
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_OPERATION_LOG_FAILED: {error}"))?;
    injected_output_switch_failure(failure_point, OutputManuscriptSwitchFailurePoint::BeforeCommit)?;
    transaction.commit().map_err(|error| format!("OUTPUT_MANUSCRIPT_SWITCH_TRANSACTION_COMMIT_FAILED: {error}"))?;
    injected_output_switch_failure(failure_point, OutputManuscriptSwitchFailurePoint::DurableReadback)
        .map_err(|error| format!("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: {error}"))?;

    let (brief_description, structured_summary_text): (String, String) = connection.query_row(
        &format!("SELECT {}, structured_summary FROM {} WHERE id = ?1 AND deleted_at IS NULL", contract.brief_column, contract.table),
        [&input.owner_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: owner: {error}"))?;
    let structured_summary: Value = serde_json::from_str(&structured_summary_text)
        .map_err(|error| format!("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: structuredSummary: {error}"))?;
    if brief_description != input.structured_patch.brief_description || structured_summary != applied_structured_summary {
        return Err("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: owner value mismatch".to_string());
    }
    let duplicate_absent = structured_summary.as_array().is_some_and(|fields| {
        !fields.iter().any(|field| {
            field.get("key").and_then(Value::as_str) == Some(contract.brief_stable_key)
        })
    });
    if !duplicate_absent {
        return Err("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: nested duplicate remains".to_string());
    }
    let (readback_current_file_ref_id, readback_default_file_ref_id): (Option<String>, Option<String>) = connection.query_row(
        "SELECT current_file_ref_id, default_manuscript_file_ref_id FROM manuscript_bindings
         WHERE owner_type = ?1 AND owner_id = ?2 AND manuscript_channel = 'primary' AND deleted_at IS NULL",
        params![input.owner_type, input.owner_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: binding: {error}"))?;
    let operation_status: String = connection.query_row(
        "SELECT status FROM operation_logs WHERE id = ?1",
        [&input.operation_id],
        |row| row.get(0),
    ).map_err(|error| format!("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: operation: {error}"))?;
    if readback_current_file_ref_id.as_deref() != Some(input.next_current_file_ref_id.as_str()) || operation_status != "success" {
        return Err("OUTPUT_MANUSCRIPT_DURABLE_READBACK_FAILED_COMMIT_CONFIRMED: terminal mismatch".to_string());
    }
    Ok(CommitOutputManuscriptSwitchResult {
        owner_type: input.owner_type.clone(),
        owner_id: input.owner_id.clone(),
        project_id: input.project_id.clone(),
        current_file_ref_id: readback_current_file_ref_id.expect("validated current FileRef"),
        default_manuscript_file_ref_id: readback_default_file_ref_id,
        brief_description,
        structured_summary,
        operation_log_id: input.operation_id.clone(),
        operation_status,
        nested_duplicate_retired: true,
        durable_readback_confirmed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_database_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("labpod-{label}-{}-{nonce}", std::process::id()))
            .join(DATABASE_FILE_NAME)
    }

    fn table_exists_at(connection: &Connection, table: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .expect("query table existence")
    }

    #[test]
    fn generic_record_bridge_persists_manuscript_channel_columns() {
        for table in ["file_refs", "manuscript_bindings"] {
            let columns = allowed_columns(table).expect("registered SQLite table");
            assert!(
                columns.contains(&"manuscript_channel"),
                "{table} must not silently drop manuscript_channel"
            );
        }
    }

    #[test]
    fn experiment_independent_raw_registration_is_idempotent_and_preserves_binding_in_temp_sqlite() {
        let path = temporary_database_path("lp11-h4-independent-raw");
        initialize_database_at(&path).expect("initialize isolated H4 database");
        let connection = Connection::open(&path).expect("open isolated H4 database");

        let binding = serde_json::json!({
            "id": "binding-h4",
            "owner_type": "experiment",
            "owner_id": "experiment-h4",
            "manuscript_channel": "primary",
            "default_folder_file_ref_id": null,
            "default_manuscript_file_ref_id": null,
            "current_file_ref_id": null,
            "schema_version": 1,
            "created_at": "2026-07-19T00:00:00.000Z",
            "updated_at": "2026-07-19T00:00:00.000Z",
            "deleted_at": null
        });
        save_record(
            &connection,
            "manuscript_bindings",
            binding.as_object().expect("binding payload"),
        )
        .expect("save untouched binding");

        let selected = serde_json::json!({
            "id": "file-h4-selected",
            "owner_type": "experiment",
            "owner_id": "experiment-h4",
            "manuscript_channel": "primary",
            "resource_kind": "file",
            "file_role": "manuscript",
            "location_mode": "external",
            "file_type": "markdown",
            "path": "d:/research/ordinary.md",
            "path_identity_key": "d:/research/ordinary.md",
            "title": "ordinary.md",
            "schema_version": 2,
            "source": "imported",
            "custom_fields": "[]",
            "created_at": "2026-07-19T00:00:01.000Z",
            "updated_at": "2026-07-19T00:00:01.000Z",
            "deleted_at": null
        });
        for _ in 0..2 {
            save_record(
                &connection,
                "file_refs",
                selected.as_object().expect("selected FileRef payload"),
            )
            .expect("idempotent FileRef upsert");
        }

        let exact_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM file_refs
                 WHERE owner_type='experiment' AND owner_id='experiment-h4'
                   AND manuscript_channel='primary'
                   AND path_identity_key='d:/research/ordinary.md'
                   AND resource_kind='file' AND file_role='manuscript'
                   AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count exact registered identity");
        assert_eq!(exact_count, 1);
        let binding_state: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT current_file_ref_id, default_manuscript_file_ref_id
                 FROM manuscript_bindings WHERE id='binding-h4'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read preserved binding");
        assert_eq!(binding_state, (None, None));

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = path.parent().and_then(|parent| fs::remove_dir(parent).ok());
    }

    #[test]
    fn experiment_run_canonical_provisioning_metadata_converges_in_temp_sqlite() {
        let path = temporary_database_path("lp11-i3-b2-a-run-canonical");
        initialize_database_at(&path).expect("initialize isolated Run provisioning database");
        let connection = Connection::open(&path).expect("open isolated Run provisioning database");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-unicode', 'project-unicode', '中文自动建档实验', '', 'unknown',
                   '', '', '', '2026-07-18', '1933', '中文自动建档实验', '2026-07-18', '2026-07-18'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-unicode', 'experiment-unicode', 'project-unicode', '88888', 'planned',
                   '2026-07-20', '0938', '88888', '2026-07-20', '2026-07-20'
                 );"
            )
            .expect("seed Unicode Experiment and Run");

        let parent_manuscript = "C:/LabPod/中文根/projects/中文路径验收课题_28624d3728e0/2026-07/18/experiment/2026-07-18_1933_exp_c0007c936ca1_中文自动建档实验/experiment.md";
        for (id, path_value) in [
            ("run-additional-parent-default", parent_manuscript.to_string()),
            (
                "run-additional-parent-copy",
                parent_manuscript.replace("experiment.md", "experiment - 副本.md"),
            ),
        ] {
            let additional = serde_json::json!({
                "id": id,
                "owner_type": "experimentRun",
                "owner_id": "run-unicode",
                "manuscript_channel": "primary",
                "resource_kind": "file",
                "file_role": "manuscript",
                "location_mode": "managed",
                "file_type": "markdown",
                "path": path_value,
                "path_identity_key": path_value.to_lowercase(),
                "title": "existing additional manuscript",
                "schema_version": 2,
                "source": "imported",
                "custom_fields": "[]",
                "created_at": "2026-07-20T00:00:00.000Z",
                "updated_at": "2026-07-20T00:00:00.000Z",
                "deleted_at": null
            });
            save_record(
                &connection,
                "file_refs",
                additional.as_object().expect("additional FileRef payload"),
            )
            .expect("seed existing additional Run FileRef");
        }

        let run_workspace = "C:/LabPod/中文根/projects/中文路径验收课题_28624d3728e0/2026-07/18/experiment/2026-07-18_1933_exp_c0007c936ca1_中文自动建档实验/runs/2026-07/20/2026-07-20_0938_run_1a8b110464f3_88888";
        let run_manuscript = format!("{run_workspace}/experiment-run.md");
        let folder = serde_json::json!({
            "id": "run-canonical-folder",
            "owner_type": "experimentRun",
            "owner_id": "run-unicode",
            "manuscript_channel": "primary",
            "resource_kind": "folder",
            "file_role": "defaultFolder",
            "location_mode": "managed",
            "file_type": "folder",
            "path": run_workspace,
            "path_identity_key": run_workspace.to_lowercase(),
            "title": "88888",
            "schema_version": 2,
            "source": "system",
            "custom_fields": "[]",
            "created_at": "2026-07-20T01:00:00.000Z",
            "updated_at": "2026-07-20T01:00:00.000Z",
            "deleted_at": null
        });
        let manuscript = serde_json::json!({
            "id": "run-canonical-manuscript",
            "owner_type": "experimentRun",
            "owner_id": "run-unicode",
            "manuscript_channel": "primary",
            "resource_kind": "file",
            "file_role": "manuscript",
            "location_mode": "managed",
            "file_type": "markdown",
            "path": run_manuscript,
            "path_identity_key": run_manuscript.to_lowercase(),
            "title": "experiment-run.md",
            "schema_version": 2,
            "source": "system",
            "custom_fields": "[]",
            "created_at": "2026-07-20T01:00:00.000Z",
            "updated_at": "2026-07-20T01:00:00.000Z",
            "deleted_at": null
        });
        let binding = serde_json::json!({
            "id": "run-primary-binding",
            "owner_type": "experimentRun",
            "owner_id": "run-unicode",
            "manuscript_channel": "primary",
            "default_folder_file_ref_id": "run-canonical-folder",
            "default_manuscript_file_ref_id": "run-canonical-manuscript",
            "current_file_ref_id": "run-canonical-manuscript",
            "schema_version": 1,
            "created_at": "2026-07-20T01:00:00.000Z",
            "updated_at": "2026-07-20T01:00:00.000Z",
            "deleted_at": null
        });

        for _ in 0..2 {
            save_record(&connection, "file_refs", folder.as_object().expect("folder payload"))
                .expect("idempotent canonical folder ensure");
            save_record(
                &connection,
                "file_refs",
                manuscript.as_object().expect("manuscript payload"),
            )
            .expect("idempotent canonical manuscript ensure");
            save_record(
                &connection,
                "manuscript_bindings",
                binding.as_object().expect("binding payload"),
            )
            .expect("idempotent primary Binding ensure");
        }
        drop(connection);

        let readback = Connection::open(&path).expect("reopen isolated database for readback");
        let canonical_count: i64 = readback
            .query_row(
                "SELECT COUNT(*) FROM file_refs
                 WHERE owner_type='experimentRun' AND owner_id='run-unicode'
                   AND manuscript_channel='primary' AND id IN ('run-canonical-folder', 'run-canonical-manuscript')
                   AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("read canonical FileRef count");
        assert_eq!(canonical_count, 2);
        let binding_state: (String, String, String) = readback
            .query_row(
                "SELECT default_folder_file_ref_id, default_manuscript_file_ref_id, current_file_ref_id
                 FROM manuscript_bindings
                 WHERE owner_type='experimentRun' AND owner_id='run-unicode'
                   AND manuscript_channel='primary' AND deleted_at IS NULL",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read authoritative Run Binding");
        assert_eq!(
            binding_state,
            (
                "run-canonical-folder".to_string(),
                "run-canonical-manuscript".to_string(),
                "run-canonical-manuscript".to_string(),
            )
        );
        let additional_count: i64 = readback
            .query_row(
                "SELECT COUNT(*) FROM file_refs
                 WHERE id IN ('run-additional-parent-default', 'run-additional-parent-copy')
                   AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("read preserved additional FileRef count");
        assert_eq!(additional_count, 2);

        drop(readback);
        let _ = fs::remove_file(&path);
        let _ = path.parent().and_then(|parent| fs::remove_dir(parent).ok());
    }

    #[test]
    fn workspace_title_identity_validator_matches_windows_reserved_slug_contract() {
        for identity in ["_con", "_prn.txt", "中文-safe"] {
            let record = serde_json::json!({ "workspace_title_identity": identity });
            validate_workspace_title_identity_record(
                "experiments",
                record.as_object().expect("workspace identity record"),
            )
            .expect("canonical workspace identity must be accepted");
        }
        for identity in ["CON", "unsafe_underscore", "trailing."] {
            let record = serde_json::json!({ "workspace_title_identity": identity });
            assert!(
                validate_workspace_title_identity_record(
                    "experiments",
                    record.as_object().expect("invalid workspace identity record"),
                )
                .is_err(),
                "non-canonical workspace identity must be rejected: {identity}"
            );
        }
    }

    #[test]
    fn generic_owner_save_and_update_cannot_change_experiment_lifecycle_state() {
        let path = temporary_database_path("owner-lifecycle-bridge-guard");
        initialize_database_at(&path).expect("initialize database");
        let connection = Connection::open(&path).expect("open database");
        connection.execute_batch(
            "INSERT INTO experiments (
               id, project_id, experiment_name, machine_object, fault_type,
               sensor_config, data_path, result_summary,
               created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
             ) VALUES (
               'experiment-a', 'project-a', 'Experiment A', '', 'unknown',
               '', '', '', '2026-07-18', '0905', 'experiment-a', '2026-07-18', '2026-07-18'
             );"
        ).expect("seed Experiment");

        let delete_payload = serde_json::json!({"id":"experiment-a","deleted_at":"deleted"});
        assert!(save_record(&connection, "experiments", delete_payload.as_object().unwrap())
            .unwrap_err().contains("ordinary save cannot change Experiment lifecycle state"));
        assert!(update_record(&connection, "experiments", "experiment-a", delete_payload.as_object().unwrap())
            .unwrap_err().contains("ordinary update cannot change Experiment lifecycle state"));

        connection.execute("UPDATE experiments SET deleted_at='deleted' WHERE id='experiment-a'", []).unwrap();
        let restore_payload = serde_json::json!({"id":"experiment-a","deleted_at":null});
        assert!(save_record(&connection, "experiments", restore_payload.as_object().unwrap())
            .unwrap_err().contains("ordinary save cannot change Experiment lifecycle state"));

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = path.parent().and_then(|parent| fs::remove_dir(parent).ok());
    }

    #[test]
    fn experiment_run_parent_guard_distinguishes_lifecycle_states() {
        let path = temporary_database_path("experiment-run-parent-guard");
        initialize_database_at(&path).expect("initialize database");
        let connection = Connection::open(&path).expect("open database");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-a', 'project-a', 'Experiment A', '', 'unknown',
                   '', '', '', '2026-07-17', '0905', 'experiment-a', '2026-07-17', '2026-07-17'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-a', 'experiment-a', 'project-a', 'Run A', 'planned',
                   '2026-07-17', '0910', 'run-a', '2026-07-17', '2026-07-17'
                 );"
            )
            .expect("seed guard fixtures");

        assert_experiment_run_writable(&connection, "run-a").expect("active Run is writable");
        connection
            .execute(
                "UPDATE experiments SET deleted_at = '2026-07-17T10:00:00Z' WHERE id = 'experiment-a'",
                [],
            )
            .expect("delete parent");
        assert_eq!(
            assert_experiment_run_writable(&connection, "run-a").unwrap_err(),
            "EXPERIMENT_RUN_PARENT_DELETED"
        );
        connection
            .execute("UPDATE experiments SET deleted_at = NULL WHERE id = 'experiment-a'", [])
            .expect("restore parent");
        assert_experiment_run_writable(&connection, "run-a").expect("parent restore re-enables Run");
        connection
            .execute(
                "UPDATE experiment_runs SET deleted_at = '2026-07-17T11:00:00Z' WHERE id = 'run-a'",
                [],
            )
            .expect("delete Run");
        assert_eq!(
            assert_experiment_run_writable(&connection, "run-a").unwrap_err(),
            "EXPERIMENT_RUN_DELETED"
        );
        assert_eq!(
            assert_experiment_run_writable(&connection, "missing-run").unwrap_err(),
            "EXPERIMENT_RUN_NOT_FOUND"
        );

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = path.parent().and_then(|parent| fs::remove_dir(parent).ok());
    }

    #[test]
    fn experiment_run_owned_write_boundaries_reject_deleted_parent_without_touching_other_owners() {
        let path = temporary_database_path("experiment-run-owned-guard");
        initialize_database_at(&path).expect("initialize database");
        let connection = Connection::open(&path).expect("open database");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-a', 'project-a', 'Experiment A', '', 'unknown',
                   '', '', '', '2026-07-17', '0905', 'experiment-a', '2026-07-17', '2026-07-17'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-a', 'experiment-a', 'project-a', 'Run A', 'planned',
                   '2026-07-17', '0910', 'run-a', '2026-07-17', '2026-07-17'
                 );
                 INSERT INTO result_metrics (id, run_id, experiment_id, name, value, created_at, updated_at)
                 VALUES ('metric-a', 'run-a', 'experiment-a', 'Accuracy', '0.9', '2026-07-17', '2026-07-17');
                 INSERT INTO file_refs (
                   id, owner_type, owner_id, manuscript_channel, file_type, path,
                   path_identity_key, title, created_at, updated_at
                 ) VALUES
                   ('run-file', 'experimentRun', 'run-a', 'primary', 'other', 'C:/run.txt', 'c:/run.txt', 'Run file', '2026-07-17', '2026-07-17'),
                   ('experiment-file', 'experiment', 'experiment-a', 'primary', 'other', 'C:/experiment.txt', 'c:/experiment.txt', 'Experiment file', '2026-07-17', '2026-07-17'),
                   ('deleted-run-file', 'experimentRun', 'run-a', 'primary', 'other', 'C:/deleted.txt', 'c:/deleted.txt', 'Deleted run file', '2026-07-17', '2026-07-17');
                 UPDATE file_refs SET deleted_at = '2026-07-17T09:00:00Z' WHERE id = 'deleted-run-file';
                 INSERT INTO manuscript_bindings (
                   id, owner_type, owner_id, manuscript_channel, created_at, updated_at
                 ) VALUES ('run-binding', 'experimentRun', 'run-a', 'primary', '2026-07-17', '2026-07-17');
                 UPDATE experiments SET deleted_at = '2026-07-17T10:00:00Z' WHERE id = 'experiment-a';"
            )
            .expect("seed owned guard fixtures");

        for (table, payload) in [
            (
                "result_metrics",
                serde_json::json!({
                    "id": "metric-new",
                    "run_id": "run-a",
                    "experiment_id": "experiment-a",
                    "name": "Blocked metric",
                    "value": "1",
                    "created_at": "2026-07-17",
                    "updated_at": "2026-07-17"
                }),
            ),
            (
                "file_refs",
                serde_json::json!({
                    "id": "run-file-new",
                    "owner_type": "experimentRun",
                    "owner_id": "run-a",
                    "manuscript_channel": "primary",
                    "file_type": "other",
                    "path": "C:/blocked.txt",
                    "path_identity_key": "c:/blocked.txt",
                    "title": "Blocked file",
                    "created_at": "2026-07-17",
                    "updated_at": "2026-07-17"
                }),
            ),
            (
                "manuscript_bindings",
                serde_json::json!({
                    "id": "run-binding-new",
                    "owner_type": "experimentRun",
                    "owner_id": "run-a",
                    "manuscript_channel": "primary",
                    "created_at": "2026-07-17",
                    "updated_at": "2026-07-17"
                }),
            ),
        ] {
            assert_eq!(
                save_record(&connection, table, payload.as_object().unwrap()).unwrap_err(),
                "EXPERIMENT_RUN_PARENT_DELETED"
            );
        }

        for (table, id) in [
            ("result_metrics", "metric-a"),
            ("file_refs", "run-file"),
            ("manuscript_bindings", "run-binding"),
        ] {
            let patch = serde_json::json!({"updated_at": "2026-07-17T12:00:00Z"});
            assert_eq!(
                update_record(&connection, table, id, patch.as_object().unwrap()).unwrap_err(),
                "EXPERIMENT_RUN_PARENT_DELETED"
            );
            assert_eq!(
                soft_delete_record(&connection, table, id, "2026-07-17T12:00:00Z", "2026-07-17T12:00:00Z").unwrap_err(),
                "EXPERIMENT_RUN_PARENT_DELETED"
            );
        }
        assert_eq!(
            restore_record(&connection, "file_refs", "deleted-run-file", "2026-07-17T12:00:00Z").unwrap_err(),
            "EXPERIMENT_RUN_PARENT_DELETED"
        );
        assert_eq!(
            hard_delete_record(&connection, "file_refs", "deleted-run-file").unwrap_err(),
            "EXPERIMENT_RUN_PARENT_DELETED"
        );
        let mut connection = connection;
        assert_eq!(
            manuscript_binding::write_manuscript_binding_in_connection(
                &mut connection,
                &manuscript_binding::WriteManuscriptBindingInput {
                    operation: "remove".into(),
                    owner_type: "experimentRun".into(),
                    owner_id: "run-a".into(),
                    manuscript_channel: "primary".into(),
                    binding_id: None,
                    file_ref_id: None,
                    default_folder_file_ref_id: None,
                    default_manuscript_file_ref_id: None,
                    expected: manuscript_binding::ExpectedManuscriptBindingState {
                        exists: true,
                        updated_at: Some("2026-07-17".into()),
                        default_folder_file_ref_id: None,
                        default_manuscript_file_ref_id: None,
                        current_file_ref_id: None,
                    },
                    occurred_at: "2026-07-17T12:00:00Z".into(),
                }
            )
            .unwrap_err(),
            "EXPERIMENT_RUN_PARENT_DELETED"
        );

        let preserved: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM result_metrics WHERE id = 'metric-a' AND deleted_at IS NULL),
                   (SELECT COUNT(*) FROM file_refs WHERE id = 'run-file' AND deleted_at IS NULL),
                   (SELECT COUNT(*) FROM manuscript_bindings WHERE id = 'run-binding' AND deleted_at IS NULL)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read preserved owned metadata");
        assert_eq!(preserved, (1, 1, 1));

        let other_owner_patch = serde_json::json!({
            "title": "Experiment file updated",
            "updated_at": "2026-07-17T12:00:00Z"
        });
        assert!(update_record(
            &connection,
            "file_refs",
            "experiment-file",
            other_owner_patch.as_object().unwrap()
        )
        .expect("other FileRef owner must remain unaffected"));

        connection
            .execute("UPDATE experiments SET deleted_at = NULL WHERE id = 'experiment-a'", [])
            .expect("restore parent");
        let restored_parent_patch = serde_json::json!({
            "title": "Run file after parent restore",
            "updated_at": "2026-07-17T13:00:00Z"
        });
        assert!(update_record(
            &connection,
            "file_refs",
            "run-file",
            restored_parent_patch.as_object().unwrap()
        )
        .expect("parent restore re-enables active Run-owned writes"));

        connection
            .execute(
                "UPDATE experiment_runs SET deleted_at = '2026-07-17T14:00:00Z' WHERE id = 'run-a'",
                [],
            )
            .expect("delete Run independently");
        let deleted_run_patch = serde_json::json!({"updated_at": "2026-07-17T15:00:00Z"});
        assert_eq!(
            update_record(
                &connection,
                "result_metrics",
                "metric-a",
                deleted_run_patch.as_object().unwrap()
            )
            .unwrap_err(),
            "EXPERIMENT_RUN_DELETED"
        );

        connection
            .execute("UPDATE experiment_runs SET deleted_at = NULL WHERE id = 'run-a'", [])
            .expect("restore Run metadata");
        connection
            .execute(
                "UPDATE experiments SET deleted_at = '2026-07-17T16:00:00Z' WHERE id = 'experiment-a'",
                [],
            )
            .expect("delete parent again");
        assert_eq!(
            assert_experiment_run_writable(&connection, "run-a").unwrap_err(),
            "EXPERIMENT_RUN_PARENT_DELETED"
        );

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = path.parent().and_then(|parent| fs::remove_dir(parent).ok());
    }

    #[test]
    fn experiment_creation_local_time_is_required_valid_roundtripped_and_immutable() {
        for table in ["experiments", "experiment_runs"] {
            let columns = allowed_columns(table).expect("registered SQLite table");
            assert!(columns.contains(&"created_local_date"), "{table} local date column");
            assert!(columns.contains(&"created_local_time"), "{table} local time column");
            assert!(
                columns.contains(&"workspace_title_identity"),
                "{table} frozen workspace-title identity column"
            );
        }

        let path = temporary_database_path("experiment-created-local-time");
        initialize_database_at(&path).expect("initialize database");
        let connection = Connection::open(&path).expect("open database");

        for identity in [None, Some("")] {
            let mut payload = serde_json::json!({
                "id": format!("experiment-invalid-identity-{}", identity.is_some()),
                "project_id": "project-time",
                "experiment_name": "Invalid identity",
                "machine_object": "",
                "fault_type": "unknown",
                "sensor_config": "",
                "data_path": "",
                "result_summary": "",
                "created_local_date": "2026-07-17",
                "created_local_time": "0905",
                "created_at": "2026-07-17T01:05:00.000Z",
                "updated_at": "2026-07-17T01:05:00.000Z"
            });
            if let Some(value) = identity {
                payload["workspace_title_identity"] = Value::String(value.to_string());
            }
            let error = save_record(
                &connection,
                "experiments",
                payload.as_object().expect("invalid identity payload"),
            )
            .expect_err("missing or blank workspace-title identity must fail");
            assert!(error.contains("workspace-title identity"), "{error}");
        }

        let experiment = serde_json::json!({
            "id": "experiment-time",
            "project_id": "project-time",
            "experiment_name": "实验时钟",
            "machine_object": "",
            "fault_type": "unknown",
            "sensor_config": "",
            "data_path": "",
            "result_summary": "",
            "created_local_date": "2026-07-17",
            "created_local_time": "0905",
            "workspace_title_identity": "experiment-clock",
            "created_at": "2026-07-17T01:05:00.000Z",
            "updated_at": "2026-07-17T01:05:00.000Z"
        });
        save_record(
            &connection,
            "experiments",
            experiment.as_object().expect("experiment payload"),
        )
        .expect("save Experiment frozen time");

        let run = serde_json::json!({
            "id": "run-time",
            "experiment_id": "experiment-time",
            "project_id": "project-time",
            "title": "Run 时钟",
            "status": "planned",
            "started_at": "2030-01-01T00:00:00Z",
            "completed_at": "2030-01-02T00:00:00Z",
            "created_local_date": "2026-07-18",
            "created_local_time": "2359",
            "workspace_title_identity": "run-clock",
            "created_at": "2026-07-18T15:59:00.000Z",
            "updated_at": "2026-07-18T15:59:00.000Z"
        });
        save_record(
            &connection,
            "experiment_runs",
            run.as_object().expect("run payload"),
        )
        .expect("save Run frozen time");

        let stored: (String, String, String) = connection
            .query_row(
                "SELECT created_at, created_local_date, created_local_time
                 FROM experiment_runs WHERE id = 'run-time'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read Run frozen time");
        assert_eq!(stored, ("2026-07-18T15:59:00.000Z".into(), "2026-07-18".into(), "2359".into()));

        for (table, id) in [("experiments", "experiment-time"), ("experiment_runs", "run-time")] {
            for field in ["created_local_date", "created_local_time"] {
                let mut patch = Map::new();
                patch.insert(field.to_string(), Value::String("invalid mutation".to_string()));
                let error = update_record(
                    &connection,
                    table,
                    id,
                    &patch,
                )
                .expect_err("ordinary update must reject frozen creation time");
                assert!(error.contains("immutable creation-local-time column"), "{error}");
            }
            let mut patch = Map::new();
            patch.insert(
                "workspace_title_identity".to_string(),
                Value::String("changed-title-identity".to_string()),
            );
            let error = update_record(&connection, table, id, &patch)
                .expect_err("ordinary update must reject frozen workspace-title identity");
            assert!(error.contains("immutable workspace-title identity"), "{error}");
        }

        for (table, payload) in [
            ("experiments", &experiment),
            ("experiment_runs", &run),
        ] {
            let mut replacement = payload
                .as_object()
                .expect("workspace identity payload")
                .clone();
            replacement.insert(
                "workspace_title_identity".to_string(),
                Value::String("changed-by-upsert".to_string()),
            );
            let error = save_record(&connection, table, &replacement)
                .expect_err("upsert must reject frozen workspace-title identity changes");
            assert!(error.contains("immutable workspace-title identity"), "{error}");
        }

        for (table, payload) in [
            (
                "experiments",
                serde_json::json!({
                    "id": "experiment-invalid-time",
                    "project_id": "project-time",
                    "experiment_name": "Invalid",
                    "machine_object": "",
                    "fault_type": "unknown",
                    "sensor_config": "",
                    "data_path": "",
                    "result_summary": "",
                    "created_local_date": "2026-02-30",
                    "created_local_time": "0905",
                    "created_at": "2026-02-28T01:05:00.000Z",
                    "updated_at": "2026-02-28T01:05:00.000Z"
                }),
            ),
            (
                "experiment_runs",
                serde_json::json!({
                    "id": "run-missing-time",
                    "experiment_id": "experiment-time",
                    "project_id": "project-time",
                    "title": "Missing",
                    "status": "planned",
                    "created_at": "2026-07-18T15:59:00.000Z",
                    "updated_at": "2026-07-18T15:59:00.000Z"
                }),
            ),
        ] {
            let error = save_record(
                &connection,
                table,
                payload.as_object().expect("invalid frozen time payload"),
            )
            .expect_err("invalid or missing frozen creation time must fail");
            assert!(error.contains("created local"), "{error}");
        }

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = path.parent().and_then(|parent| fs::remove_dir(parent).ok());
    }

    #[test]
    fn experiment_run_update_rejects_parent_and_project_and_roundtrips_structured_fields() {
        let path = temporary_database_path("experiment-run-update");
        initialize_database_at(&path).expect("initialize database");
        let connection = Connection::open(&path).expect("open database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary, other,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-a', 'project-a', 'Experiment A', '', 'unknown',
                   '', '', '', '实验其他', '2026-07-17', '0905', 'experiment-a', '2026-07-17', '2026-07-17'
                 );
                 INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-b', 'project-b', 'Experiment B', '', 'unknown',
                   '', '', '', '2026-07-17', '0906', 'experiment-b', '2026-07-17', '2026-07-17'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status,
                   variable_parameter_summary, summary_other, custom_fields,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-a', 'experiment-a', 'project-a', 'Run A', 'planned',
                   '转速 1200 rpm', '运行其他', '[{\"name\":\"generalNotes\",\"value\":\"正文保留\"}]',
                   '2026-07-17', '0910', 'run-a', '2026-07-17', '2026-07-17'
                 );",
            )
            .expect("seed ExperimentRun");

        let mutable_patch = serde_json::json!({
            "title": "Run A updated",
            "variable_parameter_summary": "参数 β",
            "summary_other": null,
            "updated_at": "2026-07-17T01:00:00Z"
        })
        .as_object()
        .expect("mutable patch")
        .clone();
        assert!(update_record(&connection, "experiment_runs", "run-a", &mutable_patch)
            .expect("update mutable fields"));

        for immutable_patch in [
            serde_json::json!({"experiment_id": "experiment-b"}),
            serde_json::json!({"project_id": "project-b"}),
        ] {
            let error = update_record(
                &connection,
                "experiment_runs",
                "run-a",
                immutable_patch.as_object().expect("immutable patch"),
            )
            .expect_err("immutable update must fail");
            assert!(error.contains("immutable ExperimentRun column"), "{error}");
        }

        let direct_parent_mutation = serde_json::json!({
            "id": "run-a",
            "experiment_id": "experiment-b",
            "project_id": "project-b",
            "title": "Run A",
            "status": "planned",
            "created_local_date": "2026-07-17",
            "created_local_time": "0910",
            "workspace_title_identity": "run-a",
            "created_at": "2026-07-17",
            "updated_at": "2026-07-17"
        });
        let error = save_record(
            &connection,
            "experiment_runs",
            direct_parent_mutation.as_object().expect("direct mutation"),
        )
        .expect_err("generic save must reject parent mutation");
        assert!(error.contains("immutable ExperimentRun column"), "{error}");

        let mismatched_create = serde_json::json!({
            "id": "run-mismatch",
            "experiment_id": "experiment-a",
            "project_id": "project-b",
            "title": "Mismatch",
            "status": "planned",
            "created_local_date": "2026-07-17",
            "created_local_time": "0911",
            "workspace_title_identity": "run-mismatch",
            "created_at": "2026-07-17",
            "updated_at": "2026-07-17"
        });
        let error = save_record(
            &connection,
            "experiment_runs",
            mismatched_create.as_object().expect("mismatched create"),
        )
        .expect_err("generic save must enforce parent Project");
        assert_eq!(error, EXPERIMENT_RUN_PROJECT_MISMATCH);

        for (payload, expected) in [
            (
                serde_json::json!({
                    "id": "run-without-parent",
                    "project_id": "project-a",
                    "title": "No parent",
                    "status": "planned",
                    "created_local_date": "2026-07-17",
                    "created_local_time": "0912",
                    "workspace_title_identity": "run-without-parent",
                    "created_at": "2026-07-17",
                    "updated_at": "2026-07-17"
                }),
                "parent experiment is required",
            ),
            (
                serde_json::json!({
                    "id": "run-missing-parent",
                    "experiment_id": "experiment-missing",
                    "project_id": "project-a",
                    "title": "Missing parent",
                    "status": "planned",
                    "created_local_date": "2026-07-17",
                    "created_local_time": "0913",
                    "workspace_title_identity": "run-missing-parent",
                    "created_at": "2026-07-17",
                    "updated_at": "2026-07-17"
                }),
                EXPERIMENT_RUN_PARENT_NOT_FOUND,
            ),
        ] {
            let error = save_record(
                &connection,
                "experiment_runs",
                payload.as_object().expect("invalid parent payload"),
            )
            .expect_err("invalid parent must fail");
            assert!(error.contains(expected), "{error}");
        }
        connection
            .execute(
                "UPDATE experiments SET deleted_at = '2026-07-17' WHERE id = 'experiment-b'",
                [],
            )
            .expect("soft delete parent B");
        let deleted_parent_payload = serde_json::json!({
            "id": "run-deleted-parent",
            "experiment_id": "experiment-b",
            "project_id": "project-b",
            "title": "Deleted parent",
            "status": "planned",
            "created_local_date": "2026-07-17",
            "created_local_time": "0914",
            "workspace_title_identity": "run-deleted-parent",
            "created_at": "2026-07-17",
            "updated_at": "2026-07-17"
        });
        let error = save_record(
            &connection,
            "experiment_runs",
            deleted_parent_payload.as_object().expect("deleted parent payload"),
        )
        .expect_err("deleted parent must fail");
        assert_eq!(error, EXPERIMENT_RUN_PARENT_DELETED);

        let row: (String, String, String, String, Option<String>, String) = connection
            .query_row(
                "SELECT experiment_id, project_id, title, variable_parameter_summary,
                        summary_other, custom_fields
                 FROM experiment_runs WHERE id = 'run-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .expect("read ExperimentRun");
        assert_eq!(row.0, "experiment-a");
        assert_eq!(row.1, "project-a");
        assert_eq!(row.2, "Run A updated");
        assert_eq!(row.3, "参数 β");
        assert_eq!(row.4, None);
        assert!(row.5.contains("generalNotes"));

        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    #[test]
    fn experiment_run_expected_updated_at_guard_has_exactly_one_winner_and_preserves_it() {
        let path = temporary_database_path("lp13-b1-a13-run-cas");
        initialize_database_at(&path).expect("initialize A13 CAS database");
        let connection = Connection::open(&path).expect("open A13 CAS database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-a13', 'project-a13', 'Experiment A13', '', 'unknown',
                   '', '', '', '2026-08-16', '0100', 'experiment-a13',
                   '2026-08-16T01:00:00.000Z', '2026-08-16T01:00:00.000Z'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-a13', 'experiment-a13', 'project-a13', 'Reviewed state', 'planned',
                   '2026-08-16', '0101', 'run-a13',
                   '2026-08-16T01:01:00.000Z', '2026-08-16T01:01:00.000Z'
                 );",
            )
            .expect("seed A13 ExperimentRun");

        let reviewed_token = "2026-08-16T01:01:00.000Z";
        let winning_patch = serde_json::json!({
            "title": "Atomic winner",
            "updated_at": "2026-08-16T01:02:00.000Z"
        });
        let losing_patch = serde_json::json!({
            "title": "Unreviewed loser",
            "updated_at": "2026-08-16T01:03:00.000Z"
        });
        assert!(update_record_with_expected_updated_at(
            &connection,
            "experiment_runs",
            "run-a13",
            winning_patch.as_object().expect("winning patch"),
            Some(reviewed_token),
        )
        .expect("first guarded update"));
        assert!(!update_record_with_expected_updated_at(
            &connection,
            "experiment_runs",
            "run-a13",
            losing_patch.as_object().expect("losing patch"),
            Some(reviewed_token),
        )
        .expect("second guarded update must be a typed zero-row mismatch"));

        let winning_readback: (String, String) = connection
            .query_row(
                "SELECT title, updated_at FROM experiment_runs WHERE id = 'run-a13'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read winning ExperimentRun state");
        assert_eq!(winning_readback.0, "Atomic winner");
        assert_eq!(winning_readback.1, "2026-08-16T01:02:00.000Z");

        let parent = path.parent().expect("A13 CAS database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup A13 CAS database");
    }

    #[test]
    fn literature_operation_create_and_updated_at_guard_are_atomic_and_zero_schema() {
        let path = temporary_database_path("lp13-b1-a16-literature-atomic");
        initialize_database_at(&path).expect("initialize A16 Literature database");
        let connection = Connection::open(&path).expect("open A16 Literature database");
        let reviewed_token = "2026-08-16T02:00:00.000Z";
        let original = serde_json::json!({
            "id": "literature-a16-operation",
            "title": "Operation-bound Literature",
            "authors": [{"name":"Researcher"}],
            "reading_status": "unread",
            "tags": [],
            "schema_version": 2,
            "source": "ai",
            "ai_metadata": {"standardResultOperation":{"operationKey":"a16-lit-create:result:authorization"}},
            "created_at": reviewed_token,
            "updated_at": reviewed_token,
            "deleted_at": null
        });
        assert!(insert_record_if_absent(
            &connection,
            "literatures",
            original.as_object().expect("original Literature record"),
        )
        .expect("first atomic Literature create"));
        let mut duplicate = original.clone();
        duplicate["title"] = serde_json::json!("Must not overwrite");
        assert!(!insert_record_if_absent(
            &connection,
            "literatures",
            duplicate.as_object().expect("duplicate Literature record"),
        )
        .expect("duplicate operation identity is a no-op"));

        let winning_patch = serde_json::json!({
            "title": "Atomic Literature winner",
            "updated_at": "2026-08-16T02:00:00.001Z"
        });
        let losing_patch = serde_json::json!({
            "title": "Same-reviewed-token loser",
            "updated_at": "2026-08-16T02:00:00.001Z"
        });
        assert!(update_record_with_expected_updated_at(
            &connection,
            "literatures",
            "literature-a16-operation",
            winning_patch.as_object().expect("winning Literature patch"),
            Some(reviewed_token),
        )
        .expect("first guarded Literature update"));
        assert!(!update_record_with_expected_updated_at(
            &connection,
            "literatures",
            "literature-a16-operation",
            losing_patch.as_object().expect("losing Literature patch"),
            Some(reviewed_token),
        )
        .expect("second same-token Literature update must lose"));
        let readback: (String, String, String) = connection
            .query_row(
                "SELECT title, updated_at, ai_metadata FROM literatures WHERE id='literature-a16-operation'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read authoritative Literature winner");
        assert_eq!(readback.0, "Atomic Literature winner");
        assert_eq!(readback.1, "2026-08-16T02:00:00.001Z");
        assert!(readback.2.contains("a16-lit-create:result:authorization"));

        let parent = path.parent().expect("A16 Literature database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup A16 Literature database");
    }

    #[test]
    fn file_database_initialization_is_complete_and_idempotent() {
        let path = temporary_database_path("fresh");
        initialize_database_at(&path).expect("initialize fresh database");
        initialize_database_at(&path).expect("initialize database again");

        let connection = Connection::open(&path).expect("open initialized database");
        for table in [
            "file_refs",
            "manuscript_bindings",
            "managed_root_settings",
            "literatures",
            "operation_logs",
            "recycle_entries",
        ] {
            assert!(table_exists_at(&connection, table), "missing {table}");
        }
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user_version");
        assert_eq!(user_version, schema::CURRENT_SCHEMA_VERSION);

        let parent = path.parent().expect("temporary database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("remove test database directory");
    }

    #[test]
    fn initialization_failure_is_structured_and_does_not_advance_version() {
        let path = temporary_database_path("failure");
        std::fs::create_dir_all(path.parent().expect("database parent"))
            .expect("create test directory");
        let connection = Connection::open(&path).expect("create malformed database");
        connection
            .execute_batch(
                "PRAGMA user_version = 16;
                 CREATE VIEW managed_root_settings AS SELECT 'managed-root' AS id;",
            )
            .expect("create conflicting schema object");
        drop(connection);

        let error = initialize_database_at(&path).expect_err("initialization must fail");
        assert!(error.contains("code=source-version-unsupported"), "{error}");
        assert!(error.contains("stage=v59-predecessor-version"), "{error}");
        assert!(error.contains("table=none"), "{error}");
        assert!(error.contains("database_path="), "{error}");

        let connection = Connection::open(&path).expect("reopen malformed database");
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read unchanged user_version");
        assert_eq!(user_version, 16);

        let parent = path.parent().expect("temporary database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("remove test database directory");
    }

    fn seed_finding_manuscript_switch(connection: &Connection) {
        connection.execute(
            r#"INSERT INTO findings (id, project_id, title, summary, structured_summary, created_at, updated_at)
             VALUES ('finding-1', 'project-1', 'Finding', 'A brief',
               '[{"key":"content","value":"stale nested brief","order":1},{"key":"supportingEvidence","value":"old evidence","order":2},{"key":"extensionField","value":"preserve me","order":99}]',
               '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')"#,
            [],
        ).expect("seed finding");
        for (id, path) in [("file-a", "C:/a.md"), ("file-b", "C:/b.md")] {
            connection.execute(
                "INSERT INTO file_refs (
                   id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
                   location_mode, file_type, path, path_identity_key, title, created_at, updated_at
                 ) VALUES (?1, 'finding', 'finding-1', 'primary', 'file', 'manuscript',
                   'managed', 'markdown', ?2, ?2, ?1, '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')",
                params![id, path],
            ).expect("seed file ref");
        }
        connection.execute(
            "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, manuscript_channel, default_manuscript_file_ref_id,
               current_file_ref_id, created_at, updated_at
             ) VALUES ('binding-1', 'finding', 'finding-1', 'primary', 'file-a', 'file-a',
               '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')",
            [],
        ).expect("seed binding");
    }

    fn finding_switch_input(operation_id: &str) -> CommitOutputManuscriptSwitchInput {
        CommitOutputManuscriptSwitchInput {
            owner_type: "finding".to_string(),
            owner_id: "finding-1".to_string(),
            project_id: "project-1".to_string(),
            expected_current_file_ref_id: "file-a".to_string(),
            next_current_file_ref_id: "file-b".to_string(),
            structured_patch: OutputManuscriptStructuredPatch {
                brief_description: "B brief".to_string(),
                structured_summary: serde_json::json!([
                    {"key":"supportingEvidence","label":"支撑证据","value":"","order":2},
                    {"key":"noveltyDifference","label":"新颖性或差异","value":"","order":3},
                    {"key":"reliabilityJudgement","label":"可靠性判断","value":"","order":4},
                    {"key":"boundaryOrMissingEvidence","label":"边界或缺失证据","value":"","order":5},
                    {"key":"other","label":"其他","value":"","order":6}
                ]),
            },
            source_schema_version: "outputs-manuscript@1".to_string(),
            occurred_at: "2026-07-16T01:00:00Z".to_string(),
            operation_id: operation_id.to_string(),
        }
    }

    fn assert_finding_switch_state(
        connection: &Connection,
        expected_summary: &str,
        expected_current: &str,
        expected_structured_summary: &str,
    ) {
        let (summary, structured_summary): (String, String) = connection.query_row(
            "SELECT summary, structured_summary FROM findings WHERE id = 'finding-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("read finding state");
        let current: String = connection.query_row(
            "SELECT current_file_ref_id FROM manuscript_bindings WHERE id = 'binding-1'",
            [],
            |row| row.get(0),
        ).expect("read binding state");
        assert_eq!(summary, expected_summary);
        assert_eq!(current, expected_current);
        assert_eq!(structured_summary, expected_structured_summary);
    }

    #[test]
    fn output_manuscript_switch_transaction_commits_owner_binding_and_log_together() {
        let path = temporary_database_path("output-switch-commit");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_finding_manuscript_switch(&connection);
        let result = commit_output_manuscript_switch_in_connection(
            &mut connection,
            &finding_switch_input("operation-switch-1"),
        ).expect("commit switch");
        assert_eq!(result.current_file_ref_id, "file-b");
        assert_eq!(result.default_manuscript_file_ref_id.as_deref(), Some("file-a"));
        let (summary, structured): (String, String) = connection.query_row(
            "SELECT summary, structured_summary FROM findings WHERE id = 'finding-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("read finding");
        assert_eq!(summary, "B brief");
        assert!(!structured.contains("\"content\""));
        assert!(structured.contains("extensionField"));
        assert!(structured.contains("preserve me"));
        assert_eq!(result.brief_description, "B brief");
        assert_eq!(result.structured_summary.to_string(), structured);
        assert!(result.nested_duplicate_retired);
        assert!(result.durable_readback_confirmed);
        assert_eq!(result.operation_status, "success");
        let current: String = connection.query_row(
            "SELECT current_file_ref_id FROM manuscript_bindings WHERE id = 'binding-1'",
            [],
            |row| row.get(0),
        ).expect("read binding");
        assert_eq!(current, "file-b");
        let log_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id = 'operation-switch-1'",
            [],
            |row| row.get(0),
        ).expect("read log");
        assert_eq!(log_count, 1);
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    #[test]
    fn output_manuscript_switch_transaction_rolls_back_owner_and_binding_when_log_fails() {
        let path = temporary_database_path("output-switch-rollback");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_finding_manuscript_switch(&connection);
        connection.execute(
            "INSERT INTO operation_logs (
               id, operation_type, source, module, status, risk_level, target, summary,
               actor_id, actor_label, created_at, updated_at
             ) VALUES ('duplicate-operation', 'custom', 'user', 'output', 'success', 'low', '{}',
               'existing', 'local-user', 'Local user', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')",
            [],
        ).expect("seed duplicate operation log");
        let error = commit_output_manuscript_switch_in_connection(
            &mut connection,
            &finding_switch_input("duplicate-operation"),
        ).expect_err("duplicate operation id must roll back transaction");
        assert!(error.contains("OUTPUT_MANUSCRIPT_OPERATION_LOG_FAILED"), "{error}");
        assert_finding_switch_state(
            &connection,
            "A brief",
            "file-a",
            "[{\"key\":\"content\",\"value\":\"stale nested brief\",\"order\":1},{\"key\":\"supportingEvidence\",\"value\":\"old evidence\",\"order\":2},{\"key\":\"extensionField\",\"value\":\"preserve me\",\"order\":99}]",
        );
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    #[test]
    fn output_manuscript_switch_rejects_invalid_patch_without_database_changes() {
        let path = temporary_database_path("output-switch-invalid-patch");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_finding_manuscript_switch(&connection);
        let mut input = finding_switch_input("operation-invalid-patch");
        input.structured_patch.structured_summary = serde_json::json!([
            {"key":"unexpected","label":"Unexpected","value":"value","order":1}
        ]);
        let error = commit_output_manuscript_switch_in_connection(&mut connection, &input)
            .expect_err("invalid patch must be rejected");
        assert!(error.contains("OUTPUT_MANUSCRIPT_PATCH_INVALID"), "{error}");
        assert_finding_switch_state(&connection, "A brief", "file-a", "[{\"key\":\"content\",\"value\":\"stale nested brief\",\"order\":1},{\"key\":\"supportingEvidence\",\"value\":\"old evidence\",\"order\":2},{\"key\":\"extensionField\",\"value\":\"preserve me\",\"order\":99}]");
        let log_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id = 'operation-invalid-patch'",
            [],
            |row| row.get(0),
        ).expect("read log count");
        assert_eq!(log_count, 0);
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    #[test]
    fn output_manuscript_switch_rejects_stale_expected_current_without_database_changes() {
        let path = temporary_database_path("output-switch-stale-current");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_finding_manuscript_switch(&connection);
        let mut input = finding_switch_input("operation-stale-current");
        input.expected_current_file_ref_id = "file-stale".to_string();
        let error = commit_output_manuscript_switch_in_connection(&mut connection, &input)
            .expect_err("stale current must be rejected");
        assert!(error.contains("OUTPUT_MANUSCRIPT_CURRENT_STALE"), "{error}");
        assert_finding_switch_state(&connection, "A brief", "file-a", "[{\"key\":\"content\",\"value\":\"stale nested brief\",\"order\":1},{\"key\":\"supportingEvidence\",\"value\":\"old evidence\",\"order\":2},{\"key\":\"extensionField\",\"value\":\"preserve me\",\"order\":99}]");
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    #[test]
    fn output_manuscript_switch_rolls_back_owner_when_binding_changes_during_transaction() {
        let path = temporary_database_path("output-switch-binding-race");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_finding_manuscript_switch(&connection);
        connection.execute_batch(
            "CREATE TRIGGER simulate_output_switch_binding_race
             AFTER UPDATE OF summary ON findings
             WHEN NEW.id = 'finding-1'
             BEGIN
               UPDATE manuscript_bindings SET current_file_ref_id = 'file-b' WHERE id = 'binding-1';
             END;",
        ).expect("create binding race trigger");
        let error = commit_output_manuscript_switch_in_connection(
            &mut connection,
            &finding_switch_input("operation-binding-race"),
        ).expect_err("binding race must roll back the owner update");
        assert!(error.contains("OUTPUT_MANUSCRIPT_CURRENT_STALE"), "{error}");
        assert_finding_switch_state(&connection, "A brief", "file-a", "[{\"key\":\"content\",\"value\":\"stale nested brief\",\"order\":1},{\"key\":\"supportingEvidence\",\"value\":\"old evidence\",\"order\":2},{\"key\":\"extensionField\",\"value\":\"preserve me\",\"order\":99}]");
        let log_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id = 'operation-binding-race'",
            [],
            |row| row.get(0),
        ).expect("read log count");
        assert_eq!(log_count, 0);
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    fn seed_output_owner_manuscript_switch(connection: &Connection, owner_type: &str) {
        let contract = output_manuscript_owner_contract(owner_type).expect("owner contract");
        let owner_id = format!("{owner_type}-1");
        let existing_structured = serde_json::json!([
            {"key": contract.brief_stable_key, "value": "stale duplicate", "order": 1},
            {"key": contract.structured_keys[0], "value": "old canonical", "order": 2},
            {"key": "extensionField", "value": "preserved unrelated", "order": 99}
        ]).to_string();
        match owner_type {
            "resultItem" => connection.execute(
                "INSERT INTO result_items (id, project_id, source_type, source_id, title, result_type, status, structured_summary, summary, created_at, updated_at)
                 VALUES (?1, 'project-1', 'manual', 'source-1', 'Result', 'text', 'pending_review', ?2, 'old direct', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
                params![owner_id, existing_structured],
            ),
            "finding" => connection.execute(
                "INSERT INTO findings (id, project_id, title, summary, structured_summary, created_at, updated_at)
                 VALUES (?1, 'project-1', 'Finding', 'old direct', ?2, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
                params![owner_id, existing_structured],
            ),
            "outputCandidate" => connection.execute(
                "INSERT INTO output_candidates (id, project_id, title, description, candidate_type, status, structured_summary, created_at, updated_at)
                 VALUES (?1, 'project-1', 'Candidate', 'old direct', 'paper', 'pending_evaluation', ?2, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
                params![owner_id, existing_structured],
            ),
            "outputGap" => connection.execute(
                "INSERT INTO output_gaps (id, project_id, title, description, gap_type, status, structured_summary, created_at, updated_at)
                 VALUES (?1, 'project-1', 'Gap', 'old direct', 'data', 'pending', ?2, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
                params![owner_id, existing_structured],
            ),
            "researchOutput" => connection.execute(
                "INSERT INTO outputs (id, project_id, output_name, output_type, status, structured_summary, usable_for_paper, description, created_at, updated_at)
                 VALUES (?1, 'project-1', 'Output', 'paper', 'draft', ?2, 0, 'old direct', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
                params![owner_id, existing_structured],
            ),
            _ => unreachable!("tested owner"),
        }.expect("seed Outputs owner");
        for (id, path) in [("file-a", "C:/a.md"), ("file-b", "C:/b.md")] {
            connection.execute(
                "INSERT INTO file_refs (
                   id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
                   location_mode, file_type, path, path_identity_key, title, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'primary', 'file', 'manuscript',
                   'managed', 'markdown', ?4, ?4, ?1, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
                params![format!("{owner_type}-{id}"), owner_type, owner_id, format!("{path}/{owner_type}")],
            ).expect("seed owner FileRef");
        }
        connection.execute(
            "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, manuscript_channel, default_manuscript_file_ref_id,
               current_file_ref_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'primary', ?4, ?4, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')",
            params![
                format!("binding-{owner_type}"),
                owner_type,
                owner_id,
                format!("{owner_type}-file-a")
            ],
        ).expect("seed owner Binding");
    }

    fn output_owner_switch_input(
        owner_type: &str,
        operation_id: &str,
        direct_value: &str,
        nested_value: &str,
    ) -> CommitOutputManuscriptSwitchInput {
        let contract = output_manuscript_owner_contract(owner_type).expect("owner contract");
        let structured_summary = Value::Array(
            contract.structured_keys.iter().enumerate().map(|(index, key)| {
                serde_json::json!({
                    "key": key,
                    "value": nested_value,
                    "order": index + 2
                })
            }).collect()
        );
        CommitOutputManuscriptSwitchInput {
            owner_type: owner_type.to_string(),
            owner_id: format!("{owner_type}-1"),
            project_id: "project-1".to_string(),
            expected_current_file_ref_id: format!("{owner_type}-file-a"),
            next_current_file_ref_id: format!("{owner_type}-file-b"),
            structured_patch: OutputManuscriptStructuredPatch {
                brief_description: direct_value.to_string(),
                structured_summary,
            },
            source_schema_version: "outputs-manuscript@1".to_string(),
            occurred_at: "2026-08-09T01:00:00Z".to_string(),
            operation_id: operation_id.to_string(),
        }
    }

    #[test]
    fn output_manuscript_switch_five_owner_exact_set_and_full_clear_retire_duplicates_atomically() {
        for (scenario, direct_value, nested_value) in [
            ("set", "new direct", "new canonical"),
            ("clear", "", ""),
        ] {
            for owner_type in ["resultItem", "finding", "outputCandidate", "outputGap", "researchOutput"] {
                let path = temporary_database_path(&format!("output-switch-{scenario}-{owner_type}"));
                initialize_database_at(&path).expect("initialize database");
                let mut connection = Connection::open(&path).expect("open database");
                connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
                seed_output_owner_manuscript_switch(&connection, owner_type);
                let contract = output_manuscript_owner_contract(owner_type).expect("owner contract");
                let input = output_owner_switch_input(
                    owner_type,
                    &format!("operation-{scenario}-{owner_type}"),
                    direct_value,
                    nested_value,
                );
                let result = commit_output_manuscript_switch_in_connection(&mut connection, &input)
                    .expect("five-owner switch");
                assert_eq!(result.brief_description, direct_value, "{scenario}/{owner_type}");
                assert_eq!(result.current_file_ref_id, format!("{owner_type}-file-b"));
                let expected_default = format!("{owner_type}-file-a");
                assert_eq!(result.default_manuscript_file_ref_id.as_deref(), Some(expected_default.as_str()));
                let fields = result.structured_summary.as_array().expect("structured readback");
                assert!(fields.iter().all(|field| field.get("key").and_then(Value::as_str) != Some(contract.brief_stable_key)));
                for &key in contract.structured_keys {
                    let field = fields.iter().find(|field| field.get("key").and_then(Value::as_str) == Some(key)).expect("canonical field");
                    assert_eq!(field.get("value").and_then(Value::as_str), Some(nested_value));
                }
                assert!(fields.iter().any(|field| field.get("key").and_then(Value::as_str) == Some("extensionField")));
                assert!(result.nested_duplicate_retired);
                assert!(result.durable_readback_confirmed);
                let parent = path.parent().expect("database parent");
                drop(connection);
                std::fs::remove_dir_all(parent).expect("cleanup database");
            }
        }
    }

    #[test]
    fn output_manuscript_switch_failure_injection_rolls_back_every_precommit_stage_and_classifies_readback_failure_as_committed() {
        for failure_point in [
            OutputManuscriptSwitchFailurePoint::AfterDirectUpdate,
            OutputManuscriptSwitchFailurePoint::BeforeDuplicateRetirement,
            OutputManuscriptSwitchFailurePoint::DuringDuplicateRetirement,
            OutputManuscriptSwitchFailurePoint::AfterDuplicateRetirement,
            OutputManuscriptSwitchFailurePoint::BeforeCommit,
        ] {
            let path = temporary_database_path(&format!("output-switch-failure-{failure_point:?}"));
            initialize_database_at(&path).expect("initialize database");
            let mut connection = Connection::open(&path).expect("open database");
            connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
            seed_finding_manuscript_switch(&connection);
            let error = commit_output_manuscript_switch_in_connection_with_failure(
                &mut connection,
                &finding_switch_input(&format!("operation-{failure_point:?}")),
                Some(failure_point),
            ).expect_err("precommit injection must roll back");
            assert!(error.contains("OUTPUT_MANUSCRIPT_TEST_FAILURE"), "{error}");
            assert_finding_switch_state(&connection, "A brief", "file-a", "[{\"key\":\"content\",\"value\":\"stale nested brief\",\"order\":1},{\"key\":\"supportingEvidence\",\"value\":\"old evidence\",\"order\":2},{\"key\":\"extensionField\",\"value\":\"preserve me\",\"order\":99}]");
            let log_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE id = ?1",
                [format!("operation-{failure_point:?}")],
                |row| row.get(0),
            ).expect("read log count");
            assert_eq!(log_count, 0);
            let parent = path.parent().expect("database parent");
            drop(connection);
            std::fs::remove_dir_all(parent).expect("cleanup database");
        }

        let path = temporary_database_path("output-switch-readback-failure");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_finding_manuscript_switch(&connection);
        let error = commit_output_manuscript_switch_in_connection_with_failure(
            &mut connection,
            &finding_switch_input("operation-readback-failure"),
            Some(OutputManuscriptSwitchFailurePoint::DurableReadback),
        ).expect_err("readback injection must report committed uncertainty");
        assert!(error.contains("DURABLE_READBACK_FAILED_COMMIT_CONFIRMED"), "{error}");
        let (summary, structured, current, log_count): (String, String, String, i64) = connection.query_row(
            "SELECT f.summary, f.structured_summary, b.current_file_ref_id,
                    (SELECT COUNT(*) FROM operation_logs WHERE id = 'operation-readback-failure')
             FROM findings f JOIN manuscript_bindings b ON b.owner_id = f.id
             WHERE f.id = 'finding-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).expect("read committed state");
        assert_eq!(summary, "B brief");
        assert!(!structured.contains("\"content\""));
        assert_eq!(current, "file-b");
        assert_eq!(log_count, 1);
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }

    fn output_lifecycle_operation_log_record(
        operation_id: &str,
        owner_type: &str,
        owner_id: &str,
        operation_type: &str,
        occurred_at: &str,
    ) -> Value {
        serde_json::json!({
            "id": operation_id,
            "operation_type": operation_type,
            "source": "user",
            "module": if owner_type == "researchOutput" { "output" } else { "outputConversion" },
            "status": "success",
            "risk_level": "low",
            "target": serde_json::json!({ "entityType": owner_type, "entityId": owner_id }).to_string(),
            "summary": format!("{operation_type} output metadata"),
            "related_entities": "[]",
            "impact_summary": Value::Null,
            "confirmation": Value::Null,
            "feedback": Value::Null,
            "warnings": "[]",
            "errors": "[]",
            "skipped": "[]",
            "is_recoverable": operation_type == "delete",
            "recycle_entry_id": Value::Null,
            "actor_id": "local_user",
            "actor_label": "Local user",
            "refresh_keys": "[]",
            "schema_version": 1,
            "created_at": occurred_at,
            "updated_at": occurred_at,
            "deleted_at": Value::Null
        })
    }

    fn output_lifecycle_recycle_record(
        recycle_id: &str,
        owner_type: &str,
        owner_id: &str,
        operation_id: &str,
        occurred_at: &str,
    ) -> Value {
        let (_, recycle_entity_type) = output_lifecycle_table(owner_type).expect("owner contract");
        serde_json::json!({
            "id": recycle_id,
            "entity_type": recycle_entity_type,
            "entity_id": owner_id,
            "title": owner_id,
            "summary": Value::Null,
            "module": if owner_type == "researchOutput" { "output" } else { "outputConversion" },
            "entity_deleted_at": occurred_at,
            "deleted_by": "user",
            "operation_log_id": operation_id,
            "can_restore": true,
            "cannot_restore_reason": Value::Null,
            "known_impact_summary": Value::Null,
            "restore_status": "not_started",
            "refresh_keys": "[]",
            "schema_version": 1,
            "created_at": occurred_at,
            "updated_at": occurred_at,
            "deleted_at": Value::Null,
            "revision": 0
        })
    }

    #[test]
    fn output_lifecycle_transaction_delete_restore_is_atomic_for_five_owners() {
        for owner_type in [
            "resultItem",
            "finding",
            "outputCandidate",
            "outputGap",
            "researchOutput",
        ] {
            let path = temporary_database_path(&format!("output-lifecycle-{owner_type}"));
            initialize_database_at(&path).expect("initialize database");
            let mut connection = Connection::open(&path).expect("open database");
            connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
            seed_output_owner_manuscript_switch(&connection, owner_type);
            let owner_id = format!("{owner_type}-1");
            let delete_at = "2026-08-12T12:00:00Z";
            let delete_input = CommitOutputLifecycleTransactionInput {
                mode: "softDelete".to_string(),
                owner_type: owner_type.to_string(),
                owner_id: owner_id.clone(),
                occurred_at: delete_at.to_string(),
                operation_log_record: output_lifecycle_operation_log_record(
                    &format!("delete-{owner_type}"),
                    owner_type,
                    &owner_id,
                    "delete",
                    delete_at,
                ),
                recycle_entry_record: Some(output_lifecycle_recycle_record(
                    &format!("recycle-{owner_type}"),
                    owner_type,
                    &owner_id,
                    &format!("delete-{owner_type}"),
                    delete_at,
                )),
                recycle_entry_id: None,
            };
            let deleted = commit_output_lifecycle_transaction_in_connection(
                &mut connection,
                &delete_input,
            ).expect("atomic delete");
            assert_eq!(deleted.owner_deleted_at.as_deref(), Some(delete_at));
            assert!(deleted.durable_readback_confirmed);

            let restore_at = "2026-08-12T12:01:00Z";
            let restore_input = CommitOutputLifecycleTransactionInput {
                mode: "restore".to_string(),
                owner_type: owner_type.to_string(),
                owner_id: owner_id.clone(),
                occurred_at: restore_at.to_string(),
                operation_log_record: output_lifecycle_operation_log_record(
                    &format!("restore-{owner_type}"),
                    owner_type,
                    &owner_id,
                    "restore",
                    restore_at,
                ),
                recycle_entry_record: None,
                recycle_entry_id: Some(format!("recycle-{owner_type}")),
            };
            let restored = commit_output_lifecycle_transaction_in_connection(
                &mut connection,
                &restore_input,
            ).expect("atomic restore");
            assert_eq!(restored.owner_deleted_at, None);
            assert_eq!(restored.recycle_restore_status, "restored");
            assert!(!restored.recycle_can_restore);
            assert!(restored.durable_readback_confirmed);
            let parent = path.parent().expect("database parent");
            drop(connection);
            std::fs::remove_dir_all(parent).expect("cleanup database");
        }
    }

    #[test]
    fn output_lifecycle_transaction_required_effect_failure_rolls_back_owner_and_effects() {
        let path = temporary_database_path("output-lifecycle-required-effect-failure");
        initialize_database_at(&path).expect("initialize database");
        let mut connection = Connection::open(&path).expect("open database");
        connection.execute_batch("PRAGMA foreign_keys = ON;").expect("foreign keys");
        seed_output_owner_manuscript_switch(&connection, "finding");
        connection.execute_batch(
            "CREATE TRIGGER fail_output_recycle_effect
             BEFORE INSERT ON recycle_entries
             BEGIN
               SELECT RAISE(FAIL, 'injected required recycle effect failure');
             END;"
        ).expect("install failure trigger");
        let occurred_at = "2026-08-12T12:00:00Z";
        let input = CommitOutputLifecycleTransactionInput {
            mode: "softDelete".to_string(),
            owner_type: "finding".to_string(),
            owner_id: "finding-1".to_string(),
            occurred_at: occurred_at.to_string(),
            operation_log_record: output_lifecycle_operation_log_record(
                "delete-finding-failure",
                "finding",
                "finding-1",
                "delete",
                occurred_at,
            ),
            recycle_entry_record: Some(output_lifecycle_recycle_record(
                "recycle-finding-failure",
                "finding",
                "finding-1",
                "delete-finding-failure",
                occurred_at,
            )),
            recycle_entry_id: None,
        };
        let error = commit_output_lifecycle_transaction_in_connection(&mut connection, &input)
            .expect_err("required effect failure must abort the transaction");
        assert!(error.contains("injected required recycle effect failure"), "{error}");
        let (deleted_at, log_count, recycle_count): (Option<String>, i64, i64) = connection
            .query_row(
                "SELECT deleted_at,
                        (SELECT COUNT(*) FROM operation_logs WHERE id='delete-finding-failure'),
                        (SELECT COUNT(*) FROM recycle_entries WHERE id='recycle-finding-failure')
                 FROM findings WHERE id='finding-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read rolled-back state");
        assert_eq!(deleted_at, None);
        assert_eq!(log_count, 0);
        assert_eq!(recycle_count, 0);
        let parent = path.parent().expect("database parent");
        drop(connection);
        std::fs::remove_dir_all(parent).expect("cleanup database");
    }
}
