use super::open_connection;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

const RUN_KEYS: [&str; 6] = [
    "conditionSummary",
    "variableParameterSummary",
    "methodSummary",
    "resultSummary",
    "conclusion",
    "summaryOther",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunOutlineReplacement {
    pub(crate) key: String,
    pub(crate) action: String,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchAudit {
    pub(crate) actor_id: String,
    pub(crate) actor_label: String,
    pub(crate) source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchTransactionInput {
    pub(crate) operation_id: String,
    pub(crate) owner_type: String,
    pub(crate) run_id: String,
    pub(crate) experiment_id: String,
    pub(crate) project_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) binding_id: String,
    pub(crate) expected_binding_updated_at: String,
    pub(crate) expected_current_file_ref_id: String,
    pub(crate) expected_current_path_identity: String,
    pub(crate) expected_default_manuscript_file_ref_id: String,
    pub(crate) expected_default_path_identity: String,
    pub(crate) target_file_ref_id: String,
    pub(crate) target_path_identity: String,
    pub(crate) target_location_mode: String,
    pub(crate) outline_replacements: Vec<ExperimentRunOutlineReplacement>,
    pub(crate) old_current_writeback_completed: bool,
    pub(crate) old_current_post_revision: String,
    pub(crate) target_physical_revision: String,
    pub(crate) occurred_at: String,
    pub(crate) log_summary: String,
    pub(crate) audit: ExperimentRunSwitchAudit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchTransactionResult {
    pub(crate) run_id: String,
    pub(crate) binding_id: String,
    pub(crate) previous_current_file_ref_id: String,
    pub(crate) current_file_ref_id: String,
    pub(crate) default_manuscript_file_ref_id: String,
    pub(crate) operation_log_id: String,
    pub(crate) run_updated_at: String,
    pub(crate) binding_updated_at: String,
}

#[derive(Debug)]
struct FileRefRow {
    owner_type: String,
    owner_id: String,
    channel: String,
    resource_kind: String,
    file_role: String,
    location_mode: String,
    path_identity: String,
    deleted_at: Option<String>,
}

fn validate_input(input: &ExperimentRunSwitchTransactionInput) -> Result<(), String> {
    if input.owner_type != "experimentRun"
        || input.manuscript_channel != "primary"
        || input.outline_replacements.len() != RUN_KEYS.len()
        || !input.old_current_writeback_completed
        || input.operation_id.trim().is_empty()
        || input.old_current_post_revision.trim().is_empty()
        || input.target_physical_revision.trim().is_empty()
        || input.audit.source != "user"
        || input.audit.actor_id.trim().is_empty()
        || input.audit.actor_label.trim().is_empty()
        || input.log_summary.trim().is_empty()
        || input.log_summary.len() > 200
        || input.log_summary.contains(['\r', '\n'])
    {
        return Err("RUN_SWITCH_TRANSACTION_INPUT_INVALID".into());
    }
    if input.expected_current_file_ref_id == input.target_file_ref_id {
        return Err("RUN_SWITCH_ALREADY_CURRENT".into());
    }
    for (index, replacement) in input.outline_replacements.iter().enumerate() {
        if replacement.key != RUN_KEYS[index] {
            return Err("RUN_SWITCH_REPLACEMENT_KEY_INVALID".into());
        }
        match (replacement.action.as_str(), replacement.value.as_deref()) {
            ("clear", None) => {}
            ("set", Some(value)) if !value.trim().is_empty() => {}
            _ => return Err("RUN_SWITCH_REPLACEMENT_VALUE_INVALID".into()),
        }
    }
    Ok(())
}

fn file_ref(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
) -> Result<Option<FileRefRow>, String> {
    transaction
        .query_row(
            "SELECT owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                    location_mode,path_identity_key,deleted_at
             FROM file_refs WHERE id=?1",
            [id],
            |row| {
                Ok(FileRefRow {
                    owner_type: row.get(0)?,
                    owner_id: row.get(1)?,
                    channel: row.get(2)?,
                    resource_kind: row.get(3)?,
                    file_role: row.get(4)?,
                    location_mode: row.get(5)?,
                    path_identity: row.get(6)?,
                    deleted_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("RUN_SWITCH_FILE_REF_READ_FAILED: {error}"))
}

fn validate_run_file(
    row: Option<FileRefRow>,
    input: &ExperimentRunSwitchTransactionInput,
    expected_path_identity: &str,
    expected_location_mode: Option<&str>,
    invalid_code: &str,
    owner_code: &str,
) -> Result<FileRefRow, String> {
    let Some(row) = row else {
        return Err(invalid_code.into());
    };
    if row.owner_type != "experimentRun" || row.owner_id != input.run_id {
        return Err(owner_code.into());
    }
    if row.deleted_at.is_some()
        || row.channel != "primary"
        || row.resource_kind != "file"
        || row.file_role != "manuscript"
        || !matches!(row.location_mode.as_str(), "managed" | "external")
        || row.path_identity != expected_path_identity
        || expected_location_mode.is_some_and(|mode| row.location_mode != mode)
    {
        return Err(invalid_code.into());
    }
    Ok(row)
}

fn replacement_value(replacement: &ExperimentRunOutlineReplacement) -> Option<String> {
    match replacement.action.as_str() {
        "set" => replacement.value.clone(),
        "clear" => None,
        _ => unreachable!("validated replacement"),
    }
}

pub(crate) fn commit_experiment_run_switch_in_connection(
    connection: &mut Connection,
    input: &ExperimentRunSwitchTransactionInput,
) -> Result<ExperimentRunSwitchTransactionResult, String> {
    validate_input(input)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("RUN_SWITCH_TRANSACTION_BEGIN_FAILED: {error}"))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("RUN_SWITCH_TRANSACTION_BEGIN_FAILED: {error}"))?;

    let existing_operation: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id=?1 AND deleted_at IS NULL",
            [&input.operation_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("RUN_SWITCH_OPERATION_LOG_READ_FAILED: {error}"))?;
    if existing_operation != 0 {
        return Err("RUN_SWITCH_IN_PROGRESS".into());
    }

    let parent = transaction
        .query_row(
            "SELECT project_id,updated_at,deleted_at FROM experiments WHERE id=?1",
            [&input.experiment_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
        )
        .optional()
        .map_err(|error| format!("RUN_SWITCH_PARENT_READ_FAILED: {error}"))?;
    let Some((parent_project_id, _parent_updated_at, parent_deleted_at)) = parent else {
        return Err("RUN_SWITCH_PARENT_MISSING".into());
    };
    if parent_deleted_at.is_some() {
        return Err("RUN_SWITCH_PARENT_DELETED".into());
    }
    if parent_project_id != input.project_id {
        return Err("RUN_SWITCH_PARENT_MISSING".into());
    }

    let run = transaction
        .query_row(
            "SELECT experiment_id,project_id,updated_at,deleted_at FROM experiment_runs WHERE id=?1",
            [&input.run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("RUN_SWITCH_OWNER_READ_FAILED: {error}"))?;
    let Some((experiment_id, run_project_id, _run_updated_at, run_deleted_at)) = run else {
        return Err("RUN_SWITCH_OWNER_MISSING".into());
    };
    if run_deleted_at.is_some() {
        return Err("RUN_SWITCH_OWNER_DELETED".into());
    }
    if experiment_id != input.experiment_id
        || run_project_id != input.project_id
        || run_project_id != parent_project_id
    {
        return Err("RUN_SWITCH_TARGET_OWNER_MISMATCH".into());
    }

    let binding = transaction
        .query_row(
            "SELECT id,current_file_ref_id,default_manuscript_file_ref_id,updated_at
             FROM manuscript_bindings
             WHERE owner_type='experimentRun' AND owner_id=?1
               AND manuscript_channel='primary' AND deleted_at IS NULL",
            [&input.run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("RUN_SWITCH_BINDING_READ_FAILED: {error}"))?;
    let Some((binding_id, current_id, default_id, binding_updated_at)) = binding else {
        return Err("RUN_SWITCH_BINDING_MISSING".into());
    };
    if binding_id != input.binding_id
        || binding_updated_at != input.expected_binding_updated_at
        || current_id.as_deref() != Some(input.expected_current_file_ref_id.as_str())
    {
        return Err("RUN_SWITCH_CURRENT_MISMATCH".into());
    }
    if default_id.as_deref() != Some(input.expected_default_manuscript_file_ref_id.as_str()) {
        return Err("RUN_SWITCH_DEFAULT_MISMATCH".into());
    }

    let current = validate_run_file(
        file_ref(&transaction, &input.expected_current_file_ref_id)?,
        input,
        &input.expected_current_path_identity,
        None,
        "RUN_SWITCH_CURRENT_MISMATCH",
        "RUN_SWITCH_CURRENT_MISMATCH",
    )?;
    validate_run_file(
        file_ref(&transaction, &input.expected_default_manuscript_file_ref_id)?,
        input,
        &input.expected_default_path_identity,
        None,
        "RUN_SWITCH_DEFAULT_MISMATCH",
        "RUN_SWITCH_DEFAULT_MISMATCH",
    )?;
    let target = validate_run_file(
        file_ref(&transaction, &input.target_file_ref_id)?,
        input,
        &input.target_path_identity,
        Some(&input.target_location_mode),
        "RUN_SWITCH_TARGET_INVALID",
        "RUN_SWITCH_TARGET_OWNER_MISMATCH",
    )?;
    if current.path_identity == target.path_identity {
        return Err("RUN_SWITCH_TARGET_CONFLICT".into());
    }
    let cross_owner_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM file_refs
             WHERE path_identity_key=?1 AND deleted_at IS NULL
               AND NOT (owner_type='experimentRun' AND owner_id=?2)",
            params![input.target_path_identity, input.run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("RUN_SWITCH_TARGET_VALIDATION_FAILED: {error}"))?;
    if cross_owner_count != 0 {
        return Err("RUN_SWITCH_TARGET_OWNER_MISMATCH".into());
    }

    let values: Vec<Option<String>> = input
        .outline_replacements
        .iter()
        .map(replacement_value)
        .collect();
    let run_changed = transaction
        .execute(
            "UPDATE experiment_runs SET
               condition_summary=?1,variable_parameter_summary=?2,method_summary=?3,
               result_summary=?4,conclusion=?5,summary_other=?6,updated_at=?7
             WHERE id=?8 AND experiment_id=?9 AND project_id=?10
               AND deleted_at IS NULL",
            params![
                values[0], values[1], values[2], values[3], values[4], values[5],
                input.occurred_at, input.run_id, input.experiment_id, input.project_id
            ],
        )
        .map_err(|error| format!("RUN_SWITCH_OWNER_UPDATE_FAILED: {error}"))?;
    if run_changed != 1 {
        return Err("RUN_SWITCH_OWNER_DELETED".into());
    }

    let binding_changed = transaction
        .execute(
            "UPDATE manuscript_bindings SET current_file_ref_id=?1,updated_at=?2
             WHERE id=?3 AND owner_type='experimentRun' AND owner_id=?4
               AND manuscript_channel='primary' AND current_file_ref_id=?5
               AND default_manuscript_file_ref_id=?6 AND updated_at=?7
               AND deleted_at IS NULL",
            params![
                input.target_file_ref_id,
                input.occurred_at,
                input.binding_id,
                input.run_id,
                input.expected_current_file_ref_id,
                input.expected_default_manuscript_file_ref_id,
                input.expected_binding_updated_at
            ],
        )
        .map_err(|error| format!("RUN_SWITCH_BINDING_UPDATE_FAILED: {error}"))?;
    if binding_changed != 1 {
        return Err("RUN_SWITCH_CURRENT_MISMATCH".into());
    }

    let target_json = serde_json::json!({
        "entityType": "experimentRun",
        "entityId": input.run_id
    });
    let related_json = serde_json::json!([
        {"type":"fileRef","id":input.expected_current_file_ref_id,"relation":"previousCurrent"},
        {"type":"fileRef","id":input.target_file_ref_id,"relation":"current"}
    ]);
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
        "affectedEntities": related_json,
        "refreshKeys": ["experimentRun.changed", "fileRef.changed", "operationLog.changed"],
        "details": {
            "ownerType": "experimentRun",
            "fromCurrentFileRefId": input.expected_current_file_ref_id,
            "toCurrentFileRefId": input.target_file_ref_id,
            "defaultUnchanged": true,
            "outlineFullReplacement": true,
            "oldCurrentWritebackCompleted": true,
            "oldCurrentPostRevision": input.old_current_post_revision,
            "targetPhysicalRevision": input.target_physical_revision,
            "targetPhysicalWriteCount": 0
        }
    });
    let refresh_keys = serde_json::json!([
        "experimentRun.changed",
        "fileRef.changed",
        "operationLog.changed"
    ]);
    transaction
        .execute(
            "INSERT INTO operation_logs (
               id,operation_type,source,module,status,risk_level,target,summary,
               related_entities,confirmation,feedback,warnings,errors,skipped,
               is_recoverable,actor_id,actor_label,refresh_keys,schema_version,
               created_at,updated_at,deleted_at
             ) VALUES (?1,'custom','user','experiment','success','medium',?2,?3,
               ?4,?5,?6,'[]','[]','[]',0,?7,?8,?9,1,?10,?10,NULL)",
            params![
                input.operation_id,
                target_json.to_string(),
                input.log_summary,
                related_json.to_string(),
                confirmation_json.to_string(),
                feedback_json.to_string(),
                input.audit.actor_id,
                input.audit.actor_label,
                refresh_keys.to_string(),
                input.occurred_at
            ],
        )
        .map_err(|error| format!("RUN_SWITCH_OPERATION_LOG_FAILED: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("RUN_SWITCH_TRANSACTION_COMMIT_FAILED: {error}"))?;
    Ok(ExperimentRunSwitchTransactionResult {
        run_id: input.run_id.clone(),
        binding_id,
        previous_current_file_ref_id: input.expected_current_file_ref_id.clone(),
        current_file_ref_id: input.target_file_ref_id.clone(),
        default_manuscript_file_ref_id: input
            .expected_default_manuscript_file_ref_id
            .clone(),
        operation_log_id: input.operation_id.clone(),
        run_updated_at: input.occurred_at.clone(),
        binding_updated_at: input.occurred_at.clone(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn commit_experiment_run_manuscript_switch(
    app_handle: AppHandle,
    input: ExperimentRunSwitchTransactionInput,
) -> Result<ExperimentRunSwitchTransactionResult, String> {
    let mut connection = open_connection(&app_handle)?;
    commit_experiment_run_switch_in_connection(&mut connection, &input)
}
