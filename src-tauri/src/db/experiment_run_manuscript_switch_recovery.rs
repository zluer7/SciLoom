use super::experiment_run_manuscript_switch::{
    commit_experiment_run_switch_in_connection, ExperimentRunOutlineReplacement,
    ExperimentRunSwitchAudit, ExperimentRunSwitchTransactionInput,
};
use super::open_connection;
use super::formal_switch_recovery::{
    is_canonical_formal_switch_phase, is_valid_formal_switch_transition,
    safe_formal_switch_file_name, safe_formal_switch_value,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub(crate) const RECOVERY_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS experiment_run_manuscript_switch_recoveries (
  recovery_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  owner_type TEXT NOT NULL CHECK (owner_type = 'experimentRun'),
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  manuscript_channel TEXT NOT NULL CHECK (manuscript_channel = 'primary'),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared','writeback_unknown','writeback_applied','db_commit_unknown','db_committed',
    'activation_pending','resolved','blocked','cancelled_safe'
  )),
  binding_id TEXT NOT NULL,
  expected_run_updated_at TEXT NOT NULL,
  expected_parent_updated_at TEXT NOT NULL,
  expected_binding_updated_at TEXT NOT NULL,
  old_current_file_ref_id TEXT NOT NULL,
  old_current_file_ref_updated_at TEXT NOT NULL,
  old_current_path_identity TEXT NOT NULL,
  old_current_location_mode TEXT NOT NULL CHECK (old_current_location_mode IN ('managed','external')),
  default_file_ref_id TEXT NOT NULL,
  default_file_ref_updated_at TEXT NOT NULL,
  default_path_identity TEXT NOT NULL,
  default_location_mode TEXT NOT NULL CHECK (default_location_mode IN ('managed','external')),
  target_file_ref_id TEXT NOT NULL,
  target_file_ref_updated_at TEXT NOT NULL,
  target_path_identity TEXT NOT NULL,
  target_location_mode TEXT NOT NULL CHECK (target_location_mode IN ('managed','external')),
  before_condition_summary TEXT,
  before_variable_parameter_summary TEXT,
  before_method_summary TEXT,
  before_result_summary TEXT,
  before_conclusion TEXT,
  before_summary_other TEXT,
  outline_replacements_json TEXT NOT NULL,
  run_title_snapshot TEXT NOT NULL,
  parent_title_snapshot TEXT NOT NULL,
  project_title_snapshot TEXT NOT NULL,
  rating_snapshot TEXT,
  tags_json TEXT NOT NULL,
  run_date_snapshot TEXT NOT NULL,
  run_time_snapshot TEXT NOT NULL,
  deterministic_writeback_version INTEGER NOT NULL CHECK (deterministic_writeback_version = 1),
  recorded_at TEXT NOT NULL,
  writeback_digest TEXT NOT NULL,
  writeback_byte_length INTEGER NOT NULL CHECK (writeback_byte_length >= 0),
  old_current_pre_revision TEXT NOT NULL,
  old_current_post_revision TEXT,
  writeback_verification_result TEXT,
  target_physical_revision TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  target_byte_length INTEGER NOT NULL CHECK (target_byte_length >= 0),
  old_current_pre_digest TEXT NOT NULL,
  old_current_expected_post_digest TEXT NOT NULL,
  old_current_file_name TEXT NOT NULL,
  target_file_name TEXT NOT NULL,
  default_file_name TEXT NOT NULL,
  transaction_attempted_at TEXT,
  db_commit_observed_at TEXT,
  post_verify_status TEXT,
  operation_log_observed INTEGER NOT NULL DEFAULT 0 CHECK (operation_log_observed IN (0,1)),
  observed_current_file_ref_id TEXT,
  observed_default_file_ref_id TEXT,
  observed_outline_digest TEXT,
  activation_status TEXT NOT NULL DEFAULT 'pending',
  last_error_code TEXT,
  last_diagnostic_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (old_current_file_ref_id <> target_file_ref_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_switch_recovery_unresolved_owner
  ON experiment_run_manuscript_switch_recoveries(run_id, manuscript_channel)
  WHERE phase NOT IN ('resolved','cancelled_safe');
CREATE INDEX IF NOT EXISTS idx_run_switch_recovery_operation
  ON experiment_run_manuscript_switch_recoveries(operation_id);
INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (32, 'experiment_run_switch_durable_recovery');
"#;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchRecoveryPrepareInput {
    pub(crate) recovery_id: String,
    pub(crate) operation_id: String,
    pub(crate) run_id: String,
    pub(crate) experiment_id: String,
    pub(crate) project_id: String,
    pub(crate) binding_id: String,
    pub(crate) expected_run_updated_at: String,
    pub(crate) expected_parent_updated_at: String,
    pub(crate) expected_binding_updated_at: String,
    pub(crate) old_current_file_ref_id: String,
    pub(crate) old_current_file_ref_updated_at: String,
    pub(crate) old_current_path_identity: String,
    pub(crate) old_current_location_mode: String,
    pub(crate) default_file_ref_id: String,
    pub(crate) default_file_ref_updated_at: String,
    pub(crate) default_path_identity: String,
    pub(crate) default_location_mode: String,
    pub(crate) target_file_ref_id: String,
    pub(crate) target_file_ref_updated_at: String,
    pub(crate) target_path_identity: String,
    pub(crate) target_location_mode: String,
    pub(crate) before_condition_summary: Option<String>,
    pub(crate) before_variable_parameter_summary: Option<String>,
    pub(crate) before_method_summary: Option<String>,
    pub(crate) before_result_summary: Option<String>,
    pub(crate) before_conclusion: Option<String>,
    pub(crate) before_summary_other: Option<String>,
    pub(crate) outline_replacements_json: String,
    pub(crate) run_title_snapshot: String,
    pub(crate) parent_title_snapshot: String,
    pub(crate) project_title_snapshot: String,
    pub(crate) rating_snapshot: Option<String>,
    pub(crate) tags_json: String,
    pub(crate) run_date_snapshot: String,
    pub(crate) run_time_snapshot: String,
    pub(crate) deterministic_writeback_version: i64,
    pub(crate) recorded_at: String,
    pub(crate) writeback_digest: String,
    pub(crate) writeback_byte_length: i64,
    pub(crate) old_current_pre_revision: String,
    pub(crate) target_physical_revision: String,
    pub(crate) target_digest: String,
    pub(crate) target_byte_length: i64,
    pub(crate) old_current_pre_digest: String,
    pub(crate) old_current_expected_post_digest: String,
    pub(crate) old_current_file_name: String,
    pub(crate) target_file_name: String,
    pub(crate) default_file_name: String,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchRecoveryRecord {
    pub(crate) recovery_id: String,
    pub(crate) operation_id: String,
    pub(crate) run_id: String,
    pub(crate) experiment_id: String,
    pub(crate) project_id: String,
    pub(crate) phase: String,
    pub(crate) target_file_ref_id: String,
    pub(crate) old_current_file_ref_id: String,
    pub(crate) default_file_ref_id: String,
    pub(crate) old_current_file_name: String,
    pub(crate) target_file_name: String,
    pub(crate) default_file_name: String,
    pub(crate) old_current_pre_revision: String,
    pub(crate) old_current_post_revision: Option<String>,
    pub(crate) writeback_digest: String,
    pub(crate) writeback_byte_length: i64,
    pub(crate) recorded_at: String,
    pub(crate) activation_status: String,
    pub(crate) last_error_code: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryRow {
    pub(crate) input: ExperimentRunSwitchRecoveryPrepareInput,
    pub(crate) phase: String,
    pub(crate) old_current_post_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchPostVerifyResult {
    pub(crate) status: String,
    pub(crate) operation_id: String,
    pub(crate) recovery_id: String,
    pub(crate) phase: String,
    pub(crate) current_file_ref_id: Option<String>,
    pub(crate) default_file_ref_id: Option<String>,
    pub(crate) operation_log_count: i64,
    pub(crate) database_read_source: &'static str,
    pub(crate) safe_diagnostic_code: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentRunSwitchRecoveryPhaseInput {
    pub(crate) operation_id: String,
    pub(crate) expected_phase: String,
    pub(crate) next_phase: String,
    pub(crate) occurred_at: String,
    pub(crate) old_current_post_revision: Option<String>,
    pub(crate) writeback_verification_result: Option<String>,
    pub(crate) last_error_code: Option<String>,
    pub(crate) last_diagnostic_summary: Option<String>,
}

fn digest_text(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn validate_prepare(input: &ExperimentRunSwitchRecoveryPrepareInput) -> Result<(), String> {
    let replacements: Vec<ExperimentRunOutlineReplacement> =
        serde_json::from_str(&input.outline_replacements_json)
            .map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    if !safe_formal_switch_value(&input.recovery_id)
        || !safe_formal_switch_value(&input.operation_id)
        || input.deterministic_writeback_version != 1
        || input.writeback_byte_length < 0
        || input.target_byte_length < 0
        || input.old_current_file_ref_id == input.target_file_ref_id
        || replacements.len() != 6
        || !safe_formal_switch_file_name(&input.old_current_file_name)
        || !safe_formal_switch_file_name(&input.target_file_name)
        || !safe_formal_switch_file_name(&input.default_file_name)
        || serde_json::from_str::<Vec<String>>(&input.tags_json).is_err()
    {
        return Err("RUN_SWITCH_RECOVERY_PERSIST_FAILED".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn ensure_recovery_schema_in_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(RECOVERY_SCHEMA_SQL)
        .map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())
}

fn summary_from_input(input: &ExperimentRunSwitchRecoveryPrepareInput) -> ExperimentRunSwitchRecoveryRecord {
    ExperimentRunSwitchRecoveryRecord {
        recovery_id: input.recovery_id.clone(),
        operation_id: input.operation_id.clone(),
        run_id: input.run_id.clone(),
        experiment_id: input.experiment_id.clone(),
        project_id: input.project_id.clone(),
        phase: "prepared".into(),
        target_file_ref_id: input.target_file_ref_id.clone(),
        old_current_file_ref_id: input.old_current_file_ref_id.clone(),
        default_file_ref_id: input.default_file_ref_id.clone(),
        old_current_file_name: input.old_current_file_name.clone(),
        target_file_name: input.target_file_name.clone(),
        default_file_name: input.default_file_name.clone(),
        old_current_pre_revision: input.old_current_pre_revision.clone(),
        old_current_post_revision: None,
        writeback_digest: input.writeback_digest.clone(),
        writeback_byte_length: input.writeback_byte_length,
        recorded_at: input.recorded_at.clone(),
        activation_status: "pending".into(),
        last_error_code: None,
        created_at: input.created_at.clone(),
        updated_at: input.created_at.clone(),
    }
}

pub(crate) fn prepare_experiment_run_switch_recovery_in_connection(
    connection: &Connection,
    input: &ExperimentRunSwitchRecoveryPrepareInput,
) -> Result<ExperimentRunSwitchRecoveryRecord, String> {
    validate_prepare(input)?;
    let existing: i64 = connection.query_row(
        "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries
         WHERE run_id=?1 AND manuscript_channel='primary'
           AND phase NOT IN ('resolved','cancelled_safe')",
        [&input.run_id], |row| row.get(0),
    ).map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    if existing != 0 {
        return Err("RUN_SWITCH_RECOVERY_ALREADY_ACTIVE".into());
    }
    connection.execute(
        "INSERT INTO experiment_run_manuscript_switch_recoveries (
           recovery_id,operation_id,owner_type,run_id,experiment_id,project_id,
           manuscript_channel,phase,binding_id,expected_run_updated_at,
           expected_parent_updated_at,expected_binding_updated_at,
           old_current_file_ref_id,old_current_file_ref_updated_at,old_current_path_identity,
           old_current_location_mode,default_file_ref_id,default_file_ref_updated_at,
           default_path_identity,default_location_mode,target_file_ref_id,
           target_file_ref_updated_at,target_path_identity,target_location_mode,
           before_condition_summary,before_variable_parameter_summary,before_method_summary,
           before_result_summary,before_conclusion,before_summary_other,
           outline_replacements_json,run_title_snapshot,parent_title_snapshot,
           project_title_snapshot,rating_snapshot,tags_json,
           run_date_snapshot,run_time_snapshot,deterministic_writeback_version,recorded_at,
           writeback_digest,writeback_byte_length,old_current_pre_revision,
           target_physical_revision,target_digest,target_byte_length,
           old_current_pre_digest,old_current_expected_post_digest,
           old_current_file_name,target_file_name,default_file_name,created_at,updated_at
         ) VALUES (
           ?1,?2,'experimentRun',?3,?4,?5,'primary','prepared',?6,?7,?8,?9,
           ?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,
           ?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,
           ?37,?38,?39,?40,?41,?42,?43,?44,?45,?46,?47,?48,?49,?49)",
        params![
            input.recovery_id,input.operation_id,input.run_id,input.experiment_id,input.project_id,
            input.binding_id,input.expected_run_updated_at,input.expected_parent_updated_at,
            input.expected_binding_updated_at,input.old_current_file_ref_id,
            input.old_current_file_ref_updated_at,input.old_current_path_identity,
            input.old_current_location_mode,input.default_file_ref_id,
            input.default_file_ref_updated_at,input.default_path_identity,
            input.default_location_mode,input.target_file_ref_id,
            input.target_file_ref_updated_at,input.target_path_identity,input.target_location_mode,
            input.before_condition_summary,input.before_variable_parameter_summary,
            input.before_method_summary,input.before_result_summary,input.before_conclusion,
            input.before_summary_other,input.outline_replacements_json,input.run_title_snapshot,
            input.parent_title_snapshot,input.project_title_snapshot,input.rating_snapshot,input.tags_json,
            input.run_date_snapshot,input.run_time_snapshot,
            input.deterministic_writeback_version,input.recorded_at,input.writeback_digest,
            input.writeback_byte_length,input.old_current_pre_revision,input.target_physical_revision,
            input.target_digest,input.target_byte_length,input.old_current_pre_digest,
            input.old_current_expected_post_digest,input.old_current_file_name,
            input.target_file_name,input.default_file_name,input.created_at
        ],
    ).map_err(|error| {
        if error.to_string().contains("UNIQUE constraint failed") {
            "RUN_SWITCH_RECOVERY_ALREADY_ACTIVE".to_string()
        } else {
            "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string()
        }
    })?;
    let verified = post_verify_experiment_run_switch_recovery_in_connection(connection, &input.operation_id)?;
    if verified.status != "not_committed" {
        let _ = connection.execute(
            "DELETE FROM experiment_run_manuscript_switch_recoveries WHERE operation_id=?1 AND phase='prepared'",
            [&input.operation_id],
        );
        return Err("RUN_SWITCH_RECOVERY_IDENTITY_MISMATCH".into());
    }
    Ok(summary_from_input(input))
}

fn recovery_row(connection: &Connection, operation_id: &str) -> Result<RecoveryRow, String> {
    connection.query_row(
        "SELECT recovery_id,operation_id,run_id,experiment_id,project_id,binding_id,
                expected_run_updated_at,expected_parent_updated_at,expected_binding_updated_at,
                old_current_file_ref_id,old_current_file_ref_updated_at,old_current_path_identity,
                old_current_location_mode,default_file_ref_id,default_file_ref_updated_at,
                default_path_identity,default_location_mode,target_file_ref_id,
                target_file_ref_updated_at,target_path_identity,target_location_mode,
                before_condition_summary,before_variable_parameter_summary,before_method_summary,
                before_result_summary,before_conclusion,before_summary_other,
                outline_replacements_json,run_title_snapshot,parent_title_snapshot,
                project_title_snapshot,rating_snapshot,tags_json,
                run_date_snapshot,run_time_snapshot,deterministic_writeback_version,recorded_at,
                writeback_digest,writeback_byte_length,old_current_pre_revision,target_physical_revision,
                target_digest,target_byte_length,old_current_pre_digest,
                old_current_expected_post_digest,old_current_file_name,target_file_name,
                default_file_name,created_at,phase,old_current_post_revision
         FROM experiment_run_manuscript_switch_recoveries WHERE operation_id=?1",
        [operation_id],
        |row| Ok(RecoveryRow {
            input: ExperimentRunSwitchRecoveryPrepareInput {
                recovery_id: row.get(0)?, operation_id: row.get(1)?, run_id: row.get(2)?,
                experiment_id: row.get(3)?, project_id: row.get(4)?, binding_id: row.get(5)?,
                expected_run_updated_at: row.get(6)?, expected_parent_updated_at: row.get(7)?,
                expected_binding_updated_at: row.get(8)?, old_current_file_ref_id: row.get(9)?,
                old_current_file_ref_updated_at: row.get(10)?, old_current_path_identity: row.get(11)?,
                old_current_location_mode: row.get(12)?, default_file_ref_id: row.get(13)?,
                default_file_ref_updated_at: row.get(14)?, default_path_identity: row.get(15)?,
                default_location_mode: row.get(16)?, target_file_ref_id: row.get(17)?,
                target_file_ref_updated_at: row.get(18)?, target_path_identity: row.get(19)?,
                target_location_mode: row.get(20)?, before_condition_summary: row.get(21)?,
                before_variable_parameter_summary: row.get(22)?, before_method_summary: row.get(23)?,
                before_result_summary: row.get(24)?, before_conclusion: row.get(25)?,
                before_summary_other: row.get(26)?, outline_replacements_json: row.get(27)?,
                run_title_snapshot: row.get(28)?, parent_title_snapshot: row.get(29)?,
                project_title_snapshot: row.get(30)?, rating_snapshot: row.get(31)?,
                tags_json: row.get(32)?, run_date_snapshot: row.get(33)?, run_time_snapshot: row.get(34)?,
                deterministic_writeback_version: row.get(35)?, recorded_at: row.get(36)?,
                writeback_digest: row.get(37)?, writeback_byte_length: row.get(38)?,
                old_current_pre_revision: row.get(39)?, target_physical_revision: row.get(40)?,
                target_digest: row.get(41)?, target_byte_length: row.get(42)?,
                old_current_pre_digest: row.get(43)?, old_current_expected_post_digest: row.get(44)?,
                old_current_file_name: row.get(45)?, target_file_name: row.get(46)?,
                default_file_name: row.get(47)?, created_at: row.get(48)?,
            },
            phase: row.get(49)?, old_current_post_revision: row.get(50)?,
        }),
    ).optional().map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?
        .ok_or_else(|| "RUN_SWITCH_RECOVERY_NOT_FOUND".to_string())
}

fn replacements(row: &RecoveryRow) -> Result<Vec<ExperimentRunOutlineReplacement>, String> {
    serde_json::from_str(&row.input.outline_replacements_json)
        .map_err(|_| "RUN_SWITCH_RECOVERY_IDENTITY_MISMATCH".to_string())
}

fn expected_outline(row: &RecoveryRow) -> Result<Vec<Option<String>>, String> {
    Ok(replacements(row)?.into_iter().map(|item| match item.action.as_str() {
        "clear" => None,
        "set" => item.value,
        _ => None,
    }).collect())
}

fn read_outline(connection: &Connection, run_id: &str) -> Result<Option<(Vec<Option<String>>, String, Option<String>, String, String)>, String> {
    connection.query_row(
        "SELECT condition_summary,variable_parameter_summary,method_summary,result_summary,
                conclusion,summary_other,updated_at,deleted_at,experiment_id,project_id
         FROM experiment_runs WHERE id=?1",
        [run_id], |row| Ok((
            (0..6).map(|index| row.get(index)).collect::<rusqlite::Result<Vec<Option<String>>>>()?,
            row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?,
        )),
    ).optional().map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())
}

fn file_exact(connection: &Connection, id: &str, row: &RecoveryRow, _updated: &str, identity: &str, mode: &str) -> Result<bool, String> {
    connection.query_row(
        "SELECT COUNT(*) FROM file_refs WHERE id=?1 AND owner_type='experimentRun' AND owner_id=?2
         AND manuscript_channel='primary' AND resource_kind='file' AND file_role='manuscript'
         AND location_mode=?3 AND path_identity_key=?4 AND deleted_at IS NULL",
        params![id,row.input.run_id,mode,identity], |r| r.get::<_, i64>(0),
    ).map(|count| count == 1).map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())
}

fn persist_post_verify(
    connection: &Connection,
    result: ExperimentRunSwitchPostVerifyResult,
) -> Result<ExperimentRunSwitchPostVerifyResult,String> {
    connection.execute(
        "UPDATE experiment_run_manuscript_switch_recoveries SET post_verify_status=?1,
         operation_log_observed=?2,observed_current_file_ref_id=?3,
         observed_default_file_ref_id=?4 WHERE operation_id=?5",
        params![result.status, result.operation_log_count == 1,
            result.current_file_ref_id,result.default_file_ref_id,result.operation_id],
    ).map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    Ok(result)
}

pub(crate) fn post_verify_experiment_run_switch_recovery_in_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<ExperimentRunSwitchPostVerifyResult, String> {
    let row = recovery_row(connection, operation_id)?;
    let binding: Option<(Option<String>, Option<String>, String, Option<String>, String, String, String)> = connection.query_row(
        "SELECT current_file_ref_id,default_manuscript_file_ref_id,updated_at,deleted_at,
                owner_type,owner_id,manuscript_channel FROM manuscript_bindings WHERE id=?1",
        [&row.input.binding_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
    ).optional().map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())?;
    let owner = read_outline(connection, &row.input.run_id)?;
    let parent_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM experiments WHERE id=?1 AND project_id=?2
         AND deleted_at IS NULL",
        params![row.input.experiment_id,row.input.project_id], |r| r.get(0),
    ).map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())?;
    let log_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM operation_logs WHERE id=?1 AND status='success' AND module='experiment' AND deleted_at IS NULL",
        [operation_id], |r| r.get(0),
    ).map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())?;
    let log_payload: Option<(String,String)> = connection.query_row(
        "SELECT target,feedback FROM operation_logs WHERE id=?1 AND status='success'
         AND operation_type='custom' AND source='user' AND module='experiment'
         AND deleted_at IS NULL",
        [operation_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())?;
    let (current, default) = binding.as_ref().map(|value| (value.0.clone(), value.1.clone())).unwrap_or((None,None));
    let result = |status: &str, diagnostic: &str| ExperimentRunSwitchPostVerifyResult {
        status: status.into(), operation_id: operation_id.into(), recovery_id: row.input.recovery_id.clone(),
        phase: row.phase.clone(), current_file_ref_id: current.clone(),
        default_file_ref_id: default.clone(), operation_log_count: log_count,
        database_read_source: "sqlite-direct", safe_diagnostic_code: diagnostic.into(),
    };
    if log_count > 1 { return persist_post_verify(connection,result("duplicate_operation_log", "RUN_SWITCH_POST_VERIFY_DUPLICATE_LOG")); }
    let Some(binding) = binding else { return persist_post_verify(connection,result("identity_missing", "RUN_SWITCH_POST_VERIFY_IDENTITY_MISSING")); };
    let Some(owner) = owner else { return persist_post_verify(connection,result("identity_missing", "RUN_SWITCH_POST_VERIFY_IDENTITY_MISSING")); };
    let observed_outline = serde_json::to_string(&owner.0)
        .map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())?;
    connection.execute(
        "UPDATE experiment_run_manuscript_switch_recoveries SET observed_outline_digest=?1 WHERE operation_id=?2",
        params![digest_text(&observed_outline),operation_id],
    ).map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    if parent_count != 1 || binding.4 != "experimentRun" || binding.5 != row.input.run_id || binding.6 != "primary" {
        return persist_post_verify(connection,result("identity_missing", "RUN_SWITCH_POST_VERIFY_IDENTITY_MISSING"));
    }
    let files_exact = file_exact(connection,&row.input.old_current_file_ref_id,&row,&row.input.old_current_file_ref_updated_at,&row.input.old_current_path_identity,&row.input.old_current_location_mode)?
        && file_exact(connection,&row.input.default_file_ref_id,&row,&row.input.default_file_ref_updated_at,&row.input.default_path_identity,&row.input.default_location_mode)?
        && file_exact(connection,&row.input.target_file_ref_id,&row,&row.input.target_file_ref_updated_at,&row.input.target_path_identity,&row.input.target_location_mode)?;
    let target_cross_owner_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM file_refs WHERE path_identity_key=?1 AND deleted_at IS NULL
         AND NOT (owner_type='experimentRun' AND owner_id=?2)",
        params![row.input.target_path_identity,row.input.run_id], |r| r.get(0),
    ).map_err(|_| "RUN_SWITCH_POST_VERIFY_AMBIGUOUS".to_string())?;
    if !files_exact || target_cross_owner_count != 0 {
        return persist_post_verify(connection,result("identity_missing", "RUN_SWITCH_POST_VERIFY_IDENTITY_MISSING"));
    }
    let expected = expected_outline(&row)?;
    let pre_exact = owner.2.is_none() && owner.3 == row.input.experiment_id && owner.4 == row.input.project_id
        && binding.0.as_deref() == Some(row.input.old_current_file_ref_id.as_str())
        && binding.1.as_deref() == Some(row.input.default_file_ref_id.as_str())
        && binding.2 == row.input.expected_binding_updated_at && binding.3.is_none() && log_count == 0;
    if pre_exact { return persist_post_verify(connection,result("not_committed", "RUN_SWITCH_POST_VERIFY_NOT_COMMITTED")); }
    let log_exact = log_payload.as_ref().is_some_and(|(target,feedback)| {
        let target: serde_json::Value = serde_json::from_str(target).unwrap_or_default();
        let feedback: serde_json::Value = serde_json::from_str(feedback).unwrap_or_default();
        target["entityType"] == "experimentRun" && target["entityId"] == row.input.run_id
            && feedback["details"]["fromCurrentFileRefId"] == row.input.old_current_file_ref_id
            && feedback["details"]["toCurrentFileRefId"] == row.input.target_file_ref_id
            && feedback["details"]["defaultUnchanged"] == true
    });
    // Owner/Binding updated_at are audit metadata, not canonical switch
    // identity. The authoritative proof is the six-field projection,
    // Binding identities, FileRefs and unique success log.
    let committed_exact = owner.0 == expected
        && owner.3 == row.input.experiment_id && owner.4 == row.input.project_id
        && binding.0.as_deref() == Some(row.input.target_file_ref_id.as_str())
        && binding.1.as_deref() == Some(row.input.default_file_ref_id.as_str())
        && log_count == 1 && log_exact;
    if committed_exact { return persist_post_verify(connection,result("committed_exact", "RUN_SWITCH_POST_VERIFY_COMMITTED_EXACT")); }
    if log_count == 1 || binding.0.as_deref() == Some(row.input.target_file_ref_id.as_str()) || owner.0 == expected {
        return persist_post_verify(connection,result("committed_mismatch", "RUN_SWITCH_POST_VERIFY_COMMITTED_MISMATCH"));
    }
    persist_post_verify(connection,result("ambiguous", "RUN_SWITCH_POST_VERIFY_AMBIGUOUS"))
}

pub(crate) fn complete_experiment_run_switch_recovery_in_connection(
    connection: &mut Connection,
    operation_id: &str,
    old_current_post_revision: &str,
    updated_at: &str,
) -> Result<ExperimentRunSwitchPostVerifyResult, String> {
    let row = recovery_row(connection, operation_id)?;
    if row.phase != "writeback_applied" || row.old_current_post_revision.as_deref() != Some(old_current_post_revision) {
        return Err("RUN_SWITCH_DB_ONLY_COMPLETION_BLOCKED".into());
    }
    let verify = post_verify_experiment_run_switch_recovery_in_connection(connection, operation_id)?;
    if verify.status != "not_committed" { return Err("RUN_SWITCH_DB_ONLY_COMPLETION_BLOCKED".into()); }
    connection.execute(
        "UPDATE experiment_run_manuscript_switch_recoveries SET phase='db_commit_unknown',
         transaction_attempted_at=?1,updated_at=?1 WHERE operation_id=?2 AND phase='writeback_applied'",
        params![updated_at,operation_id],
    ).map_err(|_| "RUN_SWITCH_DB_ONLY_COMPLETION_FAILED".to_string())?;
    let input = ExperimentRunSwitchTransactionInput {
        operation_id: row.input.operation_id.clone(), owner_type: "experimentRun".into(),
        run_id: row.input.run_id.clone(), experiment_id: row.input.experiment_id.clone(),
        project_id: row.input.project_id.clone(), manuscript_channel: "primary".into(),
        binding_id: row.input.binding_id.clone(), expected_binding_updated_at: row.input.expected_binding_updated_at.clone(),
        expected_current_file_ref_id: row.input.old_current_file_ref_id.clone(),
        expected_current_path_identity: row.input.old_current_path_identity.clone(),
        expected_default_manuscript_file_ref_id: row.input.default_file_ref_id.clone(),
        expected_default_path_identity: row.input.default_path_identity.clone(),
        target_file_ref_id: row.input.target_file_ref_id.clone(),
        target_path_identity: row.input.target_path_identity.clone(),
        target_location_mode: row.input.target_location_mode.clone(),
        outline_replacements: replacements(&row)?, old_current_writeback_completed: true,
        old_current_post_revision: old_current_post_revision.into(),
        target_physical_revision: row.input.target_physical_revision.clone(),
        occurred_at: row.input.recorded_at.clone(), log_summary: "ExperimentRun formal manuscript switch".into(),
        audit: ExperimentRunSwitchAudit { actor_id: "local_user".into(), actor_label: "Local user".into(), source: "user".into() },
    };
    if commit_experiment_run_switch_in_connection(connection, &input).is_err() {
        let verify = post_verify_experiment_run_switch_recovery_in_connection(connection, operation_id)?;
        if verify.status == "not_committed" {
            connection.execute(
                "UPDATE experiment_run_manuscript_switch_recoveries SET phase='writeback_applied',
                 post_verify_status='not_committed',updated_at=?1 WHERE operation_id=?2 AND phase='db_commit_unknown'",
                params![updated_at,operation_id],
            ).map_err(|_| "RUN_SWITCH_DB_ONLY_COMPLETION_FAILED".to_string())?;
        }
        return Err("RUN_SWITCH_DB_ONLY_COMPLETION_FAILED".into());
    }
    connection.execute(
        "UPDATE experiment_run_manuscript_switch_recoveries SET phase='db_committed',
         db_commit_observed_at=?1,post_verify_status='committed_exact',operation_log_observed=1,
         observed_current_file_ref_id=target_file_ref_id,
         observed_default_file_ref_id=default_file_ref_id,updated_at=?1
         WHERE operation_id=?2",
        params![updated_at,operation_id],
    ).map_err(|_| "RUN_SWITCH_DB_ONLY_COMPLETION_FAILED".to_string())?;
    post_verify_experiment_run_switch_recovery_in_connection(connection, operation_id)
}

pub(crate) fn update_recovery_phase_in_connection(
    connection: &Connection,
    input: &ExperimentRunSwitchRecoveryPhaseInput,
) -> Result<ExperimentRunSwitchRecoveryRecord, String> {
    if !is_canonical_formal_switch_phase(&input.expected_phase)
        || !is_canonical_formal_switch_phase(&input.next_phase)
        || !is_valid_formal_switch_transition(&input.expected_phase, &input.next_phase)
    {
        return Err("RUN_SWITCH_RECOVERY_INVALID_PHASE".into());
    }
    let resolved = matches!(input.next_phase.as_str(), "resolved" | "cancelled_safe");
    let changed = connection.execute(
        "UPDATE experiment_run_manuscript_switch_recoveries SET phase=?1,updated_at=?2,
         old_current_post_revision=COALESCE(?3,old_current_post_revision),
         writeback_verification_result=COALESCE(?4,writeback_verification_result),
         last_error_code=?5,last_diagnostic_summary=?6,
         activation_status=CASE WHEN ?1='activation_pending' THEN 'pending'
           WHEN ?1='resolved' THEN 'completed' WHEN ?1='blocked' THEN 'blocked'
           ELSE activation_status END,
         resolved_at=CASE WHEN ?7 THEN ?2 ELSE resolved_at END
         WHERE operation_id=?8 AND phase=?9",
        params![input.next_phase,input.occurred_at,input.old_current_post_revision,
            input.writeback_verification_result,input.last_error_code,input.last_diagnostic_summary,
            resolved,input.operation_id,input.expected_phase],
    ).map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    if changed != 1 { return Err("RUN_SWITCH_RECOVERY_INVALID_PHASE".into()); }
    get_recovery_summary_in_connection(connection, &input.operation_id)
}

fn get_recovery_summary_in_connection(connection: &Connection, operation_id: &str) -> Result<ExperimentRunSwitchRecoveryRecord, String> {
    connection.query_row(
        "SELECT recovery_id,operation_id,run_id,experiment_id,project_id,phase,
                target_file_ref_id,old_current_file_ref_id,default_file_ref_id,
                old_current_file_name,target_file_name,default_file_name,
                old_current_pre_revision,old_current_post_revision,writeback_digest,
                writeback_byte_length,recorded_at,activation_status,last_error_code,created_at,updated_at
         FROM experiment_run_manuscript_switch_recoveries WHERE operation_id=?1",
        [operation_id], |r| Ok(ExperimentRunSwitchRecoveryRecord {
            recovery_id:r.get(0)?,operation_id:r.get(1)?,run_id:r.get(2)?,experiment_id:r.get(3)?,
            project_id:r.get(4)?,phase:r.get(5)?,target_file_ref_id:r.get(6)?,old_current_file_ref_id:r.get(7)?,
            default_file_ref_id:r.get(8)?,old_current_file_name:r.get(9)?,target_file_name:r.get(10)?,
            default_file_name:r.get(11)?,old_current_pre_revision:r.get(12)?,old_current_post_revision:r.get(13)?,
            writeback_digest:r.get(14)?,writeback_byte_length:r.get(15)?,recorded_at:r.get(16)?,activation_status:r.get(17)?,
            last_error_code:r.get(18)?,created_at:r.get(19)?,updated_at:r.get(20)?,
        }),
    ).optional().map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?
        .ok_or_else(|| "RUN_SWITCH_RECOVERY_NOT_FOUND".to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn prepare_experiment_run_switch_recovery(app_handle: AppHandle, input: ExperimentRunSwitchRecoveryPrepareInput) -> Result<ExperimentRunSwitchRecoveryRecord,String> {
    let connection = open_connection(&app_handle)?;
    prepare_experiment_run_switch_recovery_in_connection(&connection,&input)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn get_experiment_run_switch_recovery(app_handle: AppHandle, operation_id: String) -> Result<ExperimentRunSwitchRecoveryRecord,String> {
    let connection = open_connection(&app_handle)?;
    get_recovery_summary_in_connection(&connection,&operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn get_experiment_run_switch_recovery_detail(app_handle: AppHandle, operation_id: String) -> Result<RecoveryRow,String> {
    let connection = open_connection(&app_handle)?;
    recovery_row(&connection,&operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn list_experiment_run_switch_recoveries(app_handle: AppHandle, run_id: String) -> Result<Vec<ExperimentRunSwitchRecoveryRecord>,String> {
    let connection = open_connection(&app_handle)?;
    let mut statement = connection.prepare(
        "SELECT operation_id FROM experiment_run_manuscript_switch_recoveries
         WHERE run_id=?1 AND manuscript_channel='primary' AND phase NOT IN ('resolved','cancelled_safe')"
    ).map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    let ids = statement.query_map([run_id], |r| r.get::<_,String>(0))
        .map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    ids.iter().map(|id| get_recovery_summary_in_connection(&connection,id)).collect()
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn discover_experiment_run_switch_recoveries(app_handle: AppHandle) -> Result<Vec<ExperimentRunSwitchRecoveryRecord>,String> {
    let connection = open_connection(&app_handle)?;
    let mut statement = connection.prepare(
        "SELECT operation_id FROM experiment_run_manuscript_switch_recoveries
         WHERE phase NOT IN ('resolved','cancelled_safe') ORDER BY run_id,operation_id"
    ).map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    let ids = statement.query_map([], |r| r.get::<_,String>(0))
        .map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "RUN_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    ids.iter().map(|id| get_recovery_summary_in_connection(&connection,id)).collect()
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn update_experiment_run_switch_recovery_phase(app_handle: AppHandle, input: ExperimentRunSwitchRecoveryPhaseInput) -> Result<ExperimentRunSwitchRecoveryRecord,String> {
    let connection = open_connection(&app_handle)?;
    update_recovery_phase_in_connection(&connection,&input)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn post_verify_experiment_run_switch_recovery(app_handle: AppHandle, operation_id: String) -> Result<ExperimentRunSwitchPostVerifyResult,String> {
    let connection = open_connection(&app_handle)?;
    post_verify_experiment_run_switch_recovery_in_connection(&connection,&operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn complete_experiment_run_switch_recovery(app_handle: AppHandle, operation_id: String, old_current_post_revision: String, updated_at: String) -> Result<ExperimentRunSwitchPostVerifyResult,String> {
    let mut connection = open_connection(&app_handle)?;
    complete_experiment_run_switch_recovery_in_connection(&mut connection,&operation_id,&old_current_post_revision,&updated_at)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn safe_cancel_experiment_run_switch_recovery(app_handle: AppHandle, operation_id: String, observed_old_current_revision: String, occurred_at: String) -> Result<ExperimentRunSwitchRecoveryRecord,String> {
    let connection = open_connection(&app_handle)?;
    let row = recovery_row(&connection,&operation_id)?;
    if row.phase != "prepared" || row.input.old_current_pre_revision != observed_old_current_revision {
        return Err("RUN_SWITCH_SAFE_CANCEL_NOT_ALLOWED".into());
    }
    let verify = post_verify_experiment_run_switch_recovery_in_connection(&connection,&operation_id)?;
    if verify.status != "not_committed" { return Err("RUN_SWITCH_SAFE_CANCEL_NOT_ALLOWED".into()); }
    update_recovery_phase_in_connection(&connection,&ExperimentRunSwitchRecoveryPhaseInput {
        operation_id, expected_phase:"prepared".into(), next_phase:"cancelled_safe".into(),
        occurred_at, old_current_post_revision:None, writeback_verification_result:Some("not_applied".into()),
        last_error_code:None, last_diagnostic_summary:Some("writeback=0;db=0".into()),
    })
}
