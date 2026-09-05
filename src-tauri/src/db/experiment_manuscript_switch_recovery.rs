use super::experiment_manuscript_switch::{
    commit_experiment_replacement_in_connection, ExperimentOutlineReplacement,
    ExperimentOwnerSwitchReplacementInput, ExperimentSwitchAudit,
};
use super::formal_switch_recovery::{
    is_canonical_formal_switch_phase, is_valid_formal_switch_transition,
    safe_formal_switch_file_name, safe_formal_switch_value,
};
use super::open_connection;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

pub(crate) const RECOVERY_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS experiment_manuscript_switch_recoveries (
  operation_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type = 'experiment'),
  experiment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  manuscript_channel TEXT NOT NULL CHECK (manuscript_channel = 'primary'),
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared','writeback_unknown','writeback_applied','db_commit_unknown','db_committed',
    'activation_pending','resolved','blocked','cancelled_safe'
  )),
  binding_id TEXT NOT NULL,
  expected_owner_updated_at TEXT NOT NULL,
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
  before_purpose_and_question TEXT,
  before_condition_summary TEXT,
  before_method_summary TEXT,
  before_result_summary TEXT,
  before_conclusion_and_next_steps TEXT,
  before_other TEXT,
  outline_replacements_json TEXT NOT NULL,
  experiment_title_snapshot TEXT NOT NULL,
  project_title_snapshot TEXT NOT NULL,
  rating_snapshot TEXT,
  tags_json TEXT NOT NULL,
  deterministic_writeback_version INTEGER NOT NULL CHECK (deterministic_writeback_version = 1),
  recorded_at TEXT NOT NULL,
  writeback_digest TEXT NOT NULL,
  writeback_byte_length INTEGER NOT NULL CHECK (writeback_byte_length >= 0),
  old_current_pre_revision TEXT NOT NULL,
  old_current_post_revision TEXT,
  old_current_pre_digest TEXT NOT NULL,
  old_current_expected_post_digest TEXT NOT NULL,
  writeback_verification_result TEXT CHECK (writeback_verification_result IS NULL OR writeback_verification_result IN ('pre-write','exact-post','conflict')),
  target_physical_revision TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  target_byte_length INTEGER NOT NULL CHECK (target_byte_length >= 0),
  old_current_file_name TEXT NOT NULL,
  target_file_name TEXT NOT NULL,
  default_file_name TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  activation_status TEXT NOT NULL DEFAULT 'pending',
  transaction_attempted_at TEXT,
  db_commit_observed_at TEXT,
  post_verify_status TEXT,
  operation_log_observed INTEGER NOT NULL DEFAULT 0 CHECK (operation_log_observed IN (0,1)),
  observed_current_file_ref_id TEXT,
  observed_default_file_ref_id TEXT,
  observed_outline_digest TEXT,
  last_error_code TEXT,
  last_diagnostic_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (old_current_file_ref_id <> target_file_ref_id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  FOREIGN KEY (binding_id) REFERENCES manuscript_bindings(id),
  FOREIGN KEY (old_current_file_ref_id) REFERENCES file_refs(id),
  FOREIGN KEY (default_file_ref_id) REFERENCES file_refs(id),
  FOREIGN KEY (target_file_ref_id) REFERENCES file_refs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_switch_recovery_unresolved_owner
  ON experiment_manuscript_switch_recoveries(experiment_id, manuscript_channel)
  WHERE phase NOT IN ('resolved','cancelled_safe');
CREATE INDEX IF NOT EXISTS idx_experiment_switch_recovery_phase
  ON experiment_manuscript_switch_recoveries(phase);
"#;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentSwitchRecoveryPrepareInput {
    pub(crate) operation_id: String,
    pub(crate) experiment_id: String,
    pub(crate) project_id: String,
    pub(crate) binding_id: String,
    pub(crate) expected_owner_updated_at: String,
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
    pub(crate) before_purpose_and_question: Option<String>,
    pub(crate) before_condition_summary: Option<String>,
    pub(crate) before_method_summary: Option<String>,
    pub(crate) before_result_summary: Option<String>,
    pub(crate) before_conclusion_and_next_steps: Option<String>,
    pub(crate) before_other: Option<String>,
    pub(crate) outline_replacements_json: String,
    pub(crate) experiment_title_snapshot: String,
    pub(crate) project_title_snapshot: String,
    pub(crate) rating_snapshot: Option<String>,
    pub(crate) tags_json: String,
    pub(crate) deterministic_writeback_version: i64,
    pub(crate) recorded_at: String,
    pub(crate) writeback_digest: String,
    pub(crate) writeback_byte_length: i64,
    pub(crate) old_current_pre_revision: String,
    pub(crate) old_current_pre_digest: String,
    pub(crate) old_current_expected_post_digest: String,
    pub(crate) target_physical_revision: String,
    pub(crate) target_digest: String,
    pub(crate) target_byte_length: i64,
    pub(crate) old_current_file_name: String,
    pub(crate) target_file_name: String,
    pub(crate) default_file_name: String,
    pub(crate) correlation_id: String,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentSwitchRecoveryRecord {
    pub(crate) operation_id: String,
    pub(crate) experiment_id: String,
    pub(crate) project_id: String,
    pub(crate) phase: String,
    pub(crate) old_current_file_ref_id: String,
    pub(crate) target_file_ref_id: String,
    pub(crate) default_file_ref_id: String,
    pub(crate) old_current_file_name: String,
    pub(crate) target_file_name: String,
    pub(crate) default_file_name: String,
    pub(crate) old_current_pre_revision: String,
    pub(crate) old_current_post_revision: Option<String>,
    pub(crate) writeback_digest: String,
    pub(crate) writeback_byte_length: i64,
    pub(crate) writeback_verification_result: Option<String>,
    pub(crate) activation_status: String,
    pub(crate) last_error_code: Option<String>,
    pub(crate) recorded_at: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentSwitchRecoveryDetail {
    pub(crate) input: ExperimentSwitchRecoveryPrepareInput,
    pub(crate) phase: String,
    pub(crate) old_current_post_revision: Option<String>,
    pub(crate) writeback_verification_result: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentSwitchRecoveryPhaseInput {
    pub(crate) operation_id: String,
    pub(crate) expected_phase: String,
    pub(crate) next_phase: String,
    pub(crate) occurred_at: String,
    pub(crate) old_current_post_revision: Option<String>,
    pub(crate) writeback_verification_result: Option<String>,
    pub(crate) last_error_code: Option<String>,
    pub(crate) last_diagnostic_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentSwitchRecoveryPostVerifyResult {
    pub(crate) status: String,
    pub(crate) operation_id: String,
    pub(crate) phase: String,
    pub(crate) current_file_ref_id: Option<String>,
    pub(crate) default_file_ref_id: Option<String>,
    pub(crate) operation_log_count: i64,
    pub(crate) database_read_source: &'static str,
    pub(crate) safe_diagnostic_code: String,
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

#[cfg(test)]
pub(crate) fn ensure_recovery_schema_in_connection(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(RECOVERY_SCHEMA_SQL)
        .map_err(|error| format!("EXPERIMENT_SWITCH_RECOVERY_PERSIST_FAILED: {error}"))
}

fn validate_prepare(input: &ExperimentSwitchRecoveryPrepareInput) -> Result<(), String> {
    let replacements: Vec<Value> = serde_json::from_str(&input.outline_replacements_json)
        .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_PERSIST_FAILED".to_string())?;
    if !safe_formal_switch_value(&input.operation_id) || replacements.len() != 6
        || input.deterministic_writeback_version != 1 || input.writeback_byte_length < 0
        || input.target_byte_length < 0 || input.old_current_file_ref_id == input.target_file_ref_id
        || serde_json::from_str::<Vec<String>>(&input.tags_json).is_err()
        || !safe_formal_switch_file_name(&input.old_current_file_name)
        || !safe_formal_switch_file_name(&input.target_file_name)
        || !safe_formal_switch_file_name(&input.default_file_name)
    { return Err("EXPERIMENT_SWITCH_RECOVERY_PERSIST_FAILED".into()); }
    Ok(())
}

fn record(connection: &Connection, operation_id: &str) -> Result<ExperimentSwitchRecoveryRecord, String> {
    connection.query_row(
        "SELECT operation_id,experiment_id,project_id,phase,old_current_file_ref_id,target_file_ref_id,
                default_file_ref_id,old_current_file_name,target_file_name,default_file_name,
                old_current_pre_revision,old_current_post_revision,writeback_digest,writeback_byte_length,
                writeback_verification_result,activation_status,last_error_code,recorded_at,created_at,updated_at
         FROM experiment_manuscript_switch_recoveries WHERE operation_id=?1", [operation_id], |row| Ok(ExperimentSwitchRecoveryRecord {
            operation_id: row.get(0)?, experiment_id: row.get(1)?, project_id: row.get(2)?, phase: row.get(3)?,
            old_current_file_ref_id: row.get(4)?, target_file_ref_id: row.get(5)?, default_file_ref_id: row.get(6)?,
            old_current_file_name: row.get(7)?, target_file_name: row.get(8)?, default_file_name: row.get(9)?,
            old_current_pre_revision: row.get(10)?, old_current_post_revision: row.get(11)?, writeback_digest: row.get(12)?,
            writeback_byte_length: row.get(13)?, writeback_verification_result: row.get(14)?, activation_status: row.get(15)?,
            last_error_code: row.get(16)?, recorded_at: row.get(17)?, created_at: row.get(18)?, updated_at: row.get(19)?,
        })
    ).map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_NOT_FOUND".to_string())
}

pub(crate) fn prepare_experiment_switch_recovery_in_connection(connection: &Connection, input: &ExperimentSwitchRecoveryPrepareInput) -> Result<ExperimentSwitchRecoveryRecord, String> {
    validate_prepare(input)?;
    connection.execute(
        "INSERT INTO experiment_manuscript_switch_recoveries (
          operation_id,owner_type,experiment_id,project_id,manuscript_channel,phase,binding_id,
          expected_owner_updated_at,expected_binding_updated_at,old_current_file_ref_id,
          old_current_file_ref_updated_at,old_current_path_identity,old_current_location_mode,
          default_file_ref_id,default_file_ref_updated_at,default_path_identity,default_location_mode,
          target_file_ref_id,target_file_ref_updated_at,target_path_identity,target_location_mode,
          before_purpose_and_question,before_condition_summary,before_method_summary,before_result_summary,
          before_conclusion_and_next_steps,before_other,
          outline_replacements_json,experiment_title_snapshot,project_title_snapshot,rating_snapshot,tags_json,
          deterministic_writeback_version,recorded_at,writeback_digest,writeback_byte_length,
          old_current_pre_revision,old_current_pre_digest,old_current_expected_post_digest,
          target_physical_revision,target_digest,target_byte_length,old_current_file_name,target_file_name,
          default_file_name,correlation_id,created_at,updated_at
        ) VALUES (?1,'experiment',?2,?3,'primary','prepared',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,
          ?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,
          ?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44,?44)", params![
          input.operation_id,input.experiment_id,input.project_id,input.binding_id,input.expected_owner_updated_at,
          input.expected_binding_updated_at,input.old_current_file_ref_id,input.old_current_file_ref_updated_at,
          input.old_current_path_identity,input.old_current_location_mode,input.default_file_ref_id,
          input.default_file_ref_updated_at,input.default_path_identity,input.default_location_mode,
          input.target_file_ref_id,input.target_file_ref_updated_at,input.target_path_identity,input.target_location_mode,
          input.before_purpose_and_question,input.before_condition_summary,input.before_method_summary,
          input.before_result_summary,input.before_conclusion_and_next_steps,input.before_other,
          input.outline_replacements_json,input.experiment_title_snapshot,input.project_title_snapshot,input.rating_snapshot,
          input.tags_json,input.deterministic_writeback_version,input.recorded_at,input.writeback_digest,
          input.writeback_byte_length,input.old_current_pre_revision,input.old_current_pre_digest,
          input.old_current_expected_post_digest,input.target_physical_revision,input.target_digest,input.target_byte_length,
          input.old_current_file_name,input.target_file_name,input.default_file_name,input.correlation_id,input.created_at
        ]).map_err(|error| if error.to_string().contains("UNIQUE constraint failed") {
            "EXPERIMENT_SWITCH_RECOVERY_ALREADY_ACTIVE".to_string()
        } else { format!("EXPERIMENT_SWITCH_RECOVERY_PERSIST_FAILED: {error}") })?;
    record(connection, &input.operation_id)
}

pub(crate) fn get_experiment_switch_recovery_detail_in_connection(connection: &Connection, operation_id: &str) -> Result<ExperimentSwitchRecoveryDetail, String> {
    connection.query_row(
      "SELECT operation_id,experiment_id,project_id,binding_id,expected_owner_updated_at,expected_binding_updated_at,
       old_current_file_ref_id,old_current_file_ref_updated_at,old_current_path_identity,old_current_location_mode,
       default_file_ref_id,default_file_ref_updated_at,default_path_identity,default_location_mode,target_file_ref_id,
       target_file_ref_updated_at,target_path_identity,target_location_mode,before_purpose_and_question,
       before_condition_summary,before_method_summary,before_result_summary,before_conclusion_and_next_steps,before_other,
       outline_replacements_json,experiment_title_snapshot,project_title_snapshot,rating_snapshot,tags_json,
       deterministic_writeback_version,recorded_at,writeback_digest,writeback_byte_length,old_current_pre_revision,
       old_current_pre_digest,old_current_expected_post_digest,target_physical_revision,target_digest,target_byte_length,
       old_current_file_name,target_file_name,default_file_name,correlation_id,created_at,phase,old_current_post_revision,
       writeback_verification_result FROM experiment_manuscript_switch_recoveries WHERE operation_id=?1", [operation_id], |r| Ok(ExperimentSwitchRecoveryDetail {
        input: ExperimentSwitchRecoveryPrepareInput {
          operation_id:r.get(0)?,experiment_id:r.get(1)?,project_id:r.get(2)?,binding_id:r.get(3)?,expected_owner_updated_at:r.get(4)?,expected_binding_updated_at:r.get(5)?,
          old_current_file_ref_id:r.get(6)?,old_current_file_ref_updated_at:r.get(7)?,old_current_path_identity:r.get(8)?,old_current_location_mode:r.get(9)?,
          default_file_ref_id:r.get(10)?,default_file_ref_updated_at:r.get(11)?,default_path_identity:r.get(12)?,default_location_mode:r.get(13)?,
          target_file_ref_id:r.get(14)?,target_file_ref_updated_at:r.get(15)?,target_path_identity:r.get(16)?,target_location_mode:r.get(17)?,
          before_purpose_and_question:r.get(18)?,before_condition_summary:r.get(19)?,before_method_summary:r.get(20)?,
          before_result_summary:r.get(21)?,before_conclusion_and_next_steps:r.get(22)?,before_other:r.get(23)?,
          outline_replacements_json:r.get(24)?,experiment_title_snapshot:r.get(25)?,project_title_snapshot:r.get(26)?,rating_snapshot:r.get(27)?,tags_json:r.get(28)?,
          deterministic_writeback_version:r.get(29)?,recorded_at:r.get(30)?,writeback_digest:r.get(31)?,writeback_byte_length:r.get(32)?,old_current_pre_revision:r.get(33)?,
          old_current_pre_digest:r.get(34)?,old_current_expected_post_digest:r.get(35)?,target_physical_revision:r.get(36)?,target_digest:r.get(37)?,target_byte_length:r.get(38)?,
          old_current_file_name:r.get(39)?,target_file_name:r.get(40)?,default_file_name:r.get(41)?,correlation_id:r.get(42)?,created_at:r.get(43)?,
        }, phase:r.get(44)?,old_current_post_revision:r.get(45)?,writeback_verification_result:r.get(46)?
      })
    ).map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_NOT_FOUND".to_string())
}

fn list_records(connection: &Connection, experiment_id: &str) -> Result<Vec<ExperimentSwitchRecoveryRecord>, String> {
    let mut statement = connection.prepare(
      "SELECT operation_id FROM experiment_manuscript_switch_recoveries r JOIN experiments e ON e.id=r.experiment_id
       WHERE r.experiment_id=?1 AND e.deleted_at IS NULL AND r.phase NOT IN ('resolved','cancelled_safe') ORDER BY r.created_at"
    ).map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    let ids = statement.query_map([experiment_id], |row| row.get::<_, String>(0))
      .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?
      .collect::<Result<Vec<_>, _>>().map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    ids.iter().map(|id| record(connection,id)).collect()
}

pub(crate) fn update_experiment_switch_recovery_phase_in_connection(connection: &Connection, input: &ExperimentSwitchRecoveryPhaseInput) -> Result<ExperimentSwitchRecoveryRecord, String> {
    if !is_canonical_formal_switch_phase(&input.expected_phase)
      || !is_canonical_formal_switch_phase(&input.next_phase)
      || !is_valid_formal_switch_transition(&input.expected_phase, &input.next_phase) {
        return Err("EXPERIMENT_SWITCH_RECOVERY_TRANSITION_INVALID".into());
    }
    if matches!(input.expected_phase.as_str(), "resolved" | "cancelled_safe") && input.expected_phase != input.next_phase {
      return Err("EXPERIMENT_SWITCH_RECOVERY_TRANSITION_INVALID".into());
    }
    let changed = connection.execute(
      "UPDATE experiment_manuscript_switch_recoveries SET phase=?1,old_current_post_revision=COALESCE(?2,old_current_post_revision),
       writeback_verification_result=COALESCE(?3,writeback_verification_result),last_error_code=?4,last_diagnostic_summary=?5,
       activation_status=CASE WHEN ?1='resolved' THEN 'complete' WHEN ?1='activation_pending' THEN 'pending' ELSE activation_status END,
       resolved_at=CASE WHEN ?1 IN ('resolved','cancelled_safe') THEN ?6 ELSE resolved_at END,updated_at=?6
       WHERE operation_id=?7 AND phase=?8", params![input.next_phase,input.old_current_post_revision,input.writeback_verification_result,
       input.last_error_code,input.last_diagnostic_summary,input.occurred_at,input.operation_id,input.expected_phase]
    ).map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_UPDATE_FAILED".to_string())?;
    if changed != 1 { return Err("EXPERIMENT_SWITCH_RECOVERY_TRANSITION_STALE".into()); }
    record(connection,&input.operation_id)
}

pub(crate) fn post_verify_experiment_switch_recovery_in_connection(connection: &Connection, operation_id: &str) -> Result<ExperimentSwitchRecoveryPostVerifyResult, String> {
    let detail = get_experiment_switch_recovery_detail_in_connection(connection,operation_id)?;
    let binding: Option<(Option<String>,Option<String>)> = connection.query_row(
      "SELECT current_file_ref_id,default_manuscript_file_ref_id FROM manuscript_bindings WHERE id=?1 AND owner_id=?2",
      params![detail.input.binding_id,detail.input.experiment_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()
      .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    let log_count: i64 = connection.query_row("SELECT COUNT(*) FROM operation_logs WHERE id=?1 AND module='experiment' AND status='success' AND deleted_at IS NULL AND feedback LIKE '%EXPERIMENT_FORMAL_SWITCH_COMMITTED%'",[operation_id],|r|r.get(0))
      .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    let owner_outline:Option<(Option<String>,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>)>=connection.query_row(
      "SELECT purpose_and_question,condition_summary,method_summary,result_summary,conclusion_and_next_steps,other
       FROM experiments WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL",
      params![detail.input.experiment_id,detail.input.project_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()
      .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    let replacements:Vec<Value>=serde_json::from_str(&detail.input.outline_replacements_json)
      .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    let expected=replacements.iter().map(|replacement| {
      if replacement.get("action").and_then(Value::as_str)==Some("set") {
        replacement.get("value").and_then(Value::as_str).map(str::to_string)
      } else if matches!(
        replacement.get("key").and_then(Value::as_str),
        Some("resultSummary")
      ) { Some(String::new()) } else { None }
    }).collect::<Vec<_>>();
    let outline_exact=owner_outline.as_ref().is_some_and(|actual| expected.len()==6 &&
      [&actual.0,&actual.1,&actual.2,&actual.3,&actual.4,&actual.5]
        .iter().zip(expected.iter()).all(|(left,right)|*left==right));
    let target_exact:i64=connection.query_row(
      "SELECT COUNT(*) FROM file_refs WHERE id=?1 AND owner_type='experiment' AND owner_id=?2
       AND manuscript_channel='primary' AND resource_kind='file' AND file_role='manuscript'
       AND path_identity_key=?3 AND location_mode=?4 AND deleted_at IS NULL",
      params![detail.input.target_file_ref_id,detail.input.experiment_id,
        detail.input.target_path_identity,detail.input.target_location_mode],|r|r.get(0))
      .map_err(|_| "EXPERIMENT_SWITCH_RECOVERY_READ_FAILED".to_string())?;
    let (current,default) = binding.unwrap_or((None,None));
    let committed = current.as_deref()==Some(detail.input.target_file_ref_id.as_str())
      && default.as_deref()==Some(detail.input.default_file_ref_id.as_str()) && outline_exact && target_exact==1;
    let status = if current.is_none() || owner_outline.is_none() || target_exact!=1 { "identity_missing" } else if log_count>1 { "duplicate_operation_log" }
      else if committed && log_count==1 { "committed_exact" }
      else if current.as_deref()==Some(detail.input.old_current_file_ref_id.as_str()) && log_count==0 { "not_committed" }
      else { "committed_mismatch" };
    Ok(ExperimentSwitchRecoveryPostVerifyResult { status:status.into(),operation_id:operation_id.into(),phase:detail.phase,
      current_file_ref_id:current,default_file_ref_id:default,operation_log_count:log_count,database_read_source:"sqlite-direct",
      safe_diagnostic_code:format!("EXPERIMENT_SWITCH_VERIFY_{}",status.to_ascii_uppercase()) })
}

pub(crate) fn complete_experiment_switch_recovery_in_connection(
    connection: &mut Connection,
    operation_id: &str,
    old_current_post_revision: &str,
    occurred_at: &str,
) -> Result<ExperimentSwitchRecoveryPostVerifyResult, String> {
    let detail = get_experiment_switch_recovery_detail_in_connection(connection, operation_id)?;
    if detail.phase != "writeback_applied"
      || detail.old_current_post_revision.as_deref() != Some(old_current_post_revision) {
        return Err("EXPERIMENT_SWITCH_DB_ONLY_COMPLETION_BLOCKED".into());
    }
    let verify = post_verify_experiment_switch_recovery_in_connection(connection, operation_id)?;
    if verify.status != "not_committed" {
        return Err("EXPERIMENT_SWITCH_DB_ONLY_COMPLETION_BLOCKED".into());
    }
    update_experiment_switch_recovery_phase_in_connection(connection, &ExperimentSwitchRecoveryPhaseInput {
        operation_id: operation_id.into(), expected_phase: "writeback_applied".into(),
        next_phase: "db_commit_unknown".into(), occurred_at: occurred_at.into(),
        old_current_post_revision: Some(old_current_post_revision.into()),
        writeback_verification_result: Some("exact-post".into()),
        last_error_code: None, last_diagnostic_summary: None,
    })?;
    let replacements: Vec<ExperimentOutlineReplacement> = serde_json::from_str(&detail.input.outline_replacements_json)
        .map_err(|_| "EXPERIMENT_SWITCH_DB_ONLY_COMPLETION_BLOCKED".to_string())?;
    let input = ExperimentOwnerSwitchReplacementInput {
        owner_type: "experiment".into(), owner_id: detail.input.experiment_id.clone(),
        project_id: detail.input.project_id.clone(), manuscript_channel: "primary".into(),
        binding_id: detail.input.binding_id.clone(), expected_binding_updated_at: detail.input.expected_binding_updated_at.clone(),
        expected_current_file_ref_id: detail.input.old_current_file_ref_id.clone(),
        expected_default_manuscript_file_ref_id: detail.input.default_file_ref_id.clone(),
        expected_default_path_identity: detail.input.default_path_identity.clone(),
        target_file_ref_id: detail.input.target_file_ref_id.clone(),
        target_path_identity: detail.input.target_path_identity.clone(),
        target_location_mode: detail.input.target_location_mode.clone(),
        outline_replacements: replacements,
        outline_digest: digest_bytes(detail.input.outline_replacements_json.as_bytes()),
        old_current_post_revision: old_current_post_revision.into(),
        target_physical_revision: detail.input.target_physical_revision.clone(),
        occurred_at: detail.input.recorded_at.clone(), operation_id: detail.input.operation_id.clone(),
        correlation_id: detail.input.correlation_id.clone(),
        audit: ExperimentSwitchAudit { actor_id: "local_user".into(), actor_label: "Local user".into(), source: "user".into() },
    };
    if commit_experiment_replacement_in_connection(connection, &input).is_err() {
        let verify = post_verify_experiment_switch_recovery_in_connection(connection, operation_id)?;
        if verify.status == "not_committed" {
            update_experiment_switch_recovery_phase_in_connection(connection, &ExperimentSwitchRecoveryPhaseInput {
                operation_id: operation_id.into(), expected_phase: "db_commit_unknown".into(),
                next_phase: "writeback_applied".into(), occurred_at: occurred_at.into(),
                old_current_post_revision: Some(old_current_post_revision.into()),
                writeback_verification_result: Some("exact-post".into()),
                last_error_code: Some("EXPERIMENT_SWITCH_DB_ONLY_COMPLETION_FAILED".into()),
                last_diagnostic_summary: Some("database completion not committed".into()),
            })?;
        }
        return Err("EXPERIMENT_SWITCH_DB_ONLY_COMPLETION_FAILED".into());
    }
    post_verify_experiment_switch_recovery_in_connection(connection, operation_id)
}

pub(crate) fn safe_cancel_experiment_switch_recovery_in_connection(connection:&Connection, operation_id:&str, observed_revision:&str, occurred_at:&str) -> Result<ExperimentSwitchRecoveryRecord,String> {
    let detail=get_experiment_switch_recovery_detail_in_connection(connection,operation_id)?;
    let verify=post_verify_experiment_switch_recovery_in_connection(connection,operation_id)?;
    if detail.phase!="prepared" || observed_revision!=detail.input.old_current_pre_revision || verify.status!="not_committed" {
      return Err("EXPERIMENT_SWITCH_RECOVERY_CANCEL_UNSAFE".into());
    }
    update_experiment_switch_recovery_phase_in_connection(connection,&ExperimentSwitchRecoveryPhaseInput { operation_id:operation_id.into(),expected_phase:"prepared".into(),next_phase:"cancelled_safe".into(),occurred_at:occurred_at.into(),old_current_post_revision:None,writeback_verification_result:Some("pre-write".into()),last_error_code:None,last_diagnostic_summary:None })
}

fn legacy_string(value:&Value,key:&str)->String { value.get(key).and_then(Value::as_str).unwrap_or_default().to_string() }
fn migration_audit(connection:&Connection, operation_id:&str, experiment_id:&str, classification:&str, occurred_at:&str) -> rusqlite::Result<()> {
    let id=format!("legacy-experiment-switch-migration-{operation_id}");
    let feedback=serde_json::json!({"status":"success","details":{"code":"LEGACY_EXPERIMENT_SWITCH_MIGRATED","classification":classification}}).to_string();
    connection.execute("INSERT OR IGNORE INTO operation_logs (id,operation_type,source,module,status,risk_level,target,summary,related_entities,confirmation,feedback,warnings,errors,skipped,is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at)
      VALUES (?1,'custom','system','experiment','success','low',?2,'Legacy Experiment switch recovery reconciled','[]','{}',?3,'[]','[]','[]',0,'system','LabPod migration','[]',1,?4,?4)",
      params![id,serde_json::json!({"entityType":"experiment","entityId":experiment_id}).to_string(),feedback,occurred_at])?;
    Ok(())
}

fn legacy_successor_proves_commit(
    connection:&Connection,
    experiment_id:&str,
    target_file_ref_id:&str,
    committed_at:&str,
) -> rusqlite::Result<bool> {
    if committed_at.is_empty() { return Ok(false); }
    let mut statement=connection.prepare(
      "SELECT feedback FROM operation_logs WHERE module='experiment' AND feedback LIKE '%manuscriptSwitchRecovery%'"
    )?;
    let rows=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    Ok(rows.iter().any(|raw| {
      serde_json::from_str::<Value>(raw).ok()
        .and_then(|json|json.pointer("/details/manuscriptSwitchRecovery").cloned())
        .is_some_and(|next| legacy_string(&next,"experimentId")==experiment_id
          && legacy_string(&next,"oldCurrentFileRefId")==target_file_ref_id
          && legacy_string(&next,"expectedOwnerUpdatedAt")==committed_at
          && legacy_string(&next,"expectedBindingUpdatedAt")==committed_at)
    }))
}

fn legacy_successor_observed_writeback(
    connection:&Connection,
    experiment_id:&str,
    old_current_file_ref_id:&str,
    expected_post_digest:&str,
    occurred_at:&str,
) -> rusqlite::Result<bool> {
    if expected_post_digest.is_empty() || occurred_at.is_empty() { return Ok(false); }
    let mut statement=connection.prepare(
      "SELECT feedback FROM operation_logs WHERE module='experiment' AND feedback LIKE '%manuscriptSwitchRecovery%'"
    )?;
    let rows=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    Ok(rows.iter().any(|raw| {
      serde_json::from_str::<Value>(raw).ok()
        .and_then(|json|json.pointer("/details/manuscriptSwitchRecovery").cloned())
        .is_some_and(|next| legacy_string(&next,"experimentId")==experiment_id
          && legacy_string(&next,"oldCurrentFileRefId")==old_current_file_ref_id
          && legacy_string(&next,"oldCurrentPreHash")==expected_post_digest
          && legacy_string(&next,"occurredAt").as_str()>occurred_at)
    }))
}

pub(crate) fn migrate_legacy_experiment_switch_recoveries_in_connection(connection:&Connection)->rusqlite::Result<()> {
    let already:i64=connection.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version=37",[],|r|r.get(0))?;
    if already>0 { return Ok(()); }
    let mut statement=connection.prepare("SELECT id,feedback,status,created_at FROM operation_logs WHERE module='experiment' AND feedback LIKE '%manuscriptSwitchRecovery%'")?;
    let rows=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
    drop(statement);
    for (log_id,raw,status,created_at) in rows {
      let Ok(json)=serde_json::from_str::<Value>(&raw) else { migration_audit(connection,&log_id,"unknown","invalid_json",&created_at)?; continue; };
      let Some(payload)=json.pointer("/details/manuscriptSwitchRecovery") else { continue; };
      let operation_id=legacy_string(payload,"operationId"); let experiment_id=legacy_string(payload,"experimentId");
      if operation_id.is_empty() || experiment_id.is_empty() { migration_audit(connection,&log_id,&experiment_id,"invalid_identity",&created_at)?; continue; }
      let has_legacy_columns=connection.prepare("PRAGMA table_info(experiments)")?.query_map([],|r|r.get::<_,String>(1))?
        .collect::<Result<Vec<_>,_>>()?.iter().any(|column|column=="purpose");
      let owner_sql=if has_legacy_columns {
        "SELECT project_id,updated_at,purpose,research_question,hypothesis,condition_summary,method_summary,result_summary,conclusion,summary_other,title,rating,tags,deleted_at FROM experiments WHERE id=?1"
      } else {
        "SELECT project_id,updated_at,purpose_and_question,NULL,NULL,condition_summary,method_summary,result_summary,conclusion_and_next_steps,other,title,rating,tags,deleted_at FROM experiments WHERE id=?1"
      };
      let owner:Option<(String,String,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>,String,Option<String>,Option<String>,String,Option<String>,Option<String>,Option<String>)>=connection.query_row(
        owner_sql,
        [&experiment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?))).optional()?;
      let Some(owner)=owner else { migration_audit(connection,&operation_id,&experiment_id,"orphan_skipped",&created_at)?; continue; };
      let old_id=legacy_string(payload,"oldCurrentFileRefId");let target_id=legacy_string(payload,"targetFileRefId");let default_id=legacy_string(payload,"defaultFileRefId");let binding_id=legacy_string(payload,"bindingId");
      let binding:Option<(Option<String>,Option<String>,String)>=connection.query_row("SELECT current_file_ref_id,default_manuscript_file_ref_id,updated_at FROM manuscript_bindings WHERE id=?1",[&binding_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
      let file=|id:&str|->rusqlite::Result<Option<(String,String,String,String)>>{connection.query_row("SELECT updated_at,path_identity_key,location_mode,path FROM file_refs WHERE id=?1 AND deleted_at IS NULL",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()};
      let (Some(binding),Some(old),Some(default),Some(target))=(binding,file(&old_id)?,file(&default_id)?,file(&target_id)?) else { migration_audit(connection,&operation_id,&experiment_id,"identity_missing",&created_at)?; continue; };
      let phase_name=legacy_string(payload,"phase");
      let physical_digest=std::fs::read(&old.3).ok().map(|bytes|digest_bytes(&bytes));
      let expected_post_digest=legacy_string(payload,"oldCurrentExpectedPostHash");
      let stored_post_revision=legacy_string(payload,"oldCurrentPostRevision");
      let stored_verification=legacy_string(payload,"writebackVerificationResult");
      let exact_post=!expected_post_digest.is_empty() && physical_digest.as_deref()==Some(expected_post_digest.as_str());
      let success_at_operation:i64=connection.query_row(
        "SELECT COUNT(*) FROM operation_logs WHERE id=?1 AND module='experiment' AND status='success' AND deleted_at IS NULL",
        [&operation_id],|r|r.get(0))?;
      let no_effect=phase_name=="prepared" && stored_post_revision.is_empty() && stored_verification.is_empty()
        && binding.0.as_deref()==Some(old_id.as_str()) && binding.0.as_deref()!=Some(target_id.as_str())
        && success_at_operation==0;
      let stored_exact_post=!expected_post_digest.is_empty() && stored_post_revision==expected_post_digest
        && (stored_verification.is_empty() || stored_verification=="exact-post");
      let occurred_at=legacy_string(payload,"occurredAt");
      let successor_commit=legacy_successor_proves_commit(connection,&experiment_id,&target_id,&occurred_at)?;
      let successor_observed_writeback=legacy_successor_observed_writeback(
        connection,&experiment_id,&old_id,&expected_post_digest,&occurred_at)?;
      let committed=stored_exact_post && ((status=="success" && log_id==operation_id) || successor_commit);
      let classification=if no_effect {"cancelled_safe"} else if committed || successor_observed_writeback {"resolved"} else {"blocked"};
      let replacements=serde_json::json!([
        {"key":"purposeAndQuestion","action":"clear"},{"key":"conditionSummary","action":"clear"},
        {"key":"methodSummary","action":"clear"},{"key":"resultSummary","action":"clear"},
        {"key":"conclusionAndNextSteps","action":"clear"},{"key":"other","action":"clear"}
      ]).to_string();
      let purpose_and_question=[("实验目的",owner.2.as_deref()),("研究问题",owner.3.as_deref()),("研究假设",owner.4.as_deref())]
        .into_iter().filter_map(|(label,value)|value.filter(|text|!text.trim().is_empty()).map(|text|format!("{label}：\n{text}")))
        .collect::<Vec<_>>().join("\n\n");
      connection.execute("INSERT INTO experiment_manuscript_switch_recoveries (
        operation_id,owner_type,experiment_id,project_id,manuscript_channel,phase,binding_id,expected_owner_updated_at,expected_binding_updated_at,
        old_current_file_ref_id,old_current_file_ref_updated_at,old_current_path_identity,old_current_location_mode,default_file_ref_id,default_file_ref_updated_at,default_path_identity,default_location_mode,
        target_file_ref_id,target_file_ref_updated_at,target_path_identity,target_location_mode,before_purpose_and_question,before_condition_summary,before_method_summary,before_result_summary,before_conclusion_and_next_steps,before_other,
        outline_replacements_json,experiment_title_snapshot,project_title_snapshot,rating_snapshot,tags_json,deterministic_writeback_version,recorded_at,writeback_digest,writeback_byte_length,
        old_current_pre_revision,old_current_pre_digest,old_current_expected_post_digest,target_physical_revision,target_digest,target_byte_length,old_current_file_name,target_file_name,default_file_name,correlation_id,
        activation_status,last_error_code,last_diagnostic_summary,created_at,updated_at,resolved_at)
        VALUES (?1,'experiment',?2,?3,'primary',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,'legacy migration',?28,COALESCE(?29,'[]'),1,?30,?31,?32,?33,?34,?35,?36,?37,?38,'previous manuscript.md','target manuscript.md','default manuscript.md',?39,?40,?41,?42,?30,?30,CASE WHEN ?4 IN ('resolved','cancelled_safe') THEN ?30 ELSE NULL END)",params![
          operation_id,experiment_id,owner.0,classification,binding_id,legacy_string(payload,"expectedOwnerUpdatedAt"),binding.2,old_id,old.0,old.1,old.2,default_id,default.0,default.1,default.2,
          target_id,target.0,target.1,target.2,if purpose_and_question.is_empty(){None}else{Some(purpose_and_question)},owner.5,owner.6,owner.7,owner.8,owner.9,replacements,owner.10,owner.11,owner.12,created_at,
          legacy_string(payload,"writebackDigest"),payload.get("writebackByteLength").and_then(Value::as_i64).unwrap_or(0),legacy_string(payload,"oldCurrentPreRevision"),legacy_string(payload,"oldCurrentPreHash"),
          legacy_string(payload,"oldCurrentExpectedPostHash"),legacy_string(payload,"targetRevision"),legacy_string(payload,"targetHash"),payload.get("targetByteLength").and_then(Value::as_i64).unwrap_or(0),
          legacy_string(payload,"correlationId"),if classification=="resolved"{"complete"}else{"pending"},
          if classification=="blocked"{Some("LEGACY_RECOVERY_EVIDENCE_UNCERTAIN")}else{None},format!("evidence_classification:{classification};legacy_log:{log_id}")
        ])?;
      connection.execute(
        "UPDATE experiment_manuscript_switch_recoveries SET writeback_verification_result=?1
         WHERE operation_id=?2 AND writeback_verification_result IS NULL",
        params![if no_effect {Some("pre-write")} else if exact_post || stored_exact_post {Some("exact-post")} else {Some("conflict")},operation_id]
      )?;
      migration_audit(connection,&operation_id,&experiment_id,classification,&created_at)?;
    }
    connection.execute("INSERT INTO schema_migrations(version,name) VALUES(37,'experiment_manuscript_canonical_recovery')",[])?;
    Ok(())
}

#[tauri::command(rename_all="camelCase")]
pub fn prepare_experiment_switch_recovery(app_handle:AppHandle,input:ExperimentSwitchRecoveryPrepareInput)->Result<ExperimentSwitchRecoveryRecord,String>{let c=open_connection(&app_handle)?;prepare_experiment_switch_recovery_in_connection(&c,&input)}
#[tauri::command(rename_all="camelCase")]
pub fn get_experiment_switch_recovery(app_handle:AppHandle,operation_id:String)->Result<ExperimentSwitchRecoveryRecord,String>{let c=open_connection(&app_handle)?;record(&c,&operation_id)}
#[tauri::command(rename_all="camelCase")]
pub fn get_experiment_switch_recovery_detail(app_handle:AppHandle,operation_id:String)->Result<ExperimentSwitchRecoveryDetail,String>{let c=open_connection(&app_handle)?;get_experiment_switch_recovery_detail_in_connection(&c,&operation_id)}
#[tauri::command(rename_all="camelCase")]
pub fn list_experiment_switch_recoveries(app_handle:AppHandle,experiment_id:String)->Result<Vec<ExperimentSwitchRecoveryRecord>,String>{let c=open_connection(&app_handle)?;list_records(&c,&experiment_id)}
#[tauri::command(rename_all="camelCase")]
pub fn update_experiment_switch_recovery_phase(app_handle:AppHandle,input:ExperimentSwitchRecoveryPhaseInput)->Result<ExperimentSwitchRecoveryRecord,String>{let c=open_connection(&app_handle)?;update_experiment_switch_recovery_phase_in_connection(&c,&input)}
#[tauri::command(rename_all="camelCase")]
pub fn post_verify_experiment_switch_recovery(app_handle:AppHandle,operation_id:String)->Result<ExperimentSwitchRecoveryPostVerifyResult,String>{let c=open_connection(&app_handle)?;post_verify_experiment_switch_recovery_in_connection(&c,&operation_id)}
#[tauri::command(rename_all="camelCase")]
pub fn safe_cancel_experiment_switch_recovery(app_handle:AppHandle,operation_id:String,observed_old_current_revision:String,occurred_at:String)->Result<ExperimentSwitchRecoveryRecord,String>{let c=open_connection(&app_handle)?;safe_cancel_experiment_switch_recovery_in_connection(&c,&operation_id,&observed_old_current_revision,&occurred_at)}
#[tauri::command(rename_all="camelCase")]
pub fn complete_experiment_switch_recovery(app_handle:AppHandle,operation_id:String,old_current_post_revision:String,occurred_at:String)->Result<ExperimentSwitchRecoveryPostVerifyResult,String>{let mut c=open_connection(&app_handle)?;complete_experiment_switch_recovery_in_connection(&mut c,&operation_id,&old_current_post_revision,&occurred_at)}
