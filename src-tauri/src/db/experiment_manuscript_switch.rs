use super::open_connection;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

const EXPERIMENT_KEYS: [&str; 6] = [
    "purposeAndQuestion",
    "conditionSummary",
    "methodSummary",
    "resultSummary",
    "conclusionAndNextSteps",
    "other",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentOutlineReplacement {
    pub(crate) key: String,
    pub(crate) action: String,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentSwitchAudit {
    pub(crate) actor_id: String,
    pub(crate) actor_label: String,
    pub(crate) source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentOwnerSwitchReplacementInput {
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) project_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) binding_id: String,
    pub(crate) expected_binding_updated_at: String,
    pub(crate) expected_current_file_ref_id: String,
    pub(crate) expected_default_manuscript_file_ref_id: String,
    pub(crate) expected_default_path_identity: String,
    pub(crate) target_file_ref_id: String,
    pub(crate) target_path_identity: String,
    pub(crate) target_location_mode: String,
    pub(crate) outline_replacements: Vec<ExperimentOutlineReplacement>,
    pub(crate) outline_digest: String,
    pub(crate) old_current_post_revision: String,
    pub(crate) target_physical_revision: String,
    pub(crate) occurred_at: String,
    pub(crate) operation_id: String,
    pub(crate) correlation_id: String,
    pub(crate) audit: ExperimentSwitchAudit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentOwnerSwitchPostVerify {
    owner_id: String,
    binding_id: String,
    previous_current_file_ref_id: String,
    current_file_ref_id: String,
    default_manuscript_file_ref_id: String,
    operation_log_id: String,
    owner_updated_at: String,
    binding_updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentOwnerSwitchPostVerifyReadInput {
    owner_id: String,
    binding_id: String,
    target_file_ref_id: String,
    operation_id: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExperimentOutlinePostVerifyValues {
    purpose_and_question: Option<String>,
    condition_summary: Option<String>,
    method_summary: Option<String>,
    result_summary: Option<String>,
    conclusion_and_next_steps: Option<String>,
    other: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentOwnerSwitchDirectReadback {
    database_read_source: &'static str,
    owner_id: String,
    owner_found: bool,
    binding_id: String,
    binding_found: bool,
    current_file_ref_id: Option<String>,
    default_manuscript_file_ref_id: Option<String>,
    outline: ExperimentOutlinePostVerifyValues,
    target_file_ref_valid: bool,
    operation_log_id: String,
    operation_log_status: Option<String>,
    operation_log_recoverable: Option<bool>,
    operation_log_phase: Option<String>,
    owner_updated_at: Option<String>,
    binding_updated_at: Option<String>,
}

pub(crate) fn read_experiment_owner_switch_post_verify_in_connection(
    connection: &Connection,
    input: &ExperimentOwnerSwitchPostVerifyReadInput,
) -> Result<ExperimentOwnerSwitchDirectReadback, String> {
    let owner = connection
        .query_row(
            "SELECT purpose_and_question,condition_summary,method_summary,result_summary,
                    conclusion_and_next_steps,other,updated_at
             FROM experiments WHERE id=?1 AND deleted_at IS NULL",
            [&input.owner_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "POST_VERIFY_DATABASE_READ_FAILED".to_string())?;
    let binding = connection
        .query_row(
            "SELECT current_file_ref_id,default_manuscript_file_ref_id,updated_at
             FROM manuscript_bindings
             WHERE id=?1 AND owner_type='experiment' AND owner_id=?2
               AND manuscript_channel='primary' AND deleted_at IS NULL",
            params![input.binding_id, input.owner_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "POST_VERIFY_DATABASE_READ_FAILED".to_string())?;
    let target_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM file_refs
             WHERE id=?1 AND owner_type='experiment' AND owner_id=?2
               AND manuscript_channel='primary' AND resource_kind='file'
               AND file_role='manuscript' AND deleted_at IS NULL",
            params![input.target_file_ref_id, input.owner_id],
            |row| row.get(0),
        )
        .map_err(|_| "POST_VERIFY_DATABASE_READ_FAILED".to_string())?;
    let operation_log = connection
        .query_row(
            "SELECT status,is_recoverable FROM operation_logs
             WHERE id=?1 AND module='experiment' AND deleted_at IS NULL",
            [&input.operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "POST_VERIFY_DATABASE_READ_FAILED".to_string())?;

    let (outline, owner_updated_at, owner_found) = match owner {
        Some(value) => (
            ExperimentOutlinePostVerifyValues {
                purpose_and_question: value.0,
                condition_summary: value.1,
                method_summary: value.2,
                result_summary: value.3,
                conclusion_and_next_steps: value.4,
                other: value.5,
            },
            Some(value.6),
            true,
        ),
        None => (ExperimentOutlinePostVerifyValues::default(), None, false),
    };
    let (current_file_ref_id, default_manuscript_file_ref_id, binding_updated_at, binding_found) =
        match binding {
            Some(value) => (value.0, value.1, Some(value.2), true),
            None => (None, None, None, false),
        };
    let (operation_log_status, operation_log_recoverable, operation_log_phase) = match operation_log
    {
        Some((status, recoverable)) => (
            Some(status),
            Some(recoverable != 0),
            connection.query_row(
                "SELECT phase FROM experiment_manuscript_switch_recoveries WHERE operation_id=?1",
                [&input.operation_id], |row| row.get(0),
            ).optional().ok().flatten(),
        ),
        None => (None, None, None),
    };

    Ok(ExperimentOwnerSwitchDirectReadback {
        database_read_source: "sqlite-direct-post-commit",
        owner_id: input.owner_id.clone(),
        owner_found,
        binding_id: input.binding_id.clone(),
        binding_found,
        current_file_ref_id,
        default_manuscript_file_ref_id,
        outline,
        target_file_ref_valid: target_count == 1,
        operation_log_id: input.operation_id.clone(),
        operation_log_status,
        operation_log_recoverable,
        operation_log_phase,
        owner_updated_at,
        binding_updated_at,
    })
}

fn validate_input(input: &ExperimentOwnerSwitchReplacementInput) -> Result<(), String> {
    if input.owner_type != "experiment"
        || input.manuscript_channel != "primary"
        || input.outline_replacements.len() != EXPERIMENT_KEYS.len()
        || input.audit.source != "user"
        || input.audit.actor_id.trim().is_empty()
        || input.audit.actor_label.trim().is_empty()
        || input.correlation_id.trim().is_empty()
        || input.outline_digest.trim().is_empty()
        || input.old_current_post_revision.trim().is_empty()
        || input.target_physical_revision.trim().is_empty()
    {
        return Err("EXPERIMENT_FORMAL_SWITCH_REPLACEMENT_INVALID".into());
    }
    for (index, replacement) in input.outline_replacements.iter().enumerate() {
        if replacement.key != EXPERIMENT_KEYS[index] {
            return Err("EXPERIMENT_FORMAL_SWITCH_REPLACEMENT_KEY_INVALID".into());
        }
        match (replacement.action.as_str(), replacement.value.as_deref()) {
            ("clear", None) => {}
            ("set", Some(value)) if !value.trim().is_empty() => {}
            _ => return Err("EXPERIMENT_FORMAL_SWITCH_REPLACEMENT_ACTION_INVALID".into()),
        }
    }
    Ok(())
}

fn replacement_value(replacement: &ExperimentOutlineReplacement, required: bool) -> Option<String> {
    match replacement.action.as_str() {
        "set" => replacement.value.clone(),
        "clear" if required => Some(String::new()),
        "clear" => None,
        _ => unreachable!("validated replacement"),
    }
}

fn validate_file_ref(
    transaction: &rusqlite::Transaction<'_>,
    input: &ExperimentOwnerSwitchReplacementInput,
    file_ref_id: &str,
    expected_path_identity: &str,
    expected_location_mode: Option<&str>,
    error_code: &str,
) -> Result<(), String> {
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM file_refs
             WHERE id=?1 AND owner_type='experiment' AND owner_id=?2
               AND manuscript_channel='primary' AND resource_kind='file'
               AND file_role='manuscript' AND deleted_at IS NULL
               AND path_identity_key=?3
               AND (?4 IS NULL OR location_mode=?4)",
            params![
                file_ref_id,
                input.owner_id,
                expected_path_identity,
                expected_location_mode
            ],
            |row| row.get(0),
        )
        .map_err(|error| format!("{error_code}: {error}"))?;
    if count != 1 {
        return Err(error_code.into());
    }
    Ok(())
}

pub(crate) fn commit_experiment_replacement_in_connection(
    connection: &mut Connection,
    input: &ExperimentOwnerSwitchReplacementInput,
) -> Result<ExperimentOwnerSwitchPostVerify, String> {
    validate_input(input)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_TRANSACTION_BEGIN_FAILED: {error}"))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_TRANSACTION_BEGIN_FAILED: {error}"))?;

    let owner: Option<String> = transaction
        .query_row(
            "SELECT project_id FROM experiments
             WHERE id=?1 AND deleted_at IS NULL",
            [&input.owner_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_OWNER_READ_FAILED: {error}"))?;
    let Some(project_id) = owner else {
        return Err("EXPERIMENT_FORMAL_SWITCH_OWNER_UNAVAILABLE".into());
    };
    if project_id != input.project_id {
        return Err("EXPERIMENT_FORMAL_SWITCH_OWNER_CHANGED".into());
    }

    let binding: Option<(String, Option<String>, Option<String>, String)> = transaction
        .query_row(
            "SELECT id,current_file_ref_id,default_manuscript_file_ref_id,updated_at
             FROM manuscript_bindings
             WHERE owner_type='experiment' AND owner_id=?1
               AND manuscript_channel='primary' AND deleted_at IS NULL",
            [&input.owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_BINDING_READ_FAILED: {error}"))?;
    let Some((binding_id, current_file_ref_id, default_file_ref_id, binding_updated_at)) = binding
    else {
        return Err("EXPERIMENT_FORMAL_SWITCH_BINDING_INVALID".into());
    };
    if binding_id != input.binding_id
        || binding_updated_at != input.expected_binding_updated_at
        || current_file_ref_id.as_deref() != Some(input.expected_current_file_ref_id.as_str())
    {
        return Err("EXPERIMENT_FORMAL_SWITCH_CURRENT_CHANGED".into());
    }
    if default_file_ref_id.as_deref()
        != Some(input.expected_default_manuscript_file_ref_id.as_str())
    {
        return Err("EXPERIMENT_FORMAL_SWITCH_DEFAULT_CHANGED".into());
    }

    validate_file_ref(
        &transaction,
        input,
        &input.expected_default_manuscript_file_ref_id,
        &input.expected_default_path_identity,
        None,
        "EXPERIMENT_FORMAL_SWITCH_DEFAULT_CHANGED",
    )?;
    validate_file_ref(
        &transaction,
        input,
        &input.target_file_ref_id,
        &input.target_path_identity,
        Some(&input.target_location_mode),
        "EXPERIMENT_FORMAL_SWITCH_TARGET_CHANGED",
    )?;

    let recovery_phase: Option<(String, String, String, String, String, String)> = transaction
        .query_row(
            "SELECT phase,experiment_id,binding_id,old_current_file_ref_id,target_file_ref_id,default_file_ref_id
             FROM experiment_manuscript_switch_recoveries WHERE operation_id=?1",
            [&input.operation_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
        )
        .optional()
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_RECOVERY_READ_FAILED: {error}"))?;
    let Some((phase,recovery_owner,recovery_binding,recovery_old,recovery_target,recovery_default)) = recovery_phase else {
        return Err("EXPERIMENT_FORMAL_SWITCH_RECOVERY_NOT_FOUND".into());
    };
    if !matches!(phase.as_str(), "writeback_applied" | "db_commit_unknown")
        || recovery_owner != input.owner_id || recovery_binding != input.binding_id
        || recovery_old != input.expected_current_file_ref_id || recovery_target != input.target_file_ref_id
        || recovery_default != input.expected_default_manuscript_file_ref_id
    {
        return Err("EXPERIMENT_FORMAL_SWITCH_RECOVERY_PHASE_INVALID".into());
    }

    let values: Vec<Option<String>> = input
        .outline_replacements
        .iter()
        .enumerate()
        .map(|(index, replacement)| replacement_value(replacement, index == 3))
        .collect();
    let owner_changed = transaction
        .execute(
            "UPDATE experiments SET
               purpose_and_question=?1,condition_summary=?2,method_summary=?3,result_summary=?4,
               conclusion_and_next_steps=?5,other=?6,updated_at=?7
             WHERE id=?8 AND project_id=?9 AND deleted_at IS NULL",
            params![
                values[0],
                values[1],
                values[2],
                values[3],
                values[4],
                values[5],
                input.occurred_at,
                input.owner_id,
                input.project_id
            ],
        )
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_OWNER_UPDATE_FAILED: {error}"))?;
    if owner_changed != 1 {
        return Err("EXPERIMENT_FORMAL_SWITCH_OWNER_CHANGED".into());
    }

    let binding_changed = transaction
        .execute(
            "UPDATE manuscript_bindings
             SET current_file_ref_id=?1,updated_at=?2
             WHERE id=?3 AND current_file_ref_id=?4
               AND default_manuscript_file_ref_id=?5 AND updated_at=?6
               AND deleted_at IS NULL",
            params![
                input.target_file_ref_id,
                input.occurred_at,
                input.binding_id,
                input.expected_current_file_ref_id,
                input.expected_default_manuscript_file_ref_id,
                input.expected_binding_updated_at
            ],
        )
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_BINDING_UPDATE_FAILED: {error}"))?;
    if binding_changed != 1 {
        return Err("EXPERIMENT_FORMAL_SWITCH_CURRENT_CHANGED".into());
    }

    let feedback = serde_json::json!({
        "status":"success",
        "details":{"code":"EXPERIMENT_FORMAL_SWITCH_COMMITTED","operationId":input.operation_id}
    }).to_string();
    let log_changed = transaction
        .execute(
            "INSERT INTO operation_logs (
               id,operation_type,source,module,status,risk_level,target,summary,
               related_entities,confirmation,feedback,warnings,errors,skipped,
               is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at
             ) VALUES (?1,'custom','user','experiment','success','medium',?2,
               'Experiment formal manuscript switch','[]',?3,?4,'[]','[]','[]',0,?5,?6,
               '[\"experiment.changed\",\"fileRef.changed\",\"operationLog.changed\"]',1,?7,?7)",
            params![input.operation_id,
                serde_json::json!({"entityType":"experiment","entityId":input.owner_id}).to_string(),
                serde_json::json!({"required":true,"confirmedByUser":true,"confirmedAt":input.occurred_at,"confirmationId":input.correlation_id}).to_string(),
                feedback,input.audit.actor_id,input.audit.actor_label,input.occurred_at],
        )
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_OPERATION_LOG_FAILED: {error}"))?;
    if log_changed != 1 {
        return Err("EXPERIMENT_FORMAL_SWITCH_OPERATION_LOG_FAILED".into());
    }

    // The shared FormalSwitchEngine is the only phase owner. The owner
    // transaction records atomic commit evidence but deliberately leaves the
    // recovery in db_commit_unknown until direct post-verify advances it.
    let recovery_changed = transaction.execute(
        "UPDATE experiment_manuscript_switch_recoveries
         SET transaction_attempted_at=?1,operation_log_observed=1,
             observed_current_file_ref_id=?2,observed_default_file_ref_id=?3,
             observed_outline_digest=?4,last_error_code=NULL,updated_at=?1
         WHERE operation_id=?5 AND phase='db_commit_unknown'",
        params![input.occurred_at,input.target_file_ref_id,input.expected_default_manuscript_file_ref_id,input.outline_digest,input.operation_id],
    ).map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_RECOVERY_UPDATE_FAILED: {error}"))?;
    if recovery_changed != 1 { return Err("EXPERIMENT_FORMAL_SWITCH_RECOVERY_UPDATE_FAILED".into()); }

    let verified_outline: (
        Option<String>, Option<String>, Option<String>, String,
        Option<String>, Option<String>, String,
    ) = transaction
        .query_row(
            "SELECT purpose_and_question,condition_summary,method_summary,result_summary,
                    conclusion_and_next_steps,other,updated_at
             FROM experiments WHERE id=?1 AND deleted_at IS NULL",
            [&input.owner_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED: {error}"))?;
    let actual: Vec<Option<String>> = vec![
        verified_outline.0.clone(),
        verified_outline.1.clone(),
        verified_outline.2.clone(),
        Some(verified_outline.3.clone()),
        verified_outline.4.clone(),
        verified_outline.5.clone(),
    ];
    if actual != values {
        return Err("EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED".into());
    }
    let verified_binding: (String, String, String) = transaction
        .query_row(
            "SELECT current_file_ref_id,default_manuscript_file_ref_id,updated_at
             FROM manuscript_bindings WHERE id=?1 AND deleted_at IS NULL",
            [&input.binding_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED: {error}"))?;
    if verified_binding.0 != input.target_file_ref_id
        || verified_binding.1 != input.expected_default_manuscript_file_ref_id
    {
        return Err("EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED".into());
    }
    let verified_log: (String, i64, String) = transaction
        .query_row(
            "SELECT l.status,l.is_recoverable,r.phase FROM operation_logs l
             JOIN experiment_manuscript_switch_recoveries r ON r.operation_id=l.id WHERE l.id=?1",
            [&input.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED: {error}"))?;
    if verified_log.0 != "success"
        || verified_log.1 != 0
        || verified_log.2 != "db_commit_unknown"
    {
        return Err("EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED".into());
    }

    transaction
        .commit()
        .map_err(|error| format!("EXPERIMENT_FORMAL_SWITCH_TRANSACTION_COMMIT_FAILED: {error}"))?;
    Ok(ExperimentOwnerSwitchPostVerify {
        owner_id: input.owner_id.clone(),
        binding_id,
        previous_current_file_ref_id: input.expected_current_file_ref_id.clone(),
        current_file_ref_id: input.target_file_ref_id.clone(),
        default_manuscript_file_ref_id: input.expected_default_manuscript_file_ref_id.clone(),
        operation_log_id: input.operation_id.clone(),
        owner_updated_at: verified_outline.6,
        binding_updated_at: verified_binding.2,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn commit_experiment_owner_switch_replacement(
    app_handle: AppHandle,
    input: ExperimentOwnerSwitchReplacementInput,
) -> Result<ExperimentOwnerSwitchPostVerify, String> {
    let mut connection = open_connection(&app_handle)?;
    commit_experiment_replacement_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn read_experiment_owner_switch_post_verify(
    app_handle: AppHandle,
    input: ExperimentOwnerSwitchPostVerifyReadInput,
) -> Result<ExperimentOwnerSwitchDirectReadback, String> {
    let connection = open_connection(&app_handle)?;
    read_experiment_owner_switch_post_verify_in_connection(&connection, &input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn schema(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL);
                 CREATE TABLE experiments (
                   id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,rating TEXT,tags TEXT,
                   purpose_and_question TEXT,condition_summary TEXT,
                   method_summary TEXT,result_summary TEXT NOT NULL,conclusion_and_next_steps TEXT,
                   other TEXT,updated_at TEXT NOT NULL,deleted_at TEXT);
                 CREATE TABLE manuscript_bindings (
                   id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,
                   manuscript_channel TEXT NOT NULL,current_file_ref_id TEXT,
                   default_manuscript_file_ref_id TEXT,updated_at TEXT NOT NULL,deleted_at TEXT);
                 CREATE TABLE file_refs (
                   id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,
                   manuscript_channel TEXT NOT NULL,resource_kind TEXT NOT NULL,
                   file_role TEXT NOT NULL,location_mode TEXT NOT NULL,
                   path_identity_key TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
                 CREATE TABLE operation_logs (
                   id TEXT PRIMARY KEY,operation_type TEXT NOT NULL,source TEXT NOT NULL,
                   module TEXT NOT NULL,status TEXT NOT NULL,risk_level TEXT NOT NULL,
                   target TEXT NOT NULL,summary TEXT NOT NULL,related_entities TEXT NOT NULL DEFAULT '[]',
                   impact_summary TEXT,confirmation TEXT NOT NULL DEFAULT '{}',feedback TEXT NOT NULL DEFAULT '{}',
                   warnings TEXT NOT NULL DEFAULT '[]',errors TEXT NOT NULL DEFAULT '[]',skipped TEXT NOT NULL DEFAULT '[]',
                   is_recoverable INTEGER NOT NULL DEFAULT 0,actor_id TEXT NOT NULL,actor_label TEXT NOT NULL,
                   refresh_keys TEXT NOT NULL DEFAULT '[]',schema_version INTEGER NOT NULL DEFAULT 1,
                   created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);",
            )
            .expect("schema");
        super::super::experiment_manuscript_switch_recovery::ensure_recovery_schema_in_connection(connection)
            .expect("recovery schema");
    }

    fn input() -> ExperimentOwnerSwitchReplacementInput {
        ExperimentOwnerSwitchReplacementInput {
            owner_type: "experiment".into(),
            owner_id: "experiment-1".into(),
            project_id: "project-1".into(),
            manuscript_channel: "primary".into(),
            binding_id: "binding-1".into(),
            expected_binding_updated_at: "binding-rev-1".into(),
            expected_current_file_ref_id: "old".into(),
            expected_default_manuscript_file_ref_id: "default".into(),
            expected_default_path_identity: "default.md".into(),
            target_file_ref_id: "target".into(),
            target_path_identity: "target.md".into(),
            target_location_mode: "external".into(),
            outline_replacements: EXPERIMENT_KEYS
                .iter()
                .enumerate()
                .map(|(index, key)| ExperimentOutlineReplacement {
                    key: (*key).into(),
                    action: if index % 2 == 0 { "set" } else { "clear" }.into(),
                    value: if index % 2 == 0 {
                        Some(format!("value-{index}"))
                    } else {
                        None
                    },
                })
                .collect(),
            outline_digest: "outline-digest".into(),
            old_current_post_revision: "old-post-rev".into(),
            target_physical_revision: "target-physical-rev".into(),
            occurred_at: "2026-07-19T03:00:00Z".into(),
            operation_id: "operation-1".into(),
            correlation_id: "correlation-1".into(),
            audit: ExperimentSwitchAudit {
                actor_id: "local_user".into(),
                actor_label: "Local user".into(),
                source: "user".into(),
            },
        }
    }

    fn seed(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO experiments VALUES
             ('experiment-1','project-1','Experiment',NULL,'[]','old-purpose-and-question',
              'old-condition','old-method','old-result','old-conclusion','old-other',
              'owner-rev-1',NULL)",
                [],
            )
            .expect("owner");
        connection
            .execute(
                "INSERT INTO manuscript_bindings VALUES
             ('binding-1','experiment','experiment-1','primary','old','default',
              'binding-rev-1',NULL)",
                [],
            )
            .expect("binding");
        for (id, path, revision, location) in [
            ("old", "old.md", "old-file-rev-1", "external"),
            ("default", "default.md", "default-rev-1", "managed"),
            ("target", "target.md", "target-rev-1", "external"),
        ] {
            connection
                .execute(
                    "INSERT INTO file_refs VALUES
                 (?1,'experiment','experiment-1','primary','file','manuscript',?2,?3,?4,NULL)",
                    params![id, location, path, revision],
                )
                .expect("file ref");
        }
        use super::super::experiment_manuscript_switch_recovery::{
            prepare_experiment_switch_recovery_in_connection,
            update_experiment_switch_recovery_phase_in_connection,
            ExperimentSwitchRecoveryPhaseInput, ExperimentSwitchRecoveryPrepareInput,
        };
        let replacements = serde_json::to_string(&input().outline_replacements).expect("replacements");
        prepare_experiment_switch_recovery_in_connection(connection, &ExperimentSwitchRecoveryPrepareInput {
            operation_id:"operation-1".into(),experiment_id:"experiment-1".into(),project_id:"project-1".into(),binding_id:"binding-1".into(),
            expected_owner_updated_at:"owner-rev-1".into(),expected_binding_updated_at:"binding-rev-1".into(),old_current_file_ref_id:"old".into(),
            old_current_file_ref_updated_at:"old-file-rev-1".into(),old_current_path_identity:"old.md".into(),old_current_location_mode:"external".into(),
            default_file_ref_id:"default".into(),default_file_ref_updated_at:"default-rev-1".into(),default_path_identity:"default.md".into(),default_location_mode:"managed".into(),
            target_file_ref_id:"target".into(),target_file_ref_updated_at:"target-rev-1".into(),target_path_identity:"target.md".into(),target_location_mode:"external".into(),
            before_purpose_and_question:Some("old-purpose-and-question".into()),
            before_condition_summary:Some("old-condition".into()),before_method_summary:Some("old-method".into()),before_result_summary:Some("old-result".into()),
            before_conclusion_and_next_steps:Some("old-conclusion".into()),before_other:Some("old-other".into()),outline_replacements_json:replacements,
            experiment_title_snapshot:"Experiment".into(),project_title_snapshot:"Project".into(),rating_snapshot:None,tags_json:"[]".into(),
            deterministic_writeback_version:1,recorded_at:"2026-07-19T03:00:00Z".into(),writeback_digest:"writeback".into(),writeback_byte_length:1,
            old_current_pre_revision:"old-pre-rev".into(),old_current_pre_digest:"old-pre".into(),old_current_expected_post_digest:"old-post".into(),
            target_physical_revision:"target-physical-rev".into(),target_digest:"target".into(),target_byte_length:1,old_current_file_name:"old.md".into(),
            target_file_name:"target.md".into(),default_file_name:"default.md".into(),correlation_id:"correlation-1".into(),created_at:"2026-07-19T03:00:00Z".into(),
        }).expect("prepare recovery");
        for (before,after) in [
            ("prepared","writeback_unknown"),
            ("writeback_unknown","writeback_applied"),
            ("writeback_applied","db_commit_unknown"),
        ] {
            update_experiment_switch_recovery_phase_in_connection(connection,&ExperimentSwitchRecoveryPhaseInput {
                operation_id:"operation-1".into(),expected_phase:before.into(),next_phase:after.into(),occurred_at:"2026-07-19T03:00:00Z".into(),
                old_current_post_revision:(after=="writeback_applied").then(||"old-post-rev".into()),writeback_verification_result:(after=="writeback_applied").then(||"exact-post".into()),
                last_error_code:None,last_diagnostic_summary:None,
            }).expect("advance recovery");
        }
    }

    #[test]
    fn full_replacement_current_and_existing_log_commit_atomically_without_default_change() {
        let mut connection = Connection::open_in_memory().expect("open");
        schema(&connection);
        seed(&connection);
        let result =
            commit_experiment_replacement_in_connection(&mut connection, &input()).expect("commit");
        assert_eq!(result.current_file_ref_id, "target");
        assert_eq!(result.default_manuscript_file_ref_id, "default");
        let owner: (String, Option<String>, String, Option<String>) = connection
            .query_row(
                "SELECT purpose_and_question,condition_summary,result_summary,other
                 FROM experiments WHERE id='experiment-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("owner post");
        assert_eq!(owner, ("value-0".into(), None, String::new(), None));
        let log: (String, i64, String) = connection
            .query_row(
                "SELECT status,is_recoverable,feedback FROM operation_logs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("log post");
        assert_eq!(log.0, "success");
        assert_eq!(log.1, 0);
        assert!(log.2.contains("EXPERIMENT_FORMAL_SWITCH_COMMITTED"));
        let phase: String = connection.query_row(
            "SELECT phase FROM experiment_manuscript_switch_recoveries WHERE operation_id='operation-1'",
            [], |row| row.get(0),
        ).expect("canonical recovery phase");
        assert_eq!(phase, "db_commit_unknown");
    }

    #[test]
    fn post_commit_direct_readback_returns_raw_sqlite_truth_after_commit() {
        let mut connection = Connection::open_in_memory().expect("open");
        schema(&connection);
        seed(&connection);
        commit_experiment_replacement_in_connection(&mut connection, &input()).expect("commit");
        let readback = read_experiment_owner_switch_post_verify_in_connection(
            &connection,
            &ExperimentOwnerSwitchPostVerifyReadInput {
                owner_id: "experiment-1".into(),
                binding_id: "binding-1".into(),
                target_file_ref_id: "target".into(),
                operation_id: "operation-1".into(),
            },
        )
        .expect("direct readback");

        assert_eq!(readback.database_read_source, "sqlite-direct-post-commit");
        assert!(readback.owner_found);
        assert!(readback.binding_found);
        assert_eq!(readback.current_file_ref_id.as_deref(), Some("target"));
        assert_eq!(
            readback.default_manuscript_file_ref_id.as_deref(),
            Some("default")
        );
        assert_eq!(readback.outline.purpose_and_question.as_deref(), Some("value-0"));
        assert_eq!(readback.outline.condition_summary, None);
        assert_eq!(readback.outline.result_summary.as_deref(), Some(""));
        assert!(readback.target_file_ref_valid);
        assert_eq!(readback.operation_log_status.as_deref(), Some("success"));
        assert_eq!(readback.operation_log_recoverable, Some(false));
        assert_eq!(
            readback.operation_log_phase.as_deref(),
            Some("db_commit_unknown")
        );
    }

    #[test]
    fn recovery_post_verify_accepts_required_empty_strings_for_all_clear_projection() {
        let mut connection = Connection::open_in_memory().expect("open");
        schema(&connection);
        seed(&connection);
        let mut value = input();
        for replacement in &mut value.outline_replacements {
            replacement.action = "clear".into();
            replacement.value = None;
        }
        let replacements = serde_json::to_string(&value.outline_replacements)
            .expect("all-clear replacements");
        connection.execute(
            "UPDATE experiment_manuscript_switch_recoveries
             SET outline_replacements_json=?1 WHERE operation_id='operation-1'",
            [replacements],
        ).expect("align frozen evidence");

        commit_experiment_replacement_in_connection(&mut connection, &value)
            .expect("all-clear commit");
        let verified = super::super::experiment_manuscript_switch_recovery::
            post_verify_experiment_switch_recovery_in_connection(&connection, "operation-1")
            .expect("recovery post-verify");

        assert_eq!(verified.status, "committed_exact");
    }

    #[test]
    fn stale_default_and_log_failure_roll_back_outline_and_current() {
        for scenario in ["default", "log"] {
            let mut connection = Connection::open_in_memory().expect("open");
            schema(&connection);
            seed(&connection);
            let mut value = input();
            if scenario == "default" {
                value.expected_default_manuscript_file_ref_id = "wrong".into();
            } else {
                connection
                    .execute(
                        "UPDATE experiment_manuscript_switch_recoveries SET phase='blocked' WHERE operation_id='operation-1'",
                        [],
                    )
                    .expect("make recovery stale");
            }
            assert!(commit_experiment_replacement_in_connection(&mut connection, &value).is_err());
            let state: (String, String) = connection
                .query_row(
                    "SELECT purpose_and_question,result_summary FROM experiments",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("owner unchanged");
            let current: String = connection
                .query_row(
                    "SELECT current_file_ref_id FROM manuscript_bindings",
                    [],
                    |row| row.get(0),
                )
                .expect("current unchanged");
            assert_eq!(state, ("old-purpose-and-question".into(), "old-result".into()));
            assert_eq!(current, "old");
        }
    }

    #[test]
    fn write_failures_after_outline_or_binding_update_roll_back_the_whole_transaction() {
        for failing_table in ["manuscript_bindings", "operation_logs"] {
            let mut connection = Connection::open_in_memory().expect("open");
            schema(&connection);
            seed(&connection);
            let action = if failing_table == "operation_logs" { "INSERT" } else { "UPDATE" };
            connection
                .execute_batch(&format!(
                    "CREATE TRIGGER fail_switch_write BEFORE {action} ON {failing_table}
                     BEGIN SELECT RAISE(FAIL, 'fault injection'); END;"
                ))
                .expect("fault trigger");
            assert!(
                commit_experiment_replacement_in_connection(&mut connection, &input()).is_err()
            );
            let outline: (String, String) = connection
                .query_row(
                    "SELECT purpose_and_question,result_summary FROM experiments",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("outline rollback");
            let binding: (String, String) = connection
                .query_row(
                    "SELECT current_file_ref_id,default_manuscript_file_ref_id
                     FROM manuscript_bindings",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("binding rollback");
            let log_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM operation_logs",
                    [],
                    |row| row.get(0),
                )
                .expect("log rollback");
            assert_eq!(outline, ("old-purpose-and-question".into(), "old-result".into()));
            assert_eq!(binding, ("old".into(), "default".into()));
            assert_eq!(log_count, 0);
        }
    }

    #[test]
    fn incomplete_duplicate_or_unknown_replacement_is_rejected_before_writes() {
        for scenario in ["incomplete", "duplicate", "unknown"] {
            let mut connection = Connection::open_in_memory().expect("open");
            schema(&connection);
            seed(&connection);
            let mut value = input();
            match scenario {
                "incomplete" => {
                    value.outline_replacements.pop();
                }
                "duplicate" => {
                    value.outline_replacements[1].key = "purpose".into();
                }
                "unknown" => {
                    value.outline_replacements[1].key = "status".into();
                }
                _ => unreachable!(),
            }
            assert!(commit_experiment_replacement_in_connection(&mut connection, &value).is_err());
            let current: String = connection
                .query_row(
                    "SELECT current_file_ref_id FROM manuscript_bindings",
                    [],
                    |row| row.get(0),
                )
                .expect("current unchanged");
            assert_eq!(current, "old");
        }
    }

    #[test]
    fn temp_sqlite_and_root_integration_keeps_target_bytes_unchanged() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("labpod-h5-switch-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&root).expect("temp root");
        let database_path = root.join("switch.sqlite");
        let old_path = root.join("old.md");
        let target_path = root.join("target.md");
        std::fs::write(&old_path, b"# old\nbody").expect("old seed");
        std::fs::write(&target_path, b"# ordinary target\nbody").expect("target seed");
        let target_before = std::fs::read(&target_path).expect("target before");
        let target_mtime_before = std::fs::metadata(&target_path)
            .expect("target metadata before")
            .modified()
            .expect("target mtime before");

        let mut connection = Connection::open(&database_path).expect("temp sqlite");
        schema(&connection);
        seed(&connection);
        std::fs::write(&old_path, b"## context summary\n\n# old\nbody")
            .expect("write old current context");
        commit_experiment_replacement_in_connection(&mut connection, &input())
            .expect("transaction");

        assert_eq!(
            std::fs::read_to_string(&old_path).expect("old reread"),
            "## context summary\n\n# old\nbody"
        );
        assert_eq!(
            std::fs::read(&target_path).expect("target after"),
            target_before
        );
        assert_eq!(
            std::fs::metadata(&target_path)
                .expect("target metadata after")
                .modified()
                .expect("target mtime after"),
            target_mtime_before
        );
        let binding: (String, String) = connection
            .query_row(
                "SELECT current_file_ref_id,default_manuscript_file_ref_id
                 FROM manuscript_bindings",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("binding post");
        assert_eq!(binding, ("target".into(), "default".into()));
        drop(connection);
        let reopened = Connection::open(&database_path).expect("reopen temp sqlite");
        reopened
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable foreign keys after restart");
        let persisted: (String, i64, String) = reopened
            .query_row(
                "SELECT status,is_recoverable,feedback FROM operation_logs WHERE id='operation-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("durable recovery log after restart");
        assert_eq!(persisted.0, "success");
        assert_eq!(persisted.1, 0);
        assert!(persisted.2.contains("EXPERIMENT_FORMAL_SWITCH_COMMITTED"));
        let persisted_phase: String = reopened.query_row(
            "SELECT phase FROM experiment_manuscript_switch_recoveries WHERE operation_id='operation-1'",
            [], |row| row.get(0),
        ).expect("durable canonical recovery after restart");
        assert_eq!(persisted_phase, "db_commit_unknown");
        let quick_check: String = reopened
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .expect("quick check");
        let foreign_key_violations: i64 = reopened
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
            .expect("foreign key check");
        assert_eq!(quick_check, "ok");
        assert_eq!(foreign_key_violations, 0);
        drop(reopened);
        let verified_root = std::fs::canonicalize(&root).expect("verify cleanup root");
        let verified_temp = std::fs::canonicalize(std::env::temp_dir()).expect("verify temp root");
        assert!(verified_root.starts_with(&verified_temp));
        std::fs::remove_dir_all(verified_root).expect("cleanup temp root");
    }
}
