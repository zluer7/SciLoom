use crate::manuscript_save_as_target_guard::ManuscriptSaveAsTargetGuardAuthority;
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::manuscript_save_as_operation::{
    self, SaveAsFailureCode, SaveAsOperationRecord, SaveAsOperationStage,
};
use super::manuscript_save_as_candidate_custody::CandidateCustodyRecord;

pub(crate) const FINALIZATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS manuscript_save_as_finalizations (
  operation_id TEXT PRIMARY KEY
    REFERENCES manuscript_save_as_operations(operation_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  finalization_state TEXT NOT NULL CHECK (finalization_state IN (
    'presentation_completed','lifecycle_install_pending','lifecycle_prepared',
    'lifecycle_installed','finalization_pending','finalized',
    'lifecycle_rejected','revoke_pending','revoked',
    'compensation_pending','compensated','finalization_blocked'
  )),
  receipt_id TEXT NOT NULL CHECK (receipt_id <> ''),
  owner_type TEXT NOT NULL CHECK (owner_type <> ''),
  owner_id TEXT NOT NULL CHECK (owner_id <> ''),
  channel TEXT NOT NULL CHECK (channel IN ('primary','literature_outline','dedicated_notes')),
  candidate_file_ref_id TEXT NOT NULL CHECK (candidate_file_ref_id <> ''),
  p4_permit_id TEXT NOT NULL CHECK (p4_permit_id <> ''),
  p4_operation_generation INTEGER NOT NULL CHECK (p4_operation_generation > 0),
  p4_process_generation TEXT NOT NULL CHECK (p4_process_generation <> ''),
  terminal_outcome_id TEXT NOT NULL CHECK (terminal_outcome_id <> ''),
  terminal_outcome_code TEXT NOT NULL CHECK (terminal_outcome_code IN (
    'TERMINAL_SUCCESS','TERMINAL_REJECT','TERMINAL_CANCEL',
    'RETRYABLE_PRESENTATION_FAILURE','STALE_OPERATION','STALE_PROCESS',
    'CONFLICTING_CALLBACK','UNKNOWN'
  )),
  terminal_outcome_revision INTEGER NOT NULL CHECK (terminal_outcome_revision > 0),
  finalization_request_id TEXT UNIQUE,
  acknowledgement_nonce TEXT UNIQUE,
  owner_instance_token TEXT,
  mount_token TEXT,
  lease_token TEXT,
  mount_generation INTEGER CHECK (mount_generation IS NULL OR mount_generation > 0),
  replacement_generation INTEGER CHECK (replacement_generation IS NULL OR replacement_generation >= 0),
  provisional_install_id TEXT UNIQUE,
  lifecycle_decision_id TEXT UNIQUE,
  lifecycle_decision TEXT CHECK (lifecycle_decision IS NULL OR lifecycle_decision IN (
    'prepared','installed','rejected','stale','owner_unavailable',
    'identity_mismatch','install_failed'
  )),
  lifecycle_decision_created_at TEXT,
  revoke_decision_id TEXT UNIQUE,
  revoke_decision_created_at TEXT,
  claim_token TEXT,
  claim_revision INTEGER CHECK (claim_revision IS NULL OR claim_revision >= 0),
  claim_process_generation TEXT,
  claim_generation INTEGER CHECK (claim_generation IS NULL OR claim_generation > 0),
  claim_namespace TEXT CHECK (claim_namespace IS NULL OR claim_namespace = 'save_as_finalization'),
  custody_at_finalization TEXT CHECK (
    custody_at_finalization IS NULL OR custody_at_finalization = 'outputs_lifecycle'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (finalization_request_id IS NULL AND acknowledgement_nonce IS NULL
      AND owner_instance_token IS NULL AND mount_token IS NULL AND lease_token IS NULL
      AND mount_generation IS NULL AND replacement_generation IS NULL
      AND finalization_state = 'presentation_completed')
    OR
    (finalization_request_id IS NOT NULL AND acknowledgement_nonce IS NOT NULL
      AND owner_instance_token IS NOT NULL AND mount_token IS NOT NULL AND lease_token IS NOT NULL
      AND mount_generation IS NOT NULL AND replacement_generation IS NOT NULL)
  ),
  CHECK (
    (claim_token IS NULL AND claim_revision IS NULL AND claim_process_generation IS NULL
      AND claim_generation IS NULL AND claim_namespace IS NULL)
    OR
    (claim_token IS NOT NULL AND claim_revision IS NOT NULL
      AND claim_process_generation IS NOT NULL AND claim_generation IS NOT NULL
      AND claim_namespace = 'save_as_finalization')
  ),
  CHECK (
    (finalization_state IN ('finalized','compensated','finalization_blocked')
      AND terminal_at IS NOT NULL)
    OR
    (finalization_state NOT IN ('finalized','compensated','finalization_blocked')
      AND terminal_at IS NULL)
  ),
  UNIQUE (p4_process_generation, p4_permit_id)
);
CREATE INDEX IF NOT EXISTS idx_save_as_finalizations_pending_order
ON manuscript_save_as_finalizations(updated_at, operation_id)
WHERE finalization_state IN (
  'presentation_completed','lifecycle_install_pending','lifecycle_prepared',
  'lifecycle_installed','finalization_pending','lifecycle_rejected',
  'revoke_pending','revoked','compensation_pending','finalization_blocked'
);
CREATE INDEX IF NOT EXISTS idx_save_as_finalizations_claim
ON manuscript_save_as_finalizations(claim_namespace, claim_process_generation, operation_id)
WHERE claim_token IS NOT NULL;
INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (47, 'save_as_lifecycle_finalization_atomicity');
INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (48, 'save_as_p4_exact_outcome_acceptance');
"#;

const COLUMNS: &str = "operation_id,revision,finalization_state,receipt_id,
owner_type,owner_id,channel,candidate_file_ref_id,p4_permit_id,
p4_operation_generation,p4_process_generation,terminal_outcome_id,
terminal_outcome_code,terminal_outcome_revision,finalization_request_id,
acknowledgement_nonce,owner_instance_token,mount_token,lease_token,mount_generation,
replacement_generation,provisional_install_id,lifecycle_decision_id,lifecycle_decision,
lifecycle_decision_created_at,revoke_decision_id,revoke_decision_created_at,
claim_token,claim_revision,claim_process_generation,claim_generation,claim_namespace,
custody_at_finalization,created_at,updated_at,terminal_at";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsFinalizationRecord {
    operation_id: String,
    revision: i64,
    finalization_state: String,
    receipt_id: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    candidate_file_ref_id: String,
    p4_permit_id: String,
    p4_operation_generation: i64,
    p4_process_generation: String,
    terminal_outcome_id: String,
    terminal_outcome_code: String,
    terminal_outcome_revision: i64,
    finalization_request_id: Option<String>,
    acknowledgement_nonce: Option<String>,
    owner_instance_token: Option<String>,
    mount_token: Option<String>,
    lease_token: Option<String>,
    mount_generation: Option<i64>,
    replacement_generation: Option<i64>,
    provisional_install_id: Option<String>,
    lifecycle_decision_id: Option<String>,
    lifecycle_decision: Option<String>,
    lifecycle_decision_created_at: Option<String>,
    revoke_decision_id: Option<String>,
    revoke_decision_created_at: Option<String>,
    claim_token: Option<String>,
    claim_revision: Option<i64>,
    claim_process_generation: Option<String>,
    claim_generation: Option<i64>,
    claim_namespace: Option<String>,
    custody_at_finalization: Option<String>,
    created_at: String,
    updated_at: String,
    terminal_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordPresentationCompletedInput {
    operation_id: String,
    expected_operation_revision: i64,
    receipt_id: String,
    permit_id: String,
    operation_generation: i64,
    process_generation: String,
    terminal_outcome_id: String,
    terminal_outcome_code: String,
    terminal_outcome_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueFinalizationRequestInput {
    operation_id: String,
    expected_finalization_revision: i64,
    receipt_id: String,
    owner_instance_token: String,
    mount_token: String,
    lease_token: String,
    mount_generation: i64,
    replacement_generation: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleDecisionReceipt {
    decision_version: i64,
    lifecycle_decision_id: String,
    finalization_request_id: String,
    acknowledgement_nonce: String,
    operation_id: String,
    receipt_id: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    candidate_file_ref_id: String,
    owner_instance_token: String,
    mount_token: String,
    lease_token: String,
    mount_generation: i64,
    replacement_generation: i64,
    provisional_install_id: String,
    decision: String,
    decision_created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordLifecycleDecisionInput {
    expected_finalization_revision: i64,
    claim_token: String,
    receipt: LifecycleDecisionReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinalizeOperationInput {
    operation_id: String,
    expected_finalization_revision: i64,
    claim_token: String,
    lifecycle_decision_id: String,
    provisional_install_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordRevokedDecisionInput {
    expected_finalization_revision: i64,
    claim_token: String,
    receipt: LifecycleDecisionReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteCompensationInput {
    operation_id: String,
    expected_finalization_revision: i64,
    claim_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimFinalizationInput {
    operation_id: String,
    expected_finalization_revision: i64,
    finalization_request_id: String,
    claim_generation: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContainInterruptedSaveAsInput {
    operation_id: String,
    expected_operation_revision: i64,
    expected_finalization_revision: i64,
    expected_custody_revision: i64,
    receipt_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContainPrePresentationMissingBindingInput {
    operation_id: String,
    expected_operation_revision: i64,
    expected_custody_revision: i64,
    receipt_id: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    source_file_ref_id: Option<String>,
    source_path_identity_key: String,
    target_file_ref_id: String,
    target_path_identity_key: String,
    expected_process_generation: String,
    expected_runtime_handle: String,
    expected_runtime_consumer_id: String,
    expected_runtime_generation: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrePresentationContainmentRecord {
    operation: SaveAsOperationRecord,
    custody: CandidateCustodyRecord,
    blocking_code: SaveAsFailureCode,
    source_proof_complete: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReconcileInterruptedSaveAsInput {
    operation_id: String,
    expected_operation_revision: i64,
    expected_finalization_revision: i64,
    expected_custody_revision: i64,
    receipt_id: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    source_file_ref_id: String,
    target_file_ref_id: String,
    target_path_identity_key: String,
}

fn now_after(previous: Option<&str>) -> String {
    let current = Utc::now();
    let timestamp = previous
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .filter(|value| *value >= current)
        .map(|value| value + chrono::Duration::milliseconds(1))
        .unwrap_or(current);
    timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SaveAsFinalizationRecord> {
    Ok(SaveAsFinalizationRecord {
        operation_id: row.get(0)?,
        revision: row.get(1)?,
        finalization_state: row.get(2)?,
        receipt_id: row.get(3)?,
        owner_type: row.get(4)?,
        owner_id: row.get(5)?,
        channel: row.get(6)?,
        candidate_file_ref_id: row.get(7)?,
        p4_permit_id: row.get(8)?,
        p4_operation_generation: row.get(9)?,
        p4_process_generation: row.get(10)?,
        terminal_outcome_id: row.get(11)?,
        terminal_outcome_code: row.get(12)?,
        terminal_outcome_revision: row.get(13)?,
        finalization_request_id: row.get(14)?,
        acknowledgement_nonce: row.get(15)?,
        owner_instance_token: row.get(16)?,
        mount_token: row.get(17)?,
        lease_token: row.get(18)?,
        mount_generation: row.get(19)?,
        replacement_generation: row.get(20)?,
        provisional_install_id: row.get(21)?,
        lifecycle_decision_id: row.get(22)?,
        lifecycle_decision: row.get(23)?,
        lifecycle_decision_created_at: row.get(24)?,
        revoke_decision_id: row.get(25)?,
        revoke_decision_created_at: row.get(26)?,
        claim_token: row.get(27)?,
        claim_revision: row.get(28)?,
        claim_process_generation: row.get(29)?,
        claim_generation: row.get(30)?,
        claim_namespace: row.get(31)?,
        custody_at_finalization: row.get(32)?,
        created_at: row.get(33)?,
        updated_at: row.get(34)?,
        terminal_at: row.get(35)?,
    })
}

pub(crate) fn readback_in_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<SaveAsFinalizationRecord>, String> {
    connection
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM manuscript_save_as_finalizations WHERE operation_id=?1"
            ),
            [operation_id],
            row_record,
        )
        .optional()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())
}

fn custody_identity(
    connection: &Connection,
    operation_id: &str,
) -> Result<(String, String, String, String, String, String), String> {
    connection
        .query_row(
            "SELECT receipt_id,owner_type,owner_id,channel,candidate_file_ref_id,
                    current_custody_authority
             FROM manuscript_save_as_candidate_custody WHERE operation_id=?1",
            [operation_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_CUSTODY_CONFLICT".to_string())
}

pub(crate) fn legacy_v47_schema_is_current(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='manuscript_save_as_finalizations'
           AND sql LIKE '%finalization_request_id%'
           AND sql LIKE '%save_as_finalization%'
           AND sql NOT LIKE '%p4_permit_id%'",
        [],
        |row| row.get(0),
    )?;
    let migration: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=47 AND name='save_as_lifecycle_finalization_atomicity'",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1 && migration == 1)
}

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    let has_final_stage: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='manuscript_save_as_operations'
           AND sql LIKE '%finalization_compensated%'",
        [],
        |row| row.get(0),
    )?;
    if has_final_stage == 0 {
        connection.execute_batch(
            "DROP INDEX IF EXISTS uq_manuscript_save_as_operations_active_target;
             DROP INDEX IF EXISTS idx_manuscript_save_as_operations_active_owner_channel_stage;
             DROP INDEX IF EXISTS idx_manuscript_save_as_operations_reconcilable_order;
             DROP INDEX IF EXISTS idx_manuscript_save_as_operations_target_file_ref;
             DROP INDEX IF EXISTS idx_save_as_candidate_custody_state;
             ALTER TABLE manuscript_save_as_candidate_custody
               RENAME TO manuscript_save_as_candidate_custody_v46;
             ALTER TABLE manuscript_save_as_operations
               RENAME TO manuscript_save_as_operations_v46;",
        )?;
        connection.execute_batch(manuscript_save_as_operation::SAVE_AS_OPERATION_SCHEMA_SQL)?;
        connection.execute(
            &format!(
                "INSERT INTO manuscript_save_as_operations ({cols})
                 SELECT {cols} FROM manuscript_save_as_operations_v46",
                cols = manuscript_save_as_operation::COLUMNS
            ),
            [],
        )?;
        connection.execute_batch(
            super::manuscript_save_as_candidate_custody::CANDIDATE_CUSTODY_SCHEMA_SQL,
        )?;
        connection.execute(
            &format!(
                "INSERT INTO manuscript_save_as_candidate_custody ({cols})
                 SELECT {cols} FROM manuscript_save_as_candidate_custody_v46",
                cols = super::manuscript_save_as_candidate_custody::COLUMNS
            ),
            [],
        )?;
        connection.execute_batch(
            "DROP TABLE manuscript_save_as_candidate_custody_v46;
             DROP TABLE manuscript_save_as_operations_v46;",
        )?;
    }
    let legacy_finalization: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='manuscript_save_as_finalizations'
           AND sql NOT LIKE '%p4_permit_id%'",
        [],
        |row| row.get(0),
    )?;
    if legacy_finalization == 1 {
        connection.execute_batch("DROP TABLE manuscript_save_as_finalizations;")?;
    }
    connection.execute_batch(FINALIZATION_SCHEMA_SQL)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='manuscript_save_as_finalizations'
           AND sql LIKE '%finalization_request_id%'
           AND sql LIKE '%acknowledgement_nonce%'
           AND sql LIKE '%provisional_install_id%'
           AND sql LIKE '%lifecycle_decision_id%'
           AND sql LIKE '%p4_permit_id%'
           AND sql LIKE '%terminal_outcome_id%'
           AND sql LIKE '%terminal_outcome_revision%'
           AND sql LIKE '%save_as_finalization%'",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
          'idx_save_as_finalizations_pending_order',
          'idx_save_as_finalizations_claim'
        )",
        [],
        |row| row.get(0),
    )?;
    let migration: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=48 AND name='save_as_p4_exact_outcome_acceptance'",
        [],
        |row| row.get(0),
    )?;
    let stage: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='manuscript_save_as_operations'
           AND sql LIKE '%finalization_compensated%'",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1 && indexes == 2 && migration == 1 && stage == 1)
}

fn record_presentation(
    connection: &mut Connection,
    input: &RecordPresentationCompletedInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if let Some(existing) = readback_in_connection(&transaction, &input.operation_id)? {
        if existing.receipt_id == input.receipt_id
            && existing.p4_permit_id == input.permit_id
            && existing.p4_operation_generation == input.operation_generation
            && existing.p4_process_generation == input.process_generation
            && existing.terminal_outcome_id == input.terminal_outcome_id
            && existing.terminal_outcome_code == input.terminal_outcome_code
            && existing.terminal_outcome_revision == input.terminal_outcome_revision
        {
            return Ok(existing);
        }
        return Err("SAVE_AS_P4_OUTCOME_ACCEPTANCE_CONFLICT".into());
    }
    let operation = manuscript_save_as_operation::readback_in_connection(
        &transaction,
        &input.operation_id,
    )
    .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?
    .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let (receipt_id, owner_type, owner_id, channel, file_ref_id, _) =
        custody_identity(&transaction, &input.operation_id)?;
    if operation.revision != input.expected_operation_revision
        || operation.stage != SaveAsOperationStage::P4PresentationPending
        || operation.operation_generation != input.operation_generation
        || operation.producer_process_generation != input.process_generation
        || operation.target_file_ref_id.as_deref() != Some(file_ref_id.as_str())
        || receipt_id != input.receipt_id
        || input.permit_id.trim().is_empty()
        || input.terminal_outcome_id.trim().is_empty()
        || input.terminal_outcome_code != "TERMINAL_SUCCESS"
        || input.terminal_outcome_revision <= 0
    {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let timestamp = now_after(Some(&operation.updated_at));
    transaction
        .execute(
            "INSERT INTO manuscript_save_as_finalizations (
             operation_id,revision,finalization_state,receipt_id,owner_type,owner_id,
             channel,candidate_file_ref_id,p4_permit_id,p4_operation_generation,
             p4_process_generation,terminal_outcome_id,terminal_outcome_code,
             terminal_outcome_revision,created_at,updated_at
             ) VALUES (?1,0,'presentation_completed',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)",
            params![
                input.operation_id,
                receipt_id,
                owner_type,
                owner_id,
                channel,
                file_ref_id,
                input.permit_id,
                input.operation_generation,
                input.process_generation,
                input.terminal_outcome_id,
                input.terminal_outcome_code,
                input.terminal_outcome_revision,
                timestamp
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

fn issue_request(
    connection: &mut Connection,
    input: &IssueFinalizationRequestInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let current = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    if current.finalization_request_id.is_some() {
        if current.receipt_id == input.receipt_id
            && current.owner_instance_token.as_deref() == Some(&input.owner_instance_token)
            && current.mount_token.as_deref() == Some(&input.mount_token)
            && current.lease_token.as_deref() == Some(&input.lease_token)
            && current.mount_generation == Some(input.mount_generation)
            && current.replacement_generation == Some(input.replacement_generation)
        {
            return Ok(current);
        }
        return Err("SAVE_AS_FINALIZATION_REQUEST_CONFLICT".into());
    }
    if current.revision != input.expected_finalization_revision
        || current.finalization_state != "presentation_completed"
        || current.receipt_id != input.receipt_id
        || input.mount_generation <= 0
        || input.replacement_generation < 0
    {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let request_id = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();
    let timestamp = now_after(Some(&current.updated_at));
    let changed = transaction
        .execute(
            "UPDATE manuscript_save_as_finalizations SET
             revision=revision+1,finalization_state='lifecycle_install_pending',
             finalization_request_id=?1,acknowledgement_nonce=?2,
             owner_instance_token=?3,mount_token=?4,lease_token=?5,
             mount_generation=?6,replacement_generation=?7,updated_at=?8
             WHERE operation_id=?9 AND revision=?10
               AND finalization_state='presentation_completed'",
            params![
                request_id,
                nonce,
                input.owner_instance_token,
                input.mount_token,
                input.lease_token,
                input.mount_generation,
                input.replacement_generation,
                timestamp,
                input.operation_id,
                input.expected_finalization_revision
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

fn validate_receipt(
    current: &SaveAsFinalizationRecord,
    receipt: &LifecycleDecisionReceipt,
) -> Result<(), String> {
    let decision_valid = matches!(
        receipt.decision.as_str(),
        "prepared"
            | "installed"
            | "rejected"
            | "stale"
            | "owner_unavailable"
            | "identity_mismatch"
            | "install_failed"
            | "revoked"
    );
    if receipt.decision_version != 1
        || !decision_valid
        || current.finalization_request_id.as_deref()
            != Some(receipt.finalization_request_id.as_str())
        || current.acknowledgement_nonce.as_deref()
            != Some(receipt.acknowledgement_nonce.as_str())
        || current.operation_id != receipt.operation_id
        || current.receipt_id != receipt.receipt_id
        || current.owner_type != receipt.owner_type
        || current.owner_id != receipt.owner_id
        || current.channel != receipt.channel
        || current.candidate_file_ref_id != receipt.candidate_file_ref_id
        || current.owner_instance_token.as_deref()
            != Some(receipt.owner_instance_token.as_str())
        || current.mount_token.as_deref() != Some(receipt.mount_token.as_str())
        || current.lease_token.as_deref() != Some(receipt.lease_token.as_str())
        || current.mount_generation != Some(receipt.mount_generation)
        || current.replacement_generation != Some(receipt.replacement_generation)
        || receipt.lifecycle_decision_id.is_empty()
        || receipt.provisional_install_id.is_empty()
    {
        return Err("SAVE_AS_LIFECYCLE_DECISION_IDENTITY_MISMATCH".into());
    }
    Ok(())
}

fn record_decision(
    connection: &mut Connection,
    input: &RecordLifecycleDecisionInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let current = readback_in_connection(&transaction, &input.receipt.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    validate_receipt(&current, &input.receipt)?;
    if current.lifecycle_decision_id.as_deref()
        == Some(input.receipt.lifecycle_decision_id.as_str())
        && current.provisional_install_id.as_deref()
            == Some(input.receipt.provisional_install_id.as_str())
        && current.lifecycle_decision.as_deref() == Some(input.receipt.decision.as_str())
    {
        return Ok(current);
    }
    if current.claim_token.as_deref() != Some(&input.claim_token)
        || current.revision != input.expected_finalization_revision
        || matches!(
            current.finalization_state.as_str(),
            "finalized" | "compensated" | "finalization_blocked"
        )
        || (current.lifecycle_decision_id.is_some()
            && current.lifecycle_decision_id.as_deref()
                != Some(input.receipt.lifecycle_decision_id.as_str()))
        || (current.provisional_install_id.is_some()
            && current.provisional_install_id.as_deref()
                != Some(input.receipt.provisional_install_id.as_str()))
    {
        return Err("SAVE_AS_LIFECYCLE_DECISION_CONFLICT".into());
    }
    let (state, decision) = match input.receipt.decision.as_str() {
        "prepared" => ("lifecycle_prepared", "prepared"),
        "installed" => ("lifecycle_installed", "installed"),
        "rejected" => ("lifecycle_rejected", "rejected"),
        "stale" => ("lifecycle_rejected", "stale"),
        "owner_unavailable" => ("lifecycle_rejected", "owner_unavailable"),
        "identity_mismatch" => ("lifecycle_rejected", "identity_mismatch"),
        "install_failed" => ("lifecycle_rejected", "install_failed"),
        _ => return Err("SAVE_AS_LIFECYCLE_DECISION_CONFLICT".into()),
    };
    let transition_is_valid = match input.receipt.decision.as_str() {
        "prepared" => {
            current.finalization_state == "lifecycle_install_pending"
                && current.lifecycle_decision.is_none()
        }
        "installed" => {
            current.finalization_state == "lifecycle_prepared"
                && current.lifecycle_decision.as_deref() == Some("prepared")
        }
        "rejected" | "stale" | "owner_unavailable" | "identity_mismatch"
        | "install_failed" => {
            matches!(
                current.finalization_state.as_str(),
                "lifecycle_install_pending" | "lifecycle_prepared"
            )
        }
        _ => false,
    };
    if !transition_is_valid {
        return Err("SAVE_AS_LIFECYCLE_DECISION_CONFLICT".into());
    }
    let timestamp = now_after(Some(&current.updated_at));
    let changed = transaction
        .execute(
            "UPDATE manuscript_save_as_finalizations SET
             revision=revision+1,finalization_state=?1,provisional_install_id=?2,
             lifecycle_decision_id=?3,lifecycle_decision=?4,
             lifecycle_decision_created_at=?5,updated_at=?6
             WHERE operation_id=?7 AND revision=?8 AND claim_token=?9",
            params![
                state,
                input.receipt.provisional_install_id,
                input.receipt.lifecycle_decision_id,
                decision,
                input.receipt.decision_created_at,
                timestamp,
                input.receipt.operation_id,
                input.expected_finalization_revision,
                input.claim_token
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.receipt.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

fn finalize(
    connection: &mut Connection,
    input: &FinalizeOperationInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let current = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    if current.finalization_state == "finalized" {
        return Ok(current);
    }
    let operation = manuscript_save_as_operation::readback_in_connection(
        &transaction,
        &input.operation_id,
    )
    .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?
    .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let (_, _, _, _, _, custody_authority) =
        custody_identity(&transaction, &input.operation_id)?;
    if current.revision != input.expected_finalization_revision
        || current.claim_token.as_deref() != Some(&input.claim_token)
        || current.finalization_state != "lifecycle_installed"
        || current.lifecycle_decision.as_deref() != Some("installed")
        || current.lifecycle_decision_id.as_deref()
            != Some(input.lifecycle_decision_id.as_str())
        || current.provisional_install_id.as_deref()
            != Some(input.provisional_install_id.as_str())
        || operation.stage != SaveAsOperationStage::P4PresentationPending
        || custody_authority != "outputs_lifecycle"
    {
        return Err("SAVE_AS_FINALIZATION_CUSTODY_CONFLICT".into());
    }
    let timestamp = now_after(Some(&current.updated_at));
    let changed_operation = transaction
        .execute(
            "UPDATE manuscript_save_as_operations SET revision=revision+1,
             stage='completed',updated_at=?1,terminal_at=?1
             WHERE operation_id=?2 AND revision=?3
               AND stage='p4_presentation_pending'",
            params![timestamp, operation.operation_id, operation.revision],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let changed_finalization = transaction
        .execute(
            "UPDATE manuscript_save_as_finalizations SET revision=revision+1,
             finalization_state='finalized',custody_at_finalization='outputs_lifecycle',
             updated_at=?1,terminal_at=?1
             WHERE operation_id=?2 AND revision=?3 AND claim_token=?4
               AND finalization_state='lifecycle_installed'",
            params![
                timestamp,
                input.operation_id,
                input.expected_finalization_revision,
                input.claim_token
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if changed_operation != 1 || changed_finalization != 1 {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

fn record_revoked(
    connection: &mut Connection,
    input: &RecordRevokedDecisionInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let current = readback_in_connection(&transaction, &input.receipt.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    validate_receipt(&current, &input.receipt)?;
    if current.revoke_decision_id.as_deref()
        == Some(input.receipt.lifecycle_decision_id.as_str())
        && current.finalization_state == "revoked"
    {
        return Ok(current);
    }
    if input.receipt.decision != "revoked"
        || current.revision != input.expected_finalization_revision
        || current.claim_token.as_deref() != Some(&input.claim_token)
        || current.provisional_install_id.as_deref()
            != Some(input.receipt.provisional_install_id.as_str())
        || current.finalization_state == "finalized"
    {
        return Err("SAVE_AS_LIFECYCLE_DECISION_CONFLICT".into());
    }
    let timestamp = now_after(Some(&current.updated_at));
    let changed = transaction
        .execute(
            "UPDATE manuscript_save_as_finalizations SET revision=revision+1,
             finalization_state='revoked',revoke_decision_id=?1,
             revoke_decision_created_at=?2,updated_at=?3
             WHERE operation_id=?4 AND revision=?5 AND claim_token=?6
               AND finalization_state IN (
                 'lifecycle_prepared','lifecycle_installed','lifecycle_rejected',
                 'revoke_pending'
               )",
            params![
                input.receipt.lifecycle_decision_id,
                input.receipt.decision_created_at,
                timestamp,
                input.receipt.operation_id,
                input.expected_finalization_revision,
                input.claim_token
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.receipt.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

fn complete_compensation(
    connection: &mut Connection,
    input: &CompleteCompensationInput,
    blocked: bool,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let current = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    if (!blocked && current.finalization_state == "compensated")
        || (blocked && current.finalization_state == "finalization_blocked")
    {
        return Ok(current);
    }
    let operation = manuscript_save_as_operation::readback_in_connection(
        &transaction,
        &input.operation_id,
    )
    .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?
    .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let custody_state: String = transaction
        .query_row(
            "SELECT custody_state FROM manuscript_save_as_candidate_custody
             WHERE operation_id=?1",
            [&input.operation_id],
            |row| row.get(0),
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_CUSTODY_CONFLICT".to_string())?;
    let resolved = matches!(
        custody_state.as_str(),
        "cleanup_resolved" | "process_generation_retired"
    );
    if current.revision != input.expected_finalization_revision
        || current.claim_token.as_deref() != Some(&input.claim_token)
        || operation.stage != SaveAsOperationStage::P4PresentationPending
        || (!blocked
            && (!resolved
                || !matches!(
                    current.finalization_state.as_str(),
                    "revoked" | "lifecycle_rejected"
                )))
        || (blocked && resolved)
    {
        return Err("SAVE_AS_FINALIZATION_CUSTODY_CONFLICT".into());
    }
    let timestamp = now_after(Some(&current.updated_at));
    let stage = if blocked {
        "reconciliation_blocked"
    } else {
        "finalization_compensated"
    };
    let state = if blocked {
        "finalization_blocked"
    } else {
        "compensated"
    };
    let reconciliation = if blocked { "blocked" } else { "resolved" };
    let blocking_code = if blocked {
        Some("SAVE_AS_OPERATION_STALE")
    } else {
        None
    };
    let changed_operation = transaction
        .execute(
            "UPDATE manuscript_save_as_operations SET revision=revision+1,
             stage=?1,reconciliation_state=?2,blocking_code=?3,
             updated_at=?4,terminal_at=?4
             WHERE operation_id=?5 AND revision=?6
               AND stage='p4_presentation_pending'",
            params![
                stage,
                reconciliation,
                blocking_code,
                timestamp,
                input.operation_id,
                operation.revision
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let changed_finalization = transaction
        .execute(
            "UPDATE manuscript_save_as_finalizations SET revision=revision+1,
             finalization_state=?1,updated_at=?2,terminal_at=?2
             WHERE operation_id=?3 AND revision=?4 AND claim_token=?5",
            params![
                state,
                timestamp,
                input.operation_id,
                input.expected_finalization_revision,
                input.claim_token
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if changed_operation != 1 || changed_finalization != 1 {
        return Err("SAVE_AS_FINALIZATION_REVISION_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

fn claim(
    connection: &mut Connection,
    input: &ClaimFinalizationInput,
    process_generation: &str,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let current = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    if current.finalization_request_id.as_deref()
        != Some(input.finalization_request_id.as_str())
        || input.claim_generation <= 0
        || matches!(
            current.finalization_state.as_str(),
            "finalized" | "compensated"
        )
    {
        return Err("SAVE_AS_FINALIZATION_CLAIM_CONFLICT".into());
    }
    if current.claim_process_generation.as_deref() == Some(process_generation)
        && current.claim_generation == Some(input.claim_generation)
        && current.claim_token.is_some()
    {
        return Ok(current);
    }
    if current.revision != input.expected_finalization_revision {
        return Err("SAVE_AS_FINALIZATION_CLAIM_CONFLICT".into());
    }
    if current.claim_token.is_some()
        && current.claim_process_generation.as_deref() == Some(process_generation)
    {
        return Err("SAVE_AS_FINALIZATION_CLAIM_CONFLICT".into());
    }
    let token = Uuid::new_v4().to_string();
    let timestamp = now_after(Some(&current.updated_at));
    let changed = transaction
        .execute(
            "UPDATE manuscript_save_as_finalizations SET revision=revision+1,
             claim_token=?1,claim_revision=revision+1,claim_process_generation=?2,
             claim_generation=?3,claim_namespace='save_as_finalization',updated_at=?4
             WHERE operation_id=?5 AND revision=?6",
            params![
                token,
                process_generation,
                input.claim_generation,
                timestamp,
                input.operation_id,
                input.expected_finalization_revision
            ],
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    if changed != 1 {
        return Err("SAVE_AS_FINALIZATION_CLAIM_CONFLICT".into());
    }
    let record = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(record)
}

pub(crate) fn list_pending_in_connection(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SaveAsFinalizationRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM manuscript_save_as_finalizations
             WHERE finalization_state IN (
               'presentation_completed','lifecycle_install_pending','lifecycle_prepared',
               'lifecycle_installed','finalization_pending','lifecycle_rejected',
               'revoke_pending','revoked','compensation_pending'
             )
               AND NOT EXISTS (
                 SELECT 1 FROM manuscript_save_as_operations AS operation
                 WHERE operation.operation_id=manuscript_save_as_finalizations.operation_id
                   AND operation.stage IN ('reconciliation_blocked','finalization_compensated')
               )
             ORDER BY updated_at ASC, operation_id COLLATE BINARY ASC LIMIT ?1"
        ))
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let records = statement
        .query_map([limit.clamp(1, 1_000)], row_record)
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(records)
}

pub(crate) fn list_interrupted_in_connection(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SaveAsFinalizationRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT finalization.operation_id FROM manuscript_save_as_finalizations AS finalization
             JOIN manuscript_save_as_operations AS operation
               ON operation.operation_id=finalization.operation_id
             JOIN manuscript_save_as_candidate_custody AS custody
               ON custody.operation_id=finalization.operation_id
             WHERE finalization.finalization_state='presentation_completed'
               AND operation.stage='reconciliation_blocked'
               AND operation.reconciliation_state='blocked'
               AND operation.blocking_code='SAVE_AS_OPERATION_STALE'
               AND custody.current_custody_authority='resolved'
               AND custody.custody_state='process_generation_retired'
             ORDER BY finalization.updated_at ASC,
                      finalization.operation_id COLLATE BINARY ASC LIMIT ?1"
        )
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    let operation_ids = statement
        .query_map([limit.clamp(1, 1_000)], |row| row.get::<_, String>(0))
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string())?;
    operation_ids.into_iter().map(|operation_id| {
        readback_in_connection(connection, &operation_id)?.ok_or_else(|| {
            "SAVE_AS_FINALIZATION_RESPONSE_UNKNOWN".to_string()
        })
    }).collect()
}

fn contain_pre_presentation_missing_binding(
    connection: &mut Connection,
    input: &ContainPrePresentationMissingBindingInput,
    current_process_generation: &str,
) -> Result<PrePresentationContainmentRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    let operation = manuscript_save_as_operation::readback_in_connection(
        &transaction,
        &input.operation_id,
    )
    .map_err(|_| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?
    .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let custody = super::manuscript_save_as_candidate_custody::readback_in_connection(
        &transaction,
        &input.operation_id,
    )?
    .ok_or_else(|| "SAVE_AS_CUSTODY_NOT_FOUND".to_string())?;
    let finalization_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM manuscript_save_as_finalizations WHERE operation_id=?1",
            [&input.operation_id],
            |row| row.get(0),
        )
        .map_err(|_| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    if finalization_count != 0 {
        return Err("SAVE_AS_WINDOW_P_FINALIZATION_ALREADY_EXISTS".into());
    }
    let immutable_identity_matches = operation.operation_id == input.operation_id
        && operation.operation_generation == custody.operation_generation
        && operation.producer_process_generation == input.expected_process_generation
        && custody.process_generation == input.expected_process_generation
        && operation.owner_type == input.owner_type
        && operation.owner_id == input.owner_id
        && operation.channel == input.channel
        && custody.owner_type == input.owner_type
        && custody.owner_id == input.owner_id
        && custody.channel == input.channel
        && operation.source_file_ref_id == input.source_file_ref_id
        && operation.source_path_identity_key == input.source_path_identity_key
        && operation.target_file_ref_id.as_deref() == Some(input.target_file_ref_id.as_str())
        && operation.target_path_identity_key == input.target_path_identity_key
        && custody.candidate_file_ref_id == input.target_file_ref_id
        && custody.receipt_id == input.receipt_id;
    if !immutable_identity_matches {
        return Err("SAVE_AS_WINDOW_P_CONTAINMENT_IDENTITY_CONFLICT".into());
    }
    let target_proof: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM file_refs
             WHERE id=?1 AND owner_type=?2 AND owner_id=?3 AND manuscript_channel=?4
               AND resource_kind='file' AND file_role='manuscript'
               AND path_identity_key=?5 AND deleted_at IS NULL",
            params![
                input.target_file_ref_id,
                input.owner_type,
                input.owner_id,
                input.channel,
                input.target_path_identity_key
            ],
            |row| row.get(0),
        )
        .map_err(|_| "SAVE_AS_WINDOW_P_TARGET_PROOF_FAILED".to_string())?;
    if target_proof != 1 {
        return Err("SAVE_AS_WINDOW_P_TARGET_IDENTITY_CONFLICT".into());
    }
    let source_proof_count = transaction
        .query_row(
            "SELECT COUNT(*) FROM file_refs
             WHERE (?1 IS NULL OR id=?1)
               AND owner_type=?2 AND owner_id=?3 AND manuscript_channel=?4
               AND resource_kind='file' AND file_role='manuscript'
               AND path_identity_key=?5 AND deleted_at IS NULL",
            params![
                input.source_file_ref_id,
                input.owner_type,
                input.owner_id,
                input.channel,
                input.source_path_identity_key
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "SAVE_AS_WINDOW_P_SOURCE_PROOF_FAILED".to_string())?;
    let source_proof_complete = source_proof_count == 1;
    let blocking_code = if source_proof_complete {
        SaveAsFailureCode::SaveAsRuntimeGenerationStale
    } else {
        SaveAsFailureCode::SaveAsSourceSnapshotInvalid
    };

    let already_contained = operation.stage == SaveAsOperationStage::ReconciliationBlocked
        && operation.reconciliation_state.as_str() == "blocked"
        && operation.blocking_code == Some(blocking_code)
        && custody.current_custody_authority == "resolved"
        && custody.custody_state == "process_generation_retired"
        && custody.runtime_handle.is_none();
    if already_contained {
        return Ok(PrePresentationContainmentRecord {
            operation,
            custody,
            blocking_code,
            source_proof_complete,
        });
    }
    if operation.revision != input.expected_operation_revision
        || custody.revision != input.expected_custody_revision
        || operation.stage != SaveAsOperationStage::P4PresentationPending
        || operation.reconciliation_state.as_str() != "resolved"
        || operation.terminal_at.is_some()
        || custody.current_custody_authority != "r3_authority"
        || custody.custody_state != "activated_held"
        || custody.runtime_handle.as_deref() != Some(input.expected_runtime_handle.as_str())
        || custody.runtime_consumer_id != input.expected_runtime_consumer_id
        || custody.runtime_generation != Some(input.expected_runtime_generation)
    {
        return Err("SAVE_AS_WINDOW_P_CONTAINMENT_STATE_CONFLICT".into());
    }
    if input.expected_process_generation == current_process_generation {
        return Err("SAVE_AS_WINDOW_P_PROCESS_STILL_CURRENT".into());
    }

    let previous_updated_at = if operation.updated_at > custody.updated_at {
        operation.updated_at.as_str()
    } else {
        custody.updated_at.as_str()
    };
    let timestamp = now_after(Some(previous_updated_at));
    let changed_operation = transaction
        .execute(
            "UPDATE manuscript_save_as_operations SET revision=revision+1,
             stage='reconciliation_blocked',reconciliation_state='blocked',
             blocking_code=?1,updated_at=?2,terminal_at=?2
             WHERE operation_id=?3 AND revision=?4 AND stage='p4_presentation_pending'
               AND reconciliation_state='resolved' AND terminal_at IS NULL",
            params![
                blocking_code.as_str(),
                timestamp,
                input.operation_id,
                input.expected_operation_revision
            ],
        )
        .map_err(|error| format!("SAVE_AS_WINDOW_P_CONTAINMENT_OPERATION_FAILED:{error}"))?;
    let changed_custody = transaction
        .execute(
            "UPDATE manuscript_save_as_candidate_custody SET revision=revision+1,
             current_custody_authority='resolved',custody_state='process_generation_retired',
             runtime_handle=NULL,cleanup_claim_token=NULL,last_attempt_at=?1,
             final_close_result='process_generation_retired',
             resolved_reason='process_generation_retired',updated_at=?1,resolved_at=?1
             WHERE operation_id=?2 AND revision=?3 AND receipt_id=?4
               AND current_custody_authority='r3_authority'
               AND custody_state='activated_held' AND runtime_handle=?5
               AND runtime_consumer_id=?6 AND runtime_generation=?7",
            params![
                timestamp,
                input.operation_id,
                input.expected_custody_revision,
                input.receipt_id,
                input.expected_runtime_handle,
                input.expected_runtime_consumer_id,
                input.expected_runtime_generation
            ],
        )
        .map_err(|error| format!("SAVE_AS_WINDOW_P_CONTAINMENT_CUSTODY_FAILED:{error}"))?;
    if changed_operation != 1 || changed_custody != 1 {
        return Err("SAVE_AS_WINDOW_P_CONTAINMENT_REVISION_CONFLICT".into());
    }
    let contained_operation = manuscript_save_as_operation::readback_in_connection(
        &transaction,
        &input.operation_id,
    )
    .map_err(|_| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?
    .ok_or_else(|| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    let contained_custody = super::manuscript_save_as_candidate_custody::readback_in_connection(
        &transaction,
        &input.operation_id,
    )?
    .ok_or_else(|| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    transaction
        .commit()
        .map_err(|_| "SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    Ok(PrePresentationContainmentRecord {
        operation: contained_operation,
        custody: contained_custody,
        blocking_code,
        source_proof_complete,
    })
}

fn contain_interrupted(
    connection: &mut Connection,
    input: &ContainInterruptedSaveAsInput,
    current_process_generation: &str,
) -> Result<Option<SaveAsFinalizationRecord>, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_INTERRUPTED_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    let operation = manuscript_save_as_operation::readback_in_connection(
        &transaction,
        &input.operation_id,
    )
    .map_err(|_| "SAVE_AS_INTERRUPTED_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?
    .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let finalization = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    if operation.stage == SaveAsOperationStage::ReconciliationBlocked
        && finalization.finalization_state == "presentation_completed"
    {
        return Ok(Some(finalization));
    }
    if operation.revision != input.expected_operation_revision
        || finalization.revision != input.expected_finalization_revision
        || finalization.receipt_id != input.receipt_id
    {
        return Err("SAVE_AS_INTERRUPTED_CONTAINMENT_REVISION_CONFLICT".into());
    }
    let custody = super::manuscript_save_as_candidate_custody::readback_in_connection(
        &transaction,
        &input.operation_id,
    )?
    .ok_or_else(|| "SAVE_AS_CUSTODY_NOT_FOUND".to_string())?;
    if operation.stage != SaveAsOperationStage::P4PresentationPending
        || operation.source_file_ref_id.is_none()
        || operation.target_file_ref_id.is_none()
        || finalization.finalization_state != "presentation_completed"
        || finalization.receipt_id != custody.receipt_id
        || finalization.owner_type != operation.owner_type
        || finalization.owner_id != operation.owner_id
        || finalization.channel != operation.channel
        || finalization.candidate_file_ref_id != operation.target_file_ref_id.as_deref().unwrap_or("")
        || custody.revision != input.expected_custody_revision
        || custody.operation_generation != operation.operation_generation
        || custody.process_generation != operation.producer_process_generation
        || custody.owner_type != operation.owner_type
        || custody.owner_id != operation.owner_id
        || custody.channel != operation.channel
        || custody.candidate_file_ref_id != operation.target_file_ref_id.as_deref().unwrap_or("")
    {
        return Err("SAVE_AS_INTERRUPTED_CONTAINMENT_IDENTITY_CONFLICT".into());
    }
    if operation.producer_process_generation == current_process_generation
        || finalization.p4_process_generation == current_process_generation
        || custody.process_generation == current_process_generation
    {
        return Ok(None);
    }
    let timestamp = now_after(Some(&finalization.updated_at));
    let changed_operation = transaction.execute(
        "UPDATE manuscript_save_as_operations SET revision=revision+1,
         stage='reconciliation_blocked',reconciliation_state='blocked',
         blocking_code='SAVE_AS_OPERATION_STALE',updated_at=?1,terminal_at=?1
         WHERE operation_id=?2 AND revision=?3 AND stage='p4_presentation_pending'",
        params![timestamp, input.operation_id, input.expected_operation_revision],
    ).map_err(|error| format!("SAVE_AS_INTERRUPTED_CONTAINMENT_OPERATION_FAILED:{error}"))?;
    let changed_custody = transaction.execute(
        "UPDATE manuscript_save_as_candidate_custody SET revision=revision+1,
         current_custody_authority='resolved',custody_state='process_generation_retired',
         runtime_handle=NULL,cleanup_claim_token=NULL,last_attempt_at=?1,
         final_close_result='process_generation_retired',
         resolved_reason='process_generation_retired',updated_at=?1,resolved_at=?1
         WHERE operation_id=?2 AND revision=?3 AND receipt_id=?4
           AND custody_state NOT IN ('cleanup_resolved','process_generation_retired')",
        params![timestamp, input.operation_id, input.expected_custody_revision, input.receipt_id],
    ).map_err(|error| format!("SAVE_AS_INTERRUPTED_CONTAINMENT_CUSTODY_FAILED:{error}"))?;
    if changed_operation != 1 || changed_custody != 1 {
        return Err("SAVE_AS_INTERRUPTED_CONTAINMENT_REVISION_CONFLICT".into());
    }
    let contained = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_INTERRUPTED_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    transaction.commit()
        .map_err(|_| "SAVE_AS_INTERRUPTED_CONTAINMENT_RESPONSE_UNKNOWN".to_string())?;
    Ok(Some(contained))
}

fn reconcile_interrupted_preserving_target(
    connection: &mut Connection,
    input: &ReconcileInterruptedSaveAsInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "SAVE_AS_INTERRUPTED_RECONCILIATION_RESPONSE_UNKNOWN".to_string())?;
    let operation = manuscript_save_as_operation::readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| "SAVE_AS_INTERRUPTED_RECONCILIATION_RESPONSE_UNKNOWN".to_string())?
        .ok_or_else(|| "SAVE_AS_OPERATION_NOT_FOUND".to_string())?;
    let finalization = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_FINALIZATION_NOT_FOUND".to_string())?;
    if operation.stage == SaveAsOperationStage::FinalizationCompensated
        && finalization.finalization_state == "presentation_completed"
    {
        return Ok(finalization);
    }
    let custody = super::manuscript_save_as_candidate_custody::readback_in_connection(
        &transaction,
        &input.operation_id,
    )?.ok_or_else(|| "SAVE_AS_CUSTODY_NOT_FOUND".to_string())?;
    if operation.revision != input.expected_operation_revision
        || finalization.revision != input.expected_finalization_revision
        || custody.revision != input.expected_custody_revision
        || finalization.receipt_id != input.receipt_id
        || custody.receipt_id != input.receipt_id
        || operation.owner_type != input.owner_type
        || operation.owner_id != input.owner_id
        || operation.channel != input.channel
        || operation.source_file_ref_id.as_deref() != Some(input.source_file_ref_id.as_str())
        || operation.target_file_ref_id.as_deref() != Some(input.target_file_ref_id.as_str())
        || operation.target_path_identity_key != input.target_path_identity_key
        || operation.stage != SaveAsOperationStage::ReconciliationBlocked
        || finalization.finalization_state != "presentation_completed"
        || custody.custody_state != "process_generation_retired"
        || custody.current_custody_authority != "resolved"
    {
        return Err("SAVE_AS_INTERRUPTED_RECONCILIATION_IDENTITY_CONFLICT".into());
    }
    let timestamp = now_after(Some(&finalization.updated_at));
    let changed_operation = transaction.execute(
        "UPDATE manuscript_save_as_operations SET revision=revision+1,
         stage='finalization_compensated',reconciliation_state='resolved',
         blocking_code=NULL,updated_at=?1,terminal_at=?1
         WHERE operation_id=?2 AND revision=?3 AND stage='reconciliation_blocked'",
        params![timestamp, input.operation_id, input.expected_operation_revision],
    ).map_err(|_| "SAVE_AS_INTERRUPTED_RECONCILIATION_RESPONSE_UNKNOWN".to_string())?;
    if changed_operation != 1 {
        return Err("SAVE_AS_INTERRUPTED_RECONCILIATION_REVISION_CONFLICT".into());
    }
    let reconciled = readback_in_connection(&transaction, &input.operation_id)?
        .ok_or_else(|| "SAVE_AS_INTERRUPTED_RECONCILIATION_RESPONSE_UNKNOWN".to_string())?;
    transaction.commit()
        .map_err(|_| "SAVE_AS_INTERRUPTED_RECONCILIATION_RESPONSE_UNKNOWN".to_string())?;
    Ok(reconciled)
}

#[tauri::command]
pub(crate) fn record_save_as_presentation_completed(
    app_handle: AppHandle,
    input: RecordPresentationCompletedInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    record_presentation(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn issue_save_as_finalization_request(
    app_handle: AppHandle,
    input: IssueFinalizationRequestInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    issue_request(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn readback_save_as_finalization(
    app_handle: AppHandle,
    operation_id: String,
) -> Result<Option<SaveAsFinalizationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    readback_in_connection(&connection, &operation_id)
}

#[tauri::command]
pub(crate) fn list_pending_save_as_finalizations(
    app_handle: AppHandle,
    limit: u32,
) -> Result<Vec<SaveAsFinalizationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_pending_in_connection(&connection, limit)
}

#[tauri::command]
pub(crate) fn list_interrupted_save_as_finalizations(
    app_handle: AppHandle,
    limit: u32,
) -> Result<Vec<SaveAsFinalizationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_interrupted_in_connection(&connection, limit)
}

#[tauri::command]
pub(crate) fn contain_pre_presentation_missing_binding_save_as(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: ContainPrePresentationMissingBindingInput,
) -> Result<PrePresentationContainmentRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    contain_pre_presentation_missing_binding(
        &mut connection,
        &input,
        authority.process_generation(),
    )
}

#[tauri::command]
pub(crate) fn contain_interrupted_save_as_finalization(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: ContainInterruptedSaveAsInput,
) -> Result<Option<SaveAsFinalizationRecord>, String> {
    let mut connection = super::open_connection(&app_handle)?;
    contain_interrupted(&mut connection, &input, authority.process_generation())
}

#[tauri::command]
pub(crate) fn reconcile_interrupted_save_as_preserving_target(
    app_handle: AppHandle,
    input: ReconcileInterruptedSaveAsInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    reconcile_interrupted_preserving_target(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn claim_save_as_finalization(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: ClaimFinalizationInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    claim(&mut connection, &input, authority.process_generation())
}

#[tauri::command]
pub(crate) fn record_save_as_lifecycle_decision(
    app_handle: AppHandle,
    input: RecordLifecycleDecisionInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    record_decision(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn finalize_save_as_operation(
    app_handle: AppHandle,
    input: FinalizeOperationInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    finalize(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn record_save_as_revoked_decision(
    app_handle: AppHandle,
    input: RecordRevokedDecisionInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    record_revoked(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn complete_save_as_finalization_compensation(
    app_handle: AppHandle,
    input: CompleteCompensationInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    complete_compensation(&mut connection, &input, false)
}

#[tauri::command]
pub(crate) fn block_save_as_finalization(
    app_handle: AppHandle,
    input: CompleteCompensationInput,
) -> Result<SaveAsFinalizationRecord, String> {
    let mut connection = super::open_connection(&app_handle)?;
    complete_compensation(&mut connection, &input, true)
}

#[cfg(test)]
pub(crate) fn f6_record_presentation_in_connection(
    connection: &mut Connection,
    input: &RecordPresentationCompletedInput,
) -> Result<SaveAsFinalizationRecord, String> {
    record_presentation(connection, input)
}

#[cfg(test)]
pub(crate) fn f6_issue_request_in_connection(
    connection: &mut Connection,
    input: &IssueFinalizationRequestInput,
) -> Result<SaveAsFinalizationRecord, String> {
    issue_request(connection, input)
}

#[cfg(test)]
pub(crate) fn f6_claim_in_connection(
    connection: &mut Connection,
    input: &ClaimFinalizationInput,
    process_generation: &str,
) -> Result<SaveAsFinalizationRecord, String> {
    claim(connection, input, process_generation)
}

#[cfg(test)]
pub(crate) fn f6_record_decision_in_connection(
    connection: &mut Connection,
    input: &RecordLifecycleDecisionInput,
) -> Result<SaveAsFinalizationRecord, String> {
    record_decision(connection, input)
}

#[cfg(test)]
pub(crate) fn f6_finalize_in_connection(
    connection: &mut Connection,
    input: &FinalizeOperationInput,
) -> Result<SaveAsFinalizationRecord, String> {
    finalize(connection, input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::manuscript_save_as_candidate_custody;
    use crate::db::manuscript_save_as_operation::{
        SaveAsCommitState, SaveAsOperationRecord, SaveAsReconciliationState,
    };

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT DEFAULT CURRENT_TIMESTAMP
             );",
        ).unwrap();
        manuscript_save_as_operation::apply_schema_migration(&connection).unwrap();
        manuscript_save_as_candidate_custody::apply_schema_migration(&connection).unwrap();
        apply_schema_migration(&connection).unwrap();
        connection.execute_batch(
            "CREATE TABLE file_refs (
               id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
               manuscript_channel TEXT NOT NULL, resource_kind TEXT NOT NULL,
               file_role TEXT NOT NULL, path_identity_key TEXT NOT NULL, deleted_at TEXT
             );",
        ).unwrap();
        connection
    }

    fn operation(id: &str, updated_at: &str) -> SaveAsOperationRecord {
        SaveAsOperationRecord {
            operation_id: id.into(),
            revision: 8,
            commit_fence_revision: 8,
            operation_generation: 1,
            producer_process_generation: "process-1".into(),
            owner_type: "resultItem".into(),
            owner_id: "owner-1".into(),
            channel: "primary".into(),
            source_window_role: "independent".into(),
            source_file_ref_id: Some("source".into()),
            source_path_identity_key: "n:/source.md".into(),
            source_revision: "source-r1".into(),
            source_runtime_generation: 1,
            snapshot_sha256: "a".repeat(64),
            snapshot_byte_length: 1,
            encoding_contract_version: "utf-8-v1".into(),
            newline_contract_version: "none-v1".into(),
            target_display_path: "N:\\target.md".into(),
            target_path_identity_key: format!("n:/{id}.md"),
            target_location_mode: "managed".into(),
            target_parent_path_identity_key: "n:/".into(),
            target_parent_physical_identity_hash: "b".repeat(64),
            d1_physical_identity_hash: Some("c".repeat(64)),
            d1_readback_sha256: Some("a".repeat(64)),
            d1_readback_revision: Some("target-r1".into()),
            d1_byte_length: Some(1),
            d1_proof_generation: Some(1),
            target_file_ref_id: Some(format!("file-{id}")),
            d2_readback_revision: Some("file-r1".into()),
            containment_fence_token: None,
            reconciliation_result_code: None,
            reconciliation_resolved_at: None,
            stage: SaveAsOperationStage::P4PresentationPending,
            d1_commit_state: SaveAsCommitState::Confirmed,
            d2_commit_state: SaveAsCommitState::Confirmed,
            reconciliation_state: SaveAsReconciliationState::Resolved,
            blocking_code: None,
            claim_token: Some("claim".into()),
            claim_revision: Some(0),
            claim_process_generation: Some("process-1".into()),
            observation_generation: Some(0),
            observation_revision: Some(0),
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
            terminal_at: None,
        }
    }

    fn seed(connection: &mut Connection, id: &str, updated_at: &str) {
        let record = operation(id, updated_at);
        let mut initial = record.clone();
        initial.revision = 0;
        initial.commit_fence_revision = 0;
        initial.stage = SaveAsOperationStage::PreD1Claimed;
        initial.d1_commit_state = SaveAsCommitState::NotStarted;
        initial.d2_commit_state = SaveAsCommitState::NotStarted;
        initial.reconciliation_state = SaveAsReconciliationState::NotRequired;
        initial.d1_physical_identity_hash = None;
        initial.d1_readback_sha256 = None;
        initial.d1_readback_revision = None;
        initial.d1_byte_length = None;
        initial.d1_proof_generation = None;
        initial.target_file_ref_id = None;
        initial.d2_readback_revision = None;
        manuscript_save_as_operation::create_in_connection(connection, &initial).unwrap();
        connection.execute(
            "UPDATE manuscript_save_as_operations SET
             revision=8,stage='p4_presentation_pending',
             d1_commit_state='confirmed',d2_commit_state='confirmed',
             reconciliation_state='resolved',d1_physical_identity_hash=?1,
             d1_readback_sha256=?2,d1_readback_revision=?3,d1_byte_length=1,
             d1_proof_generation=1,target_file_ref_id=?4,d2_readback_revision='file-r1',
             updated_at=?5
             WHERE operation_id=?6",
            params![
                "c".repeat(64),
                "a".repeat(64),
                "target-r1",
                format!("file-{id}"),
                updated_at,
                id
            ],
        ).unwrap();
        connection.execute(
            "INSERT OR IGNORE INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               path_identity_key,deleted_at
             ) VALUES ('source','resultItem','owner-1','primary','file','manuscript',
               'n:/source.md',NULL)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               path_identity_key,deleted_at
             ) VALUES (?1,'resultItem','owner-1','primary','file','manuscript',?2,NULL)",
            params![format!("file-{id}"), format!("n:/{id}.md")],
        ).unwrap();
        connection.execute(
            "INSERT INTO manuscript_save_as_candidate_custody (
             operation_id,revision,receipt_version,receipt_id,operation_generation,
             process_generation,owner_type,owner_id,channel,candidate_file_ref_id,
             candidate_role,runtime_handle,runtime_consumer_id,runtime_generation,
             activation_authority,current_custody_authority,custody_state,
             initial_automatic_attempt_count,explicit_cleanup_cycle_count,total_close_attempt_count,
             created_at,updated_at
             ) VALUES (?1,2,1,?2,1,'process-1','resultItem','owner-1','primary',?3,
             'save_as_target','runtime','consumer',1,'r3_authority','outputs_lifecycle',
             'transferred',0,0,0,?4,?4)",
            params![id, format!("receipt-{id}"), format!("file-{id}"), updated_at],
        ).unwrap();
    }

    fn requested(connection: &mut Connection, id: &str) -> SaveAsFinalizationRecord {
        let presented = record_presentation(connection, &RecordPresentationCompletedInput {
            operation_id: id.into(),
            expected_operation_revision: 8,
            receipt_id: format!("receipt-{id}"),
            permit_id: format!("permit-{id}"),
            operation_generation: 1,
            process_generation: "process-1".into(),
            terminal_outcome_id: format!("outcome-{id}"),
            terminal_outcome_code: "TERMINAL_SUCCESS".into(),
            terminal_outcome_revision: 1,
        }).unwrap();
        issue_request(connection, &IssueFinalizationRequestInput {
            operation_id: id.into(),
            expected_finalization_revision: presented.revision,
            receipt_id: presented.receipt_id.clone(),
            owner_instance_token: "instance".into(),
            mount_token: "mount".into(),
            lease_token: "lease".into(),
            mount_generation: 1,
            replacement_generation: 0,
        }).unwrap()
    }

    fn prepare_window_p_owner(
        connection: &Connection,
        operation_id: &str,
        owner_type: &str,
        owner_id: &str,
        channel: &str,
    ) {
        connection.execute(
            "UPDATE manuscript_save_as_operations
             SET owner_type=?1,owner_id=?2,channel=?3 WHERE operation_id=?4",
            params![owner_type, owner_id, channel, operation_id],
        ).unwrap();
        connection.execute(
            "UPDATE manuscript_save_as_candidate_custody
             SET owner_type=?1,owner_id=?2,channel=?3,
                 current_custody_authority='r3_authority',custody_state='activated_held'
             WHERE operation_id=?4",
            params![owner_type, owner_id, channel, operation_id],
        ).unwrap();
        connection.execute(
            "UPDATE file_refs SET owner_type=?1,owner_id=?2,manuscript_channel=?3
             WHERE id='source' OR id=?4",
            params![owner_type, owner_id, channel, format!("file-{operation_id}")],
        ).unwrap();
    }

    fn window_p_input(
        operation_id: &str,
        owner_type: &str,
        owner_id: &str,
        channel: &str,
    ) -> ContainPrePresentationMissingBindingInput {
        ContainPrePresentationMissingBindingInput {
            operation_id: operation_id.into(),
            expected_operation_revision: 8,
            expected_custody_revision: 2,
            receipt_id: format!("receipt-{operation_id}"),
            owner_type: owner_type.into(),
            owner_id: owner_id.into(),
            channel: channel.into(),
            source_file_ref_id: Some("source".into()),
            source_path_identity_key: "n:/source.md".into(),
            target_file_ref_id: format!("file-{operation_id}"),
            target_path_identity_key: format!("n:/{operation_id}.md"),
            expected_process_generation: "process-1".into(),
            expected_runtime_handle: "runtime".into(),
            expected_runtime_consumer_id: "consumer".into(),
            expected_runtime_generation: 1,
        }
    }

    fn fresh_operation(
        operation_id: &str,
        source_file_ref_id: Option<&str>,
        source_path_identity_key: &str,
    ) -> SaveAsOperationRecord {
        let mut record = operation(operation_id, "2026-08-04T01:00:00.000Z");
        record.revision = 0;
        record.commit_fence_revision = 0;
        record.stage = SaveAsOperationStage::PreD1Claimed;
        record.d1_commit_state = SaveAsCommitState::NotStarted;
        record.d2_commit_state = SaveAsCommitState::NotStarted;
        record.reconciliation_state = SaveAsReconciliationState::NotRequired;
        record.d1_physical_identity_hash = None;
        record.d1_readback_sha256 = None;
        record.d1_readback_revision = None;
        record.d1_byte_length = None;
        record.d1_proof_generation = None;
        record.target_file_ref_id = None;
        record.d2_readback_revision = None;
        record.source_file_ref_id = source_file_ref_id.map(str::to_string);
        record.source_path_identity_key = source_path_identity_key.into();
        record.claim_token = Some(format!("claim-{operation_id}"));
        record.claim_revision = Some(0);
        record.observation_generation = Some(0);
        record.observation_revision = Some(0);
        record
    }

    #[test]
    fn request_claim_decision_and_finalize_are_one_authority_transaction() {
        let mut connection = database();
        seed(&mut connection, "operation-a", "2026-07-30T00:00:00.000Z");
        let presented = record_presentation(&mut connection, &RecordPresentationCompletedInput {
            operation_id: "operation-a".into(),
            expected_operation_revision: 8,
            receipt_id: "receipt-operation-a".into(),
            permit_id: "permit-operation-a".into(),
            operation_generation: 1,
            process_generation: "process-1".into(),
            terminal_outcome_id: "outcome-operation-a".into(),
            terminal_outcome_code: "TERMINAL_SUCCESS".into(),
            terminal_outcome_revision: 1,
        }).unwrap();
        let requested = issue_request(&mut connection, &IssueFinalizationRequestInput {
            operation_id: "operation-a".into(),
            expected_finalization_revision: presented.revision,
            receipt_id: presented.receipt_id.clone(),
            owner_instance_token: "instance".into(),
            mount_token: "mount".into(),
            lease_token: "lease".into(),
            mount_generation: 1,
            replacement_generation: 0,
        }).unwrap();
        let claimed = claim(&mut connection, &ClaimFinalizationInput {
            operation_id: "operation-a".into(),
            expected_finalization_revision: requested.revision,
            finalization_request_id: requested.finalization_request_id.clone().unwrap(),
            claim_generation: 1,
        }, "process-1").unwrap();
        let decision_id = Uuid::new_v4().to_string();
        let provisional_id = Uuid::new_v4().to_string();
        let base = LifecycleDecisionReceipt {
            decision_version: 1,
            lifecycle_decision_id: decision_id.clone(),
            finalization_request_id: claimed.finalization_request_id.clone().unwrap(),
            acknowledgement_nonce: claimed.acknowledgement_nonce.clone().unwrap(),
            operation_id: "operation-a".into(),
            receipt_id: claimed.receipt_id.clone(),
            owner_type: claimed.owner_type.clone(),
            owner_id: claimed.owner_id.clone(),
            channel: claimed.channel.clone(),
            candidate_file_ref_id: claimed.candidate_file_ref_id.clone(),
            owner_instance_token: claimed.owner_instance_token.clone().unwrap(),
            mount_token: claimed.mount_token.clone().unwrap(),
            lease_token: claimed.lease_token.clone().unwrap(),
            mount_generation: 1,
            replacement_generation: 0,
            provisional_install_id: provisional_id.clone(),
            decision: "prepared".into(),
            decision_created_at: "2026-07-30T00:00:01.000Z".into(),
        };
        let prepared = record_decision(&mut connection, &RecordLifecycleDecisionInput {
            expected_finalization_revision: claimed.revision,
            claim_token: claimed.claim_token.clone().unwrap(),
            receipt: base.clone(),
        }).unwrap();
        let mut installed_receipt = base;
        installed_receipt.decision = "installed".into();
        let installed = record_decision(&mut connection, &RecordLifecycleDecisionInput {
            expected_finalization_revision: prepared.revision,
            claim_token: prepared.claim_token.clone().unwrap(),
            receipt: installed_receipt,
        }).unwrap();
        let finalized = finalize(&mut connection, &FinalizeOperationInput {
            operation_id: "operation-a".into(),
            expected_finalization_revision: installed.revision,
            claim_token: installed.claim_token.clone().unwrap(),
            lifecycle_decision_id: decision_id,
            provisional_install_id: provisional_id,
        }).unwrap();
        assert_eq!(finalized.finalization_state, "finalized");
        assert_eq!(
            manuscript_save_as_operation::readback_in_connection(&connection, "operation-a")
                .unwrap().unwrap().stage,
            SaveAsOperationStage::Completed
        );
    }

    #[test]
    fn presentation_acceptance_binds_exact_permit_and_terminal_outcome() {
        let mut connection = database();
        seed(
            &mut connection,
            "operation-exact",
            "2026-07-30T00:00:00.000Z",
        );
        let exact = RecordPresentationCompletedInput {
            operation_id: "operation-exact".into(),
            expected_operation_revision: 8,
            receipt_id: "receipt-operation-exact".into(),
            permit_id: "permit-operation-exact".into(),
            operation_generation: 1,
            process_generation: "process-1".into(),
            terminal_outcome_id: "outcome-operation-exact".into(),
            terminal_outcome_code: "TERMINAL_SUCCESS".into(),
            terminal_outcome_revision: 1,
        };
        let accepted = record_presentation(&mut connection, &exact).unwrap();
        assert_eq!(accepted.p4_permit_id, exact.permit_id);
        assert_eq!(
            accepted.p4_operation_generation,
            exact.operation_generation
        );
        assert_eq!(
            accepted.p4_process_generation,
            exact.process_generation
        );
        assert_eq!(
            accepted.terminal_outcome_id,
            exact.terminal_outcome_id
        );
        assert_eq!(
            accepted.terminal_outcome_code,
            exact.terminal_outcome_code
        );
        assert_eq!(
            accepted.terminal_outcome_revision,
            exact.terminal_outcome_revision
        );
        assert_eq!(
            record_presentation(&mut connection, &exact).unwrap(),
            accepted
        );

        let mut conflicts = Vec::new();
        let mut wrong = exact.clone();
        wrong.permit_id = "foreign-permit".into();
        conflicts.push(wrong);
        let mut wrong = exact.clone();
        wrong.operation_generation = 2;
        conflicts.push(wrong);
        let mut wrong = exact.clone();
        wrong.process_generation = "foreign-process".into();
        conflicts.push(wrong);
        let mut wrong = exact.clone();
        wrong.terminal_outcome_id = "foreign-outcome".into();
        conflicts.push(wrong);
        let mut wrong = exact.clone();
        wrong.terminal_outcome_revision = 2;
        conflicts.push(wrong);
        let mut wrong = exact.clone();
        wrong.receipt_id = "foreign-receipt".into();
        conflicts.push(wrong);
        for conflict in conflicts {
            assert_eq!(
                record_presentation(&mut connection, &conflict)
                    .unwrap_err(),
                "SAVE_AS_P4_OUTCOME_ACCEPTANCE_CONFLICT"
            );
        }
    }

    #[test]
    fn pending_query_orders_before_limit_and_claim_namespace_is_independent() {
        let mut connection = database();
        for id in ["operation-c", "operation-a", "operation-b"] {
            seed(&mut connection, id, "2026-07-30T00:00:00.000Z");
            record_presentation(&mut connection, &RecordPresentationCompletedInput {
                operation_id: id.into(),
                expected_operation_revision: 8,
                receipt_id: format!("receipt-{id}"),
                permit_id: format!("permit-{id}"),
                operation_generation: 1,
                process_generation: "process-1".into(),
                terminal_outcome_id: format!("outcome-{id}"),
                terminal_outcome_code: "TERMINAL_SUCCESS".into(),
                terminal_outcome_revision: 1,
            }).unwrap();
        }
        connection.execute(
            "UPDATE manuscript_save_as_finalizations
             SET updated_at='2026-07-30T00:00:01.000Z'",
            [],
        ).unwrap();
        let listed = list_pending_in_connection(&connection, 2).unwrap();
        assert_eq!(
            listed.iter().map(|record| record.operation_id.as_str()).collect::<Vec<_>>(),
            vec!["operation-a", "operation-b"]
        );
        let query_plan: String = connection.query_row(
            "EXPLAIN QUERY PLAN SELECT operation_id FROM manuscript_save_as_finalizations
             WHERE finalization_state IN (
               'presentation_completed','lifecycle_install_pending','lifecycle_prepared',
               'lifecycle_installed','finalization_pending','lifecycle_rejected',
               'revoke_pending','revoked','compensation_pending','finalization_blocked'
             ) ORDER BY updated_at ASC, operation_id COLLATE BINARY ASC LIMIT 2",
            [],
            |row| row.get(3),
        ).unwrap();
        assert!(query_plan.contains("idx_save_as_finalizations_pending_order"));
    }

    #[test]
    fn window_p_missing_binding_atomically_contains_all_four_owner_channels() {
        for (owner_type, owner_id, channel) in [
            ("experiment", "experiment-1", "primary"),
            ("experimentRun", "run-1", "primary"),
            ("literature", "literature-1", "literature_outline"),
            ("literature", "literature-1", "dedicated_notes"),
        ] {
            let mut connection = database();
            let operation_id = format!("window-p-{owner_type}-{channel}");
            seed(&mut connection, &operation_id, "2026-08-04T00:00:00.000Z");
            prepare_window_p_owner(
                &connection,
                &operation_id,
                owner_type,
                owner_id,
                channel,
            );
            let input = window_p_input(
                &operation_id,
                owner_type,
                owner_id,
                channel,
            );
            let contained = contain_pre_presentation_missing_binding(
                &mut connection,
                &input,
                "process-2",
            ).unwrap();
            assert_eq!(
                contained.operation.stage,
                SaveAsOperationStage::ReconciliationBlocked
            );
            assert_eq!(
                contained.blocking_code,
                SaveAsFailureCode::SaveAsRuntimeGenerationStale
            );
            assert!(contained.source_proof_complete);
            assert_eq!(contained.custody.current_custody_authority, "resolved");
            assert_eq!(contained.custody.custody_state, "process_generation_retired");
            assert!(contained.custody.runtime_handle.is_none());
            let finalizations: i64 = connection.query_row(
                "SELECT COUNT(*) FROM manuscript_save_as_finalizations WHERE operation_id=?1",
                [&operation_id],
                |row| row.get(0),
            ).unwrap();
            assert_eq!(finalizations, 0);
            let repeated = contain_pre_presentation_missing_binding(
                &mut connection,
                &input,
                "process-2",
            ).unwrap();
            assert_eq!(repeated, contained);
        }
    }

    #[test]
    fn window_p_missing_source_proof_uses_distinct_fail_closed_reason() {
        let mut connection = database();
        let operation_id = "window-p-source-missing";
        seed(&mut connection, operation_id, "2026-08-04T00:00:00.000Z");
        prepare_window_p_owner(
            &connection,
            operation_id,
            "experiment",
            "experiment-1",
            "primary",
        );
        connection.execute("DELETE FROM file_refs WHERE id='source'", []).unwrap();
        let contained = contain_pre_presentation_missing_binding(
            &mut connection,
            &window_p_input(operation_id, "experiment", "experiment-1", "primary"),
            "process-2",
        ).unwrap();
        assert!(!contained.source_proof_complete);
        assert_eq!(
            contained.blocking_code,
            SaveAsFailureCode::SaveAsSourceSnapshotInvalid
        );
        assert_eq!(contained.custody.custody_state, "process_generation_retired");
    }

    #[test]
    fn window_p_nullable_source_file_ref_uses_exact_unique_source_path_proof() {
        let mut connection = database();
        let operation_id = "window-p-source-path-proof";
        seed(&mut connection, operation_id, "2026-08-04T00:00:00.000Z");
        prepare_window_p_owner(
            &connection,
            operation_id,
            "experiment",
            "experiment-1",
            "primary",
        );
        connection.execute(
            "UPDATE manuscript_save_as_operations SET source_file_ref_id=NULL WHERE operation_id=?1",
            [operation_id],
        ).unwrap();
        let mut input = window_p_input(operation_id, "experiment", "experiment-1", "primary");
        input.source_file_ref_id = None;
        let contained = contain_pre_presentation_missing_binding(
            &mut connection,
            &input,
            "process-2",
        ).unwrap();
        assert!(contained.source_proof_complete);
        assert_eq!(
            contained.blocking_code,
            SaveAsFailureCode::SaveAsRuntimeGenerationStale
        );
        assert_eq!(contained.custody.custody_state, "process_generation_retired");
    }

    #[test]
    fn window_p_blind_retry_guard_is_source_scoped_and_terminal_at_does_not_release_it() {
        let mut connection = database();
        let operation_id = "window-p-blind-guard";
        seed(&mut connection, operation_id, "2026-08-04T00:00:00.000Z");
        prepare_window_p_owner(
            &connection,
            operation_id,
            "experiment",
            "experiment-1",
            "primary",
        );
        contain_pre_presentation_missing_binding(
            &mut connection,
            &window_p_input(operation_id, "experiment", "experiment-1", "primary"),
            "process-2",
        ).unwrap();
        let contained_terminal_at: Option<String> = connection.query_row(
            "SELECT terminal_at FROM manuscript_save_as_operations WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        ).unwrap();
        assert!(contained_terminal_at.is_some());

        let mut same_file_ref = fresh_operation(
            "window-p-retry-file-ref",
            Some("source"),
            "n:/renamed-source.md",
        );
        same_file_ref.owner_type = "experiment".into();
        same_file_ref.owner_id = "experiment-1".into();
        assert_eq!(
            manuscript_save_as_operation::create_in_connection(
                &mut connection,
                &same_file_ref,
            ).unwrap_err().code,
            "SAVE_AS_J0_CLAIM_CONFLICT"
        );

        let mut same_path = fresh_operation(
            "window-p-retry-path",
            None,
            "n:/source.md",
        );
        same_path.owner_type = "experiment".into();
        same_path.owner_id = "experiment-1".into();
        assert_eq!(
            manuscript_save_as_operation::create_in_connection(
                &mut connection,
                &same_path,
            ).unwrap_err().code,
            "SAVE_AS_J0_CLAIM_CONFLICT"
        );

        let mut different_source = fresh_operation(
            "window-p-unrelated-source",
            Some("other-source"),
            "n:/other-source.md",
        );
        different_source.owner_type = "experiment".into();
        different_source.owner_id = "experiment-1".into();
        assert!(manuscript_save_as_operation::create_in_connection(
            &mut connection,
            &different_source,
        ).is_ok());
    }

    #[test]
    fn window_p_custody_write_failure_rolls_back_operation_transition() {
        let mut connection = database();
        let operation_id = "window-p-rollback";
        seed(&mut connection, operation_id, "2026-08-04T00:00:00.000Z");
        prepare_window_p_owner(
            &connection,
            operation_id,
            "experiment",
            "experiment-1",
            "primary",
        );
        connection.execute_batch(
            "CREATE TRIGGER force_window_p_custody_failure
             BEFORE UPDATE ON manuscript_save_as_candidate_custody
             BEGIN SELECT RAISE(ABORT, 'forced custody failure'); END;",
        ).unwrap();
        assert!(contain_pre_presentation_missing_binding(
            &mut connection,
            &window_p_input(operation_id, "experiment", "experiment-1", "primary"),
            "process-2",
        ).is_err());
        let operation = manuscript_save_as_operation::readback_in_connection(
            &connection,
            operation_id,
        ).unwrap().unwrap();
        let custody = manuscript_save_as_candidate_custody::readback_in_connection(
            &connection,
            operation_id,
        ).unwrap().unwrap();
        assert_eq!(operation.stage, SaveAsOperationStage::P4PresentationPending);
        assert_eq!(custody.custody_state, "activated_held");
        assert_eq!(custody.runtime_handle.as_deref(), Some("runtime"));
    }

    #[test]
    fn retired_process_is_contained_guarded_and_explicitly_compensated_without_target_loss() {
        let mut connection = database();
        let operation_id = "operation-interrupted";
        seed(&mut connection, operation_id, "2026-07-30T00:00:00.000Z");
        let presented = record_presentation(
            &mut connection,
            &RecordPresentationCompletedInput {
                operation_id: operation_id.into(),
                expected_operation_revision: 8,
                receipt_id: format!("receipt-{operation_id}"),
                permit_id: format!("permit-{operation_id}"),
                operation_generation: 1,
                process_generation: "process-1".into(),
                terminal_outcome_id: format!("outcome-{operation_id}"),
                terminal_outcome_code: "TERMINAL_SUCCESS".into(),
                terminal_outcome_revision: 1,
            },
        )
        .unwrap();

        assert!(contain_interrupted(
            &mut connection,
            &ContainInterruptedSaveAsInput {
                operation_id: operation_id.into(),
                expected_operation_revision: 8,
                expected_finalization_revision: presented.revision,
                expected_custody_revision: 2,
                receipt_id: format!("receipt-{operation_id}"),
            },
            "process-1",
        )
        .unwrap()
        .is_none());

        let contained = contain_interrupted(
            &mut connection,
            &ContainInterruptedSaveAsInput {
                operation_id: operation_id.into(),
                expected_operation_revision: 8,
                expected_finalization_revision: presented.revision,
                expected_custody_revision: 2,
                receipt_id: format!("receipt-{operation_id}"),
            },
            "process-2",
        )
        .unwrap()
        .unwrap();
        assert_eq!(contained.finalization_state, "presentation_completed");
        assert!(list_pending_in_connection(&connection, 10).unwrap().is_empty());
        assert_eq!(
            list_interrupted_in_connection(&connection, 10)
                .unwrap()
                .iter()
                .map(|record| record.operation_id.as_str())
                .collect::<Vec<_>>(),
            vec![operation_id]
        );
        let guarded = manuscript_save_as_operation::readback_in_connection(
            &connection,
            operation_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(guarded.stage, SaveAsOperationStage::ReconciliationBlocked);
        assert_eq!(guarded.target_file_ref_id.as_deref(), Some("file-operation-interrupted"));
        let custody = manuscript_save_as_candidate_custody::readback_in_connection(
            &connection,
            operation_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(custody.custody_state, "process_generation_retired");

        let mut same_source = operation("operation-retry", "n:/different-target.md");
        same_source.revision = 0;
        same_source.commit_fence_revision = 0;
        same_source.stage = SaveAsOperationStage::PreD1Claimed;
        same_source.d1_commit_state = SaveAsCommitState::NotStarted;
        same_source.d2_commit_state = SaveAsCommitState::NotStarted;
        same_source.reconciliation_state = SaveAsReconciliationState::NotRequired;
        same_source.d1_physical_identity_hash = None;
        same_source.d1_readback_sha256 = None;
        same_source.d1_readback_revision = None;
        same_source.d1_byte_length = None;
        same_source.d1_proof_generation = None;
        same_source.target_file_ref_id = None;
        same_source.d2_readback_revision = None;
        same_source.claim_token = Some("claim-retry".into());
        same_source.claim_revision = Some(0);
        same_source.observation_generation = Some(0);
        same_source.observation_revision = Some(0);
        assert_eq!(
            manuscript_save_as_operation::create_in_connection(&mut connection, &same_source)
                .unwrap_err()
                .code,
            "SAVE_AS_J0_CLAIM_CONFLICT"
        );

        let mut unrelated = same_source.clone();
        unrelated.operation_id = "operation-unrelated".into();
        unrelated.source_file_ref_id = Some("unrelated-source".into());
        unrelated.source_path_identity_key = "n:/unrelated.md".into();
        unrelated.target_display_path = "N:\\unrelated-target.md".into();
        unrelated.target_path_identity_key = "n:/unrelated-target.md".into();
        unrelated.claim_token = Some("claim-unrelated".into());
        assert!(manuscript_save_as_operation::create_in_connection(
            &mut connection,
            &unrelated,
        )
        .is_ok());

        let reconciled = reconcile_interrupted_preserving_target(
            &mut connection,
            &ReconcileInterruptedSaveAsInput {
                operation_id: operation_id.into(),
                expected_operation_revision: guarded.revision,
                expected_finalization_revision: contained.revision,
                expected_custody_revision: custody.revision,
                receipt_id: contained.receipt_id.clone(),
                owner_type: guarded.owner_type.clone(),
                owner_id: guarded.owner_id.clone(),
                channel: guarded.channel.clone(),
                source_file_ref_id: guarded.source_file_ref_id.clone().unwrap(),
                target_file_ref_id: guarded.target_file_ref_id.clone().unwrap(),
                target_path_identity_key: guarded.target_path_identity_key.clone(),
            },
        )
        .unwrap();
        assert_eq!(reconciled.finalization_state, "presentation_completed");
        let operation_after = manuscript_save_as_operation::readback_in_connection(
            &connection,
            operation_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(operation_after.stage, SaveAsOperationStage::FinalizationCompensated);
        assert_eq!(operation_after.target_file_ref_id, guarded.target_file_ref_id);
        assert!(list_interrupted_in_connection(&connection, 10).unwrap().is_empty());
        assert!(manuscript_save_as_operation::create_in_connection(
            &mut connection,
            &same_source,
        )
        .is_ok());
    }

    #[test]
    fn claim_response_loss_is_idempotent_and_restart_takeover_fences_old_process() {
        let mut connection = database();
        seed(&mut connection, "operation-claim", "2026-07-30T00:00:00.000Z");
        let requested = requested(&mut connection, "operation-claim");
        let claim_input = ClaimFinalizationInput {
            operation_id: "operation-claim".into(),
            expected_finalization_revision: requested.revision,
            finalization_request_id: requested.finalization_request_id.clone().unwrap(),
            claim_generation: 1,
        };
        let first = claim(&mut connection, &claim_input, "process-a").unwrap();
        let response_loss_retry = claim(&mut connection, &claim_input, "process-a").unwrap();
        assert_eq!(response_loss_retry, first);

        let same_process_new_generation = claim(&mut connection, &ClaimFinalizationInput {
            expected_finalization_revision: first.revision,
            claim_generation: 2,
            ..claim_input.clone()
        }, "process-a");
        assert_eq!(
            same_process_new_generation.unwrap_err(),
            "SAVE_AS_FINALIZATION_CLAIM_CONFLICT"
        );

        let takeover = claim(&mut connection, &ClaimFinalizationInput {
            expected_finalization_revision: first.revision,
            claim_generation: 1,
            ..claim_input
        }, "process-b").unwrap();
        assert_ne!(takeover.claim_token, first.claim_token);
        assert_eq!(
            takeover.claim_process_generation.as_deref(),
            Some("process-b")
        );

        let stale_process_receipt = LifecycleDecisionReceipt {
            decision_version: 1,
            lifecycle_decision_id: Uuid::new_v4().to_string(),
            finalization_request_id: takeover.finalization_request_id.clone().unwrap(),
            acknowledgement_nonce: takeover.acknowledgement_nonce.clone().unwrap(),
            operation_id: takeover.operation_id.clone(),
            receipt_id: takeover.receipt_id.clone(),
            owner_type: takeover.owner_type.clone(),
            owner_id: takeover.owner_id.clone(),
            channel: takeover.channel.clone(),
            candidate_file_ref_id: takeover.candidate_file_ref_id.clone(),
            owner_instance_token: takeover.owner_instance_token.clone().unwrap(),
            mount_token: takeover.mount_token.clone().unwrap(),
            lease_token: takeover.lease_token.clone().unwrap(),
            mount_generation: takeover.mount_generation.unwrap(),
            replacement_generation: takeover.replacement_generation.unwrap(),
            provisional_install_id: Uuid::new_v4().to_string(),
            decision: "prepared".into(),
            decision_created_at: "2026-07-30T00:00:01.000Z".into(),
        };
        let stale_process_write = record_decision(
            &mut connection,
            &RecordLifecycleDecisionInput {
                expected_finalization_revision: takeover.revision,
                claim_token: first.claim_token.unwrap(),
                receipt: stale_process_receipt,
            },
        );
        assert_eq!(
            stale_process_write.unwrap_err(),
            "SAVE_AS_LIFECYCLE_DECISION_CONFLICT"
        );
    }

    #[test]
    fn installed_decision_wins_race_against_late_rejection_and_can_finalize() {
        let mut connection = database();
        seed(&mut connection, "operation-race", "2026-07-30T00:00:00.000Z");
        let requested = requested(&mut connection, "operation-race");
        let claimed = claim(&mut connection, &ClaimFinalizationInput {
            operation_id: "operation-race".into(),
            expected_finalization_revision: requested.revision,
            finalization_request_id: requested.finalization_request_id.clone().unwrap(),
            claim_generation: 1,
        }, "process-1").unwrap();
        let decision_id = Uuid::new_v4().to_string();
        let provisional_id = Uuid::new_v4().to_string();
        let mut receipt = LifecycleDecisionReceipt {
            decision_version: 1,
            lifecycle_decision_id: decision_id.clone(),
            finalization_request_id: claimed.finalization_request_id.clone().unwrap(),
            acknowledgement_nonce: claimed.acknowledgement_nonce.clone().unwrap(),
            operation_id: claimed.operation_id.clone(),
            receipt_id: claimed.receipt_id.clone(),
            owner_type: claimed.owner_type.clone(),
            owner_id: claimed.owner_id.clone(),
            channel: claimed.channel.clone(),
            candidate_file_ref_id: claimed.candidate_file_ref_id.clone(),
            owner_instance_token: claimed.owner_instance_token.clone().unwrap(),
            mount_token: claimed.mount_token.clone().unwrap(),
            lease_token: claimed.lease_token.clone().unwrap(),
            mount_generation: claimed.mount_generation.unwrap(),
            replacement_generation: claimed.replacement_generation.unwrap(),
            provisional_install_id: provisional_id.clone(),
            decision: "prepared".into(),
            decision_created_at: "2026-07-30T00:00:01.000Z".into(),
        };
        let prepared = record_decision(&mut connection, &RecordLifecycleDecisionInput {
            expected_finalization_revision: claimed.revision,
            claim_token: claimed.claim_token.clone().unwrap(),
            receipt: receipt.clone(),
        }).unwrap();
        receipt.decision = "installed".into();
        let installed = record_decision(&mut connection, &RecordLifecycleDecisionInput {
            expected_finalization_revision: prepared.revision,
            claim_token: prepared.claim_token.clone().unwrap(),
            receipt: receipt.clone(),
        }).unwrap();

        receipt.decision = "stale".into();
        let late_rejection = record_decision(&mut connection, &RecordLifecycleDecisionInput {
            expected_finalization_revision: installed.revision,
            claim_token: installed.claim_token.clone().unwrap(),
            receipt,
        });
        assert_eq!(
            late_rejection.unwrap_err(),
            "SAVE_AS_LIFECYCLE_DECISION_CONFLICT"
        );

        let finalized = finalize(&mut connection, &FinalizeOperationInput {
            operation_id: installed.operation_id.clone(),
            expected_finalization_revision: installed.revision,
            claim_token: installed.claim_token.clone().unwrap(),
            lifecycle_decision_id: decision_id,
            provisional_install_id: provisional_id,
        }).unwrap();
        assert_eq!(finalized.finalization_state, "finalized");
    }
}
