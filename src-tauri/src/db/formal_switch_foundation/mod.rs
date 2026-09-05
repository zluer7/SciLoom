pub(crate) mod encoding;
pub(crate) mod state;

use self::encoding::{
    decode_attempt_metadata, encode_attempt_metadata, encode_envelope, sha256,
    validate_normative_registry, verify_canonical_bytes, FormalSwitchAttemptMetadataV1,
    FormalSwitchEnvelopeProjection, FormalSwitchImmutableEnvelopeV1,
};
use self::state::{
    initial_state, unresolved_slot_predicate_sql, valid_state_sql, valid_transition_sql,
    validate_normative_matrix, validate_state, validate_transition, FormalSwitchOperationState,
};
use rusqlite::{params, Connection, OptionalExtension};

pub(crate) const FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION: i64 = 53;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OldRecoveryDrainSnapshot {
    pub(crate) experiment_unresolved: i64,
    pub(crate) experiment_prepared_or_unknown: i64,
    pub(crate) run_unresolved: i64,
    pub(crate) run_prepared_or_unknown: i64,
}

impl OldRecoveryDrainSnapshot {
    fn is_drained(&self) -> bool {
        self.experiment_unresolved == 0
            && self.experiment_prepared_or_unknown == 0
            && self.run_unresolved == 0
            && self.run_prepared_or_unknown == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SchemaMigrationAdmission {
    Closed,
    OpenVerifiedV53,
    Incomplete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TargetOwnerCutoverAdmission {
    ClosedNotReady,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FormalSwitchFoundationAvailability {
    Available,
    MigrationClosed,
    AuthorityIncomplete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchMigrationFoundationStatus {
    pub(crate) schema_migration_admission: SchemaMigrationAdmission,
    pub(crate) target_owner_cutover_admission: TargetOwnerCutoverAdmission,
    pub(crate) availability: FormalSwitchFoundationAvailability,
    pub(crate) schema_version: i64,
    pub(crate) old_recovery_family_count: usize,
    pub(crate) production_owner_caller_count: usize,
}

pub(crate) struct FormalSwitchMigrationAdmissionAuthority;

impl FormalSwitchMigrationAdmissionAuthority {
    pub(crate) fn read(connection: &Connection) -> FormalSwitchMigrationFoundationStatus {
        read_migration_foundation_status(connection)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchOperationRecord {
    pub(crate) operation_id: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) entry_kind: String,
    pub(crate) owner_subtype: String,
    pub(crate) payload_version: i64,
    pub(crate) canonical_encoding_version: String,
    pub(crate) engine_contract_version: i64,
    pub(crate) descriptor_identity: String,
    pub(crate) descriptor_version: i64,
    pub(crate) descriptor_hash: Vec<u8>,
    pub(crate) candidate_contract_version: i64,
    pub(crate) settlement_plan_version: i64,
    pub(crate) transaction_payload_version: i64,
    pub(crate) recovery_payload_version: i64,
    pub(crate) immutable_payload: Vec<u8>,
    pub(crate) payload_sha256: Vec<u8>,
    pub(crate) state: FormalSwitchOperationState,
    pub(crate) phase_revision: i64,
    pub(crate) last_error_code: Option<String>,
    pub(crate) last_diagnostic_summary: Option<String>,
    pub(crate) attempt_metadata: Option<Vec<u8>>,
    pub(crate) created_at_epoch_ms: i64,
    pub(crate) updated_at_epoch_ms: i64,
    pub(crate) resolved_at_epoch_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchOperationSummaryV1 {
    pub(crate) operation_id: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) entry_kind: String,
    pub(crate) owner_subtype: String,
    pub(crate) phase: String,
    pub(crate) phase_revision: i64,
    pub(crate) terminal_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutableFormalSwitchOperationV1 {
    pub(crate) record: FormalSwitchOperationRecord,
    pub(crate) envelope: FormalSwitchImmutableEnvelopeV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrepareImmutableOperationResult {
    Prepared(FormalSwitchOperationRecord),
    AlreadyPrepared(FormalSwitchOperationRecord),
    AlreadyExistsSameOperation(FormalSwitchOperationRecord),
    ConflictInconsistent,
    UnresolvedIdentityConflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PhaseCasFailure {
    NotFound,
    PhaseConflict,
    RevisionConflict,
    PayloadIntegrityConflict,
    TerminalConflict,
    InvalidTransition,
    Persistence(String),
}

fn table_exists(connection: &Connection, table: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
}

fn schema_object_exists(connection: &Connection, kind: &str, name: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type=?1 AND name=?2)",
        params![kind, name],
        |row| row.get(0),
    )
}

fn schema_object_sql(
    connection: &Connection,
    kind: &str,
    name: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
            params![kind, name],
            |row| row.get(0),
        )
        .optional()
}

fn normalized_sql(sql: &str) -> String {
    sql.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let sql = format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)");
    connection.query_row(&sql, [column], |row| row.get(0))
}

pub(crate) fn read_old_recovery_drain_snapshot(
    connection: &Connection,
) -> Result<OldRecoveryDrainSnapshot, String> {
    let experiment_unresolved = connection
        .query_row(
            "SELECT COUNT(*) FROM experiment_manuscript_switch_recoveries WHERE phase NOT IN ('resolved','cancelled_safe')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("FORMAL_SWITCH_DRAIN_EXPERIMENT_READ_FAILED:{error}"))?;
    let experiment_prepared_or_unknown = connection
        .query_row(
            "SELECT COUNT(*) FROM experiment_manuscript_switch_recoveries WHERE phase IN ('prepared','writeback_unknown','db_commit_unknown')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("FORMAL_SWITCH_DRAIN_EXPERIMENT_UNKNOWN_READ_FAILED:{error}"))?;
    let run_unresolved = connection
        .query_row(
            "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries WHERE phase NOT IN ('resolved','cancelled_safe')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("FORMAL_SWITCH_DRAIN_RUN_READ_FAILED:{error}"))?;
    let run_prepared_or_unknown = connection
        .query_row(
            "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries WHERE phase IN ('prepared','writeback_unknown','db_commit_unknown')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("FORMAL_SWITCH_DRAIN_RUN_UNKNOWN_READ_FAILED:{error}"))?;
    Ok(OldRecoveryDrainSnapshot {
        experiment_unresolved,
        experiment_prepared_or_unknown,
        run_unresolved,
        run_prepared_or_unknown,
    })
}

fn validate_migration_prechecks(connection: &Connection) -> Result<(), String> {
    let invalid_new_success_null: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE operation_type='formal_switch' AND status='success'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("FORMAL_SWITCH_LOG_PRECHECK_FAILED:{error}"))?;
    if invalid_new_success_null != 0 {
        return Err("FORMAL_SWITCH_OPERATION_LOG_PRECHECK_CONFLICT".into());
    }
    let cross_family_collision: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM experiment_manuscript_switch_recoveries e JOIN experiment_run_manuscript_switch_recoveries r ON r.operation_id=e.operation_id WHERE e.phase NOT IN ('resolved','cancelled_safe') OR r.phase NOT IN ('resolved','cancelled_safe')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("FORMAL_SWITCH_OPERATION_ID_PRECHECK_FAILED:{error}"))?;
    if cross_family_collision != 0 {
        return Err("FORMAL_SWITCH_OPERATION_ID_COLLISION".into());
    }
    Ok(())
}

fn table_schema_sql() -> Result<String, String> {
    let valid_state = valid_state_sql("")?;
    let unresolved = unresolved_slot_predicate_sql()?;
    let valid_transition = valid_transition_sql()?;
    Ok(format!(
        r#"
CREATE TABLE formal_switch_operations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('experiment','experimentRun','literature','review','resultItem','finding','outputCandidate','outputGap','researchOutput')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  manuscript_channel TEXT NOT NULL CHECK (manuscript_channel IN ('primary','literature_outline','dedicated_notes')),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('USER_CONFIRMED_SWITCH','REPAIR_CONFIRMED_SWITCH')),
  owner_subtype TEXT NOT NULL DEFAULT '',
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  canonical_encoding_version TEXT NOT NULL CHECK (canonical_encoding_version = 'CanonicalEnvelopeEncodingV1'),
  engine_contract_version INTEGER NOT NULL CHECK (engine_contract_version = 1),
  descriptor_identity TEXT NOT NULL CHECK (length(descriptor_identity) > 0),
  descriptor_version INTEGER NOT NULL CHECK (descriptor_version >= 1),
  descriptor_hash BLOB NOT NULL CHECK (length(descriptor_hash) = 32),
  candidate_contract_version INTEGER NOT NULL CHECK (candidate_contract_version = 1),
  settlement_plan_version INTEGER NOT NULL CHECK (settlement_plan_version = 1),
  transaction_payload_version INTEGER NOT NULL CHECK (transaction_payload_version = 1),
  recovery_payload_version INTEGER NOT NULL CHECK (recovery_payload_version = 1),
  immutable_payload BLOB NOT NULL,
  payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
  phase TEXT NOT NULL,
  phase_revision INTEGER NOT NULL DEFAULT 0 CHECK (phase_revision >= 0),
  settlement_outcome TEXT NOT NULL CHECK (settlement_outcome IN ('NOT_REQUIRED','APPLIED','ALREADY_APPLIED','UNKNOWN')),
  db_outcome TEXT NOT NULL CHECK (db_outcome IN ('NOT_APPLIED','COMMITTED','ALREADY_COMMITTED','UNKNOWN')),
  activation_outcome TEXT NOT NULL CHECK (activation_outcome IN ('PENDING','APPLIED','ALREADY_ACTIVE','UNKNOWN')),
  terminal_code TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 128),
  last_diagnostic_summary TEXT CHECK (last_diagnostic_summary IS NULL OR length(last_diagnostic_summary) <= 1024),
  attempt_metadata BLOB CHECK (attempt_metadata IS NULL OR length(attempt_metadata) <= 512),
  created_at_epoch_ms INTEGER NOT NULL,
  updated_at_epoch_ms INTEGER NOT NULL,
  resolved_at_epoch_ms INTEGER,
  CHECK (updated_at_epoch_ms >= created_at_epoch_ms),
  CHECK (resolved_at_epoch_ms IS NULL OR resolved_at_epoch_ms >= created_at_epoch_ms),
  CHECK (
    (phase IN ('resolved','cancelled_safe') AND resolved_at_epoch_ms IS NOT NULL) OR
    (phase NOT IN ('resolved','cancelled_safe') AND resolved_at_epoch_ms IS NULL)
  ),
  CHECK (
    (owner_type='literature' AND manuscript_channel IN ('literature_outline','dedicated_notes') AND owner_subtype='') OR
    (owner_type='review' AND manuscript_channel='primary' AND owner_subtype IN ('stage','periodic','experiment_comparison','literature_comparison','custom')) OR
    (owner_type NOT IN ('literature','review') AND manuscript_channel='primary' AND owner_subtype='')
  ),
  CHECK ({valid_state})
);
CREATE UNIQUE INDEX uq_formal_switch_operations_unresolved_identity
  ON formal_switch_operations(owner_type,owner_id,manuscript_channel,entry_kind,owner_subtype)
  WHERE {unresolved};
CREATE INDEX idx_formal_switch_operations_owner_channel
  ON formal_switch_operations(owner_type,owner_id,manuscript_channel,phase);
CREATE INDEX idx_formal_switch_operations_phase
  ON formal_switch_operations(phase,phase_revision);
CREATE TRIGGER trg_formal_switch_operations_immutable_update
BEFORE UPDATE OF operation_id,owner_type,owner_id,manuscript_channel,entry_kind,owner_subtype,
  payload_version,canonical_encoding_version,engine_contract_version,descriptor_identity,
  descriptor_version,descriptor_hash,candidate_contract_version,settlement_plan_version,
  transaction_payload_version,recovery_payload_version,immutable_payload,payload_sha256,created_at_epoch_ms
ON formal_switch_operations
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_IMMUTABLE_PAYLOAD'); END;
CREATE TRIGGER trg_formal_switch_operations_duplicate_insert
BEFORE INSERT ON formal_switch_operations
WHEN EXISTS(SELECT 1 FROM formal_switch_operations WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_OPERATION_REPLACEMENT_FORBIDDEN'); END;
CREATE TRIGGER trg_formal_switch_operations_delete
BEFORE DELETE ON formal_switch_operations
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_OPERATION_DELETE_FORBIDDEN'); END;
CREATE TRIGGER trg_formal_switch_operations_state_transition
BEFORE UPDATE OF phase,phase_revision,settlement_outcome,db_outcome,activation_outcome,terminal_code,
  last_error_code,last_diagnostic_summary,attempt_metadata,updated_at_epoch_ms,resolved_at_epoch_ms
ON formal_switch_operations
WHEN NEW.phase_revision <> OLD.phase_revision + 1 OR NOT ({valid_transition})
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_INVALID_TRANSITION'); END;
ALTER TABLE operation_logs ADD COLUMN formal_switch_operation_id TEXT;
CREATE UNIQUE INDEX uq_operation_logs_formal_switch_success_operation_id
  ON operation_logs(formal_switch_operation_id)
  WHERE operation_type='formal_switch' AND status='success' AND formal_switch_operation_id IS NOT NULL;
CREATE TRIGGER trg_operation_logs_formal_switch_success_identity_insert
BEFORE INSERT ON operation_logs
WHEN NEW.operation_type='formal_switch' AND NEW.status='success' AND NEW.formal_switch_operation_id IS NULL
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_SUCCESS_OPERATION_ID_REQUIRED'); END;
CREATE TRIGGER trg_operation_logs_formal_switch_success_identity_update
BEFORE UPDATE OF operation_type,status,formal_switch_operation_id ON operation_logs
WHEN (NEW.operation_type='formal_switch' AND NEW.status='success' AND NEW.formal_switch_operation_id IS NULL)
  OR (OLD.operation_type='formal_switch' AND OLD.status='success' AND OLD.formal_switch_operation_id IS NOT NULL AND (
       NEW.formal_switch_operation_id IS NOT OLD.formal_switch_operation_id OR
       NEW.operation_type IS NOT OLD.operation_type OR NEW.status IS NOT OLD.status))
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_SUCCESS_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER trg_operation_logs_formal_switch_success_identity_delete
BEFORE DELETE ON operation_logs
WHEN OLD.operation_type='formal_switch' AND OLD.status='success' AND OLD.formal_switch_operation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'FORMAL_SWITCH_SUCCESS_DELETE_FORBIDDEN'); END;
INSERT INTO schema_migrations(version,name)
VALUES (53,'formal_switch_shared_durable_persistence_foundation');
"#
    ))
}

pub(crate) fn apply_schema_migration(connection: &Connection) -> Result<(), String> {
    validate_normative_registry()?;
    validate_normative_matrix()?;
    if table_exists(connection, "formal_switch_operations").map_err(|error| error.to_string())? {
        return Err("FORMAL_SWITCH_SECOND_GENERIC_TABLE_OR_PARTIAL_SCHEMA".into());
    }
    if column_exists(connection, "operation_logs", "formal_switch_operation_id")
        .map_err(|error| error.to_string())?
    {
        return Err("FORMAL_SWITCH_OPERATION_LOG_PARTIAL_SCHEMA".into());
    }
    let first = read_old_recovery_drain_snapshot(connection)?;
    if !first.is_drained() {
        return Err("FORMAL_SWITCH_MIGRATION_DRAIN_INCOMPLETE".into());
    }
    validate_migration_prechecks(connection)?;
    let second = read_old_recovery_drain_snapshot(connection)?;
    if !second.is_drained() || second != first {
        return Err("FORMAL_SWITCH_MIGRATION_SECOND_READBACK_FAILED".into());
    }
    connection
        .execute_batch(&table_schema_sql()?)
        .map_err(|error| format!("FORMAL_SWITCH_V53_MIGRATION_FAILED:{error}"))?;
    if !schema_is_current(connection)? {
        return Err("FORMAL_SWITCH_V53_POST_MIGRATION_READBACK_FAILED".into());
    }
    Ok(())
}

pub(crate) fn schema_is_current(connection: &Connection) -> Result<bool, String> {
    validate_normative_registry()?;
    validate_normative_matrix()?;
    if !table_exists(connection, "formal_switch_operations").map_err(|error| error.to_string())?
        || !column_exists(connection, "operation_logs", "formal_switch_operation_id")
            .map_err(|error| error.to_string())?
    {
        return Ok(false);
    }
    for (kind, name) in [
        ("index", "uq_formal_switch_operations_unresolved_identity"),
        ("index", "idx_formal_switch_operations_owner_channel"),
        ("index", "idx_formal_switch_operations_phase"),
        (
            "index",
            "uq_operation_logs_formal_switch_success_operation_id",
        ),
        ("trigger", "trg_formal_switch_operations_immutable_update"),
        ("trigger", "trg_formal_switch_operations_duplicate_insert"),
        ("trigger", "trg_formal_switch_operations_delete"),
        ("trigger", "trg_formal_switch_operations_state_transition"),
        (
            "trigger",
            "trg_operation_logs_formal_switch_success_identity_insert",
        ),
        (
            "trigger",
            "trg_operation_logs_formal_switch_success_identity_update",
        ),
        (
            "trigger",
            "trg_operation_logs_formal_switch_success_identity_delete",
        ),
    ] {
        if !schema_object_exists(connection, kind, name).map_err(|error| error.to_string())? {
            return Ok(false);
        }
    }
    let mut columns = connection
        .prepare("PRAGMA table_info(formal_switch_operations)")
        .map_err(|error| error.to_string())?;
    let actual_columns = columns
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let expected_columns = [
        ("operation_id", "TEXT", 0, 1),
        ("owner_type", "TEXT", 1, 0),
        ("owner_id", "TEXT", 1, 0),
        ("manuscript_channel", "TEXT", 1, 0),
        ("entry_kind", "TEXT", 1, 0),
        ("owner_subtype", "TEXT", 1, 0),
        ("payload_version", "INTEGER", 1, 0),
        ("canonical_encoding_version", "TEXT", 1, 0),
        ("engine_contract_version", "INTEGER", 1, 0),
        ("descriptor_identity", "TEXT", 1, 0),
        ("descriptor_version", "INTEGER", 1, 0),
        ("descriptor_hash", "BLOB", 1, 0),
        ("candidate_contract_version", "INTEGER", 1, 0),
        ("settlement_plan_version", "INTEGER", 1, 0),
        ("transaction_payload_version", "INTEGER", 1, 0),
        ("recovery_payload_version", "INTEGER", 1, 0),
        ("immutable_payload", "BLOB", 1, 0),
        ("payload_sha256", "BLOB", 1, 0),
        ("phase", "TEXT", 1, 0),
        ("phase_revision", "INTEGER", 1, 0),
        ("settlement_outcome", "TEXT", 1, 0),
        ("db_outcome", "TEXT", 1, 0),
        ("activation_outcome", "TEXT", 1, 0),
        ("terminal_code", "TEXT", 0, 0),
        ("last_error_code", "TEXT", 0, 0),
        ("last_diagnostic_summary", "TEXT", 0, 0),
        ("attempt_metadata", "BLOB", 0, 0),
        ("created_at_epoch_ms", "INTEGER", 1, 0),
        ("updated_at_epoch_ms", "INTEGER", 1, 0),
        ("resolved_at_epoch_ms", "INTEGER", 0, 0),
    ];
    if actual_columns.len() != expected_columns.len()
        || actual_columns.iter().zip(expected_columns).any(
            |(
                (actual_name, actual_type, actual_not_null, actual_pk),
                (name, kind, not_null, pk),
            )| {
                actual_name != name
                    || !actual_type.eq_ignore_ascii_case(kind)
                    || *actual_not_null != not_null
                    || *actual_pk != pk
            },
        )
    {
        return Ok(false);
    }
    let operation_log_column: Option<(String, i64)> = connection
        .query_row(
            "SELECT type,\"notnull\" FROM pragma_table_info('operation_logs') WHERE name='formal_switch_operation_id'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if operation_log_column
        .as_ref()
        .is_none_or(|(kind, not_null)| !kind.eq_ignore_ascii_case("TEXT") || *not_null != 0)
    {
        return Ok(false);
    }
    let table_sql = normalized_sql(
        &schema_object_sql(connection, "table", "formal_switch_operations")
            .map_err(|error| error.to_string())?
            .ok_or("FORMAL_SWITCH_TABLE_SQL_MISSING")?,
    );
    for required in [
        "length(payload_sha256) = 32",
        "length(descriptor_hash) = 32",
        "phase_revision >= 0",
        "owner_type='review' and manuscript_channel='primary'",
        "phase in ('resolved','cancelled_safe') and resolved_at_epoch_ms is not null",
    ] {
        if !table_sql.contains(required) {
            return Ok(false);
        }
    }
    let unresolved_index = normalized_sql(
        &schema_object_sql(
            connection,
            "index",
            "uq_formal_switch_operations_unresolved_identity",
        )
        .map_err(|error| error.to_string())?
        .ok_or("FORMAL_SWITCH_UNRESOLVED_INDEX_SQL_MISSING")?,
    );
    if !unresolved_index.contains(
        "on formal_switch_operations(owner_type,owner_id,manuscript_channel,entry_kind,owner_subtype)",
    ) || !unresolved_index.contains(
        "terminal_code is null or terminal_code not in ('resolved','cancelled_safe')",
    ) {
        return Ok(false);
    }
    let success_index = normalized_sql(
        &schema_object_sql(
            connection,
            "index",
            "uq_operation_logs_formal_switch_success_operation_id",
        )
        .map_err(|error| error.to_string())?
        .ok_or("FORMAL_SWITCH_SUCCESS_INDEX_SQL_MISSING")?,
    );
    if !success_index.contains("on operation_logs(formal_switch_operation_id)")
        || !success_index.contains(
            "where operation_type='formal_switch' and status='success' and formal_switch_operation_id is not null",
        )
    {
        return Ok(false);
    }
    let immutable_trigger = normalized_sql(
        &schema_object_sql(
            connection,
            "trigger",
            "trg_formal_switch_operations_immutable_update",
        )
        .map_err(|error| error.to_string())?
        .ok_or("FORMAL_SWITCH_IMMUTABLE_TRIGGER_SQL_MISSING")?,
    );
    let delete_trigger = normalized_sql(
        &schema_object_sql(connection, "trigger", "trg_formal_switch_operations_delete")
            .map_err(|error| error.to_string())?
            .ok_or("FORMAL_SWITCH_DELETE_TRIGGER_SQL_MISSING")?,
    );
    let duplicate_insert_trigger = normalized_sql(
        &schema_object_sql(
            connection,
            "trigger",
            "trg_formal_switch_operations_duplicate_insert",
        )
        .map_err(|error| error.to_string())?
        .ok_or("FORMAL_SWITCH_DUPLICATE_INSERT_TRIGGER_SQL_MISSING")?,
    );
    let state_trigger = normalized_sql(
        &schema_object_sql(
            connection,
            "trigger",
            "trg_formal_switch_operations_state_transition",
        )
        .map_err(|error| error.to_string())?
        .ok_or("FORMAL_SWITCH_STATE_TRIGGER_SQL_MISSING")?,
    );
    if !immutable_trigger.contains("before update of operation_id")
        || !immutable_trigger.contains("immutable_payload,payload_sha256,created_at_epoch_ms")
        || !duplicate_insert_trigger.contains("before insert on formal_switch_operations")
        || !duplicate_insert_trigger.contains("where operation_id=new.operation_id")
        || !delete_trigger.contains("before delete on formal_switch_operations")
        || !state_trigger.contains("new.phase_revision <> old.phase_revision + 1")
    {
        return Ok(false);
    }
    connection
        .prepare(RECORD_SELECT)
        .map_err(|error| format!("FORMAL_SWITCH_REPOSITORY_CAPABILITY_UNAVAILABLE:{error}"))?;
    let migration_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version=53 AND name='formal_switch_shared_durable_persistence_foundation'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(migration_count == 1)
}

pub(crate) fn read_migration_foundation_status(
    connection: &Connection,
) -> FormalSwitchMigrationFoundationStatus {
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(-1);
    let current = schema_version >= FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION
        && schema_is_current(connection).unwrap_or(false);
    let clean_pre_migration = schema_version < FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION
        && !table_exists(connection, "formal_switch_operations").unwrap_or(true)
        && !column_exists(connection, "operation_logs", "formal_switch_operation_id")
            .unwrap_or(true);
    FormalSwitchMigrationFoundationStatus {
        schema_migration_admission: if current {
            SchemaMigrationAdmission::OpenVerifiedV53
        } else if clean_pre_migration {
            SchemaMigrationAdmission::Closed
        } else {
            SchemaMigrationAdmission::Incomplete
        },
        target_owner_cutover_admission: TargetOwnerCutoverAdmission::ClosedNotReady,
        availability: if current {
            FormalSwitchFoundationAvailability::Available
        } else if clean_pre_migration {
            FormalSwitchFoundationAvailability::MigrationClosed
        } else {
            FormalSwitchFoundationAvailability::AuthorityIncomplete
        },
        schema_version,
        old_recovery_family_count: 2,
        production_owner_caller_count: 0,
    }
}

const RECORD_SELECT: &str = "SELECT operation_id,owner_type,owner_id,manuscript_channel,entry_kind,owner_subtype,
 payload_version,canonical_encoding_version,engine_contract_version,descriptor_identity,descriptor_version,
 descriptor_hash,candidate_contract_version,settlement_plan_version,transaction_payload_version,recovery_payload_version,
 immutable_payload,payload_sha256,phase,phase_revision,settlement_outcome,db_outcome,activation_outcome,terminal_code,
 last_error_code,last_diagnostic_summary,attempt_metadata,created_at_epoch_ms,updated_at_epoch_ms,resolved_at_epoch_ms
 FROM formal_switch_operations WHERE operation_id=?1";

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<FormalSwitchOperationRecord> {
    Ok(FormalSwitchOperationRecord {
        operation_id: row.get(0)?,
        owner_type: row.get(1)?,
        owner_id: row.get(2)?,
        manuscript_channel: row.get(3)?,
        entry_kind: row.get(4)?,
        owner_subtype: row.get(5)?,
        payload_version: row.get(6)?,
        canonical_encoding_version: row.get(7)?,
        engine_contract_version: row.get(8)?,
        descriptor_identity: row.get(9)?,
        descriptor_version: row.get(10)?,
        descriptor_hash: row.get(11)?,
        candidate_contract_version: row.get(12)?,
        settlement_plan_version: row.get(13)?,
        transaction_payload_version: row.get(14)?,
        recovery_payload_version: row.get(15)?,
        immutable_payload: row.get(16)?,
        payload_sha256: row.get(17)?,
        state: FormalSwitchOperationState {
            phase: row.get(18)?,
            settlement_outcome: row.get(20)?,
            db_outcome: row.get(21)?,
            activation_outcome: row.get(22)?,
            terminal_code: row.get(23)?,
        },
        phase_revision: row.get(19)?,
        last_error_code: row.get(24)?,
        last_diagnostic_summary: row.get(25)?,
        attempt_metadata: row.get(26)?,
        created_at_epoch_ms: row.get(27)?,
        updated_at_epoch_ms: row.get(28)?,
        resolved_at_epoch_ms: row.get(29)?,
    })
}

pub(crate) fn read_operation(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<FormalSwitchOperationRecord>, String> {
    connection
        .query_row(RECORD_SELECT, [operation_id], map_record)
        .optional()
        .map_err(|error| format!("FORMAL_SWITCH_OPERATION_READ_FAILED:{error}"))
}

fn projection_matches(
    record: &FormalSwitchOperationRecord,
    projection: &FormalSwitchEnvelopeProjection,
) -> bool {
    record.operation_id == projection.operation_id
        && record.owner_type == projection.owner_type
        && record.owner_id == projection.owner_id
        && record.manuscript_channel == projection.manuscript_channel
        && record.entry_kind == projection.entry_kind
        && record.owner_subtype == projection.owner_subtype
        && record.payload_version == projection.payload_version
        && record.canonical_encoding_version == projection.canonical_encoding_version
        && record.engine_contract_version == projection.engine_contract_version
        && record.descriptor_identity == projection.descriptor_identity
        && record.descriptor_version == projection.descriptor_version
        && record.descriptor_hash == projection.descriptor_hash
        && record.candidate_contract_version == projection.candidate_contract_version
        && record.settlement_plan_version == projection.settlement_plan_version
        && record.transaction_payload_version == projection.transaction_payload_version
        && record.recovery_payload_version == projection.recovery_payload_version
        && record.created_at_epoch_ms == projection.created_at_epoch_ms
}

pub(crate) fn verify_payload_integrity(
    record: &FormalSwitchOperationRecord,
) -> Result<FormalSwitchImmutableEnvelopeV1, String> {
    let actual = sha256(&record.immutable_payload);
    if record.payload_sha256.as_slice() != actual {
        return Err("PAYLOAD_INTEGRITY_CONFLICT".into());
    }
    let envelope = verify_canonical_bytes(&record.immutable_payload)?;
    if !projection_matches(record, &envelope.projection()?) {
        return Err("MATERIALIZED_ENVELOPE_IDENTITY_MISMATCH".into());
    }
    validate_state(&record.state)?;
    if let Some(metadata) = &record.attempt_metadata {
        decode_attempt_metadata(metadata)?;
    }
    Ok(envelope)
}

pub(crate) fn prepare_immutable_operation(
    connection: &Connection,
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<PrepareImmutableOperationResult, String> {
    validate_normative_registry()?;
    let canonical = encode_envelope(envelope)?;
    let decoded = verify_canonical_bytes(&canonical)?;
    let projection = decoded.projection()?;
    let hash = sha256(&canonical);
    let state = initial_state()?;
    let inserted = connection.execute(
        "INSERT INTO formal_switch_operations(
          operation_id,owner_type,owner_id,manuscript_channel,entry_kind,owner_subtype,
          payload_version,canonical_encoding_version,engine_contract_version,descriptor_identity,
          descriptor_version,descriptor_hash,candidate_contract_version,settlement_plan_version,
          transaction_payload_version,recovery_payload_version,immutable_payload,payload_sha256,
          phase,phase_revision,settlement_outcome,db_outcome,activation_outcome,terminal_code,
          last_error_code,last_diagnostic_summary,attempt_metadata,created_at_epoch_ms,updated_at_epoch_ms,resolved_at_epoch_ms
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,0,?20,?21,?22,NULL,NULL,NULL,NULL,?23,?23,NULL)",
        params![
            projection.operation_id, projection.owner_type, projection.owner_id,
            projection.manuscript_channel, projection.entry_kind, projection.owner_subtype,
            projection.payload_version, projection.canonical_encoding_version,
            projection.engine_contract_version, projection.descriptor_identity,
            projection.descriptor_version, projection.descriptor_hash,
            projection.candidate_contract_version, projection.settlement_plan_version,
            projection.transaction_payload_version, projection.recovery_payload_version,
            canonical, hash.as_slice(), state.phase, state.settlement_outcome,
            state.db_outcome, state.activation_outcome, projection.created_at_epoch_ms,
        ],
    );
    match inserted {
        Ok(1) => {
            let record = read_operation(connection, &envelope.operation_id)?
                .ok_or("FORMAL_SWITCH_PREPARE_READBACK_MISSING")?;
            verify_payload_integrity(&record)?;
            Ok(PrepareImmutableOperationResult::Prepared(record))
        }
        Ok(_) => Err("FORMAL_SWITCH_PREPARE_AFFECTED_ROW_COUNT".into()),
        Err(_) => {
            if let Some(record) = read_operation(connection, &envelope.operation_id)? {
                if record.immutable_payload == canonical && record.payload_sha256 == hash {
                    verify_payload_integrity(&record)?;
                    if record.state.phase == "prepared" {
                        Ok(PrepareImmutableOperationResult::AlreadyPrepared(record))
                    } else {
                        Ok(PrepareImmutableOperationResult::AlreadyExistsSameOperation(
                            record,
                        ))
                    }
                } else {
                    Ok(PrepareImmutableOperationResult::ConflictInconsistent)
                }
            } else {
                Ok(PrepareImmutableOperationResult::UnresolvedIdentityConflict)
            }
        }
    }
}

pub(crate) fn read_unresolved_operation_summaries(
    connection: &Connection,
) -> Result<Vec<FormalSwitchOperationSummaryV1>, String> {
    let predicate = unresolved_slot_predicate_sql()?;
    let sql = format!("SELECT operation_id,owner_type,owner_id,manuscript_channel,entry_kind,owner_subtype,phase,phase_revision,terminal_code FROM formal_switch_operations WHERE {predicate} ORDER BY created_at_epoch_ms,operation_id");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(FormalSwitchOperationSummaryV1 {
                operation_id: row.get(0)?,
                owner_type: row.get(1)?,
                owner_id: row.get(2)?,
                manuscript_channel: row.get(3)?,
                entry_kind: row.get(4)?,
                owner_subtype: row.get(5)?,
                phase: row.get(6)?,
                phase_revision: row.get(7)?,
                terminal_code: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn read_verified_operation_for_continuation(
    connection: &Connection,
    operation_id: &str,
) -> Result<ExecutableFormalSwitchOperationV1, String> {
    let record = read_operation(connection, operation_id)?.ok_or("NOT_FOUND")?;
    let envelope = verify_payload_integrity(&record)?;
    Ok(ExecutableFormalSwitchOperationV1 { record, envelope })
}

pub(crate) fn advance_phase_cas(
    connection: &Connection,
    operation_id: &str,
    expected_phase: &str,
    expected_phase_revision: i64,
    expected_payload_sha256: &[u8; 32],
    next_state: &FormalSwitchOperationState,
    attempt_metadata: Option<&FormalSwitchAttemptMetadataV1>,
    last_error_code: Option<&str>,
    last_diagnostic_summary: Option<&str>,
    updated_at_epoch_ms: i64,
) -> Result<FormalSwitchOperationRecord, PhaseCasFailure> {
    let current = read_operation(connection, operation_id)
        .map_err(PhaseCasFailure::Persistence)?
        .ok_or(PhaseCasFailure::NotFound)?;
    verify_payload_integrity(&current).map_err(|_| PhaseCasFailure::PayloadIntegrityConflict)?;
    if current.payload_sha256.as_slice() != expected_payload_sha256 {
        return Err(PhaseCasFailure::PayloadIntegrityConflict);
    }
    if current.state.terminal_code.is_some() {
        return Err(PhaseCasFailure::TerminalConflict);
    }
    if current.state.phase != expected_phase {
        return Err(PhaseCasFailure::PhaseConflict);
    }
    if current.phase_revision != expected_phase_revision {
        return Err(PhaseCasFailure::RevisionConflict);
    }
    if validate_transition(&current.state, next_state).is_err() {
        return Err(PhaseCasFailure::InvalidTransition);
    }
    let metadata = attempt_metadata
        .map(encode_attempt_metadata)
        .transpose()
        .map_err(PhaseCasFailure::Persistence)?;
    let resolved_at = matches!(next_state.phase.as_str(), "resolved" | "cancelled_safe")
        .then_some(updated_at_epoch_ms);
    let changed = connection
        .execute(
            "UPDATE formal_switch_operations SET phase=?1,phase_revision=phase_revision+1,
          settlement_outcome=?2,db_outcome=?3,activation_outcome=?4,terminal_code=?5,
          last_error_code=?6,last_diagnostic_summary=?7,attempt_metadata=?8,
          updated_at_epoch_ms=?9,resolved_at_epoch_ms=?10
         WHERE operation_id=?11 AND phase=?12 AND phase_revision=?13 AND payload_sha256=?14",
            params![
                next_state.phase,
                next_state.settlement_outcome,
                next_state.db_outcome,
                next_state.activation_outcome,
                next_state.terminal_code,
                last_error_code,
                last_diagnostic_summary,
                metadata,
                updated_at_epoch_ms,
                resolved_at,
                operation_id,
                expected_phase,
                expected_phase_revision,
                expected_payload_sha256.as_slice()
            ],
        )
        .map_err(|error| PhaseCasFailure::Persistence(error.to_string()))?;
    if changed == 1 {
        let readback = read_operation(connection, operation_id)
            .map_err(PhaseCasFailure::Persistence)?
            .ok_or(PhaseCasFailure::NotFound)?;
        verify_payload_integrity(&readback)
            .map_err(|_| PhaseCasFailure::PayloadIntegrityConflict)?;
        return Ok(readback);
    }
    let observed = read_operation(connection, operation_id)
        .map_err(PhaseCasFailure::Persistence)?
        .ok_or(PhaseCasFailure::NotFound)?;
    if observed.state.terminal_code.is_some() {
        Err(PhaseCasFailure::TerminalConflict)
    } else if observed.state.phase != expected_phase {
        Err(PhaseCasFailure::PhaseConflict)
    } else if observed.phase_revision != expected_phase_revision {
        Err(PhaseCasFailure::RevisionConflict)
    } else if observed.payload_sha256.as_slice() != expected_payload_sha256 {
        Err(PhaseCasFailure::PayloadIntegrityConflict)
    } else {
        Err(PhaseCasFailure::Persistence(
            "FORMAL_SWITCH_PHASE_CAS_FAILED".into(),
        ))
    }
}

pub(crate) fn mark_contained_or_blocked_cas(
    connection: &Connection,
    operation_id: &str,
    expected_phase: &str,
    expected_phase_revision: i64,
    expected_payload_sha256: &[u8; 32],
    contained: bool,
    state_outcomes: (&str, &str, &str),
    updated_at_epoch_ms: i64,
) -> Result<FormalSwitchOperationRecord, PhaseCasFailure> {
    let next = FormalSwitchOperationState {
        phase: if contained { "contained" } else { "blocked" }.into(),
        settlement_outcome: state_outcomes.0.into(),
        db_outcome: state_outcomes.1.into(),
        activation_outcome: state_outcomes.2.into(),
        terminal_code: Some(
            if contained {
                "CONTAINED_CONTINUATION_BLOCKED"
            } else {
                "BLOCKED_MANUAL_ADJUDICATION_REQUIRED"
            }
            .into(),
        ),
    };
    advance_phase_cas(
        connection,
        operation_id,
        expected_phase,
        expected_phase_revision,
        expected_payload_sha256,
        &next,
        None,
        None,
        None,
        updated_at_epoch_ms,
    )
}

pub(crate) fn read_formal_switch_success_by_operation_id(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<String>, String> {
    connection.query_row(
        "SELECT id FROM operation_logs WHERE operation_type='formal_switch' AND status='success' AND formal_switch_operation_id=?1",
        [operation_id], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())
}

pub(crate) fn verify_operation_id_exactly_once(
    connection: &Connection,
    operation_id: &str,
) -> Result<(), String> {
    let row_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM formal_switch_operations WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let success_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM operation_logs WHERE operation_type='formal_switch' AND status='success' AND formal_switch_operation_id=?1",
        [operation_id], |row| row.get(0)
    ).map_err(|error| error.to_string())?;
    if row_count <= 1 && success_count <= 1 {
        Ok(())
    } else {
        Err("FORMAL_SWITCH_EXACTLY_ONCE_VIOLATION".into())
    }
}

#[cfg(test)]
pub(crate) fn remove_v53_foundation_for_legacy_fixture(
    connection: &Connection,
) -> Result<(), String> {
    if table_exists(connection, "formal_switch_operations").map_err(|error| error.to_string())? {
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM formal_switch_operations", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if row_count != 0 {
            return Err("FORMAL_SWITCH_TEST_FIXTURE_DOWNGRADE_NONEMPTY".into());
        }
        connection
            .execute_batch("DROP TABLE formal_switch_operations;")
            .map_err(|error| error.to_string())?;
    }
    if column_exists(connection, "operation_logs", "formal_switch_operation_id")
        .map_err(|error| error.to_string())?
    {
        connection
            .execute_batch(
                "DROP TRIGGER IF EXISTS trg_operation_logs_formal_switch_success_identity_delete;
                 DROP TRIGGER IF EXISTS trg_operation_logs_formal_switch_success_identity_update;
                 DROP TRIGGER IF EXISTS trg_operation_logs_formal_switch_success_identity_insert;
                 DROP INDEX IF EXISTS uq_operation_logs_formal_switch_success_operation_id;
                 ALTER TABLE operation_logs DROP COLUMN formal_switch_operation_id;",
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute("DELETE FROM schema_migrations WHERE version=53", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}
