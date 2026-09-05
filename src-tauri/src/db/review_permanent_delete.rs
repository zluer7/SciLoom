use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

pub(crate) const SCHEMA_VERSION: i64 = 51;
const MIGRATION_NAME: &str = "review_permanent_delete_durable_authority_foundation";

const ACTION_TABLE_V51_SQL: &str = r#"
CREATE TABLE review_lifecycle_actions_v51 (
  lifecycle_action_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('review_soft_delete','review_restore','review_permanent_delete')),
  review_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  expected_review_source_state TEXT NOT NULL CHECK (expected_review_source_state IN ('active','deleted')),
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
  expected_recycle_entry_revision INTEGER,
  impact_plan_version INTEGER,
  impact_digest TEXT,
  impact_plan_json TEXT,
  confirmed_at TEXT,
  operation_log_effect_id TEXT NOT NULL UNIQUE,
  recycle_effect_id TEXT NOT NULL UNIQUE,
  binding_cleanup_effect_id TEXT UNIQUE,
  file_ref_cleanup_effect_id TEXT UNIQUE,
  recycle_terminal_effect_id TEXT UNIQUE,
  current_stage TEXT NOT NULL CHECK (current_stage IN ('prepared','planning_committed','operation_log_recorded','recycle_effect_recorded','completed')),
  terminal_result TEXT CHECK (terminal_result IN ('completed','cancelled_before_mutation','planning_conflict','identity_conflict','source_state_conflict','recycle_entry_conflict','impact_plan_conflict','already_terminal_by_other_action','non_retryable_failure')),
  last_error_code TEXT,
  last_error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (last_error_retryable IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (operation_type='review_soft_delete' AND expected_review_source_state='active' AND expected_review_deleted_at IS NULL AND target_review_deleted_at IS NOT NULL AND source_delete_action_id IS NULL)
    OR (operation_type='review_restore' AND expected_review_source_state='deleted' AND expected_review_deleted_at IS NOT NULL AND target_review_deleted_at IS NULL AND source_delete_action_id IS NOT NULL)
    OR (operation_type='review_permanent_delete' AND expected_review_source_state='deleted' AND expected_review_deleted_at IS NOT NULL AND target_review_deleted_at=expected_review_deleted_at AND source_delete_action_id IS NOT NULL)
  ),
  CHECK (operation_type<>'review_permanent_delete' OR (
    expected_recycle_entry_revision IS NOT NULL AND expected_recycle_entry_revision>=0
    AND impact_plan_version=1
    AND length(impact_digest)=64 AND impact_digest NOT GLOB '*[^0-9a-f]*'
    AND impact_plan_json IS NOT NULL AND confirmed_at IS NOT NULL
    AND binding_cleanup_effect_id IS NOT NULL AND file_ref_cleanup_effect_id IS NOT NULL
    AND recycle_terminal_effect_id IS NOT NULL
    AND current_stage IN ('prepared','planning_committed','completed')
  )),
  CHECK (operation_type='review_permanent_delete' OR (
    expected_recycle_entry_revision IS NULL AND impact_plan_version IS NULL
    AND impact_digest IS NULL AND impact_plan_json IS NULL AND confirmed_at IS NULL
    AND binding_cleanup_effect_id IS NULL AND file_ref_cleanup_effect_id IS NULL
    AND recycle_terminal_effect_id IS NULL
  )),
  CHECK (terminal_result<>'completed' OR current_stage='completed'),
  CHECK ((committed_planning_epoch IS NULL)=(committed_planning_revision IS NULL))
);

INSERT INTO review_lifecycle_actions_v51 (
  lifecycle_action_id,revision,operation_type,review_id,project_id,
  expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,
  target_review_updated_at,target_review_deleted_at,expected_planning_epoch,
  expected_planning_revision,planned_committed_planning_revision,
  committed_planning_epoch,committed_planning_revision,planning_effect_id,
  source_delete_action_id,exact_recycle_entry_id,operation_log_effect_id,recycle_effect_id,
  current_stage,terminal_result,last_error_code,last_error_retryable,created_at,updated_at,terminal_at
)
SELECT lifecycle_action_id,revision,operation_type,review_id,project_id,
  expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,
  target_review_updated_at,target_review_deleted_at,expected_planning_epoch,
  expected_planning_revision,planned_committed_planning_revision,
  committed_planning_epoch,committed_planning_revision,planning_effect_id,
  source_delete_action_id,exact_recycle_entry_id,operation_log_effect_id,recycle_effect_id,
  current_stage,terminal_result,last_error_code,last_error_retryable,created_at,updated_at,terminal_at
FROM review_lifecycle_actions;

DROP TABLE review_lifecycle_actions;
ALTER TABLE review_lifecycle_actions_v51 RENAME TO review_lifecycle_actions;

CREATE UNIQUE INDEX uq_review_lifecycle_actions_pending_review
  ON review_lifecycle_actions(review_id) WHERE terminal_result IS NULL;
CREATE INDEX idx_review_lifecycle_actions_review_created
  ON review_lifecycle_actions(review_id,created_at DESC);

CREATE TABLE review_lifecycle_action_targets (
  lifecycle_action_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('binding','file_ref','entity_link','change_log')),
  target_id TEXT NOT NULL,
  expected_revision TEXT NOT NULL,
  owner_type TEXT,
  owner_id TEXT,
  manuscript_channel TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY','PERMANENTLY_TERMINALIZE')),
  reason TEXT NOT NULL,
  PRIMARY KEY(lifecycle_action_id,target_kind,target_id),
  FOREIGN KEY(lifecycle_action_id) REFERENCES review_lifecycle_actions(lifecycle_action_id) ON DELETE CASCADE,
  CHECK (
    (target_kind='binding' AND disposition='DELETE' AND owner_type='review' AND owner_id IS NOT NULL AND manuscript_channel IS NOT NULL)
    OR (target_kind='file_ref' AND disposition='PERMANENTLY_TERMINALIZE' AND owner_type='review' AND owner_id IS NOT NULL AND manuscript_channel IS NOT NULL)
    OR (target_kind='entity_link' AND disposition='DELETE' AND owner_type IS NULL AND owner_id IS NULL AND manuscript_channel IS NULL)
    OR (target_kind='change_log' AND disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY') AND owner_type IS NULL AND owner_id IS NULL AND manuscript_channel IS NULL)
  )
);
CREATE INDEX idx_review_lifecycle_action_targets_action_kind
  ON review_lifecycle_action_targets(lifecycle_action_id,target_kind,target_id);

INSERT OR IGNORE INTO schema_migrations(version,name)
VALUES (51,'review_permanent_delete_durable_authority_foundation');
"#;

const TARGET_TABLE_DELETE_REMEDIATION_SQL: &str = r#"
CREATE TABLE review_lifecycle_action_targets_v51 (
  lifecycle_action_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('binding','file_ref','entity_link','change_log')),
  target_id TEXT NOT NULL,
  expected_revision TEXT NOT NULL,
  owner_type TEXT,
  owner_id TEXT,
  manuscript_channel TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY','PERMANENTLY_TERMINALIZE')),
  reason TEXT NOT NULL,
  PRIMARY KEY(lifecycle_action_id,target_kind,target_id),
  FOREIGN KEY(lifecycle_action_id) REFERENCES review_lifecycle_actions(lifecycle_action_id) ON DELETE CASCADE,
  CHECK (
    (target_kind='binding' AND disposition='DELETE' AND owner_type='review' AND owner_id IS NOT NULL AND manuscript_channel IS NOT NULL)
    OR (target_kind='file_ref' AND disposition='PERMANENTLY_TERMINALIZE' AND owner_type='review' AND owner_id IS NOT NULL AND manuscript_channel IS NOT NULL)
    OR (target_kind='entity_link' AND disposition='DELETE' AND owner_type IS NULL AND owner_id IS NULL AND manuscript_channel IS NULL)
    OR (target_kind='change_log' AND disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY') AND owner_type IS NULL AND owner_id IS NULL AND manuscript_channel IS NULL)
  )
);
INSERT INTO review_lifecycle_action_targets_v51(
  lifecycle_action_id,target_kind,target_id,expected_revision,owner_type,owner_id,
  manuscript_channel,disposition,reason
)
SELECT lifecycle_action_id,target_kind,target_id,expected_revision,owner_type,owner_id,
  manuscript_channel,disposition,reason
FROM review_lifecycle_action_targets;
DROP TABLE review_lifecycle_action_targets;
ALTER TABLE review_lifecycle_action_targets_v51 RENAME TO review_lifecycle_action_targets;
CREATE INDEX idx_review_lifecycle_action_targets_action_kind
  ON review_lifecycle_action_targets(lifecycle_action_id,target_kind,target_id);
"#;

const TERMINAL_GUARD_SQL: &str = r#"
CREATE TRIGGER file_refs_revision_guard
AFTER UPDATE ON file_refs WHEN NEW.revision=OLD.revision
BEGIN
  UPDATE file_refs SET revision=OLD.revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER manuscript_bindings_revision_guard
AFTER UPDATE ON manuscript_bindings WHEN NEW.revision=OLD.revision
BEGIN
  UPDATE manuscript_bindings SET revision=OLD.revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER manuscript_bindings_permanent_file_ref_reference_insert
BEFORE INSERT ON manuscript_bindings WHEN EXISTS (
  SELECT 1 FROM file_refs terminal WHERE terminal.permanent_delete_status='permanently_deleted'
    AND terminal.id IN (NEW.default_folder_file_ref_id,NEW.default_manuscript_file_ref_id,NEW.current_file_ref_id)
)
BEGIN SELECT RAISE(ABORT,'MANUSCRIPT_BINDING_FILE_REF_PERMANENTLY_TERMINAL'); END;
CREATE TRIGGER manuscript_bindings_permanent_file_ref_reference_update
BEFORE UPDATE ON manuscript_bindings WHEN EXISTS (
  SELECT 1 FROM file_refs terminal WHERE terminal.permanent_delete_status='permanently_deleted'
    AND terminal.id IN (NEW.default_folder_file_ref_id,NEW.default_manuscript_file_ref_id,NEW.current_file_ref_id)
)
BEGIN SELECT RAISE(ABORT,'MANUSCRIPT_BINDING_FILE_REF_PERMANENTLY_TERMINAL'); END;

CREATE TRIGGER file_refs_permanent_terminal_immutable
BEFORE UPDATE ON file_refs WHEN OLD.permanent_delete_status='permanently_deleted' AND (
  NEW.permanent_delete_status IS NOT OLD.permanent_delete_status
  OR NEW.permanent_delete_lifecycle_action_id IS NOT OLD.permanent_delete_lifecycle_action_id
  OR NEW.permanently_deleted_at IS NOT OLD.permanently_deleted_at
  OR NEW.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'FILE_REF_PERMANENTLY_TERMINAL'); END;
CREATE TRIGGER file_refs_permanent_terminal_binding_guard
BEFORE UPDATE ON file_refs WHEN OLD.permanent_delete_status IS NULL AND NEW.permanent_delete_status='permanently_deleted' AND EXISTS (
  SELECT 1 FROM manuscript_bindings binding WHERE binding.deleted_at IS NULL AND (
    binding.default_folder_file_ref_id=NEW.id OR binding.default_manuscript_file_ref_id=NEW.id OR binding.current_file_ref_id=NEW.id
  )
)
BEGIN SELECT RAISE(ABORT,'FILE_REF_ACTIVE_BINDING_CONFLICT'); END;
CREATE TRIGGER file_refs_permanent_terminal_delete_blocked
BEFORE DELETE ON file_refs WHEN OLD.permanent_delete_status='permanently_deleted'
BEGIN SELECT RAISE(ABORT,'FILE_REF_PERMANENTLY_TERMINAL'); END;

CREATE TRIGGER file_refs_permanent_terminal_shape_insert
BEFORE INSERT ON file_refs WHEN NOT (
  (NEW.permanent_delete_status IS NULL AND NEW.permanent_delete_lifecycle_action_id IS NULL AND NEW.permanently_deleted_at IS NULL)
  OR (NEW.permanent_delete_status='permanently_deleted' AND NEW.permanent_delete_lifecycle_action_id IS NOT NULL AND NEW.permanently_deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT,'FILE_REF_PERMANENT_TERMINAL_SHAPE_INVALID'); END;
CREATE TRIGGER file_refs_permanent_terminal_shape_update
BEFORE UPDATE ON file_refs WHEN NOT (
  (NEW.permanent_delete_status IS NULL AND NEW.permanent_delete_lifecycle_action_id IS NULL AND NEW.permanently_deleted_at IS NULL)
  OR (NEW.permanent_delete_status='permanently_deleted' AND NEW.permanent_delete_lifecycle_action_id IS NOT NULL AND NEW.permanently_deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT,'FILE_REF_PERMANENT_TERMINAL_SHAPE_INVALID'); END;

CREATE TRIGGER file_refs_permanent_identity_reuse_insert
BEFORE INSERT ON file_refs WHEN EXISTS (
  SELECT 1 FROM file_refs terminal
  WHERE terminal.owner_type=NEW.owner_type AND terminal.owner_id=NEW.owner_id
    AND terminal.manuscript_channel=NEW.manuscript_channel
    AND terminal.path_identity_key=NEW.path_identity_key
    AND terminal.permanent_delete_status='permanently_deleted'
)
BEGIN SELECT RAISE(ABORT,'FILE_REF_PERMANENT_IDENTITY_REUSE_FORBIDDEN'); END;

CREATE TRIGGER file_refs_permanent_identity_reuse_update
BEFORE UPDATE ON file_refs WHEN NEW.permanent_delete_status IS NULL AND EXISTS (
  SELECT 1 FROM file_refs terminal
  WHERE terminal.id<>NEW.id AND terminal.owner_type=NEW.owner_type AND terminal.owner_id=NEW.owner_id
    AND terminal.manuscript_channel=NEW.manuscript_channel
    AND terminal.path_identity_key=NEW.path_identity_key
    AND terminal.permanent_delete_status='permanently_deleted'
)
BEGIN SELECT RAISE(ABORT,'FILE_REF_PERMANENT_IDENTITY_REUSE_FORBIDDEN'); END;

CREATE TRIGGER recycle_entries_permanent_terminal_immutable
BEFORE UPDATE ON recycle_entries WHEN OLD.restore_status='permanently_deleted' AND (
  NEW.restore_status<>'permanently_deleted' OR NEW.can_restore<>0
  OR NEW.terminal_lifecycle_action_id IS NOT OLD.terminal_lifecycle_action_id
  OR NEW.terminal_at IS NOT OLD.terminal_at OR NEW.deleted_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'RECYCLE_ENTRY_PERMANENTLY_TERMINAL'); END;
CREATE TRIGGER recycle_entries_permanent_terminal_delete_blocked
BEFORE DELETE ON recycle_entries WHEN OLD.restore_status='permanently_deleted'
BEGIN SELECT RAISE(ABORT,'RECYCLE_ENTRY_PERMANENTLY_TERMINAL'); END;
CREATE TRIGGER recycle_entries_permanent_terminal_shape_insert
BEFORE INSERT ON recycle_entries WHEN NEW.restore_status='permanently_deleted' AND (
  NEW.can_restore<>0 OR NEW.terminal_lifecycle_action_id IS NULL OR NEW.terminal_at IS NULL OR NEW.deleted_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'RECYCLE_ENTRY_PERMANENT_TERMINAL_SHAPE_INVALID'); END;
CREATE TRIGGER recycle_entries_permanent_terminal_shape_update
BEFORE UPDATE ON recycle_entries WHEN NEW.restore_status='permanently_deleted' AND (
  NEW.can_restore<>0 OR NEW.terminal_lifecycle_action_id IS NULL OR NEW.terminal_at IS NULL OR NEW.deleted_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'RECYCLE_ENTRY_PERMANENT_TERMINAL_SHAPE_INVALID'); END;
"#;

const DROP_TERMINAL_GUARD_SQL: &str = r#"
DROP TRIGGER IF EXISTS file_refs_revision_guard;
DROP TRIGGER IF EXISTS manuscript_bindings_revision_guard;
DROP TRIGGER IF EXISTS manuscript_bindings_permanent_file_ref_reference_insert;
DROP TRIGGER IF EXISTS manuscript_bindings_permanent_file_ref_reference_update;
DROP TRIGGER IF EXISTS file_refs_permanent_terminal_immutable;
DROP TRIGGER IF EXISTS file_refs_permanent_terminal_binding_guard;
DROP TRIGGER IF EXISTS file_refs_permanent_terminal_delete_blocked;
DROP TRIGGER IF EXISTS file_refs_permanent_terminal_shape_insert;
DROP TRIGGER IF EXISTS file_refs_permanent_terminal_shape_update;
DROP TRIGGER IF EXISTS file_refs_permanent_identity_reuse_insert;
DROP TRIGGER IF EXISTS file_refs_permanent_identity_reuse_update;
DROP TRIGGER IF EXISTS recycle_entries_permanent_terminal_immutable;
DROP TRIGGER IF EXISTS recycle_entries_permanent_terminal_delete_blocked;
DROP TRIGGER IF EXISTS recycle_entries_permanent_terminal_shape_insert;
DROP TRIGGER IF EXISTS recycle_entries_permanent_terminal_shape_update;
"#;

pub(crate) fn suspend_terminal_guards_for_historical_replay(
    connection: &Connection,
) -> rusqlite::Result<()> {
    connection.execute_batch(DROP_TERMINAL_GUARD_SQL)
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

fn target_table_supports_change_log_delete(connection: &Connection) -> rusqlite::Result<bool> {
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='review_lifecycle_action_targets'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(sql.is_some_and(|value| {
        value.contains("disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY')")
    }))
}

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    // Historical migration tests and recovery paths may replay the migration
    // after only the SQLite user_version has been rewound.  An exact v51
    // contract is already authoritative and must be a zero-write replay.
    if schema_is_current(connection).unwrap_or(false) {
        return Ok(());
    }
    add_column_if_missing(
        connection,
        "file_refs",
        "revision",
        "INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0)",
    )?;
    add_column_if_missing(connection,"file_refs","permanent_delete_status","TEXT CHECK (permanent_delete_status IS NULL OR permanent_delete_status='permanently_deleted')")?;
    add_column_if_missing(
        connection,
        "file_refs",
        "permanent_delete_lifecycle_action_id",
        "TEXT",
    )?;
    add_column_if_missing(connection, "file_refs", "permanently_deleted_at", "TEXT")?;
    add_column_if_missing(
        connection,
        "manuscript_bindings",
        "revision",
        "INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0)",
    )?;
    add_column_if_missing(connection, "recycle_entries", "terminal_at", "TEXT")?;
    let action_table_exists: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='review_lifecycle_actions'",
        [],
        |row| row.get(0),
    )?;
    let target_table_exists: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='review_lifecycle_action_targets'",
        [],
        |row| row.get(0),
    )?;
    if action_table_exists == 1
        && target_table_exists == 1
        && !target_table_supports_change_log_delete(connection)?
    {
        connection.execute_batch(TARGET_TABLE_DELETE_REMEDIATION_SQL)?;
    }
    if !durable_core_is_current(connection)? {
        connection.execute_batch(ACTION_TABLE_V51_SQL)?;
    }
    connection.execute_batch(DROP_TERMINAL_GUARD_SQL)?;
    connection.execute_batch(TERMINAL_GUARD_SQL)
}

fn durable_core_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version=?1 AND name=?2",
        params![SCHEMA_VERSION, MIGRATION_NAME],
        |row| row.get(0),
    )?;
    let action_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('review_lifecycle_actions')",
        [],
        |row| row.get(0),
    )?;
    let target_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('review_lifecycle_action_targets')",
        [],
        |row| row.get(0),
    )?;
    let durable_columns: i64 = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM pragma_table_info('file_refs') WHERE name IN ('revision','permanent_delete_status','permanent_delete_lifecycle_action_id','permanently_deleted_at')) + (SELECT COUNT(*) FROM pragma_table_info('manuscript_bindings') WHERE name='revision') + (SELECT COUNT(*) FROM pragma_table_info('recycle_entries') WHERE name='terminal_at')", [], |row| row.get(0))?;
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='review_lifecycle_actions'",
        [],
        |row| row.get(0),
    )?;
    let target_delete_supported = target_table_supports_change_log_delete(connection)?;
    Ok(marker == 1
        && action_columns == 35
        && target_columns == 9
        && durable_columns == 6
        && sql.contains("review_permanent_delete")
        && sql.contains("impact_plan_conflict")
        && target_delete_supported)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let guards: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('file_refs_revision_guard','manuscript_bindings_revision_guard','manuscript_bindings_permanent_file_ref_reference_insert','manuscript_bindings_permanent_file_ref_reference_update','file_refs_permanent_terminal_immutable','file_refs_permanent_terminal_binding_guard','file_refs_permanent_terminal_delete_blocked','file_refs_permanent_terminal_shape_insert','file_refs_permanent_terminal_shape_update','file_refs_permanent_identity_reuse_insert','file_refs_permanent_identity_reuse_update','recycle_entries_permanent_terminal_immutable','recycle_entries_permanent_terminal_delete_blocked','recycle_entries_permanent_terminal_shape_insert','recycle_entries_permanent_terminal_shape_update')", [], |row| row.get(0))?;
    Ok(durable_core_is_current(connection)? && guards == 15)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeleteTarget {
    pub target_id: String,
    pub expected_revision: String,
    pub owner_type: Option<String>,
    pub owner_id: Option<String>,
    pub manuscript_channel: Option<String>,
    pub disposition: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfirmedImpactPlan {
    pub impact_plan_version: i64,
    pub lifecycle_action_id: String,
    pub review_id: String,
    pub project_id: String,
    pub exact_recycle_entry_id: String,
    pub source_delete_action_id: String,
    pub expected_recycle_entry_revision: i64,
    pub expected_planning_epoch: String,
    pub expected_planning_revision: String,
    pub expected_review_updated_at: String,
    pub expected_review_deleted_at: String,
    pub binding_targets: Vec<PermanentDeleteTarget>,
    pub file_ref_targets: Vec<PermanentDeleteTarget>,
    pub entity_link_targets: Vec<PermanentDeleteTarget>,
    pub change_log_targets: Vec<PermanentDeleteTarget>,
    pub physical_files_preserved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparePermanentDeleteInput {
    pub lifecycle_action_id: String,
    pub review_id: String,
    pub project_id: String,
    pub expected_review_updated_at: String,
    pub expected_review_deleted_at: String,
    pub expected_planning_epoch: String,
    pub expected_planning_revision: String,
    pub planned_committed_planning_revision: String,
    pub source_delete_action_id: String,
    pub exact_recycle_entry_id: String,
    pub expected_recycle_entry_revision: i64,
    pub impact_plan_version: i64,
    pub impact_digest: String,
    pub impact_plan_json: String,
    pub confirmed_at: String,
    pub planning_effect_id: String,
    pub operation_log_effect_id: String,
    pub binding_cleanup_effect_id: String,
    pub file_ref_cleanup_effect_id: String,
    pub recycle_terminal_effect_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeleteActionRecord {
    pub lifecycle_action_id: String,
    pub revision: i64,
    pub operation_type: String,
    pub review_id: String,
    pub project_id: String,
    pub expected_review_updated_at: String,
    pub expected_review_deleted_at: String,
    pub expected_planning_epoch: String,
    pub expected_planning_revision: String,
    pub planned_committed_planning_revision: String,
    pub committed_planning_epoch: Option<String>,
    pub committed_planning_revision: Option<String>,
    pub source_delete_action_id: String,
    pub exact_recycle_entry_id: String,
    pub expected_recycle_entry_revision: i64,
    pub impact_plan_version: i64,
    pub impact_digest: String,
    pub impact_plan_json: String,
    pub confirmed_at: String,
    pub planning_effect_id: String,
    pub operation_log_effect_id: String,
    pub binding_cleanup_effect_id: String,
    pub file_ref_cleanup_effect_id: String,
    pub recycle_terminal_effect_id: String,
    pub current_stage: String,
    pub terminal_result: Option<String>,
    pub last_error_code: Option<String>,
    pub last_error_retryable: bool,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedPermanentDeleteTarget {
    pub target_kind: String,
    pub target_id: String,
    pub expected_revision: String,
    pub owner_type: Option<String>,
    pub owner_id: Option<String>,
    pub manuscript_channel: Option<String>,
    pub disposition: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeleteActionReadback {
    pub action: PermanentDeleteActionRecord,
    pub targets: Vec<PersistedPermanentDeleteTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeleteMetadataRecord {
    pub id: String,
    pub revision: i64,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub deleted_at: Option<String>,
    pub permanent_delete_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeleteMetadataInventory {
    pub review_id: String,
    pub bindings: Vec<PermanentDeleteMetadataRecord>,
    pub file_refs: Vec<PermanentDeleteMetadataRecord>,
}

fn canonicalize(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("impact_plan_json_invalid: {error}"))
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

fn validate_target(
    target: &PermanentDeleteTarget,
    kind: &str,
    review_id: &str,
) -> Result<(), String> {
    if target.target_id.is_empty()
        || target.expected_revision.is_empty()
        || target.reason.trim().is_empty()
    {
        return Err("impact_plan_target_invalid".into());
    }
    let exact = match kind {
        "binding" => {
            target.disposition == "DELETE"
                && target.owner_type.as_deref() == Some("review")
                && target.owner_id.as_deref() == Some(review_id)
                && target
                    .manuscript_channel
                    .as_deref()
                    .is_some_and(|v| !v.is_empty())
        }
        "file_ref" => {
            target.disposition == "PERMANENTLY_TERMINALIZE"
                && target.owner_type.as_deref() == Some("review")
                && target.owner_id.as_deref() == Some(review_id)
                && target
                    .manuscript_channel
                    .as_deref()
                    .is_some_and(|v| !v.is_empty())
        }
        "entity_link" => {
            target.disposition == "DELETE"
                && target.owner_type.is_none()
                && target.owner_id.is_none()
                && target.manuscript_channel.is_none()
        }
        "change_log" => {
            matches!(
                target.disposition.as_str(),
                "DELETE" | "SANITIZE" | "KEEP_AUDIT_ONLY"
            ) && target.owner_type.is_none()
                && target.owner_id.is_none()
                && target.manuscript_channel.is_none()
        }
        _ => false,
    };
    if exact {
        Ok(())
    } else {
        Err("impact_plan_target_disposition_invalid".into())
    }
}

fn read_inventory(
    connection: &Connection,
    review_id: &str,
) -> Result<PermanentDeleteMetadataInventory, String> {
    fn rows(
        connection: &Connection,
        sql: &str,
        review_id: &str,
        file_ref: bool,
    ) -> Result<Vec<PermanentDeleteMetadataRecord>, String> {
        let mut statement = connection
            .prepare(sql)
            .map_err(|e| format!("metadata_inventory_prepare_failed: {e}"))?;
        let mapped = statement
            .query_map([review_id], |row| {
                Ok(PermanentDeleteMetadataRecord {
                    id: row.get(0)?,
                    revision: row.get(1)?,
                    owner_type: row.get(2)?,
                    owner_id: row.get(3)?,
                    manuscript_channel: row.get(4)?,
                    deleted_at: row.get(5)?,
                    permanent_delete_status: if file_ref { row.get(6)? } else { None },
                })
            })
            .map_err(|e| format!("metadata_inventory_query_failed: {e}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("metadata_inventory_readback_failed: {e}"))
    }
    Ok(PermanentDeleteMetadataInventory{
        review_id:review_id.to_string(),
        bindings:rows(connection,"SELECT id,revision,owner_type,owner_id,manuscript_channel,deleted_at,NULL FROM manuscript_bindings WHERE owner_type='review' AND owner_id=?1 ORDER BY id ASC",review_id,false)?,
        file_refs:rows(connection,"SELECT id,revision,owner_type,owner_id,manuscript_channel,deleted_at,permanent_delete_status FROM file_refs WHERE owner_type='review' AND owner_id=?1 ORDER BY id ASC",review_id,true)?,
    })
}

fn read_action(
    connection: &Connection,
    id: &str,
) -> Result<Option<PermanentDeleteActionRecord>, String> {
    connection.query_row("SELECT lifecycle_action_id,revision,operation_type,review_id,project_id,expected_review_updated_at,expected_review_deleted_at,expected_planning_epoch,expected_planning_revision,planned_committed_planning_revision,committed_planning_epoch,committed_planning_revision,source_delete_action_id,exact_recycle_entry_id,expected_recycle_entry_revision,impact_plan_version,impact_digest,impact_plan_json,confirmed_at,planning_effect_id,operation_log_effect_id,binding_cleanup_effect_id,file_ref_cleanup_effect_id,recycle_terminal_effect_id,current_stage,terminal_result,last_error_code,last_error_retryable,created_at,updated_at,terminal_at FROM review_lifecycle_actions WHERE lifecycle_action_id=?1 AND operation_type='review_permanent_delete'",[id],|row|Ok(PermanentDeleteActionRecord{lifecycle_action_id:row.get(0)?,revision:row.get(1)?,operation_type:row.get(2)?,review_id:row.get(3)?,project_id:row.get(4)?,expected_review_updated_at:row.get(5)?,expected_review_deleted_at:row.get(6)?,expected_planning_epoch:row.get(7)?,expected_planning_revision:row.get(8)?,planned_committed_planning_revision:row.get(9)?,committed_planning_epoch:row.get(10)?,committed_planning_revision:row.get(11)?,source_delete_action_id:row.get(12)?,exact_recycle_entry_id:row.get(13)?,expected_recycle_entry_revision:row.get(14)?,impact_plan_version:row.get(15)?,impact_digest:row.get(16)?,impact_plan_json:row.get(17)?,confirmed_at:row.get(18)?,planning_effect_id:row.get(19)?,operation_log_effect_id:row.get(20)?,binding_cleanup_effect_id:row.get(21)?,file_ref_cleanup_effect_id:row.get(22)?,recycle_terminal_effect_id:row.get(23)?,current_stage:row.get(24)?,terminal_result:row.get(25)?,last_error_code:row.get(26)?,last_error_retryable:row.get::<_,i64>(27)? != 0,created_at:row.get(28)?,updated_at:row.get(29)?,terminal_at:row.get(30)?})).optional().map_err(|e|format!("permanent_action_readback_failed: {e}"))
}

fn read_targets(
    connection: &Connection,
    action_id: &str,
) -> Result<Vec<PersistedPermanentDeleteTarget>, String> {
    let mut statement = connection.prepare(
        "SELECT target_kind,target_id,expected_revision,owner_type,owner_id,manuscript_channel,disposition,reason FROM review_lifecycle_action_targets WHERE lifecycle_action_id=?1 ORDER BY CASE target_kind WHEN 'binding' THEN 1 WHEN 'file_ref' THEN 2 WHEN 'entity_link' THEN 3 ELSE 4 END,target_id ASC"
    ).map_err(|error| format!("permanent_action_target_readback_prepare_failed: {error}"))?;
    let rows = statement
        .query_map([action_id], |row| {
            Ok(PersistedPermanentDeleteTarget {
                target_kind: row.get(0)?,
                target_id: row.get(1)?,
                expected_revision: row.get(2)?,
                owner_type: row.get(3)?,
                owner_id: row.get(4)?,
                manuscript_channel: row.get(5)?,
                disposition: row.get(6)?,
                reason: row.get(7)?,
            })
        })
        .map_err(|error| format!("permanent_action_target_readback_failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("permanent_action_target_collect_failed: {error}"))?;
    Ok(rows)
}

fn targets_match_plan(
    connection: &Connection,
    action_id: &str,
    plan: &ConfirmedImpactPlan,
) -> Result<bool, String> {
    let expected = [
        ("binding", &plan.binding_targets),
        ("file_ref", &plan.file_ref_targets),
        ("entity_link", &plan.entity_link_targets),
        ("change_log", &plan.change_log_targets),
    ]
    .into_iter()
    .flat_map(|(kind, targets)| {
        targets
            .iter()
            .map(move |target| PersistedPermanentDeleteTarget {
                target_kind: kind.to_string(),
                target_id: target.target_id.clone(),
                expected_revision: target.expected_revision.clone(),
                owner_type: target.owner_type.clone(),
                owner_id: target.owner_id.clone(),
                manuscript_channel: target.manuscript_channel.clone(),
                disposition: target.disposition.clone(),
                reason: target.reason.clone(),
            })
    })
    .collect::<Vec<_>>();
    Ok(read_targets(connection, action_id)? == expected)
}

fn input_matches(
    record: &PermanentDeleteActionRecord,
    input: &PreparePermanentDeleteInput,
) -> bool {
    record.lifecycle_action_id == input.lifecycle_action_id
        && record.review_id == input.review_id
        && record.project_id == input.project_id
        && record.expected_review_updated_at == input.expected_review_updated_at
        && record.expected_review_deleted_at == input.expected_review_deleted_at
        && record.expected_planning_epoch == input.expected_planning_epoch
        && record.expected_planning_revision == input.expected_planning_revision
        && record.planned_committed_planning_revision == input.planned_committed_planning_revision
        && record.source_delete_action_id == input.source_delete_action_id
        && record.exact_recycle_entry_id == input.exact_recycle_entry_id
        && record.expected_recycle_entry_revision == input.expected_recycle_entry_revision
        && record.impact_plan_version == input.impact_plan_version
        && record.impact_digest == input.impact_digest
        && record.impact_plan_json == input.impact_plan_json
        && record.confirmed_at == input.confirmed_at
        && record.planning_effect_id == input.planning_effect_id
        && record.operation_log_effect_id == input.operation_log_effect_id
        && record.binding_cleanup_effect_id == input.binding_cleanup_effect_id
        && record.file_ref_cleanup_effect_id == input.file_ref_cleanup_effect_id
        && record.recycle_terminal_effect_id == input.recycle_terminal_effect_id
}

pub(crate) fn prepare_in_connection(
    connection: &mut Connection,
    input: &PreparePermanentDeleteInput,
) -> Result<PermanentDeleteActionRecord, String> {
    if !safe_id(&input.lifecycle_action_id)
        || input.confirmed_at.trim().is_empty()
        || input.impact_plan_version != 1
        || input.expected_recycle_entry_revision < 0
    {
        return Err("review_permanent_delete_input_invalid".into());
    }
    let prefix = format!("review-lifecycle:{}", input.lifecycle_action_id);
    if input.planning_effect_id != format!("{prefix}:planning")
        || input.operation_log_effect_id != format!("{prefix}:operation-log")
        || input.binding_cleanup_effect_id != format!("{prefix}:binding-cleanup")
        || input.file_ref_cleanup_effect_id != format!("{prefix}:file-ref-terminalize")
        || input.recycle_terminal_effect_id
            != format!("{prefix}:recycle-terminal:{}", input.exact_recycle_entry_id)
    {
        return Err("review_permanent_delete_effect_identity_invalid".into());
    }
    let expected = input.expected_planning_revision.parse::<u128>().ok();
    let planned = input
        .planned_committed_planning_revision
        .parse::<u128>()
        .ok();
    if expected
        .zip(planned)
        .is_none_or(|(a, b)| a.checked_add(1) != Some(b))
    {
        return Err("review_permanent_delete_planning_revision_invalid".into());
    }
    let value: Value = serde_json::from_str(&input.impact_plan_json)
        .map_err(|_| "impact_plan_json_invalid".to_string())?;
    let canonical = canonicalize(&value)?;
    if canonical != input.impact_plan_json || digest(&canonical) != input.impact_digest {
        return Err("impact_plan_digest_mismatch".into());
    }
    let plan: ConfirmedImpactPlan =
        serde_json::from_value(value).map_err(|_| "impact_plan_contract_invalid".to_string())?;
    if plan.impact_plan_version != 1
        || plan.lifecycle_action_id != input.lifecycle_action_id
        || plan.review_id != input.review_id
        || plan.project_id != input.project_id
        || plan.exact_recycle_entry_id != input.exact_recycle_entry_id
        || plan.source_delete_action_id != input.source_delete_action_id
        || plan.expected_recycle_entry_revision != input.expected_recycle_entry_revision
        || plan.expected_planning_epoch != input.expected_planning_epoch
        || plan.expected_planning_revision != input.expected_planning_revision
        || plan.expected_review_updated_at != input.expected_review_updated_at
        || plan.expected_review_deleted_at != input.expected_review_deleted_at
        || !plan.physical_files_preserved
    {
        return Err("impact_plan_identity_mismatch".into());
    }
    for target in &plan.binding_targets {
        validate_target(target, "binding", &input.review_id)?;
    }
    for target in &plan.file_ref_targets {
        validate_target(target, "file_ref", &input.review_id)?;
    }
    for target in &plan.entity_link_targets {
        validate_target(target, "entity_link", &input.review_id)?;
    }
    for target in &plan.change_log_targets {
        validate_target(target, "change_log", &input.review_id)?;
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("permanent_action_prepare_begin_failed: {e}"))?;
    let entry:Option<(String,String,Option<String>,i64,String,Option<String>,i64,Option<String>)>=tx.query_row("SELECT entity_type,entity_id,created_by_lifecycle_action_id,can_restore,restore_status,terminal_lifecycle_action_id,revision,deleted_at FROM recycle_entries WHERE id=?1",[&input.exact_recycle_entry_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(|e|format!("recycle_entry_readback_failed: {e}"))?;
    if !entry.is_some_and(|e| {
        e.0 == "review"
            && e.1 == input.review_id
            && e.2.as_deref() == Some(&input.source_delete_action_id)
            && e.3 == 1
            && e.4 == "not_started"
            && e.5.is_none()
            && e.6 == input.expected_recycle_entry_revision
            && e.7.is_none()
    }) {
        return Err("recycle_entry_conflict".into());
    }
    let inventory = read_inventory(&tx, &input.review_id)?;
    if inventory
        .file_refs
        .iter()
        .any(|record| record.permanent_delete_status.is_some())
    {
        return Err("already_terminal_by_other_action".into());
    }
    let exact_bindings = inventory
        .bindings
        .iter()
        .map(|r| {
            (
                r.id.clone(),
                r.revision.to_string(),
                r.owner_type.clone(),
                r.owner_id.clone(),
                r.manuscript_channel.clone(),
            )
        })
        .eq(plan.binding_targets.iter().map(|t| {
            (
                t.target_id.clone(),
                t.expected_revision.clone(),
                t.owner_type.clone().unwrap_or_default(),
                t.owner_id.clone().unwrap_or_default(),
                t.manuscript_channel.clone().unwrap_or_default(),
            )
        }));
    let exact_files = inventory
        .file_refs
        .iter()
        .filter(|r| r.permanent_delete_status.is_none())
        .map(|r| {
            (
                r.id.clone(),
                r.revision.to_string(),
                r.owner_type.clone(),
                r.owner_id.clone(),
                r.manuscript_channel.clone(),
            )
        })
        .eq(plan.file_ref_targets.iter().map(|t| {
            (
                t.target_id.clone(),
                t.expected_revision.clone(),
                t.owner_type.clone().unwrap_or_default(),
                t.owner_id.clone().unwrap_or_default(),
                t.manuscript_channel.clone().unwrap_or_default(),
            )
        }));
    if !exact_bindings || !exact_files {
        return Err("impact_plan_metadata_inventory_conflict".into());
    }
    if let Some(existing) = read_action(&tx, &input.lifecycle_action_id)? {
        if input_matches(&existing, input)
            && targets_match_plan(&tx, &input.lifecycle_action_id, &plan)?
        {
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(existing);
        }
        return Err("review_lifecycle_identity_conflict".into());
    }
    let pending:Option<String>=tx.query_row("SELECT lifecycle_action_id FROM review_lifecycle_actions WHERE review_id=?1 AND terminal_result IS NULL",[&input.review_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if pending.is_some() {
        return Err("review_lifecycle_pending_conflict".into());
    }
    let now = Utc::now().to_rfc3339();
    tx.execute("INSERT INTO review_lifecycle_actions(lifecycle_action_id,revision,operation_type,review_id,project_id,expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,target_review_updated_at,target_review_deleted_at,expected_planning_epoch,expected_planning_revision,planned_committed_planning_revision,planning_effect_id,source_delete_action_id,exact_recycle_entry_id,expected_recycle_entry_revision,impact_plan_version,impact_digest,impact_plan_json,confirmed_at,operation_log_effect_id,recycle_effect_id,binding_cleanup_effect_id,file_ref_cleanup_effect_id,recycle_terminal_effect_id,current_stage,last_error_retryable,created_at,updated_at) VALUES(?1,0,'review_permanent_delete',?2,?3,'deleted',?4,?5,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13,?14,?15,?16,?17,?18,?19,?17,'prepared',0,?20,?20)",params![input.lifecycle_action_id,input.review_id,input.project_id,input.expected_review_updated_at,input.expected_review_deleted_at,input.expected_planning_epoch,input.expected_planning_revision,input.planned_committed_planning_revision,input.planning_effect_id,input.source_delete_action_id,input.exact_recycle_entry_id,input.expected_recycle_entry_revision,input.impact_digest,input.impact_plan_json,input.confirmed_at,input.operation_log_effect_id,input.recycle_terminal_effect_id,input.binding_cleanup_effect_id,input.file_ref_cleanup_effect_id,now]).map_err(|e|format!("permanent_action_insert_failed: {e}"))?;
    for (kind, targets) in [
        ("binding", &plan.binding_targets),
        ("file_ref", &plan.file_ref_targets),
        ("entity_link", &plan.entity_link_targets),
        ("change_log", &plan.change_log_targets),
    ] {
        for target in targets {
            tx.execute("INSERT INTO review_lifecycle_action_targets(lifecycle_action_id,target_kind,target_id,expected_revision,owner_type,owner_id,manuscript_channel,disposition,reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![input.lifecycle_action_id,kind,target.target_id,target.expected_revision,target.owner_type,target.owner_id,target.manuscript_channel,target.disposition,target.reason]).map_err(|e|format!("permanent_action_target_insert_failed: {e}"))?;
        }
    }
    let record =
        read_action(&tx, &input.lifecycle_action_id)?.ok_or("permanent_action_readback_missing")?;
    if !input_matches(&record, input)
        || !targets_match_plan(&tx, &input.lifecycle_action_id, &plan)?
    {
        return Err("permanent_action_readback_mismatch".into());
    }
    tx.commit()
        .map_err(|e| format!("permanent_action_prepare_commit_failed: {e}"))?;
    Ok(record)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordPermanentPlanningCommitInput {
    pub lifecycle_action_id: String,
    pub expected_revision: i64,
    pub impact_digest: String,
    pub committed_planning_epoch: String,
    pub committed_planning_revision: String,
}

pub(crate) fn record_planning_commit_in_connection(
    connection: &mut Connection,
    input: &RecordPermanentPlanningCommitInput,
) -> Result<PermanentDeleteActionRecord, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let current =
        read_action(&tx, &input.lifecycle_action_id)?.ok_or("review_lifecycle_action_not_found")?;
    if current.current_stage == "planning_committed"
        && current.committed_planning_epoch.as_deref() == Some(&input.committed_planning_epoch)
        && current.committed_planning_revision.as_deref()
            == Some(&input.committed_planning_revision)
        && current.impact_digest == input.impact_digest
    {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(current);
    }
    if current.revision != input.expected_revision
        || current.current_stage != "prepared"
        || current.terminal_result.is_some()
        || current.impact_digest != input.impact_digest
        || current.expected_planning_epoch != input.committed_planning_epoch
        || current.planned_committed_planning_revision != input.committed_planning_revision
    {
        return Err("review_permanent_delete_planning_cas_conflict".into());
    }
    let now = Utc::now().to_rfc3339();
    let changed=tx.execute("UPDATE review_lifecycle_actions SET revision=revision+1,current_stage='planning_committed',committed_planning_epoch=?1,committed_planning_revision=?2,updated_at=?3 WHERE lifecycle_action_id=?4 AND revision=?5 AND current_stage='prepared' AND terminal_result IS NULL AND impact_digest=?6",params![input.committed_planning_epoch,input.committed_planning_revision,now,input.lifecycle_action_id,input.expected_revision,input.impact_digest]).map_err(|e|e.to_string())?;
    if changed != 1 {
        return Err("review_permanent_delete_planning_cas_conflict".into());
    }
    let record =
        read_action(&tx, &input.lifecycle_action_id)?.ok_or("permanent_action_readback_missing")?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(record)
}

#[derive(Debug, PartialEq, Eq)]
struct PermanentDeleteOperationLogEvidence {
    id: String,
    operation_type: String,
    module: String,
    status: String,
    target: String,
    summary: String,
    impact_summary: Option<String>,
    confirmation: Option<String>,
    recycle_entry_id: Option<String>,
    is_recoverable: i64,
    lifecycle_action_id: Option<String>,
    effect_type: Option<String>,
    deleted_at: Option<String>,
}

fn expected_operation_log_evidence(
    action: &PermanentDeleteActionRecord,
) -> PermanentDeleteOperationLogEvidence {
    PermanentDeleteOperationLogEvidence {
        id: action.operation_log_effect_id.clone(),
        operation_type: "permanently_delete".into(),
        module: "review".into(),
        status: "success".into(),
        target: serde_json::json!({
            "entityId": action.review_id,
            "entityType": "review",
            "title": "[permanently deleted Review]"
        })
        .to_string(),
        summary: "Review metadata permanently deleted; physical files preserved.".into(),
        impact_summary: Some(action.impact_plan_json.clone()),
        confirmation: Some(
            serde_json::json!({
                "confirmedAt": action.confirmed_at,
                "impactDigest": action.impact_digest,
                "impactPlanVersion": action.impact_plan_version,
                "lifecycleActionId": action.lifecycle_action_id
            })
            .to_string(),
        ),
        recycle_entry_id: Some(action.exact_recycle_entry_id.clone()),
        is_recoverable: 0,
        lifecycle_action_id: Some(action.lifecycle_action_id.clone()),
        effect_type: Some("review_permanent_delete_operation_log".into()),
        deleted_at: None,
    }
}

fn readback_exact_operation_log(
    connection: &Connection,
    action: &PermanentDeleteActionRecord,
) -> Result<Option<String>, String> {
    let existing = connection
        .query_row(
            "SELECT id,operation_type,module,status,target,summary,impact_summary,confirmation,recycle_entry_id,is_recoverable,lifecycle_action_id,effect_type,deleted_at FROM operation_logs WHERE lifecycle_action_id=?1 AND effect_type='review_permanent_delete_operation_log'",
            [&action.lifecycle_action_id],
            |row| {
                Ok(PermanentDeleteOperationLogEvidence {
                    id: row.get(0)?,
                    operation_type: row.get(1)?,
                    module: row.get(2)?,
                    status: row.get(3)?,
                    target: row.get(4)?,
                    summary: row.get(5)?,
                    impact_summary: row.get(6)?,
                    confirmation: row.get(7)?,
                    recycle_entry_id: row.get(8)?,
                    is_recoverable: row.get(9)?,
                    lifecycle_action_id: row.get(10)?,
                    effect_type: row.get(11)?,
                    deleted_at: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(|error| {
            format!("review_permanent_delete_operation_log_readback_failed: {error}")
        })?;
    match existing {
        None => Ok(None),
        Some(value) if value == expected_operation_log_evidence(action) => Ok(Some(value.id)),
        Some(_) => Err("review_permanent_delete_operation_log_identity_conflict".into()),
    }
}

pub(crate) fn insert_or_readback_operation_log_in_transaction(
    connection: &Connection,
    lifecycle_action_id: &str,
    created_at: &str,
) -> Result<String, String> {
    let action = read_action(connection, lifecycle_action_id)?
        .ok_or_else(|| "review_lifecycle_action_not_found".to_string())?;
    if action.current_stage != "planning_committed" || action.terminal_result.is_some() {
        return Err("review_permanent_delete_finalization_stage_invalid".into());
    }
    if let Some(existing) = readback_exact_operation_log(connection, &action)? {
        return Ok(existing);
    }
    let expected = expected_operation_log_evidence(&action);
    connection.execute(
        "INSERT INTO operation_logs(id,operation_type,source,module,status,risk_level,target,summary,related_entities,impact_summary,confirmation,warnings,errors,skipped,is_recoverable,recycle_entry_id,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at,deleted_at,lifecycle_action_id,effect_type) VALUES(?1,'permanently_delete','user','review','success','high',?2,'Review metadata permanently deleted; physical files preserved.','[]',?3,?4,'[]','[]','[]',0,?5,'user','LabPod user',?6,1,?7,?7,NULL,?8,'review_permanent_delete_operation_log')",
        params![
            action.operation_log_effect_id,
            expected.target,
            action.impact_plan_json,
            expected.confirmation,
            action.exact_recycle_entry_id,
            serde_json::json!(["review.changed","reviewContext.changed","operationLog.changed","recycleBin.changed"]).to_string(),
            created_at,
            action.lifecycle_action_id,
        ],
    ).map_err(|error| format!("review_permanent_delete_operation_log_insert_failed: {error}"))?;
    readback_exact_operation_log(connection, &action)?
        .ok_or_else(|| "review_permanent_delete_operation_log_readback_missing".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinalizePermanentDeleteInput {
    pub lifecycle_action_id: String,
    pub expected_revision: i64,
    pub impact_digest: String,
    pub terminal_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermanentDeleteFinalizationReadback {
    pub action: PermanentDeleteActionRecord,
    pub deleted_binding_ids: Vec<String>,
    pub terminal_file_ref_ids: Vec<String>,
    pub operation_log_id: String,
    pub recycle_entry_id: String,
    pub prior_success: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FinalizationFailureSeam {
    BindingDelete,
    FileRefTerminalization,
    OperationLogInsert,
    RecycleTerminal,
    ActionCompletion,
}

fn expected_target_revision(target: &PersistedPermanentDeleteTarget) -> Result<i64, String> {
    target
        .expected_revision
        .parse::<i64>()
        .ok()
        .filter(|revision| *revision >= 0)
        .ok_or_else(|| "review_permanent_delete_target_revision_invalid".into())
}

fn readback_completed_finalization(
    connection: &Connection,
    action: &PermanentDeleteActionRecord,
    targets: &[PersistedPermanentDeleteTarget],
    prior_success: bool,
) -> Result<PermanentDeleteFinalizationReadback, String> {
    if action.current_stage != "completed"
        || action.terminal_result.as_deref() != Some("completed")
        || action.terminal_at.is_none()
        || action.last_error_code.is_some()
        || action.last_error_retryable
    {
        return Err("review_permanent_delete_completed_action_invalid".into());
    }
    let terminal_at = action.terminal_at.as_deref().unwrap_or_default();
    let binding_targets = targets
        .iter()
        .filter(|target| target.target_kind == "binding")
        .collect::<Vec<_>>();
    let file_targets = targets
        .iter()
        .filter(|target| target.target_kind == "file_ref")
        .collect::<Vec<_>>();

    for target in &binding_targets {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_bindings WHERE id=?1",
                [&target.target_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("binding_terminal_readback_failed: {error}"))?;
        if count != 0 {
            return Err("review_permanent_delete_binding_terminal_readback_conflict".into());
        }
    }
    let remaining_review_bindings: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_bindings WHERE owner_type='review' AND owner_id=?1",
            [&action.review_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("binding_owner_readback_failed: {error}"))?;
    if remaining_review_bindings != 0 {
        return Err("review_permanent_delete_unplanned_binding_conflict".into());
    }

    for target in &file_targets {
        let expected_revision = expected_target_revision(target)? + 1;
        let row: Option<(i64, String, String, String, String, Option<String>, String)> = connection
            .query_row(
                "SELECT revision,owner_type,owner_id,manuscript_channel,permanent_delete_status,permanent_delete_lifecycle_action_id,permanently_deleted_at FROM file_refs WHERE id=?1",
                [&target.target_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
            )
            .optional()
            .map_err(|error| format!("file_ref_terminal_readback_failed: {error}"))?;
        if !row.is_some_and(|row| {
            row.0 == expected_revision
                && row.1 == "review"
                && row.2 == action.review_id
                && Some(row.3.as_str()) == target.manuscript_channel.as_deref()
                && row.4 == "permanently_deleted"
                && row.5.as_deref() == Some(&action.lifecycle_action_id)
                && row.6 == terminal_at
        }) {
            return Err("review_permanent_delete_file_ref_terminal_readback_conflict".into());
        }
    }
    let review_file_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM file_refs WHERE owner_type='review' AND owner_id=?1",
            [&action.review_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("file_ref_owner_readback_failed: {error}"))?;
    if review_file_count != file_targets.len() as i64 {
        return Err("review_permanent_delete_unplanned_file_ref_conflict".into());
    }

    let operation_log_id = readback_exact_operation_log(connection, action)?
        .ok_or_else(|| "review_permanent_delete_operation_log_readback_missing".to_string())?;
    let recycle: Option<(String, String, Option<String>, i64, String, Option<String>, Option<String>, i64)> = connection
        .query_row(
            "SELECT entity_type,entity_id,created_by_lifecycle_action_id,can_restore,restore_status,terminal_lifecycle_action_id,terminal_at,revision FROM recycle_entries WHERE id=?1",
            [&action.exact_recycle_entry_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
        )
        .optional()
        .map_err(|error| format!("recycle_terminal_readback_failed: {error}"))?;
    if !recycle.is_some_and(|row| {
        row.0 == "review"
            && row.1 == action.review_id
            && row.2.as_deref() == Some(&action.source_delete_action_id)
            && row.3 == 0
            && row.4 == "permanently_deleted"
            && row.5.as_deref() == Some(&action.lifecycle_action_id)
            && row.6.as_deref() == Some(terminal_at)
            && row.7 == action.expected_recycle_entry_revision + 1
    }) {
        return Err("review_permanent_delete_recycle_terminal_readback_conflict".into());
    }

    Ok(PermanentDeleteFinalizationReadback {
        action: action.clone(),
        deleted_binding_ids: binding_targets
            .into_iter()
            .map(|target| target.target_id.clone())
            .collect(),
        terminal_file_ref_ids: file_targets
            .into_iter()
            .map(|target| target.target_id.clone())
            .collect(),
        operation_log_id,
        recycle_entry_id: action.exact_recycle_entry_id.clone(),
        prior_success,
    })
}

fn finalize_in_connection_with_failure(
    connection: &mut Connection,
    input: &FinalizePermanentDeleteInput,
    failure_seam: Option<FinalizationFailureSeam>,
) -> Result<PermanentDeleteFinalizationReadback, String> {
    if !safe_id(&input.lifecycle_action_id)
        || !matches!(input.expected_revision, 0..=i64::MAX)
        || input.terminal_at.trim().is_empty()
        || !input
            .impact_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || input.impact_digest.len() != 64
    {
        return Err("review_permanent_delete_finalization_input_invalid".into());
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("review_permanent_delete_finalization_begin_failed: {error}"))?;
    let action = read_action(&tx, &input.lifecycle_action_id)?
        .ok_or_else(|| "review_lifecycle_action_not_found".to_string())?;
    if action.impact_digest != input.impact_digest {
        return Err("review_permanent_delete_impact_digest_conflict".into());
    }
    let targets = read_targets(&tx, &input.lifecycle_action_id)?;
    if action.current_stage == "completed" {
        let result = readback_completed_finalization(&tx, &action, &targets, true)?;
        tx.commit().map_err(|error| {
            format!("review_permanent_delete_completed_readback_commit_failed: {error}")
        })?;
        return Ok(result);
    }
    if action.current_stage != "planning_committed"
        || action.terminal_result.is_some()
        || action.revision != input.expected_revision
        || action.committed_planning_epoch.as_deref() != Some(&action.expected_planning_epoch)
        || action.committed_planning_revision.as_deref()
            != Some(&action.planned_committed_planning_revision)
    {
        return Err("review_permanent_delete_finalization_stage_conflict".into());
    }
    let binding_targets = targets
        .iter()
        .filter(|target| target.target_kind == "binding")
        .collect::<Vec<_>>();
    let file_targets = targets
        .iter()
        .filter(|target| target.target_kind == "file_ref")
        .collect::<Vec<_>>();
    for target in &binding_targets {
        let plan_target = PermanentDeleteTarget {
            target_id: target.target_id.clone(),
            expected_revision: target.expected_revision.clone(),
            owner_type: target.owner_type.clone(),
            owner_id: target.owner_id.clone(),
            manuscript_channel: target.manuscript_channel.clone(),
            disposition: target.disposition.clone(),
            reason: target.reason.clone(),
        };
        validate_target(&plan_target, "binding", &action.review_id)?;
    }
    for target in &file_targets {
        let plan_target = PermanentDeleteTarget {
            target_id: target.target_id.clone(),
            expected_revision: target.expected_revision.clone(),
            owner_type: target.owner_type.clone(),
            owner_id: target.owner_id.clone(),
            manuscript_channel: target.manuscript_channel.clone(),
            disposition: target.disposition.clone(),
            reason: target.reason.clone(),
        };
        validate_target(&plan_target, "file_ref", &action.review_id)?;
    }

    let inventory = read_inventory(&tx, &action.review_id)?;
    let exact_bindings = inventory.bindings.len() == binding_targets.len()
        && inventory
            .bindings
            .iter()
            .zip(binding_targets.iter())
            .all(|(row, target)| {
                row.id == target.target_id
                    && row.revision.to_string() == target.expected_revision
                    && row.owner_type == "review"
                    && row.owner_id == action.review_id
                    && Some(row.manuscript_channel.as_str()) == target.manuscript_channel.as_deref()
                    && target.disposition == "DELETE"
            });
    let exact_files = inventory.file_refs.len() == file_targets.len()
        && inventory
            .file_refs
            .iter()
            .zip(file_targets.iter())
            .all(|(row, target)| {
                row.id == target.target_id
                    && row.revision.to_string() == target.expected_revision
                    && row.owner_type == "review"
                    && row.owner_id == action.review_id
                    && Some(row.manuscript_channel.as_str()) == target.manuscript_channel.as_deref()
                    && row.permanent_delete_status.is_none()
                    && target.disposition == "PERMANENTLY_TERMINALIZE"
            });
    if !exact_bindings || !exact_files {
        return Err("metadata_plan_conflict".into());
    }

    let recycle: Option<(String, String, String, String, Option<String>, i64, String, Option<String>, i64, Option<String>)> = tx
        .query_row(
            "SELECT id,entity_type,entity_id,entity_deleted_at,created_by_lifecycle_action_id,can_restore,restore_status,terminal_lifecycle_action_id,revision,deleted_at FROM recycle_entries WHERE id=?1",
            [&action.exact_recycle_entry_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)),
        )
        .optional()
        .map_err(|error| format!("recycle_entry_finalization_readback_failed: {error}"))?;
    if !recycle.is_some_and(|row| {
        row.0 == action.exact_recycle_entry_id
            && row.1 == "review"
            && row.2 == action.review_id
            && row.3 == action.expected_review_deleted_at
            && row.4.as_deref() == Some(&action.source_delete_action_id)
            && row.5 == 1
            && row.6 == "not_started"
            && row.7.is_none()
            && row.8 == action.expected_recycle_entry_revision
            && row.9.is_none()
    }) {
        return Err("metadata_plan_conflict".into());
    }

    for target in &file_targets {
        let mut statement = tx
            .prepare(
                "SELECT id FROM manuscript_bindings WHERE deleted_at IS NULL AND (default_folder_file_ref_id=?1 OR default_manuscript_file_ref_id=?1 OR current_file_ref_id=?1)",
            )
            .map_err(|error| format!("file_ref_binding_guard_prepare_failed: {error}"))?;
        let referencing_binding_ids = statement
            .query_map([&target.target_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("file_ref_binding_guard_readback_failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("file_ref_binding_guard_collect_failed: {error}"))?;
        if referencing_binding_ids.iter().any(|binding_id| {
            !binding_targets
                .iter()
                .any(|planned| planned.target_id == *binding_id)
        }) {
            return Err("metadata_plan_conflict".into());
        }
    }

    for target in &binding_targets {
        let expected_revision = expected_target_revision(target)?;
        let changed = tx
            .execute(
                "DELETE FROM manuscript_bindings WHERE id=?1 AND revision=?2 AND owner_type='review' AND owner_id=?3 AND manuscript_channel=?4",
                params![target.target_id, expected_revision, action.review_id, target.manuscript_channel],
            )
            .map_err(|error| format!("review_permanent_delete_binding_delete_failed: {error}"))?;
        if changed != 1 {
            return Err("metadata_plan_conflict".into());
        }
    }
    if failure_seam == Some(FinalizationFailureSeam::BindingDelete) {
        return Err("injected_binding_delete_failure".into());
    }

    for target in &file_targets {
        let active_references: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM manuscript_bindings WHERE deleted_at IS NULL AND (default_folder_file_ref_id=?1 OR default_manuscript_file_ref_id=?1 OR current_file_ref_id=?1)",
                [&target.target_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("file_ref_binding_guard_readback_failed: {error}"))?;
        if active_references != 0 {
            return Err("metadata_plan_conflict".into());
        }
        let expected_revision = expected_target_revision(target)?;
        let changed = tx
            .execute(
                "UPDATE file_refs SET deleted_at=COALESCE(deleted_at,?1),permanent_delete_status='permanently_deleted',permanent_delete_lifecycle_action_id=?2,permanently_deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?3 AND revision=?4 AND owner_type='review' AND owner_id=?5 AND manuscript_channel=?6 AND permanent_delete_status IS NULL",
                params![input.terminal_at,action.lifecycle_action_id,target.target_id,expected_revision,action.review_id,target.manuscript_channel],
            )
            .map_err(|error| format!("review_permanent_delete_file_ref_terminalization_failed: {error}"))?;
        if changed != 1 {
            return Err("metadata_plan_conflict".into());
        }
    }
    if failure_seam == Some(FinalizationFailureSeam::FileRefTerminalization) {
        return Err("injected_file_ref_terminalization_failure".into());
    }

    let operation_log_id = insert_or_readback_operation_log_in_transaction(
        &tx,
        &action.lifecycle_action_id,
        &input.terminal_at,
    )?;
    if failure_seam == Some(FinalizationFailureSeam::OperationLogInsert) {
        return Err("injected_operation_log_insert_failure".into());
    }

    let recycle_changed = tx
        .execute(
            "UPDATE recycle_entries SET can_restore=0,cannot_restore_reason='Review metadata was permanently deleted from LabPod; physical files were preserved.',restore_status='permanently_deleted',terminal_lifecycle_action_id=?1,terminal_at=?2,updated_at=?2,revision=revision+1 WHERE id=?3 AND entity_type='review' AND entity_id=?4 AND created_by_lifecycle_action_id=?5 AND revision=?6 AND can_restore=1 AND restore_status='not_started' AND terminal_lifecycle_action_id IS NULL AND deleted_at IS NULL",
            params![action.lifecycle_action_id,input.terminal_at,action.exact_recycle_entry_id,action.review_id,action.source_delete_action_id,action.expected_recycle_entry_revision],
        )
        .map_err(|error| format!("review_permanent_delete_recycle_terminal_failed: {error}"))?;
    if recycle_changed != 1 {
        return Err("metadata_plan_conflict".into());
    }
    if failure_seam == Some(FinalizationFailureSeam::RecycleTerminal) {
        return Err("injected_recycle_terminal_failure".into());
    }

    let action_changed = tx
        .execute(
            "UPDATE review_lifecycle_actions SET revision=revision+1,current_stage='completed',terminal_result='completed',last_error_code=NULL,last_error_retryable=0,updated_at=?1,terminal_at=?1 WHERE lifecycle_action_id=?2 AND revision=?3 AND current_stage='planning_committed' AND terminal_result IS NULL AND impact_digest=?4",
            params![input.terminal_at,action.lifecycle_action_id,input.expected_revision,input.impact_digest],
        )
        .map_err(|error| format!("review_permanent_delete_action_completion_failed: {error}"))?;
    if action_changed != 1 {
        return Err("review_permanent_delete_action_completion_conflict".into());
    }
    if failure_seam == Some(FinalizationFailureSeam::ActionCompletion) {
        return Err("injected_action_completion_failure".into());
    }
    let completed = read_action(&tx, &action.lifecycle_action_id)?
        .ok_or_else(|| "review_permanent_delete_completed_action_missing".to_string())?;
    let result = readback_completed_finalization(&tx, &completed, &targets, false)?;
    if result.operation_log_id != operation_log_id {
        return Err("review_permanent_delete_operation_log_identity_conflict".into());
    }
    tx.commit()
        .map_err(|error| format!("review_permanent_delete_finalization_commit_failed: {error}"))?;
    Ok(result)
}

pub(crate) fn finalize_in_connection(
    connection: &mut Connection,
    input: &FinalizePermanentDeleteInput,
) -> Result<PermanentDeleteFinalizationReadback, String> {
    finalize_in_connection_with_failure(connection, input, None)
}

#[tauri::command]
pub(crate) fn read_review_permanent_delete_metadata_inventory(
    app_handle: AppHandle,
    review_id: String,
) -> Result<PermanentDeleteMetadataInventory, String> {
    if review_id.trim().is_empty() {
        return Err("review_id_required".into());
    }
    let connection = super::open_connection(&app_handle)?;
    read_inventory(&connection, &review_id)
}
#[tauri::command]
pub(crate) fn prepare_review_permanent_delete_action(
    app_handle: AppHandle,
    input: PreparePermanentDeleteInput,
) -> Result<PermanentDeleteActionRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    prepare_in_connection(&mut connection, &input)
}
#[tauri::command]
pub(crate) fn readback_review_permanent_delete_action(
    app_handle: AppHandle,
    lifecycle_action_id: String,
) -> Result<Option<PermanentDeleteActionReadback>, String> {
    let connection = super::open_connection(&app_handle)?;
    let Some(action) = read_action(&connection, &lifecycle_action_id)? else {
        return Ok(None);
    };
    let targets = read_targets(&connection, &lifecycle_action_id)?;
    Ok(Some(PermanentDeleteActionReadback { action, targets }))
}
#[tauri::command]
pub(crate) fn read_pending_review_permanent_delete_action(
    app_handle: AppHandle,
    review_id: String,
) -> Result<Option<PermanentDeleteActionReadback>, String> {
    if review_id.trim().is_empty() {
        return Err("review_id_required".into());
    }
    let connection = super::open_connection(&app_handle)?;
    let action_id: Option<String> = connection
        .query_row(
            "SELECT lifecycle_action_id FROM review_lifecycle_actions WHERE review_id=?1 AND operation_type='review_permanent_delete' AND terminal_result IS NULL",
            [&review_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("pending_permanent_action_readback_failed: {error}"))?;
    let Some(action_id) = action_id else {
        return Ok(None);
    };
    let action = read_action(&connection, &action_id)?
        .ok_or_else(|| "pending_permanent_action_readback_missing".to_string())?;
    let targets = read_targets(&connection, &action_id)?;
    Ok(Some(PermanentDeleteActionReadback { action, targets }))
}
#[tauri::command]
pub(crate) fn record_review_permanent_delete_planning_commit(
    app_handle: AppHandle,
    input: RecordPermanentPlanningCommitInput,
) -> Result<PermanentDeleteActionRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    record_planning_commit_in_connection(&mut connection, &input)
}
#[tauri::command]
pub(crate) fn finalize_review_permanent_delete_metadata(
    app_handle: AppHandle,
    input: FinalizePermanentDeleteInput,
) -> Result<PermanentDeleteFinalizationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    finalize_in_connection(&mut connection, &input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    const SEED_SQL: &str = "INSERT INTO file_refs(id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,file_type,path,path_identity_key,title,created_at,updated_at,deleted_at) VALUES
          ('file-1','review','review-1','primary','file','manuscript','external','markdown','N:/external/review.md','n:/external/review.md','Review file','t','t',NULL),
          ('file-2','review','review-1','dedicated_notes','file','attachment','external','other','N:/external/attachment.bin','n:/external/attachment.bin','Attachment','t','t',NULL),
          ('file-other','review','review-other','primary','file','manuscript','external','markdown','N:/external/other.md','n:/external/other.md','Other Review','t','t',NULL);
          INSERT INTO manuscript_bindings(id,owner_type,owner_id,manuscript_channel,schema_version,created_at,updated_at) VALUES
          ('binding-1','review','review-1','primary',2,'t','t'),
          ('binding-2','review','review-1','dedicated_notes',2,'t','t'),
          ('binding-other','review','review-other','primary',2,'t','t');
          INSERT INTO recycle_entries(id,entity_type,entity_id,title,module,entity_deleted_at,deleted_by,can_restore,restore_status,refresh_keys,schema_version,created_at,updated_at,created_by_lifecycle_action_id,revision) VALUES
          ('entry-1','review','review-1','Review','review','review-deleted','user',1,'not_started','[]',1,'t','t','delete-action',0),
          ('entry-sibling','review','review-other','Other','review','deleted-at','user',1,'not_started','[]',1,'t','t','delete-other',0);";

    fn initialized() -> Connection {
        let connection = Connection::open_in_memory().expect("open task-owned database");
        schema::run_migrations(&connection).expect("initialize v51");
        connection
    }

    fn seeded() -> Connection {
        let connection = initialized();
        connection
            .execute_batch(SEED_SQL)
            .expect("seed exact durable authorities");
        connection
    }

    fn input(connection: &Connection) -> PreparePermanentDeleteInput {
        let inventory = read_inventory(connection, "review-1").expect("inventory");
        let plan = ConfirmedImpactPlan {
            impact_plan_version: 1,
            lifecycle_action_id: "permanent-action".into(),
            review_id: "review-1".into(),
            project_id: "project-1".into(),
            exact_recycle_entry_id: "entry-1".into(),
            source_delete_action_id: "delete-action".into(),
            expected_recycle_entry_revision: 0,
            expected_planning_epoch: "epoch-1".into(),
            expected_planning_revision: "7".into(),
            expected_review_updated_at: "review-updated".into(),
            expected_review_deleted_at: "review-deleted".into(),
            binding_targets: inventory
                .bindings
                .iter()
                .map(|record| PermanentDeleteTarget {
                    target_id: record.id.clone(),
                    expected_revision: record.revision.to_string(),
                    owner_type: Some("review".into()),
                    owner_id: Some("review-1".into()),
                    manuscript_channel: Some(record.manuscript_channel.clone()),
                    disposition: "DELETE".into(),
                    reason: "binding metadata".into(),
                })
                .collect(),
            file_ref_targets: inventory
                .file_refs
                .iter()
                .map(|record| PermanentDeleteTarget {
                    target_id: record.id.clone(),
                    expected_revision: record.revision.to_string(),
                    owner_type: Some("review".into()),
                    owner_id: Some("review-1".into()),
                    manuscript_channel: Some(record.manuscript_channel.clone()),
                    disposition: "PERMANENTLY_TERMINALIZE".into(),
                    reason: "metadata only; preserve physical file".into(),
                })
                .collect(),
            entity_link_targets: vec![],
            change_log_targets: vec![],
            physical_files_preserved: true,
        };
        let value = serde_json::to_value(plan).expect("plan value");
        let json = canonicalize(&value).expect("canonical plan");
        let impact_digest = digest(&json);
        let prefix = "review-lifecycle:permanent-action";
        PreparePermanentDeleteInput {
            lifecycle_action_id: "permanent-action".into(),
            review_id: "review-1".into(),
            project_id: "project-1".into(),
            expected_review_updated_at: "review-updated".into(),
            expected_review_deleted_at: "review-deleted".into(),
            expected_planning_epoch: "epoch-1".into(),
            expected_planning_revision: "7".into(),
            planned_committed_planning_revision: "8".into(),
            source_delete_action_id: "delete-action".into(),
            exact_recycle_entry_id: "entry-1".into(),
            expected_recycle_entry_revision: 0,
            impact_plan_version: 1,
            impact_digest,
            impact_plan_json: json,
            confirmed_at: "2026-08-07T01:00:00Z".into(),
            planning_effect_id: format!("{prefix}:planning"),
            operation_log_effect_id: format!("{prefix}:operation-log"),
            binding_cleanup_effect_id: format!("{prefix}:binding-cleanup"),
            file_ref_cleanup_effect_id: format!("{prefix}:file-ref-terminalize"),
            recycle_terminal_effect_id: format!("{prefix}:recycle-terminal:entry-1"),
        }
    }

    fn planning_committed(connection: &mut Connection) -> PermanentDeleteActionRecord {
        let prepared = prepare_in_connection(connection, &input(connection)).expect("prepare");
        record_planning_commit_in_connection(
            connection,
            &RecordPermanentPlanningCommitInput {
                lifecycle_action_id: prepared.lifecycle_action_id,
                expected_revision: prepared.revision,
                impact_digest: prepared.impact_digest,
                committed_planning_epoch: "epoch-1".into(),
                committed_planning_revision: "8".into(),
            },
        )
        .expect("record Planning commit")
    }

    fn finalization_input(action: &PermanentDeleteActionRecord) -> FinalizePermanentDeleteInput {
        FinalizePermanentDeleteInput {
            lifecycle_action_id: action.lifecycle_action_id.clone(),
            expected_revision: action.revision,
            impact_digest: action.impact_digest.clone(),
            terminal_at: "2026-08-07T02:00:00Z".into(),
        }
    }
    #[test]
    fn target_dispositions_are_exact() {
        let base = PermanentDeleteTarget {
            target_id: "x".into(),
            expected_revision: "0".into(),
            owner_type: Some("review".into()),
            owner_id: Some("r".into()),
            manuscript_channel: Some("primary".into()),
            disposition: "DELETE".into(),
            reason: "owner metadata".into(),
        };
        assert!(validate_target(&base, "binding", "r").is_ok());
        let mut file = base.clone();
        file.disposition = "PERMANENTLY_TERMINALIZE".into();
        assert!(validate_target(&file, "file_ref", "r").is_ok());
        file.owner_id = Some("other-review".into());
        assert!(validate_target(&file, "file_ref", "r").is_err());
        assert!(validate_target(&base, "change_log", "r").is_err());
        let mut change_log = base;
        change_log.owner_type = None;
        change_log.owner_id = None;
        change_log.manuscript_channel = None;
        assert!(validate_target(&change_log, "change_log", "r").is_ok());
    }

    #[test]
    fn v51_target_contract_remediates_the_b1_change_log_disposition_without_version_bump() {
        let connection = initialized();
        let version_before: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        connection.execute_batch(
            "ALTER TABLE review_lifecycle_action_targets RENAME TO review_lifecycle_action_targets_current;
             CREATE TABLE review_lifecycle_action_targets (
               lifecycle_action_id TEXT NOT NULL,
               target_kind TEXT NOT NULL CHECK (target_kind IN ('binding','file_ref','entity_link','change_log')),
               target_id TEXT NOT NULL,
               expected_revision TEXT NOT NULL,
               owner_type TEXT,
               owner_id TEXT,
               manuscript_channel TEXT,
               disposition TEXT NOT NULL CHECK (disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY','PERMANENTLY_TERMINALIZE')),
               reason TEXT NOT NULL,
               PRIMARY KEY(lifecycle_action_id,target_kind,target_id),
               FOREIGN KEY(lifecycle_action_id) REFERENCES review_lifecycle_actions(lifecycle_action_id) ON DELETE CASCADE,
               CHECK (
                 (target_kind='binding' AND disposition='DELETE' AND owner_type='review' AND owner_id IS NOT NULL AND manuscript_channel IS NOT NULL)
                 OR (target_kind='file_ref' AND disposition='PERMANENTLY_TERMINALIZE' AND owner_type='review' AND owner_id IS NOT NULL AND manuscript_channel IS NOT NULL)
                 OR (target_kind='entity_link' AND disposition='DELETE' AND owner_type IS NULL AND owner_id IS NULL AND manuscript_channel IS NULL)
                 OR (target_kind='change_log' AND disposition IN ('SANITIZE','KEEP_AUDIT_ONLY') AND owner_type IS NULL AND owner_id IS NULL AND manuscript_channel IS NULL)
               )
             );
             DROP TABLE review_lifecycle_action_targets_current;
             CREATE INDEX idx_review_lifecycle_action_targets_action_kind ON review_lifecycle_action_targets(lifecycle_action_id,target_kind,target_id);",
        ).expect("recreate exact B1 target contract");
        assert!(!schema_is_current(&connection).expect("B1 target contract is not B2 current"));
        apply_schema_migration(&connection).expect("remediate within v51");
        assert!(schema_is_current(&connection).expect("B2 v51 target contract current"));
        let target_sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='review_lifecycle_action_targets'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert!(target_sql.contains("disposition IN ('DELETE','SANITIZE','KEEP_AUDIT_ONLY')"));
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, version_before);
    }

    #[test]
    fn v51_schema_and_confirmed_plan_prepare_are_exact_and_reusable() {
        let mut connection = seeded();
        assert!(schema_is_current(&connection).expect("schema"));
        let input = input(&connection);
        let first = prepare_in_connection(&mut connection, &input).expect("prepare confirmed plan");
        let second = prepare_in_connection(&mut connection, &input).expect("exact retry");
        assert_eq!(first.lifecycle_action_id, second.lifecycle_action_id);
        assert_eq!(first.current_stage, "prepared");
        let target_count:i64=connection.query_row("SELECT COUNT(*) FROM review_lifecycle_action_targets WHERE lifecycle_action_id='permanent-action'",[],|row|row.get(0)).unwrap();
        assert_eq!(target_count, 4);
        let inventory = read_inventory(&connection, "review-1").expect("read owner inventory");
        assert_eq!(inventory.bindings.len(), 2);
        assert_eq!(inventory.file_refs.len(), 2);
        assert!(inventory
            .file_refs
            .iter()
            .all(|record| record.owner_id == "review-1"));
        assert!(inventory
            .file_refs
            .iter()
            .any(|record| record.manuscript_channel == "dedicated_notes"));
        let committed = record_planning_commit_in_connection(
            &mut connection,
            &RecordPermanentPlanningCommitInput {
                lifecycle_action_id: first.lifecycle_action_id,
                expected_revision: first.revision,
                impact_digest: first.impact_digest,
                committed_planning_epoch: "epoch-1".into(),
                committed_planning_revision: "8".into(),
            },
        )
        .expect("record exact Planning CAS");
        assert_eq!(committed.current_stage, "planning_committed");
        assert_eq!(committed.revision, 1);
        let transaction = connection
            .transaction()
            .expect("begin future finalization transaction");
        let effect = insert_or_readback_operation_log_in_transaction(
            &transaction,
            "permanent-action",
            "2026-08-07T02:00:00Z",
        )
        .expect("insert deterministic operation log");
        let repeated = insert_or_readback_operation_log_in_transaction(
            &transaction,
            "permanent-action",
            "2026-08-07T02:00:00Z",
        )
        .expect("read exact deterministic operation log");
        assert_eq!(effect, repeated);
        transaction
            .execute(
                "UPDATE operation_logs SET target='tampered' WHERE id=?1",
                [&effect],
            )
            .expect("tamper task-owned effect fixture");
        assert!(insert_or_readback_operation_log_in_transaction(
            &transaction,
            "permanent-action",
            "2026-08-07T02:00:00Z",
        )
        .is_err());
        transaction
            .rollback()
            .expect("B1 test must not retain finalization effect");
    }

    #[test]
    fn prepare_rejects_digest_inventory_and_recycle_revision_drift_before_action_insert() {
        for drift in ["digest", "inventory", "recycle"] {
            let mut connection = seeded();
            let mut request = input(&connection);
            match drift {
                "digest" => request.impact_digest = "0".repeat(64),
                "inventory" => {
                    connection
                        .execute("UPDATE file_refs SET title='changed' WHERE id='file-1'", [])
                        .unwrap();
                }
                "recycle" => request.expected_recycle_entry_revision = 1,
                _ => unreachable!(),
            };
            assert!(prepare_in_connection(&mut connection, &request).is_err());
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM review_lifecycle_actions", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{drift} must be pre-mutation");
        }
    }

    #[test]
    fn permanent_terminal_metadata_fails_closed_for_restore_and_identity_reuse() {
        let connection = seeded();
        connection.execute("UPDATE file_refs SET deleted_at='terminal',permanent_delete_status='permanently_deleted',permanent_delete_lifecycle_action_id='permanent-action',permanently_deleted_at='terminal' WHERE id='file-1'",[]).expect("terminalize task-owned metadata");
        assert!(connection
            .execute("UPDATE file_refs SET deleted_at=NULL WHERE id='file-1'", [])
            .unwrap_err()
            .to_string()
            .contains("FILE_REF_PERMANENT"));
        assert!(connection
            .execute("DELETE FROM file_refs WHERE id='file-1'", [])
            .unwrap_err()
            .to_string()
            .contains("FILE_REF_PERMANENT"));
        assert!(connection.execute("INSERT INTO file_refs(id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,file_type,path,path_identity_key,title,created_at,updated_at) VALUES('file-reuse','review','review-1','primary','file','manuscript','external','markdown','N:/external/review.md','n:/external/review.md','Reuse','t','t')",[]).unwrap_err().to_string().contains("FILE_REF_PERMANENT_IDENTITY_REUSE_FORBIDDEN"));
        assert!(connection
            .execute(
                "UPDATE manuscript_bindings SET current_file_ref_id='file-1' WHERE id='binding-1'",
                []
            )
            .unwrap_err()
            .to_string()
            .contains("MANUSCRIPT_BINDING_FILE_REF_PERMANENTLY_TERMINAL"));
        connection.execute("UPDATE recycle_entries SET can_restore=0,restore_status='permanently_deleted',terminal_lifecycle_action_id='permanent-action',terminal_at='terminal' WHERE id='entry-1'",[]).expect("terminalize recycle metadata");
        assert!(connection.execute("UPDATE recycle_entries SET can_restore=1,restore_status='not_started' WHERE id='entry-1'",[]).unwrap_err().to_string().contains("RECYCLE_ENTRY_PERMANENT"));
        assert!(connection
            .execute("DELETE FROM recycle_entries WHERE id='entry-1'", [])
            .unwrap_err()
            .to_string()
            .contains("RECYCLE_ENTRY_PERMANENT"));
        let sibling: (i64, String, Option<String>) = connection.query_row(
            "SELECT can_restore,restore_status,terminal_lifecycle_action_id FROM recycle_entries WHERE id='entry-sibling'",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).expect("read sibling recycle entry");
        assert_eq!(sibling, (1, "not_started".into(), None));
    }

    #[test]
    fn sqlite_finalization_is_one_transaction_exact_and_completed_replay_is_read_only() {
        let mut connection = seeded();
        let action = planning_committed(&mut connection);
        let request = finalization_input(&action);
        let completed = finalize_in_connection(&mut connection, &request).expect("finalize");
        assert!(!completed.prior_success);
        assert_eq!(
            completed.deleted_binding_ids,
            vec!["binding-1", "binding-2"]
        );
        assert_eq!(completed.terminal_file_ref_ids, vec!["file-1", "file-2"]);
        assert_eq!(completed.action.current_stage, "completed");
        assert_eq!(
            completed.action.terminal_result.as_deref(),
            Some("completed")
        );
        assert_eq!(completed.action.revision, action.revision + 1);

        let other_binding: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_bindings WHERE id='binding-other' AND owner_id='review-other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let other_file: (i64, Option<String>) = connection
            .query_row(
                "SELECT revision,permanent_delete_status FROM file_refs WHERE id='file-other'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let sibling: (i64, String, i64) = connection
            .query_row(
                "SELECT can_restore,restore_status,revision FROM recycle_entries WHERE id='entry-sibling'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(other_binding, 1);
        assert_eq!(other_file, (0, None));
        assert_eq!(sibling, (1, "not_started".into(), 0));

        let before_replay = (
            completed.action.revision,
            connection
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='permanent-action'",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
        );
        let replay = finalize_in_connection(&mut connection, &request).expect("completed replay");
        assert!(replay.prior_success);
        assert_eq!(replay.action.revision, before_replay.0);
        let log_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='permanent-action'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(log_count, before_replay.1);
    }

    #[test]
    fn every_sqlite_failure_seam_rolls_back_and_same_action_retry_converges_once() {
        for seam in [
            FinalizationFailureSeam::BindingDelete,
            FinalizationFailureSeam::FileRefTerminalization,
            FinalizationFailureSeam::OperationLogInsert,
            FinalizationFailureSeam::RecycleTerminal,
            FinalizationFailureSeam::ActionCompletion,
        ] {
            let mut connection = seeded();
            let action = planning_committed(&mut connection);
            let request = finalization_input(&action);
            assert!(
                finalize_in_connection_with_failure(&mut connection, &request, Some(seam)).is_err()
            );
            let rollback: (i64, i64, i64, i64, String, i64) = connection
                .query_row(
                    "SELECT
                      (SELECT COUNT(*) FROM manuscript_bindings WHERE owner_type='review' AND owner_id='review-1'),
                      (SELECT COUNT(*) FROM file_refs WHERE owner_type='review' AND owner_id='review-1' AND permanent_delete_status IS NULL),
                      (SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='permanent-action'),
                      (SELECT can_restore FROM recycle_entries WHERE id='entry-1'),
                      (SELECT current_stage FROM review_lifecycle_actions WHERE lifecycle_action_id='permanent-action'),
                      (SELECT revision FROM review_lifecycle_actions WHERE lifecycle_action_id='permanent-action')",
                    [],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
                )
                .unwrap();
            assert_eq!(
                rollback,
                (2, 2, 0, 1, "planning_committed".into(), 1),
                "{seam:?}"
            );
            let completed =
                finalize_in_connection(&mut connection, &request).expect("explicit retry");
            assert_eq!(completed.action.current_stage, "completed", "{seam:?}");
            let exactly_once: (i64, i64, i64, i64) = connection
                .query_row(
                    "SELECT
                      (SELECT COUNT(*) FROM manuscript_bindings WHERE owner_type='review' AND owner_id='review-1'),
                      (SELECT COUNT(*) FROM file_refs WHERE owner_type='review' AND owner_id='review-1' AND permanent_delete_status='permanently_deleted'),
                      (SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='permanent-action'),
                      (SELECT COUNT(*) FROM recycle_entries WHERE id='entry-1' AND restore_status='permanently_deleted')",
                    [],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
                )
                .unwrap();
            assert_eq!(exactly_once, (0, 2, 1, 1), "{seam:?}");
        }
    }

    #[test]
    fn metadata_revision_or_unexpected_binding_drift_is_zero_write() {
        for drift in ["revision", "unexpected_binding"] {
            let mut connection = seeded();
            let action = planning_committed(&mut connection);
            let request = finalization_input(&action);
            if drift == "revision" {
                connection
                    .execute("UPDATE file_refs SET title='drift' WHERE id='file-1'", [])
                    .unwrap();
            } else {
                connection.execute("INSERT INTO manuscript_bindings(id,owner_type,owner_id,manuscript_channel,current_file_ref_id,schema_version,created_at,updated_at) VALUES('binding-unexpected','experiment','experiment-1','primary','file-1',2,'t','t')",[]).unwrap();
            }
            let before = connection.total_changes();
            let error = finalize_in_connection(&mut connection, &request).unwrap_err();
            assert!(error.contains("metadata_plan_conflict"), "{drift}: {error}");
            assert_eq!(
                connection.total_changes(),
                before,
                "{drift} must be zero-write"
            );
            let state: (i64, i64, String) = connection
                .query_row(
                    "SELECT
                      (SELECT COUNT(*) FROM manuscript_bindings WHERE id IN ('binding-1','binding-2')),
                      (SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='permanent-action'),
                      (SELECT current_stage FROM review_lifecycle_actions WHERE lifecycle_action_id='permanent-action')",
                    [],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                )
                .unwrap();
            assert_eq!(state, (2, 0, "planning_committed".into()));
        }
    }

    #[test]
    fn drop_and_reopen_sqlite_resumes_same_action_without_duplicate_effects() {
        let path = std::env::temp_dir().join(format!(
            "labpod-review-permanent-delete-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let request = {
            let mut connection = Connection::open(&path).expect("open task-owned SQLite");
            schema::run_migrations(&connection).expect("initialize task-owned SQLite");
            connection
                .execute_batch(SEED_SQL)
                .expect("seed task-owned SQLite");
            let action = planning_committed(&mut connection);
            finalization_input(&action)
        };
        {
            let mut reopened = Connection::open(&path).expect("reopen task-owned SQLite");
            let completed =
                finalize_in_connection(&mut reopened, &request).expect("resume after reopen");
            assert_eq!(completed.action.current_stage, "completed");
        }
        {
            let mut reopened = Connection::open(&path).expect("reopen completed SQLite");
            let replay =
                finalize_in_connection(&mut reopened, &request).expect("response-loss replay");
            assert!(replay.prior_success);
            let counts: (i64, i64) = reopened
                .query_row(
                    "SELECT
                      (SELECT COUNT(*) FROM operation_logs WHERE lifecycle_action_id='permanent-action'),
                      (SELECT COUNT(*) FROM recycle_entries WHERE id='entry-1' AND restore_status='permanently_deleted')",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(counts, (1, 1));
        }
        std::fs::remove_file(&path).expect("remove task-owned temporary SQLite");
    }
}
