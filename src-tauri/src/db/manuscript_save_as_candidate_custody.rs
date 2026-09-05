use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

pub(crate) const CANDIDATE_CUSTODY_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS manuscript_save_as_candidate_custody (
  operation_id TEXT PRIMARY KEY REFERENCES manuscript_save_as_operations(operation_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
  receipt_id TEXT NOT NULL UNIQUE CHECK (receipt_id <> ''),
  operation_generation INTEGER NOT NULL CHECK (operation_generation > 0),
  process_generation TEXT NOT NULL CHECK (process_generation <> ''),
  owner_type TEXT NOT NULL CHECK (owner_type <> ''),
  owner_id TEXT NOT NULL CHECK (owner_id <> ''),
  channel TEXT NOT NULL CHECK (channel IN ('primary','literature_outline','dedicated_notes')),
  candidate_file_ref_id TEXT NOT NULL CHECK (candidate_file_ref_id <> ''),
  candidate_role TEXT NOT NULL CHECK (candidate_role = 'save_as_target'),
  runtime_handle TEXT,
  runtime_consumer_id TEXT NOT NULL CHECK (runtime_consumer_id <> ''),
  runtime_generation INTEGER CHECK (runtime_generation IS NULL OR runtime_generation > 0),
  activation_authority TEXT NOT NULL CHECK (activation_authority = 'r3_authority'),
  current_custody_authority TEXT NOT NULL CHECK (current_custody_authority IN (
    'r3_authority','shared_recovery','outputs_adapter','outputs_lifecycle',
    'installed_session','durable_cleanup','resolved'
  )),
  custody_state TEXT NOT NULL CHECK (custody_state IN (
    'activation_planned','activated_held','transfer_pending','transferred',
    'close_pending','residual_unclaimed','cleanup_claimed','cleanup_retryable',
    'cleanup_blocked','cleanup_resolved','process_generation_retired'
  )),
  cleanup_claim_token TEXT,
  initial_automatic_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (initial_automatic_attempt_count BETWEEN 0 AND 2),
  explicit_cleanup_cycle_count INTEGER NOT NULL DEFAULT 0
    CHECK (explicit_cleanup_cycle_count >= 0),
  total_close_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_close_attempt_count >= 0),
  last_attempt_at TEXT,
  last_error_code TEXT,
  final_close_result TEXT,
  resolved_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (
    (custody_state IN ('cleanup_resolved','process_generation_retired')
      AND current_custody_authority = 'resolved'
      AND runtime_handle IS NULL AND cleanup_claim_token IS NULL
      AND resolved_at IS NOT NULL AND final_close_result IS NOT NULL)
    OR
    (custody_state NOT IN ('cleanup_resolved','process_generation_retired')
      AND current_custody_authority <> 'resolved'
      AND resolved_at IS NULL)
  ),
  CHECK (
    (custody_state = 'activation_planned' AND runtime_handle IS NULL AND runtime_generation IS NULL)
    OR custody_state <> 'activation_planned'
  )
);
CREATE INDEX IF NOT EXISTS idx_save_as_candidate_custody_state
ON manuscript_save_as_candidate_custody(custody_state, updated_at, operation_id);
INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (46, 'save_as_candidate_custody_receipt_and_exact_cleanup');
"#;

pub(crate) const COLUMNS: &str = "operation_id,revision,receipt_version,receipt_id,
operation_generation,process_generation,owner_type,owner_id,channel,
candidate_file_ref_id,candidate_role,runtime_handle,runtime_consumer_id,runtime_generation,
activation_authority,current_custody_authority,custody_state,cleanup_claim_token,
initial_automatic_attempt_count,explicit_cleanup_cycle_count,total_close_attempt_count,
last_attempt_at,last_error_code,final_close_result,resolved_reason,created_at,updated_at,resolved_at";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CandidateCustodyRecord {
    pub(crate) operation_id: String,
    pub(crate) revision: i64,
    receipt_version: i64,
    pub(crate) receipt_id: String,
    pub(crate) operation_generation: i64,
    pub(crate) process_generation: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) channel: String,
    pub(crate) candidate_file_ref_id: String,
    candidate_role: String,
    pub(crate) runtime_handle: Option<String>,
    pub(crate) runtime_consumer_id: String,
    pub(crate) runtime_generation: Option<i64>,
    activation_authority: String,
    pub(crate) current_custody_authority: String,
    pub(crate) custody_state: String,
    cleanup_claim_token: Option<String>,
    initial_automatic_attempt_count: i64,
    explicit_cleanup_cycle_count: i64,
    total_close_attempt_count: i64,
    last_attempt_at: Option<String>,
    last_error_code: Option<String>,
    final_close_result: Option<String>,
    resolved_reason: Option<String>,
    created_at: String,
    pub(crate) updated_at: String,
    resolved_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanCandidateCustodyInput {
    operation_id: String,
    expected_operation_revision: i64,
    candidate_file_ref_id: String,
    runtime_consumer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordCandidateActivationInput {
    operation_id: String,
    expected_custody_revision: i64,
    receipt_id: String,
    runtime_handle: String,
    runtime_generation: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordCandidateRecoveryActivationInput {
    operation_id: String,
    receipt_id: String,
    expected_custody_revision: i64,
    owner_type: String,
    owner_id: String,
    channel: String,
    candidate_file_ref_id: String,
    expected_runtime_handle: Option<String>,
    expected_runtime_consumer_id: String,
    expected_runtime_generation: Option<i64>,
    runtime_handle: String,
    runtime_consumer_id: String,
    runtime_generation: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferCandidateCustodyInput {
    operation_id: String,
    expected_custody_revision: i64,
    receipt_id: String,
    next_authority: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimCandidateCleanupInput {
    operation_id: String,
    expected_custody_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordCandidateCleanupInput {
    operation_id: String,
    expected_custody_revision: i64,
    receipt_id: String,
    cleanup_claim_token: Option<String>,
    cycle: String,
    result: String,
    error_code: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CandidateCustodyRecord> {
    Ok(CandidateCustodyRecord {
        operation_id: row.get(0)?,
        revision: row.get(1)?,
        receipt_version: row.get(2)?,
        receipt_id: row.get(3)?,
        operation_generation: row.get(4)?,
        process_generation: row.get(5)?,
        owner_type: row.get(6)?,
        owner_id: row.get(7)?,
        channel: row.get(8)?,
        candidate_file_ref_id: row.get(9)?,
        candidate_role: row.get(10)?,
        runtime_handle: row.get(11)?,
        runtime_consumer_id: row.get(12)?,
        runtime_generation: row.get(13)?,
        activation_authority: row.get(14)?,
        current_custody_authority: row.get(15)?,
        custody_state: row.get(16)?,
        cleanup_claim_token: row.get(17)?,
        initial_automatic_attempt_count: row.get(18)?,
        explicit_cleanup_cycle_count: row.get(19)?,
        total_close_attempt_count: row.get(20)?,
        last_attempt_at: row.get(21)?,
        last_error_code: row.get(22)?,
        final_close_result: row.get(23)?,
        resolved_reason: row.get(24)?,
        created_at: row.get(25)?,
        updated_at: row.get(26)?,
        resolved_at: row.get(27)?,
    })
}

pub(crate) fn readback_in_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<CandidateCustodyRecord>, String> {
    connection
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM manuscript_save_as_candidate_custody
                 WHERE operation_id=?1"
            ),
            [operation_id],
            row,
        )
        .optional()
        .map_err(|_| "SAVE_AS_CUSTODY_READBACK_FAILED".into())
}

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(CANDIDATE_CUSTODY_SCHEMA_SQL)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='manuscript_save_as_candidate_custody'",
        [],
        |row| row.get(0),
    )?;
    let index: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='index' AND name='idx_save_as_candidate_custody_state'",
        [],
        |row| row.get(0),
    )?;
    let migration: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=46 AND name='save_as_candidate_custody_receipt_and_exact_cleanup'",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1 && index == 1 && migration == 1)
}

fn plan(
    connection: &mut Connection,
    input: &PlanCandidateCustodyInput,
) -> Result<CandidateCustodyRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    let operation =
        super::manuscript_save_as_operation::readback_in_connection(
            &transaction,
            &input.operation_id,
        )?
        .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    if operation.revision != input.expected_operation_revision
        || operation.target_file_ref_id.as_deref()
            != Some(input.candidate_file_ref_id.as_str())
        || operation.stage.as_str() != "r3_activation_pending"
        || input.runtime_consumer_id.trim().is_empty()
    {
        return Err("SAVE_AS_CUSTODY_IDENTITY_MISMATCH".into());
    }
    if let Some(existing) = readback_in_connection(&transaction, &input.operation_id)? {
        if existing.operation_generation == operation.operation_generation
            && existing.process_generation == operation.producer_process_generation
            && existing.candidate_file_ref_id == input.candidate_file_ref_id
            && existing.runtime_consumer_id == input.runtime_consumer_id
        {
            transaction
                .commit()
                .map_err(|_| "SAVE_AS_CUSTODY_RESPONSE_LOSS".to_string())?;
            return Ok(existing);
        }
        return Err("SAVE_AS_CUSTODY_ALREADY_EXISTS".into());
    }
    let timestamp = now();
    let receipt_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO manuscript_save_as_candidate_custody (
             operation_id,revision,receipt_version,receipt_id,operation_generation,
             process_generation,owner_type,owner_id,channel,candidate_file_ref_id,candidate_role,
             runtime_handle,runtime_consumer_id,runtime_generation,activation_authority,
             current_custody_authority,custody_state,cleanup_claim_token,
             initial_automatic_attempt_count,explicit_cleanup_cycle_count,
             total_close_attempt_count,last_attempt_at,last_error_code,final_close_result,resolved_reason,
             created_at,updated_at,resolved_at
             ) VALUES (?1,0,1,?2,?3,?4,?5,?6,?7,?8,'save_as_target',NULL,?9,NULL,
             'r3_authority','r3_authority','activation_planned',NULL,0,0,0,
             NULL,NULL,NULL,NULL,?10,?10,NULL)",
            params![
                input.operation_id,
                receipt_id,
                operation.operation_generation,
                operation.producer_process_generation,
                operation.owner_type,
                operation.owner_id,
                operation.channel,
                input.candidate_file_ref_id,
                input.runtime_consumer_id,
                timestamp,
            ],
        )
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_READBACK_FAILED".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_CUSTODY_RESPONSE_LOSS".to_string())?;
    Ok(record)
}

fn record_activation(
    connection: &Connection,
    input: &RecordCandidateActivationInput,
) -> Result<CandidateCustodyRecord, String> {
    let changed = connection
        .execute(
            "UPDATE manuscript_save_as_candidate_custody SET
             revision=revision+1,runtime_handle=?1,runtime_generation=?2,
             custody_state='activated_held',updated_at=?3
             WHERE operation_id=?4 AND revision=?5 AND receipt_id=?6
               AND custody_state='activation_planned'",
            params![
                input.runtime_handle,
                input.runtime_generation,
                now(),
                input.operation_id,
                input.expected_custody_revision,
                input.receipt_id,
            ],
        )
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    readback_in_connection(connection, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_READBACK_FAILED".into())
}

fn record_recovery_activation(
    connection: &mut Connection,
    input: &RecordCandidateRecoveryActivationInput,
) -> Result<CandidateCustodyRecord, String> {
    if input.runtime_handle.trim().is_empty()
        || input.runtime_consumer_id.trim().is_empty()
        || input.runtime_generation < 0
    {
        return Err("SAVE_AS_CUSTODY_IDENTITY_MISMATCH".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    let operation =
        super::manuscript_save_as_operation::readback_in_connection(
            &transaction,
            &input.operation_id,
        )?
        .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let current = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_NOT_FOUND".to_string())?;
    let operation_matches = operation.stage.as_str() == "r3_activation_pending"
        && operation.owner_type == input.owner_type
        && operation.owner_id == input.owner_id
        && operation.channel == input.channel
        && operation.target_file_ref_id.as_deref()
            == Some(input.candidate_file_ref_id.as_str());
    let custody_identity_matches = current.receipt_id == input.receipt_id
        && current.owner_type == input.owner_type
        && current.owner_id == input.owner_id
        && current.channel == input.channel
        && current.candidate_file_ref_id == input.candidate_file_ref_id;
    if !operation_matches || !custody_identity_matches {
        return Err("SAVE_AS_CUSTODY_IDENTITY_MISMATCH".into());
    }
    if current.runtime_handle.as_deref() == Some(input.runtime_handle.as_str())
        && current.runtime_consumer_id == input.runtime_consumer_id
        && current.runtime_generation == Some(input.runtime_generation)
        && current.revision == input.expected_custody_revision + 1
        && current.current_custody_authority == "shared_recovery"
        && current.custody_state == "transferred"
    {
        transaction
            .commit()
            .map_err(|_| "SAVE_AS_CUSTODY_RESPONSE_LOSS".to_string())?;
        return Ok(current);
    }
    if current.revision != input.expected_custody_revision
        || current.runtime_handle != input.expected_runtime_handle
        || current.runtime_consumer_id != input.expected_runtime_consumer_id
        || current.runtime_generation != input.expected_runtime_generation
        || !matches!(
            current.custody_state.as_str(),
            "activation_planned" | "activated_held" | "transfer_pending" | "transferred"
        )
        || !matches!(
            current.current_custody_authority.as_str(),
            "r3_authority" | "shared_recovery" | "outputs_adapter" | "outputs_lifecycle"
        )
    {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    let changed = transaction
        .execute(
            "UPDATE manuscript_save_as_candidate_custody SET
             revision=revision+1,runtime_handle=?1,runtime_generation=?2,
             runtime_consumer_id=?3,current_custody_authority='shared_recovery',
             custody_state='transferred',updated_at=?4
             WHERE operation_id=?5 AND receipt_id=?6 AND revision=?7
               AND owner_type=?8 AND owner_id=?9 AND channel=?10
               AND candidate_file_ref_id=?11 AND runtime_handle IS ?12
               AND runtime_generation IS ?13 AND runtime_consumer_id=?14
               AND custody_state IN ('activation_planned','activated_held','transfer_pending','transferred')",
            params![
                input.runtime_handle,
                input.runtime_generation,
                input.runtime_consumer_id,
                now(),
                input.operation_id,
                input.receipt_id,
                input.expected_custody_revision,
                input.owner_type,
                input.owner_id,
                input.channel,
                input.candidate_file_ref_id,
                input.expected_runtime_handle,
                input.expected_runtime_generation,
                input.expected_runtime_consumer_id,
            ],
        )
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_READBACK_FAILED".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_CUSTODY_RESPONSE_LOSS".to_string())?;
    Ok(record)
}

fn transfer(
    connection: &Connection,
    input: &TransferCandidateCustodyInput,
) -> Result<CandidateCustodyRecord, String> {
    if !matches!(
        input.next_authority.as_str(),
        "shared_recovery" | "outputs_adapter" | "outputs_lifecycle" | "installed_session"
            | "durable_cleanup"
    ) {
        return Err("SAVE_AS_CUSTODY_AUTHORITY_INVALID".into());
    }
    let current = readback_in_connection(connection, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_NOT_FOUND".to_string())?;
    if current.receipt_id != input.receipt_id {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    if current.current_custody_authority == input.next_authority {
        return Ok(current);
    }
    if current.revision != input.expected_custody_revision {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    let legal_edge = matches!(
        (
            current.current_custody_authority.as_str(),
            input.next_authority.as_str()
        ),
        ("r3_authority", "shared_recovery")
            | ("r3_authority", "outputs_adapter")
            | ("r3_authority", "outputs_lifecycle")
            | ("shared_recovery", "outputs_adapter")
            | ("shared_recovery", "outputs_lifecycle")
            | ("outputs_adapter", "outputs_lifecycle")
            | ("outputs_lifecycle", "installed_session")
            | ("outputs_adapter", "durable_cleanup")
            | ("outputs_lifecycle", "durable_cleanup")
    );
    if !legal_edge {
        return Err("SAVE_AS_CUSTODY_TRANSFER_INVALID".into());
    }
    let changed = connection
        .execute(
            "UPDATE manuscript_save_as_candidate_custody SET
             revision=revision+1,current_custody_authority=?1,
             custody_state='transferred',updated_at=?2
             WHERE operation_id=?3 AND revision=?4 AND receipt_id=?5
               AND runtime_handle IS NOT NULL
               AND custody_state IN ('activated_held','transfer_pending','transferred')",
            params![
                input.next_authority,
                now(),
                input.operation_id,
                input.expected_custody_revision,
                input.receipt_id,
            ],
        )
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    readback_in_connection(connection, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_READBACK_FAILED".into())
}

fn claim_cleanup(
    connection: &Connection,
    input: &ClaimCandidateCleanupInput,
) -> Result<CandidateCustodyRecord, String> {
    let token = Uuid::new_v4().to_string();
    let changed = connection
        .execute(
            "UPDATE manuscript_save_as_candidate_custody SET
             revision=revision+1,current_custody_authority='durable_cleanup',
             custody_state='cleanup_claimed',cleanup_claim_token=?1,
             explicit_cleanup_cycle_count=explicit_cleanup_cycle_count+1,
             updated_at=?2
             WHERE operation_id=?3 AND revision=?4
               AND cleanup_claim_token IS NULL
               AND custody_state IN ('residual_unclaimed','cleanup_retryable','cleanup_blocked')",
            params![token, now(), input.operation_id, input.expected_custody_revision],
        )
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_CLEANUP_CLAIM_CONFLICT".into());
    }
    readback_in_connection(connection, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_READBACK_FAILED".into())
}

fn record_cleanup(
    connection: &Connection,
    input: &RecordCandidateCleanupInput,
) -> Result<CandidateCustodyRecord, String> {
    if !matches!(input.cycle.as_str(), "automatic" | "explicit") {
        return Err("SAVE_AS_CLEANUP_CYCLE_INVALID".into());
    }
    if !matches!(
        input.result.as_str(),
        "closed" | "already_absent" | "not_activated" | "retryable_failure" | "cleanup_blocked"
            | "process_generation_retired"
    ) {
        return Err("SAVE_AS_CLEANUP_RESULT_INVALID".into());
    }
    let current = readback_in_connection(connection, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_NOT_FOUND".to_string())?;
    if current.revision != input.expected_custody_revision
        || current.receipt_id != input.receipt_id
        || (input.cycle == "explicit"
            && current.cleanup_claim_token != input.cleanup_claim_token)
        || (input.cycle == "automatic"
            && (input.cleanup_claim_token.is_some()
                || current.initial_automatic_attempt_count >= 2))
    {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    let resolved = matches!(
        input.result.as_str(),
        "closed" | "already_absent" | "not_activated" | "process_generation_retired"
    );
    let state = if resolved {
        if input.result == "process_generation_retired" {
            "process_generation_retired"
        } else {
            "cleanup_resolved"
        }
    } else if input.result == "retryable_failure" {
        "cleanup_retryable"
    } else {
        "cleanup_blocked"
    };
    let authority = if resolved { "resolved" } else { "durable_cleanup" };
    let runtime_handle = if resolved {
        None
    } else {
        current.runtime_handle.as_deref()
    };
    let claim = if input.cycle == "explicit" || resolved {
        None
    } else {
        current.cleanup_claim_token.as_deref()
    };
    let timestamp = now();
    let changed = connection
        .execute(
            "UPDATE manuscript_save_as_candidate_custody SET
             revision=revision+1,current_custody_authority=?1,custody_state=?2,
             runtime_handle=?3,cleanup_claim_token=?4,
             initial_automatic_attempt_count=initial_automatic_attempt_count+?5,
             total_close_attempt_count=total_close_attempt_count+?6,
             last_attempt_at=?7,last_error_code=?8,final_close_result=?9,resolved_reason=?10,
             updated_at=?11,resolved_at=?12
             WHERE operation_id=?13 AND revision=?14 AND receipt_id=?15",
            params![
                authority,
                state,
                runtime_handle,
                claim,
                if input.cycle == "automatic"
                    && !matches!(
                        input.result.as_str(),
                        "not_activated" | "process_generation_retired"
                    )
                {
                    1
                } else {
                    0
                },
                if matches!(
                    input.result.as_str(),
                    "not_activated" | "process_generation_retired"
                ) {
                    0
                } else {
                    1
                },
                timestamp,
                input.error_code,
                if resolved { Some(input.result.as_str()) } else { None },
                if resolved { Some(input.result.as_str()) } else { None },
                timestamp,
                if resolved { Some(timestamp.as_str()) } else { None },
                input.operation_id,
                input.expected_custody_revision,
                input.receipt_id,
            ],
        )
        .map_err(|_| "SAVE_AS_CUSTODY_STORAGE_FAILED".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_CUSTODY_REVISION_CONFLICT".into());
    }
    readback_in_connection(connection, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_CUSTODY_READBACK_FAILED".into())
}

#[tauri::command]
pub(crate) fn plan_save_as_candidate_custody(
    app_handle: AppHandle,
    input: PlanCandidateCustodyInput,
) -> Result<CandidateCustodyRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    plan(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn readback_save_as_candidate_custody(
    app_handle: AppHandle,
    operation_id: String,
) -> Result<Option<CandidateCustodyRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    readback_in_connection(&connection, &operation_id)
}

#[tauri::command]
pub(crate) fn record_save_as_candidate_activation(
    app_handle: AppHandle,
    input: RecordCandidateActivationInput,
) -> Result<CandidateCustodyRecord, String> {
    let connection = super::open_connection(&app_handle)?;
    record_activation(&connection, &input)
}

#[tauri::command]
pub(crate) fn record_save_as_candidate_recovery_activation(
    app_handle: AppHandle,
    input: RecordCandidateRecoveryActivationInput,
) -> Result<CandidateCustodyRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    record_recovery_activation(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn transfer_save_as_candidate_custody(
    app_handle: AppHandle,
    input: TransferCandidateCustodyInput,
) -> Result<CandidateCustodyRecord, String> {
    let connection = super::open_connection(&app_handle)?;
    transfer(&connection, &input)
}

#[tauri::command]
pub(crate) fn claim_save_as_candidate_cleanup(
    app_handle: AppHandle,
    input: ClaimCandidateCleanupInput,
) -> Result<CandidateCustodyRecord, String> {
    let connection = super::open_connection(&app_handle)?;
    claim_cleanup(&connection, &input)
}

#[tauri::command]
pub(crate) fn record_save_as_candidate_cleanup(
    app_handle: AppHandle,
    input: RecordCandidateCleanupInput,
) -> Result<CandidateCustodyRecord, String> {
    let connection = super::open_connection(&app_handle)?;
    record_cleanup(&connection, &input)
}

#[cfg(test)]
pub(crate) fn f6_plan_in_connection(
    connection: &mut Connection,
    input: &PlanCandidateCustodyInput,
) -> Result<CandidateCustodyRecord, String> {
    plan(connection, input)
}

#[cfg(test)]
pub(crate) fn f6_record_activation_in_connection(
    connection: &Connection,
    input: &RecordCandidateActivationInput,
) -> Result<CandidateCustodyRecord, String> {
    record_activation(connection, input)
}

#[cfg(test)]
pub(crate) fn f6_transfer_in_connection(
    connection: &Connection,
    input: &TransferCandidateCustodyInput,
) -> Result<CandidateCustodyRecord, String> {
    transfer(connection, input)
}

#[cfg(test)]
pub(crate) fn f6_readback_in_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<CandidateCustodyRecord>, String> {
    readback_in_connection(connection, operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::manuscript_save_as_operation::{
        apply_deterministic_ordering_migration, apply_schema_migration as apply_j0,
        create_in_connection, SaveAsCommitState, SaveAsOperationRecord, SaveAsOperationStage,
        SaveAsReconciliationState,
    };

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);")
            .unwrap();
        apply_j0(&connection).unwrap();
        apply_deterministic_ordering_migration(&connection).unwrap();
        apply_schema_migration(&connection).unwrap();
        connection
    }

    fn operation() -> SaveAsOperationRecord {
        SaveAsOperationRecord {
            operation_id: "operation".into(), revision: 0, commit_fence_revision: 0,
            operation_generation: 1, producer_process_generation: "process".into(),
            owner_type: "resultItem".into(),
            owner_id: "owner".into(), channel: "primary".into(),
            source_window_role: "independent".into(), source_file_ref_id: None,
            source_path_identity_key: "source".into(), source_revision: "r1".into(),
            source_runtime_generation: 1, snapshot_sha256: "a".repeat(64),
            snapshot_byte_length: 1, encoding_contract_version: "utf-8-v1".into(),
            newline_contract_version: "none-v1".into(), target_display_path: "N:\\target.md".into(),
            target_path_identity_key: "target".into(), target_location_mode: "managed".into(),
            target_parent_path_identity_key: "parent".into(),
            target_parent_physical_identity_hash: "b".repeat(64),
            d1_physical_identity_hash: None, d1_readback_sha256: None,
            d1_readback_revision: None, d1_byte_length: None, d1_proof_generation: None,
            target_file_ref_id: None, d2_readback_revision: None,
            containment_fence_token: None, reconciliation_result_code: None,
            reconciliation_resolved_at: None,
            stage: SaveAsOperationStage::PreD1Claimed,
            d1_commit_state: SaveAsCommitState::NotStarted,
            d2_commit_state: SaveAsCommitState::NotStarted,
            reconciliation_state: SaveAsReconciliationState::NotRequired,
            blocking_code: None, claim_token: Some("claim".into()), claim_revision: Some(0),
            claim_process_generation: Some("process".into()), observation_generation: Some(0),
            observation_revision: Some(0), created_at: String::new(), updated_at: String::new(),
            terminal_at: None,
        }
    }

    #[test]
    fn authority_issues_receipt_and_resolved_tombstone_removes_capability() {
        let mut connection = database();
        create_in_connection(&mut connection, &operation()).unwrap();
        connection.execute(
            "UPDATE manuscript_save_as_operations SET revision=4,stage='r3_activation_pending',
             d1_commit_state='confirmed',d2_commit_state='confirmed',
             reconciliation_state='resolved',target_file_ref_id='file'
             WHERE operation_id='operation'", [],
        ).unwrap();
        let record = super::super::manuscript_save_as_operation::readback_in_connection(
            &connection, "operation"
        ).unwrap().unwrap();
        let planned = plan(&mut connection, &PlanCandidateCustodyInput {
            operation_id: "operation".into(), expected_operation_revision: record.revision,
            candidate_file_ref_id: "file".into(), runtime_consumer_id: "consumer".into(),
        }).unwrap();
        assert!(!planned.receipt_id.is_empty());
        let active = record_activation(&connection, &RecordCandidateActivationInput {
            operation_id: "operation".into(), expected_custody_revision: planned.revision,
            receipt_id: planned.receipt_id.clone(), runtime_handle: "handle".into(),
            runtime_generation: 1,
        }).unwrap();
        let transferred = transfer(&connection, &TransferCandidateCustodyInput {
            operation_id: "operation".into(),
            expected_custody_revision: active.revision,
            receipt_id: active.receipt_id.clone(),
            next_authority: "outputs_lifecycle".into(),
        }).unwrap();
        let response_loss_retry = transfer(&connection, &TransferCandidateCustodyInput {
            operation_id: "operation".into(),
            expected_custody_revision: active.revision,
            receipt_id: active.receipt_id.clone(),
            next_authority: "outputs_lifecycle".into(),
        }).unwrap();
        assert_eq!(response_loss_retry.revision, transferred.revision);
        assert_eq!(
            transfer(&connection, &TransferCandidateCustodyInput {
                operation_id: "operation".into(),
                expected_custody_revision: transferred.revision,
                receipt_id: transferred.receipt_id.clone(),
                next_authority: "outputs_adapter".into(),
            }).unwrap_err(),
            "SAVE_AS_CUSTODY_TRANSFER_INVALID"
        );
        let blocked = record_cleanup(&connection, &RecordCandidateCleanupInput {
            operation_id: "operation".into(), expected_custody_revision: transferred.revision,
            receipt_id: transferred.receipt_id.clone(), cleanup_claim_token: None,
            cycle: "automatic".into(), result: "cleanup_blocked".into(),
            error_code: Some("LOCKED".into()),
        }).unwrap();
        assert_eq!(blocked.initial_automatic_attempt_count, 1);
        assert!(blocked.last_attempt_at.is_some());
        let claimed = claim_cleanup(&connection, &ClaimCandidateCleanupInput {
            operation_id: "operation".into(),
            expected_custody_revision: blocked.revision,
        }).unwrap();
        assert_eq!(claimed.explicit_cleanup_cycle_count, 1);
        assert_eq!(
            claim_cleanup(&connection, &ClaimCandidateCleanupInput {
                operation_id: "operation".into(),
                expected_custody_revision: blocked.revision,
            }).unwrap_err(),
            "SAVE_AS_CLEANUP_CLAIM_CONFLICT"
        );
        let closed = record_cleanup(&connection, &RecordCandidateCleanupInput {
            operation_id: "operation".into(), expected_custody_revision: claimed.revision,
            receipt_id: active.receipt_id.clone(),
            cleanup_claim_token: claimed.cleanup_claim_token.clone(),
            cycle: "explicit".into(), result: "closed".into(), error_code: None,
        }).unwrap();
        assert_eq!(closed.current_custody_authority, "resolved");
        assert!(closed.runtime_handle.is_none());
        assert_eq!(closed.total_close_attempt_count, 2);
    }

    #[test]
    fn recovery_activation_atomically_replaces_the_full_runtime_identity() {
        let mut connection = database();
        create_in_connection(&mut connection, &operation()).unwrap();
        connection.execute(
            "UPDATE manuscript_save_as_operations SET revision=4,stage='r3_activation_pending',
             d1_commit_state='confirmed',d2_commit_state='confirmed',
             reconciliation_state='resolved',target_file_ref_id='file'
             WHERE operation_id='operation'", [],
        ).unwrap();
        let operation = super::super::manuscript_save_as_operation::readback_in_connection(
            &connection, "operation"
        ).unwrap().unwrap();
        let planned = plan(&mut connection, &PlanCandidateCustodyInput {
            operation_id: "operation".into(),
            expected_operation_revision: operation.revision,
            candidate_file_ref_id: "file".into(),
            runtime_consumer_id: "old-consumer".into(),
        }).unwrap();
        let active = record_activation(&connection, &RecordCandidateActivationInput {
            operation_id: "operation".into(),
            expected_custody_revision: planned.revision,
            receipt_id: planned.receipt_id.clone(),
            runtime_handle: "old-handle".into(),
            runtime_generation: 7,
        }).unwrap();
        let transferred = transfer(&connection, &TransferCandidateCustodyInput {
            operation_id: "operation".into(),
            expected_custody_revision: active.revision,
            receipt_id: active.receipt_id.clone(),
            next_authority: "outputs_adapter".into(),
        }).unwrap();
        let request = RecordCandidateRecoveryActivationInput {
            operation_id: "operation".into(),
            receipt_id: transferred.receipt_id.clone(),
            expected_custody_revision: transferred.revision,
            owner_type: "resultItem".into(),
            owner_id: "owner".into(),
            channel: "primary".into(),
            candidate_file_ref_id: "file".into(),
            expected_runtime_handle: Some("old-handle".into()),
            expected_runtime_consumer_id: "old-consumer".into(),
            expected_runtime_generation: Some(7),
            runtime_handle: "recovery-handle".into(),
            runtime_consumer_id: "recovery-consumer".into(),
            runtime_generation: 11,
        };
        let recovered = record_recovery_activation(&mut connection, &request).unwrap();
        assert_eq!(recovered.revision, transferred.revision + 1);
        assert_eq!(recovered.runtime_handle.as_deref(), Some("recovery-handle"));
        assert_eq!(recovered.runtime_generation, Some(11));
        assert_eq!(recovered.runtime_consumer_id, "recovery-consumer");
        assert_eq!(recovered.current_custody_authority, "shared_recovery");
        assert_eq!(recovered.custody_state, "transferred");

        let same_retry = record_recovery_activation(&mut connection, &request).unwrap();
        assert_eq!(same_retry.revision, recovered.revision);

        let competing = RecordCandidateRecoveryActivationInput {
            runtime_handle: "loser-handle".into(),
            runtime_consumer_id: "loser-consumer".into(),
            runtime_generation: 12,
            ..request
        };
        assert_eq!(
            record_recovery_activation(&mut connection, &competing).unwrap_err(),
            "SAVE_AS_CUSTODY_REVISION_CONFLICT"
        );
        let authoritative = readback_in_connection(&connection, "operation")
            .unwrap().unwrap();
        assert_eq!(authoritative.revision, recovered.revision);
        assert_eq!(authoritative.runtime_handle.as_deref(), Some("recovery-handle"));
        assert_eq!(authoritative.runtime_generation, Some(11));
        assert_eq!(authoritative.runtime_consumer_id, "recovery-consumer");
    }

    #[test]
    fn recovery_activation_rejects_every_old_identity_mismatch_without_write() {
        let mut connection = database();
        create_in_connection(&mut connection, &operation()).unwrap();
        connection.execute(
            "UPDATE manuscript_save_as_operations SET revision=4,stage='r3_activation_pending',
             d1_commit_state='confirmed',d2_commit_state='confirmed',
             reconciliation_state='resolved',target_file_ref_id='file'
             WHERE operation_id='operation'", [],
        ).unwrap();
        let operation = super::super::manuscript_save_as_operation::readback_in_connection(
            &connection, "operation"
        ).unwrap().unwrap();
        let planned = plan(&mut connection, &PlanCandidateCustodyInput {
            operation_id: "operation".into(), expected_operation_revision: operation.revision,
            candidate_file_ref_id: "file".into(), runtime_consumer_id: "old-consumer".into(),
        }).unwrap();
        let active = record_activation(&connection, &RecordCandidateActivationInput {
            operation_id: "operation".into(), expected_custody_revision: planned.revision,
            receipt_id: planned.receipt_id.clone(), runtime_handle: "old-handle".into(),
            runtime_generation: 7,
        }).unwrap();
        let transferred = transfer(&connection, &TransferCandidateCustodyInput {
            operation_id: "operation".into(), expected_custody_revision: active.revision,
            receipt_id: active.receipt_id.clone(), next_authority: "outputs_adapter".into(),
        }).unwrap();
        let request = RecordCandidateRecoveryActivationInput {
            operation_id: "operation".into(), receipt_id: transferred.receipt_id.clone(),
            expected_custody_revision: transferred.revision,
            owner_type: "resultItem".into(), owner_id: "owner".into(), channel: "primary".into(),
            candidate_file_ref_id: "file".into(), expected_runtime_handle: Some("old-handle".into()),
            expected_runtime_consumer_id: "old-consumer".into(), expected_runtime_generation: Some(7),
            runtime_handle: "recovery-handle".into(),
            runtime_consumer_id: "recovery-consumer".into(), runtime_generation: 11,
        };
        let mut mismatches = Vec::new();
        let mut value = request.clone(); value.receipt_id = "wrong".into(); mismatches.push(value);
        let mut value = request.clone(); value.expected_custody_revision += 1; mismatches.push(value);
        let mut value = request.clone(); value.owner_type = "finding".into(); mismatches.push(value);
        let mut value = request.clone(); value.owner_id = "wrong".into(); mismatches.push(value);
        let mut value = request.clone(); value.channel = "dedicated_notes".into(); mismatches.push(value);
        let mut value = request.clone(); value.candidate_file_ref_id = "wrong".into(); mismatches.push(value);
        let mut value = request.clone(); value.expected_runtime_handle = Some("wrong".into()); mismatches.push(value);
        let mut value = request.clone(); value.expected_runtime_generation = Some(8); mismatches.push(value);
        let mut value = request.clone(); value.expected_runtime_consumer_id = "wrong".into(); mismatches.push(value);

        for mismatch in mismatches {
            assert!(record_recovery_activation(&mut connection, &mismatch).is_err());
            let authoritative = readback_in_connection(&connection, "operation")
                .unwrap().unwrap();
            assert_eq!(authoritative.revision, transferred.revision);
            assert_eq!(authoritative.runtime_handle.as_deref(), Some("old-handle"));
            assert_eq!(authoritative.runtime_generation, Some(7));
            assert_eq!(authoritative.runtime_consumer_id, "old-consumer");
        }
    }
}
