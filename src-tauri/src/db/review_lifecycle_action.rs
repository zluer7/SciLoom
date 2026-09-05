use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const REVIEW_LIFECYCLE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS review_lifecycle_actions (
  lifecycle_action_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('review_soft_delete', 'review_restore')),
  review_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  expected_review_source_state TEXT NOT NULL CHECK (expected_review_source_state IN ('active', 'deleted')),
  expected_review_updated_at TEXT NOT NULL,
  expected_review_deleted_at TEXT,
  target_review_updated_at TEXT NOT NULL,
  target_review_deleted_at TEXT,
  expected_planning_epoch TEXT NOT NULL,
  expected_planning_revision TEXT NOT NULL,
  planned_committed_planning_revision TEXT NOT NULL,
  committed_planning_epoch TEXT,
  committed_planning_revision TEXT,
  planning_effect_id TEXT NOT NULL UNIQUE,
  source_delete_action_id TEXT,
  exact_recycle_entry_id TEXT NOT NULL,
  operation_log_effect_id TEXT NOT NULL UNIQUE,
  recycle_effect_id TEXT NOT NULL UNIQUE,
  current_stage TEXT NOT NULL CHECK (current_stage IN (
    'prepared', 'planning_committed', 'operation_log_recorded',
    'recycle_effect_recorded', 'completed'
  )),
  terminal_result TEXT CHECK (terminal_result IN (
    'completed', 'cancelled_before_mutation', 'planning_conflict',
    'identity_conflict', 'source_state_conflict', 'recycle_entry_conflict',
    'already_terminal_by_other_action', 'non_retryable_failure'
  )),
  last_error_code TEXT,
  last_error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (last_error_retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (operation_type = 'review_soft_delete'
      AND expected_review_source_state = 'active'
      AND expected_review_deleted_at IS NULL
      AND target_review_deleted_at IS NOT NULL
      AND source_delete_action_id IS NULL)
    OR
    (operation_type = 'review_restore'
      AND expected_review_source_state = 'deleted'
      AND expected_review_deleted_at IS NOT NULL
      AND target_review_deleted_at IS NULL
      AND source_delete_action_id IS NOT NULL)
  ),
  CHECK (terminal_result <> 'completed' OR current_stage = 'completed'),
  CHECK ((committed_planning_epoch IS NULL) = (committed_planning_revision IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_lifecycle_actions_pending_review
  ON review_lifecycle_actions(review_id)
  WHERE terminal_result IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_lifecycle_actions_review_created
  ON review_lifecycle_actions(review_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operation_logs_review_lifecycle_effect
  ON operation_logs(lifecycle_action_id, effect_type)
  WHERE lifecycle_action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recycle_entries_created_by_review_lifecycle_action
  ON recycle_entries(created_by_lifecycle_action_id)
  WHERE created_by_lifecycle_action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recycle_entries_terminal_review_lifecycle_action
  ON recycle_entries(terminal_lifecycle_action_id)
  WHERE terminal_lifecycle_action_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (50, 'review_lifecycle_durable_action_authority');
"#;

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    add_column_if_missing(connection, "operation_logs", "lifecycle_action_id", "TEXT")?;
    add_column_if_missing(connection, "operation_logs", "effect_type", "TEXT")?;
    add_column_if_missing(
        connection,
        "recycle_entries",
        "created_by_lifecycle_action_id",
        "TEXT",
    )?;
    add_column_if_missing(
        connection,
        "recycle_entries",
        "terminal_lifecycle_action_id",
        "TEXT",
    )?;
    add_column_if_missing(
        connection,
        "recycle_entries",
        "revision",
        "INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)",
    )?;
    connection.execute_batch(REVIEW_LIFECYCLE_SCHEMA_SQL)
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let present: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name=?1"),
        [column],
        |row| row.get(0),
    )?;
    if present == 0 {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))?;
    }
    Ok(())
}

pub(crate) fn legacy_v49_schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let action_table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='review_lifecycle_actions'",
        [],
        |row| row.get(0),
    )?;
    let operation_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('operation_logs') WHERE name IN ('lifecycle_action_id','effect_type')",
        [],
        |row| row.get(0),
    )?;
    let recycle_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('recycle_entries') WHERE name IN ('created_by_lifecycle_action_id','terminal_lifecycle_action_id','revision')",
        [],
        |row| row.get(0),
    )?;
    let required_tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('operation_logs','recycle_entries','schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    Ok(action_table == 0 && operation_columns == 0 && recycle_columns == 0 && required_tables == 3)
}

pub(crate) fn legacy_v50_schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let table_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='review_lifecycle_actions'",
        [],
        |row| row.get(0),
    )?;
    let action_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('review_lifecycle_actions')",
        [],
        |row| row.get(0),
    )?;
    let operation_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('operation_logs') WHERE name IN ('lifecycle_action_id','effect_type')",
        [],
        |row| row.get(0),
    )?;
    let recycle_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('recycle_entries') WHERE name IN ('created_by_lifecycle_action_id','terminal_lifecycle_action_id','revision')",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
           'uq_review_lifecycle_actions_pending_review',
           'uq_operation_logs_review_lifecycle_effect',
           'uq_recycle_entries_created_by_review_lifecycle_action',
           'uq_recycle_entries_terminal_review_lifecycle_action'
         )",
        [],
        |row| row.get(0),
    )?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version=50 AND name='review_lifecycle_durable_action_authority'",
        [],
        |row| row.get(0),
    )?;
    let table_sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='review_lifecycle_actions'",
        [],
        |row| row.get(0),
    )?;

    Ok(table_count == 1
        && action_columns == 27
        && operation_columns == 2
        && recycle_columns == 3
        && indexes == 4
        && marker == 1
        && table_sql.contains("review_soft_delete")
        && table_sql.contains("review_restore")
        && table_sql.contains("planning_conflict")
        && table_sql.contains("recycle_entry_conflict"))
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let legacy_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('review_lifecycle_actions') WHERE name IN ('lifecycle_action_id','operation_type','planning_effect_id','operation_log_effect_id','recycle_effect_id','current_stage')",
        [], |row| row.get(0))?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('uq_review_lifecycle_actions_pending_review','uq_operation_logs_review_lifecycle_effect','uq_recycle_entries_created_by_review_lifecycle_action','uq_recycle_entries_terminal_review_lifecycle_action')",
        [], |row| row.get(0))?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version=50 AND name='review_lifecycle_durable_action_authority'",
        [], |row| row.get(0))?;
    Ok(legacy_columns == 6 && indexes == 4 && marker == 1)
}

const ACTION_COLUMNS: &str = "lifecycle_action_id,revision,operation_type,review_id,project_id,expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,target_review_updated_at,target_review_deleted_at,expected_planning_epoch,expected_planning_revision,planned_committed_planning_revision,committed_planning_epoch,committed_planning_revision,planning_effect_id,source_delete_action_id,exact_recycle_entry_id,operation_log_effect_id,recycle_effect_id,current_stage,terminal_result,last_error_code,last_error_retryable,created_at,updated_at,terminal_at";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewLifecycleActionRecord {
    pub(crate) lifecycle_action_id: String,
    pub(crate) revision: i64,
    pub(crate) operation_type: String,
    pub(crate) review_id: String,
    pub(crate) project_id: String,
    pub(crate) expected_review_source_state: String,
    pub(crate) expected_review_updated_at: String,
    pub(crate) expected_review_deleted_at: Option<String>,
    pub(crate) target_review_updated_at: String,
    pub(crate) target_review_deleted_at: Option<String>,
    pub(crate) expected_planning_epoch: String,
    pub(crate) expected_planning_revision: String,
    pub(crate) planned_committed_planning_revision: String,
    pub(crate) committed_planning_epoch: Option<String>,
    pub(crate) committed_planning_revision: Option<String>,
    pub(crate) planning_effect_id: String,
    pub(crate) source_delete_action_id: Option<String>,
    pub(crate) exact_recycle_entry_id: String,
    pub(crate) operation_log_effect_id: String,
    pub(crate) recycle_effect_id: String,
    pub(crate) current_stage: String,
    pub(crate) terminal_result: Option<String>,
    pub(crate) last_error_code: Option<String>,
    pub(crate) last_error_retryable: bool,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) terminal_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewLifecycleAuthorityError {
    pub(crate) code: String,
    pub(crate) retryable: bool,
    pub(crate) message: String,
}

fn authority_error(
    code: &str,
    retryable: bool,
    message: impl Into<String>,
) -> ReviewLifecycleAuthorityError {
    ReviewLifecycleAuthorityError {
        code: code.to_string(),
        retryable,
        message: message.into(),
    }
}

fn storage_error(message: impl Into<String>) -> ReviewLifecycleAuthorityError {
    authority_error("review_lifecycle_storage_failure", true, message)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrepareActionInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) operation_type: String,
    pub(crate) review_id: String,
    pub(crate) project_id: String,
    pub(crate) expected_review_source_state: String,
    pub(crate) expected_review_updated_at: String,
    pub(crate) expected_review_deleted_at: Option<String>,
    pub(crate) target_review_updated_at: String,
    pub(crate) target_review_deleted_at: Option<String>,
    pub(crate) expected_planning_epoch: String,
    pub(crate) expected_planning_revision: String,
    pub(crate) planned_committed_planning_revision: String,
    pub(crate) planning_effect_id: String,
    pub(crate) source_delete_action_id: Option<String>,
    pub(crate) exact_recycle_entry_id: String,
    pub(crate) operation_log_effect_id: String,
    pub(crate) recycle_effect_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordPlanningCommitInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_stage: String,
    pub(crate) committed_planning_epoch: String,
    pub(crate) committed_planning_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationLogEffectInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_stage: String,
    pub(crate) target_title: String,
    pub(crate) summary: String,
    pub(crate) impact_summary_json: Option<String>,
    pub(crate) confirmation_json: Option<String>,
    pub(crate) feedback_json: Option<String>,
    pub(crate) created_at: String,
}

#[cfg(test)]
impl OperationLogEffectInput {
    pub(crate) fn for_test(action: &ReviewLifecycleActionRecord, summary: &str) -> Self {
        Self {
            lifecycle_action_id: action.lifecycle_action_id.clone(),
            expected_revision: action.revision,
            expected_stage: action.current_stage.clone(),
            target_title: "Review title".to_string(),
            summary: summary.to_string(),
            impact_summary_json: None,
            confirmation_json: None,
            feedback_json: None,
            created_at: "2026-08-07T00:02:00.000Z".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecycleCreateEffectInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_stage: String,
    pub(crate) title: String,
    pub(crate) summary: Option<String>,
    pub(crate) known_impact_summary_json: Option<String>,
    pub(crate) deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecycleRestoreEffectInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) expected_action_revision: i64,
    pub(crate) expected_action_stage: String,
    pub(crate) exact_recycle_entry_id: String,
    pub(crate) expected_entry_revision: i64,
    pub(crate) source_delete_action_id: String,
    pub(crate) restored_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteActionInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordActionFailureInput {
    pub(crate) lifecycle_action_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_stage: String,
    pub(crate) error_code: String,
    pub(crate) retryable: bool,
    pub(crate) terminal_result: Option<String>,
}

impl CompleteActionInput {
    #[cfg(test)]
    pub(crate) fn from_record(record: &ReviewLifecycleActionRecord) -> Self {
        Self {
            lifecycle_action_id: record.lifecycle_action_id.clone(),
            expected_revision: record.revision,
            expected_stage: record.current_stage.clone(),
        }
    }
}

#[cfg(test)]
impl RecycleCreateEffectInput {
    pub(crate) fn for_test(action: &ReviewLifecycleActionRecord, title: &str) -> Self {
        Self {
            lifecycle_action_id: action.lifecycle_action_id.clone(),
            expected_revision: action.revision,
            expected_stage: action.current_stage.clone(),
            title: title.to_string(),
            summary: Some("Review moved to recycle bin".to_string()),
            known_impact_summary_json: None,
            deleted_at: "2026-08-07T00:01:00.000Z".to_string(),
        }
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

fn validate_prepare(input: &PrepareActionInput) -> Result<(), ReviewLifecycleAuthorityError> {
    if !valid_identity(&input.lifecycle_action_id)
        || input.review_id.is_empty()
        || input.project_id.is_empty()
    {
        return Err(authority_error(
            "review_lifecycle_input_invalid",
            false,
            "action, Review, and Project identities are required",
        ));
    }
    let prefix = format!("review-lifecycle:{}", input.lifecycle_action_id);
    let effects_valid = input.planning_effect_id == format!("{prefix}:planning")
        && input.operation_log_effect_id == format!("{prefix}:operation-log")
        && match input.operation_type.as_str() {
            "review_soft_delete" => {
                input.expected_review_source_state == "active"
                    && input.expected_review_deleted_at.is_none()
                    && input.target_review_deleted_at.is_some()
                    && input.source_delete_action_id.is_none()
                    && input.exact_recycle_entry_id == format!("{prefix}:recycle-entry")
                    && input.recycle_effect_id == format!("{prefix}:recycle-create")
            }
            "review_restore" => {
                input.expected_review_source_state == "deleted"
                    && input.expected_review_deleted_at.is_some()
                    && input.target_review_deleted_at.is_none()
                    && input
                        .source_delete_action_id
                        .as_ref()
                        .is_some_and(|value| !value.is_empty())
                    && input.recycle_effect_id
                        == format!("{prefix}:recycle-terminal:{}", input.exact_recycle_entry_id)
            }
            _ => false,
        };
    let expected_revision = input.expected_planning_revision.parse::<u128>().ok();
    let planned_revision = input
        .planned_committed_planning_revision
        .parse::<u128>()
        .ok();
    if !effects_valid
        || expected_revision
            .zip(planned_revision)
            .is_none_or(|(expected, planned)| expected.checked_add(1) != Some(planned))
    {
        return Err(authority_error(
            "review_lifecycle_input_invalid",
            false,
            "lifecycle operation invariants or deterministic effect identities are invalid",
        ));
    }
    Ok(())
}

fn row_action(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewLifecycleActionRecord> {
    Ok(ReviewLifecycleActionRecord {
        lifecycle_action_id: row.get(0)?,
        revision: row.get(1)?,
        operation_type: row.get(2)?,
        review_id: row.get(3)?,
        project_id: row.get(4)?,
        expected_review_source_state: row.get(5)?,
        expected_review_updated_at: row.get(6)?,
        expected_review_deleted_at: row.get(7)?,
        target_review_updated_at: row.get(8)?,
        target_review_deleted_at: row.get(9)?,
        expected_planning_epoch: row.get(10)?,
        expected_planning_revision: row.get(11)?,
        planned_committed_planning_revision: row.get(12)?,
        committed_planning_epoch: row.get(13)?,
        committed_planning_revision: row.get(14)?,
        planning_effect_id: row.get(15)?,
        source_delete_action_id: row.get(16)?,
        exact_recycle_entry_id: row.get(17)?,
        operation_log_effect_id: row.get(18)?,
        recycle_effect_id: row.get(19)?,
        current_stage: row.get(20)?,
        terminal_result: row.get(21)?,
        last_error_code: row.get(22)?,
        last_error_retryable: row.get::<_, i64>(23)? == 1,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
        terminal_at: row.get(26)?,
    })
}

pub(crate) fn readback_in_connection(
    connection: &Connection,
    action_id: &str,
) -> Result<Option<ReviewLifecycleActionRecord>, ReviewLifecycleAuthorityError> {
    connection
        .query_row(
            &format!("SELECT {ACTION_COLUMNS} FROM review_lifecycle_actions WHERE lifecycle_action_id=?1"),
            [action_id],
            row_action,
        )
        .optional()
        .map_err(|error| storage_error(format!("action readback failed: {error}")))
}

fn identity_matches(record: &ReviewLifecycleActionRecord, input: &PrepareActionInput) -> bool {
    record.lifecycle_action_id == input.lifecycle_action_id
        && record.operation_type == input.operation_type
        && record.review_id == input.review_id
        && record.project_id == input.project_id
        && record.expected_review_source_state == input.expected_review_source_state
        && record.expected_review_updated_at == input.expected_review_updated_at
        && record.expected_review_deleted_at == input.expected_review_deleted_at
        && record.target_review_updated_at == input.target_review_updated_at
        && record.target_review_deleted_at == input.target_review_deleted_at
        && record.expected_planning_epoch == input.expected_planning_epoch
        && record.expected_planning_revision == input.expected_planning_revision
        && record.planned_committed_planning_revision == input.planned_committed_planning_revision
        && record.planning_effect_id == input.planning_effect_id
        && record.source_delete_action_id == input.source_delete_action_id
        && record.exact_recycle_entry_id == input.exact_recycle_entry_id
        && record.operation_log_effect_id == input.operation_log_effect_id
        && record.recycle_effect_id == input.recycle_effect_id
}

pub(crate) fn prepare_in_connection(
    connection: &mut Connection,
    input: &PrepareActionInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    validate_prepare(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("action prepare begin failed: {error}")))?;
    if input.operation_type == "review_restore" {
        let entry: Option<(String, String, Option<String>, i64, String, Option<String>, Option<String>)> =
            transaction
                .query_row(
                    "SELECT entity_type,entity_id,created_by_lifecycle_action_id,can_restore,restore_status,terminal_lifecycle_action_id,deleted_at FROM recycle_entries WHERE id=?1",
                    [&input.exact_recycle_entry_id],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
                )
                .optional()
                .map_err(|error| storage_error(format!("restore entry readback failed: {error}")))?;
        let Some(entry) = entry else {
            return Err(authority_error(
                "recycle_entry_conflict",
                false,
                "exact recycle entry does not exist",
            ));
        };
        if entry.2.is_none() {
            return Err(authority_error(
                "recycle_entry_legacy_unbound",
                false,
                "legacy Review recycle entry is not bound to a lifecycle action",
            ));
        }
        if entry.0 != "review"
            || entry.1 != input.review_id
            || entry.2 != input.source_delete_action_id
            || entry.3 != 1
            || entry.4 != "not_started"
            || entry.5.is_some()
            || entry.6.is_some()
        {
            return Err(authority_error(
                "recycle_entry_conflict",
                false,
                "exact recycle entry does not match source delete action",
            ));
        }
    }
    if let Some(existing) = readback_in_connection(&transaction, &input.lifecycle_action_id)? {
        if identity_matches(&existing, input) {
            transaction.commit().map_err(|error| {
                storage_error(format!("action readback commit failed: {error}"))
            })?;
            return Ok(existing);
        }
        return Err(authority_error(
            "review_lifecycle_identity_conflict",
            false,
            "lifecycleActionId is already bound to different identity",
        ));
    }
    let pending: Option<String> = transaction
        .query_row(
            "SELECT lifecycle_action_id FROM review_lifecycle_actions WHERE review_id=?1 AND terminal_result IS NULL",
            [&input.review_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage_error(format!("pending action lookup failed: {error}")))?;
    if let Some(pending_id) = pending {
        return Err(authority_error(
            "review_lifecycle_pending_conflict",
            false,
            format!("Review already has pending action {pending_id}"),
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT INTO review_lifecycle_actions (
               lifecycle_action_id,revision,operation_type,review_id,project_id,
               expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,
               target_review_updated_at,target_review_deleted_at,expected_planning_epoch,
               expected_planning_revision,planned_committed_planning_revision,planning_effect_id,
               source_delete_action_id,exact_recycle_entry_id,operation_log_effect_id,recycle_effect_id,
               current_stage,last_error_retryable,created_at,updated_at
             ) VALUES (?1,0,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'prepared',0,?18,?18)",
            params![
                input.lifecycle_action_id,
                input.operation_type,
                input.review_id,
                input.project_id,
                input.expected_review_source_state,
                input.expected_review_updated_at,
                input.expected_review_deleted_at,
                input.target_review_updated_at,
                input.target_review_deleted_at,
                input.expected_planning_epoch,
                input.expected_planning_revision,
                input.planned_committed_planning_revision,
                input.planning_effect_id,
                input.source_delete_action_id,
                input.exact_recycle_entry_id,
                input.operation_log_effect_id,
                input.recycle_effect_id,
                timestamp,
            ],
        )
        .map_err(|error| storage_error(format!("action insert failed: {error}")))?;
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("action insert readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(format!("action prepare commit failed: {error}")))?;
    Ok(record)
}

fn stage_rank(stage: &str) -> Option<u8> {
    match stage {
        "prepared" => Some(0),
        "planning_committed" => Some(1),
        "operation_log_recorded" => Some(2),
        "recycle_effect_recorded" => Some(3),
        "completed" => Some(4),
        _ => None,
    }
}

pub(crate) fn record_planning_commit_in_connection(
    connection: &mut Connection,
    input: &RecordPlanningCommitInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("Planning stage begin failed: {error}")))?;
    let current =
        readback_in_connection(&transaction, &input.lifecycle_action_id)?.ok_or_else(|| {
            authority_error(
                "review_lifecycle_action_not_found",
                false,
                "action not found",
            )
        })?;
    if current.operation_type == "review_permanent_delete" {
        return Err(authority_error(
            "review_lifecycle_operation_requires_dedicated_authority",
            false,
            "permanent delete Planning CAS uses the dedicated v51 foundation",
        ));
    }
    if stage_rank(&current.current_stage).unwrap_or(255) >= 1 {
        if current.committed_planning_epoch.as_deref() == Some(&input.committed_planning_epoch)
            && current.committed_planning_revision.as_deref()
                == Some(&input.committed_planning_revision)
        {
            transaction
                .commit()
                .map_err(|error| storage_error(error.to_string()))?;
            return Ok(current);
        }
        return Err(authority_error(
            "review_lifecycle_identity_conflict",
            false,
            "Planning correlation readback does not match action",
        ));
    }
    if current.revision != input.expected_revision
        || current.current_stage != input.expected_stage
        || current.terminal_result.is_some()
        || input.expected_stage != "prepared"
        || current.expected_planning_epoch != input.committed_planning_epoch
        || current.planned_committed_planning_revision != input.committed_planning_revision
    {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "Planning stage CAS expectation failed",
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    let changed = transaction.execute(
        "UPDATE review_lifecycle_actions
         SET revision=revision+1,current_stage='planning_committed',
             committed_planning_epoch=?1,committed_planning_revision=?2,
             last_error_code=NULL,last_error_retryable=0,updated_at=?3
         WHERE lifecycle_action_id=?4 AND revision=?5 AND current_stage=?6 AND terminal_result IS NULL",
        params![
            input.committed_planning_epoch,
            input.committed_planning_revision,
            timestamp,
            input.lifecycle_action_id,
            input.expected_revision,
            input.expected_stage,
        ],
    ).map_err(|error| storage_error(format!("Planning stage update failed: {error}")))?;
    if changed != 1 {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "Planning stage CAS lost",
        ));
    }
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("Planning stage readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(error.to_string()))?;
    Ok(record)
}

fn exact_action_for_effect(
    connection: &Connection,
    action_id: &str,
    expected_revision: i64,
    expected_stage: &str,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let action = readback_in_connection(connection, action_id)?.ok_or_else(|| {
        authority_error(
            "review_lifecycle_action_not_found",
            false,
            "action not found",
        )
    })?;
    if action.terminal_result.is_some()
        || action.revision != expected_revision
        || action.current_stage != expected_stage
    {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "effect stage CAS expectation failed",
        ));
    }
    Ok(action)
}

pub(crate) fn record_operation_log_effect_in_connection(
    connection: &mut Connection,
    input: &OperationLogEffectInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("operation log begin failed: {error}")))?;
    let current =
        readback_in_connection(&transaction, &input.lifecycle_action_id)?.ok_or_else(|| {
            authority_error(
                "review_lifecycle_action_not_found",
                false,
                "action not found",
            )
        })?;
    if current.operation_type == "review_permanent_delete" {
        return Err(authority_error(
            "review_lifecycle_operation_requires_dedicated_authority",
            false,
            "permanent delete effects require the future atomic finalizer",
        ));
    }
    let target = serde_json::json!({
        "entityType": "review",
        "entityId": current.review_id,
        "title": input.target_title,
    })
    .to_string();
    let operation_type = if current.operation_type == "review_soft_delete" {
        "delete"
    } else {
        "restore"
    };
    let existing: Option<(String, String, String, String, String, String)> = transaction.query_row(
        "SELECT id,operation_type,module,target,summary,effect_type FROM operation_logs WHERE lifecycle_action_id=?1 AND effect_type='review_lifecycle_operation_log'",
        [&input.lifecycle_action_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).optional().map_err(|error| storage_error(format!("operation log readback failed: {error}")))?;
    if let Some(existing) = existing {
        let exact = existing.0 == current.operation_log_effect_id
            && existing.1 == operation_type
            && existing.2 == "review"
            && existing.3 == target
            && existing.4 == input.summary
            && existing.5 == "review_lifecycle_operation_log";
        if !exact {
            return Err(authority_error(
                "review_lifecycle_identity_conflict",
                false,
                "operation log effect mismatch",
            ));
        }
        if stage_rank(&current.current_stage).unwrap_or(0) >= 2 {
            transaction
                .commit()
                .map_err(|error| storage_error(error.to_string()))?;
            return Ok(current);
        }
    } else {
        if current.current_stage != "planning_committed" {
            return Err(authority_error(
                "review_lifecycle_stage_conflict",
                false,
                "log requires Planning stage",
            ));
        }
        transaction.execute(
            "INSERT INTO operation_logs (
               id,operation_type,source,module,status,risk_level,target,summary,
               related_entities,impact_summary,confirmation,feedback,warnings,errors,skipped,
               is_recoverable,recycle_entry_id,actor_id,actor_label,refresh_keys,schema_version,
               created_at,updated_at,deleted_at,lifecycle_action_id,effect_type
             ) VALUES (?1,?2,'user','review','success','high',?3,?4,'[]',?5,?6,?7,'[]','[]','[]',?8,?9,'user','LabPod user',?10,1,?11,?11,NULL,?12,'review_lifecycle_operation_log')",
            params![
                current.operation_log_effect_id,
                operation_type,
                target,
                input.summary,
                input.impact_summary_json,
                input.confirmation_json,
                input.feedback_json,
                if current.operation_type == "review_soft_delete" { 1 } else { 0 },
                current.exact_recycle_entry_id,
                serde_json::json!(["review.changed","reviewContext.changed","operationLog.changed","recycleBin.changed"]).to_string(),
                input.created_at,
                input.lifecycle_action_id,
            ],
        ).map_err(|error| storage_error(format!("operation log insert failed: {error}")))?;
    }
    let action = exact_action_for_effect(
        &transaction,
        &input.lifecycle_action_id,
        input.expected_revision,
        &input.expected_stage,
    )?;
    if action.current_stage != "planning_committed" {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "invalid log source stage",
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    let changed = transaction.execute(
        "UPDATE review_lifecycle_actions SET revision=revision+1,current_stage='operation_log_recorded',last_error_code=NULL,last_error_retryable=0,updated_at=?1 WHERE lifecycle_action_id=?2 AND revision=?3 AND current_stage=?4 AND terminal_result IS NULL",
        params![timestamp,input.lifecycle_action_id,input.expected_revision,input.expected_stage],
    ).map_err(|error| storage_error(format!("operation log stage update failed: {error}")))?;
    if changed != 1 {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "operation log stage CAS lost",
        ));
    }
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("operation log stage readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(error.to_string()))?;
    Ok(record)
}

pub(crate) fn record_recycle_create_effect_in_connection(
    connection: &mut Connection,
    input: &RecycleCreateEffectInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("recycle create begin failed: {error}")))?;
    let current =
        readback_in_connection(&transaction, &input.lifecycle_action_id)?.ok_or_else(|| {
            authority_error(
                "review_lifecycle_action_not_found",
                false,
                "action not found",
            )
        })?;
    if current.operation_type != "review_soft_delete" {
        return Err(authority_error(
            "review_lifecycle_identity_conflict",
            false,
            "recycle create requires delete action",
        ));
    }
    let existing: Option<(String,String,String,String,i64,String,String)> = transaction.query_row(
        "SELECT id,entity_type,entity_id,entity_deleted_at,can_restore,restore_status,created_by_lifecycle_action_id FROM recycle_entries WHERE created_by_lifecycle_action_id=?1",
        [&input.lifecycle_action_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
    ).optional().map_err(|error| storage_error(format!("recycle create readback failed: {error}")))?;
    if let Some(existing) = existing {
        let exact = existing.0 == current.exact_recycle_entry_id
            && existing.1 == "review"
            && existing.2 == current.review_id
            && existing.3 == input.deleted_at
            && existing.4 == 1
            && existing.5 == "not_started"
            && existing.6 == input.lifecycle_action_id;
        if !exact {
            return Err(authority_error(
                "review_lifecycle_identity_conflict",
                false,
                "recycle create effect mismatch",
            ));
        }
        if stage_rank(&current.current_stage).unwrap_or(0) >= 3 {
            transaction
                .commit()
                .map_err(|error| storage_error(error.to_string()))?;
            return Ok(current);
        }
    } else {
        if current.current_stage != "operation_log_recorded" {
            return Err(authority_error(
                "review_lifecycle_stage_conflict",
                false,
                "recycle create requires log stage",
            ));
        }
        transaction.execute(
            "INSERT INTO recycle_entries (
               id,entity_type,entity_id,title,summary,module,entity_deleted_at,deleted_by,
               operation_log_id,can_restore,cannot_restore_reason,known_impact_summary,restore_status,
               refresh_keys,schema_version,created_at,updated_at,deleted_at,
               created_by_lifecycle_action_id,terminal_lifecycle_action_id,revision
             ) VALUES (?1,'review',?2,?3,?4,'review',?5,'user',?6,1,NULL,?7,'not_started',?8,1,?5,?5,NULL,?9,NULL,0)",
            params![
                current.exact_recycle_entry_id,
                current.review_id,
                input.title,
                input.summary,
                input.deleted_at,
                current.operation_log_effect_id,
                input.known_impact_summary_json,
                serde_json::json!(["review.changed","reviewContext.changed","operationLog.changed","recycleBin.changed"]).to_string(),
                input.lifecycle_action_id,
            ],
        ).map_err(|error| storage_error(format!("recycle create insert failed: {error}")))?;
    }
    let action = exact_action_for_effect(
        &transaction,
        &input.lifecycle_action_id,
        input.expected_revision,
        &input.expected_stage,
    )?;
    if action.current_stage != "operation_log_recorded" {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "invalid recycle source stage",
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    let changed = transaction.execute(
        "UPDATE review_lifecycle_actions SET revision=revision+1,current_stage='recycle_effect_recorded',last_error_code=NULL,last_error_retryable=0,updated_at=?1 WHERE lifecycle_action_id=?2 AND revision=?3 AND current_stage=?4 AND terminal_result IS NULL",
        params![timestamp,input.lifecycle_action_id,input.expected_revision,input.expected_stage],
    ).map_err(|error| storage_error(format!("recycle stage update failed: {error}")))?;
    if changed != 1 {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "recycle stage CAS lost",
        ));
    }
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("recycle stage readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(error.to_string()))?;
    Ok(record)
}

pub(crate) fn record_recycle_restore_effect_in_connection(
    connection: &mut Connection,
    input: &RecycleRestoreEffectInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("recycle restore begin failed: {error}")))?;
    let current =
        readback_in_connection(&transaction, &input.lifecycle_action_id)?.ok_or_else(|| {
            authority_error(
                "review_lifecycle_action_not_found",
                false,
                "action not found",
            )
        })?;
    if current.operation_type != "review_restore"
        || current.exact_recycle_entry_id != input.exact_recycle_entry_id
        || current.source_delete_action_id.as_deref() != Some(&input.source_delete_action_id)
    {
        return Err(authority_error(
            "recycle_entry_conflict",
            false,
            "restore action entry identity mismatch",
        ));
    }
    let entry: Option<(String,String,Option<String>,i64,String,Option<String>,i64,Option<String>)> = transaction.query_row(
        "SELECT entity_type,entity_id,created_by_lifecycle_action_id,can_restore,restore_status,terminal_lifecycle_action_id,revision,deleted_at FROM recycle_entries WHERE id=?1",
        [&input.exact_recycle_entry_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
    ).optional().map_err(|error| storage_error(format!("restore entry readback failed: {error}")))?;
    let Some(entry) = entry else {
        return Err(authority_error(
            "recycle_entry_conflict",
            false,
            "exact restore entry missing",
        ));
    };
    if stage_rank(&current.current_stage).unwrap_or(0) >= 3 {
        if entry.0 == "review"
            && entry.1 == current.review_id
            && entry.2.as_deref() == Some(&input.source_delete_action_id)
            && entry.3 == 0
            && entry.4 == "restored"
            && entry.5.as_deref() == Some(&input.lifecycle_action_id)
            && entry.6 == input.expected_entry_revision + 1
            && entry.7.is_none()
        {
            transaction
                .commit()
                .map_err(|error| storage_error(error.to_string()))?;
            return Ok(current);
        }
        return Err(authority_error(
            "already_terminal_by_other_action",
            false,
            "entry is terminalized by another action",
        ));
    }
    if entry.2.is_none() {
        return Err(authority_error(
            "recycle_entry_legacy_unbound",
            false,
            "legacy entry is unbound",
        ));
    }
    if current.revision != input.expected_action_revision
        || current.current_stage != input.expected_action_stage
        || current.current_stage != "operation_log_recorded"
        || current.terminal_result.is_some()
        || entry.0 != "review"
        || entry.1 != current.review_id
        || entry.2.as_deref() != Some(&input.source_delete_action_id)
        || entry.3 != 1
        || entry.4 != "not_started"
        || entry.5.is_some()
        || entry.6 != input.expected_entry_revision
        || entry.7.is_some()
    {
        return Err(authority_error(
            "recycle_entry_conflict",
            false,
            "restore entry expected-revision contract failed",
        ));
    }
    let entry_changed = transaction.execute(
        "UPDATE recycle_entries SET can_restore=0,cannot_restore_reason='Review has already been restored.',restore_status='restored',summary='Review metadata restored from recycle bin.',terminal_lifecycle_action_id=?1,revision=revision+1,updated_at=?2 WHERE id=?3 AND revision=?4 AND created_by_lifecycle_action_id=?5 AND terminal_lifecycle_action_id IS NULL AND can_restore=1 AND restore_status='not_started' AND deleted_at IS NULL",
        params![input.lifecycle_action_id,input.restored_at,input.exact_recycle_entry_id,input.expected_entry_revision,input.source_delete_action_id],
    ).map_err(|error| storage_error(format!("restore entry terminal CAS failed: {error}")))?;
    if entry_changed != 1 {
        return Err(authority_error(
            "recycle_entry_conflict",
            false,
            "restore entry terminal CAS lost",
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    let action_changed = transaction.execute(
        "UPDATE review_lifecycle_actions SET revision=revision+1,current_stage='recycle_effect_recorded',last_error_code=NULL,last_error_retryable=0,updated_at=?1 WHERE lifecycle_action_id=?2 AND revision=?3 AND current_stage=?4 AND terminal_result IS NULL",
        params![timestamp,input.lifecycle_action_id,input.expected_action_revision,input.expected_action_stage],
    ).map_err(|error| storage_error(format!("restore action stage CAS failed: {error}")))?;
    if action_changed != 1 {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "restore action stage CAS lost",
        ));
    }
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("restore action readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(error.to_string()))?;
    Ok(record)
}

pub(crate) fn complete_in_connection(
    connection: &mut Connection,
    input: &CompleteActionInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("complete begin failed: {error}")))?;
    let current =
        readback_in_connection(&transaction, &input.lifecycle_action_id)?.ok_or_else(|| {
            authority_error(
                "review_lifecycle_action_not_found",
                false,
                "action not found",
            )
        })?;
    if current.current_stage == "completed"
        && current.terminal_result.as_deref() == Some("completed")
    {
        transaction
            .commit()
            .map_err(|error| storage_error(error.to_string()))?;
        return Ok(current);
    }
    if current.revision != input.expected_revision
        || current.current_stage != input.expected_stage
        || current.current_stage != "recycle_effect_recorded"
        || current.terminal_result.is_some()
    {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "complete stage CAS expectation failed",
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    let changed = transaction.execute(
        "UPDATE review_lifecycle_actions SET revision=revision+1,current_stage='completed',terminal_result='completed',last_error_code=NULL,last_error_retryable=0,updated_at=?1,terminal_at=?1 WHERE lifecycle_action_id=?2 AND revision=?3 AND current_stage=?4 AND terminal_result IS NULL",
        params![timestamp,input.lifecycle_action_id,input.expected_revision,input.expected_stage],
    ).map_err(|error| storage_error(format!("complete stage update failed: {error}")))?;
    if changed != 1 {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "complete stage CAS lost",
        ));
    }
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("complete readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(error.to_string()))?;
    Ok(record)
}

pub(crate) fn pending_for_review_in_connection(
    connection: &Connection,
    review_id: &str,
) -> Result<Option<ReviewLifecycleActionRecord>, ReviewLifecycleAuthorityError> {
    connection
        .query_row(
            &format!("SELECT {ACTION_COLUMNS} FROM review_lifecycle_actions WHERE review_id=?1 AND terminal_result IS NULL AND operation_type<>'review_permanent_delete'"),
            [review_id],
            row_action,
        )
        .optional()
        .map_err(|error| storage_error(format!("pending action readback failed: {error}")))
}

pub(crate) fn list_pending_in_connection(
    connection: &Connection,
) -> Result<Vec<ReviewLifecycleActionRecord>, ReviewLifecycleAuthorityError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {ACTION_COLUMNS} FROM review_lifecycle_actions \
             WHERE terminal_result IS NULL \
             ORDER BY updated_at DESC, created_at DESC, lifecycle_action_id ASC"
        ))
        .map_err(|error| storage_error(format!("pending action list prepare failed: {error}")))?;
    let rows = statement
        .query_map([], row_action)
        .map_err(|error| storage_error(format!("pending action list failed: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| storage_error(format!("pending action list readback failed: {error}")))
}

pub(crate) fn record_failure_in_connection(
    connection: &mut Connection,
    input: &RecordActionFailureInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    const TERMINALS: &[&str] = &[
        "cancelled_before_mutation",
        "planning_conflict",
        "identity_conflict",
        "source_state_conflict",
        "recycle_entry_conflict",
        "already_terminal_by_other_action",
        "non_retryable_failure",
    ];
    if input.error_code.is_empty()
        || (input.retryable && input.terminal_result.is_some())
        || (!input.retryable
            && input
                .terminal_result
                .as_deref()
                .is_none_or(|value| !TERMINALS.contains(&value)))
    {
        return Err(authority_error(
            "review_lifecycle_input_invalid",
            false,
            "failure outcome is invalid",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage_error(format!("failure begin failed: {error}")))?;
    let current =
        readback_in_connection(&transaction, &input.lifecycle_action_id)?.ok_or_else(|| {
            authority_error(
                "review_lifecycle_action_not_found",
                false,
                "action not found",
            )
        })?;
    if current.terminal_result.is_some() {
        if current.terminal_result == input.terminal_result
            && current.last_error_code.as_deref() == Some(&input.error_code)
        {
            transaction
                .commit()
                .map_err(|error| storage_error(error.to_string()))?;
            return Ok(current);
        }
        return Err(authority_error(
            "review_lifecycle_terminal_conflict",
            false,
            "action is already terminal",
        ));
    }
    if current.revision != input.expected_revision || current.current_stage != input.expected_stage
    {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "failure stage CAS expectation failed",
        ));
    }
    let timestamp = Utc::now().to_rfc3339();
    let changed = transaction.execute(
        "UPDATE review_lifecycle_actions SET revision=revision+1,last_error_code=?1,last_error_retryable=?2,terminal_result=?3,updated_at=?4,terminal_at=CASE WHEN ?3 IS NULL THEN NULL ELSE ?4 END WHERE lifecycle_action_id=?5 AND revision=?6 AND current_stage=?7 AND terminal_result IS NULL",
        params![input.error_code,if input.retryable {1} else {0},input.terminal_result,timestamp,input.lifecycle_action_id,input.expected_revision,input.expected_stage],
    ).map_err(|error| storage_error(format!("failure stage update failed: {error}")))?;
    if changed != 1 {
        return Err(authority_error(
            "review_lifecycle_stage_conflict",
            false,
            "failure stage CAS lost",
        ));
    }
    let record = readback_in_connection(&transaction, &input.lifecycle_action_id)?
        .ok_or_else(|| storage_error("failure readback missing"))?;
    transaction
        .commit()
        .map_err(|error| storage_error(error.to_string()))?;
    Ok(record)
}

fn open(app_handle: &AppHandle) -> Result<Connection, ReviewLifecycleAuthorityError> {
    super::open_connection(app_handle).map_err(storage_error)
}

#[tauri::command]
pub(crate) fn prepare_review_lifecycle_action(
    app_handle: AppHandle,
    input: PrepareActionInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    prepare_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn readback_review_lifecycle_action(
    app_handle: AppHandle,
    lifecycle_action_id: String,
) -> Result<Option<ReviewLifecycleActionRecord>, ReviewLifecycleAuthorityError> {
    let connection = open(&app_handle)?;
    readback_in_connection(&connection, &lifecycle_action_id)
}

#[tauri::command]
pub(crate) fn read_pending_review_lifecycle_action(
    app_handle: AppHandle,
    review_id: String,
) -> Result<Option<ReviewLifecycleActionRecord>, ReviewLifecycleAuthorityError> {
    let connection = open(&app_handle)?;
    pending_for_review_in_connection(&connection, &review_id)
}

#[tauri::command]
pub(crate) fn list_pending_review_lifecycle_actions(
    app_handle: AppHandle,
) -> Result<Vec<ReviewLifecycleActionRecord>, ReviewLifecycleAuthorityError> {
    let connection = open(&app_handle)?;
    list_pending_in_connection(&connection)
}

#[tauri::command]
pub(crate) fn record_review_lifecycle_planning_commit(
    app_handle: AppHandle,
    input: RecordPlanningCommitInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    record_planning_commit_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn record_review_lifecycle_operation_log(
    app_handle: AppHandle,
    input: OperationLogEffectInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    record_operation_log_effect_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn record_review_lifecycle_recycle_create(
    app_handle: AppHandle,
    input: RecycleCreateEffectInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    record_recycle_create_effect_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn record_review_lifecycle_recycle_restore(
    app_handle: AppHandle,
    input: RecycleRestoreEffectInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    record_recycle_restore_effect_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn complete_review_lifecycle_action(
    app_handle: AppHandle,
    input: CompleteActionInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    complete_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn record_review_lifecycle_action_failure(
    app_handle: AppHandle,
    input: RecordActionFailureInput,
) -> Result<ReviewLifecycleActionRecord, ReviewLifecycleAuthorityError> {
    let mut connection = open(&app_handle)?;
    record_failure_in_connection(&mut connection, &input)
}
