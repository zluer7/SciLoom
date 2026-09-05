use crate::manuscript_save_as_target_guard::ManuscriptSaveAsTargetGuardAuthority;
use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{
    params,
    types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef},
    Connection, OptionalExtension, ToSql, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::State;
use uuid::Uuid;

pub(crate) const SAVE_AS_OPERATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS manuscript_save_as_operations (
  operation_id TEXT PRIMARY KEY CHECK (
    operation_id <> '' AND operation_id NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  commit_fence_revision INTEGER NOT NULL DEFAULT 0 CHECK (commit_fence_revision >= 0),
  operation_generation INTEGER NOT NULL CHECK (operation_generation > 0),
  producer_process_generation TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('primary', 'literature_outline', 'dedicated_notes')),
  source_window_role TEXT NOT NULL CHECK (source_window_role IN ('current', 'independent')),
  source_file_ref_id TEXT,
  source_path_identity_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_runtime_generation INTEGER NOT NULL CHECK (source_runtime_generation >= 0),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_byte_length INTEGER NOT NULL CHECK (snapshot_byte_length >= 0),
  encoding_contract_version TEXT NOT NULL,
  newline_contract_version TEXT NOT NULL,
  target_display_path TEXT NOT NULL,
  target_path_identity_key TEXT NOT NULL,
  target_location_mode TEXT NOT NULL CHECK (target_location_mode IN ('managed', 'external')),
  target_parent_path_identity_key TEXT NOT NULL,
  target_parent_physical_identity_hash TEXT NOT NULL CHECK (length(target_parent_physical_identity_hash) = 64 AND target_parent_physical_identity_hash NOT GLOB '*[^0-9a-f]*'),
  d1_physical_identity_hash TEXT CHECK (d1_physical_identity_hash IS NULL OR (length(d1_physical_identity_hash) = 64 AND d1_physical_identity_hash NOT GLOB '*[^0-9a-f]*')),
  d1_readback_sha256 TEXT CHECK (d1_readback_sha256 IS NULL OR (length(d1_readback_sha256) = 64 AND d1_readback_sha256 NOT GLOB '*[^0-9a-f]*')),
  d1_readback_revision TEXT,
  d1_byte_length INTEGER CHECK (d1_byte_length IS NULL OR d1_byte_length >= 0),
  d1_proof_generation INTEGER CHECK (d1_proof_generation IS NULL OR d1_proof_generation > 0),
  target_file_ref_id TEXT,
  d2_readback_revision TEXT,
  containment_fence_token TEXT,
  reconciliation_result_code TEXT CHECK (
    reconciliation_result_code IS NULL OR reconciliation_result_code NOT IN (
      'contained','conflict','reconciled_terminal',
      'd2_reconciliation_contained','d2_reconciliation_conflict','d2_reconciled_terminal'
    )
  ),
  reconciliation_resolved_at TEXT,
  stage TEXT NOT NULL CHECK (stage IN (
    'pre_d1_claimed', 'd1_commit_unknown', 'd1_confirmed',
    'd2_commit_unknown', 'd2_confirmed', 'r3_activation_pending',
    'p4_presentation_pending', 'completed', 'finalization_compensated',
    'pre_d1_closed', 'reconciliation_blocked',
    'd2_reconciliation_contained', 'd2_reconciliation_conflict',
    'd2_reconciled_terminal'
  )),
  d1_commit_state TEXT NOT NULL CHECK (d1_commit_state IN ('not_started', 'unknown', 'confirmed', 'blocked')),
  d2_commit_state TEXT NOT NULL CHECK (d2_commit_state IN ('not_started', 'unknown', 'confirmed', 'blocked')),
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('not_required', 'pending', 'claimed', 'resolved', 'blocked')),
  blocking_code TEXT CHECK (blocking_code IS NULL OR blocking_code IN (
    'SAVE_AS_SOURCE_SNAPSHOT_INVALID', 'SAVE_AS_SOURCE_REVISION_STALE',
    'SAVE_AS_RUNTIME_GENERATION_STALE', 'SAVE_AS_TARGET_CANDIDATE_INVALID',
    'SAVE_AS_SOURCE_TARGET_SAME_PATH', 'SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL',
    'SAVE_AS_TARGET_ALREADY_EXISTS', 'SAVE_AS_PARENT_MISSING',
    'SAVE_AS_PERMISSION_DENIED', 'SAVE_AS_PATH_INVALID',
    'SAVE_AS_GUARD_CONFLICT', 'SAVE_AS_GUARD_STALE',
    'SAVE_AS_GUARD_RELEASE_FAILED', 'SAVE_AS_J0_CLAIM_CONFLICT',
    'SAVE_AS_J0_CAS_CONFLICT', 'SAVE_AS_J0_RESPONSE_LOSS',
    'SAVE_AS_D1_WRITE_FAILED', 'SAVE_AS_D1_FLUSH_FAILED',
    'SAVE_AS_D1_SYNC_FAILED', 'SAVE_AS_D1_READBACK_FAILED',
    'SAVE_AS_D1_READBACK_MISMATCH', 'SAVE_AS_ENCODING_NEWLINE_MISMATCH',
    'SAVE_AS_HANDOFF_MISMATCH', 'SAVE_AS_HANDOFF_ALREADY_CONSUMED',
    'SAVE_AS_OPERATION_STALE', 'SAVE_AS_CANCELLED_PRE_D1',
    'SAVE_AS_PHYSICAL_EFFECT_UNKNOWN', 'SAVE_AS_FORMAL_RESOURCE_ISOLATION_VIOLATION',
    'D2_UNKNOWN_IDENTITY_INCOMPLETE', 'D2_UNKNOWN_PHYSICAL_TARGET_MISSING',
    'D2_UNKNOWN_PHYSICAL_PROOF_MISMATCH', 'D2_UNKNOWN_FENCE_CONFLICT',
    'D2_UNKNOWN_STALE_PERMIT', 'D2_UNKNOWN_FILE_REF_CONFLICT',
    'D2_UNKNOWN_COMPETING_OPERATION', 'D2_UNKNOWN_UNEXPECTED_FINALIZATION',
    'D2_UNKNOWN_UNEXPECTED_CUSTODY', 'D2_UNKNOWN_LATE_WRITER_REJECTED',
    'D2_UNKNOWN_TERMINAL_STATE_CONFLICT', 'D2_UNKNOWN_SOURCE_UNRESOLVED'
  )),
  claim_token TEXT,
  claim_revision INTEGER CHECK (claim_revision IS NULL OR claim_revision >= 0),
  claim_process_generation TEXT,
  observation_generation INTEGER CHECK (observation_generation IS NULL OR observation_generation >= 0),
  observation_revision INTEGER CHECK (observation_revision IS NULL OR observation_revision >= 0),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  terminal_at TEXT CHECK (
    terminal_at IS NULL OR (
      length(terminal_at) = 24
      AND terminal_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    )
  ),
  CHECK (
    (stage = 'pre_d1_claimed' AND d1_commit_state = 'not_started' AND d2_commit_state = 'not_started' AND reconciliation_state = 'not_required')
    OR (stage = 'd1_commit_unknown' AND d1_commit_state = 'unknown' AND d2_commit_state = 'not_started' AND reconciliation_state IN ('pending', 'claimed', 'blocked'))
    OR (stage = 'd1_confirmed' AND d1_commit_state = 'confirmed' AND d2_commit_state = 'not_started' AND reconciliation_state IN ('not_required', 'resolved'))
    OR (stage = 'd2_commit_unknown' AND d1_commit_state = 'confirmed' AND d2_commit_state = 'unknown' AND reconciliation_state IN ('pending', 'claimed', 'blocked'))
    OR (stage IN ('d2_confirmed', 'r3_activation_pending', 'p4_presentation_pending', 'completed', 'finalization_compensated') AND d1_commit_state = 'confirmed' AND d2_commit_state = 'confirmed' AND reconciliation_state IN ('not_required', 'resolved'))
    OR (stage = 'pre_d1_closed' AND d1_commit_state = 'not_started' AND d2_commit_state = 'not_started' AND reconciliation_state = 'not_required')
    OR (stage = 'reconciliation_blocked' AND reconciliation_state = 'blocked' AND blocking_code IS NOT NULL AND (
      (d1_commit_state = 'blocked' AND d2_commit_state = 'not_started')
      OR (d1_commit_state = 'confirmed' AND d2_commit_state IN ('blocked', 'confirmed'))
    ))
    OR (stage = 'd2_reconciliation_contained' AND d1_commit_state = 'confirmed'
      AND d2_commit_state = 'unknown' AND reconciliation_state = 'pending'
      AND containment_fence_token IS NOT NULL AND blocking_code IS NULL)
    OR (stage = 'd2_reconciliation_conflict' AND d1_commit_state = 'confirmed'
      AND d2_commit_state = 'blocked' AND reconciliation_state = 'blocked'
      AND containment_fence_token IS NOT NULL AND blocking_code IS NOT NULL)
    OR (stage = 'd2_reconciled_terminal' AND d1_commit_state = 'confirmed'
      AND d2_commit_state = 'confirmed' AND reconciliation_state = 'resolved'
      AND target_file_ref_id IS NOT NULL AND reconciliation_resolved_at IS NOT NULL
      AND reconciliation_result_code = 'file_ref_reconciled_non_success')
  ),
  CHECK (
    (claim_token IS NULL AND claim_revision IS NULL AND claim_process_generation IS NULL)
    OR (claim_token IS NOT NULL AND claim_revision IS NOT NULL AND claim_process_generation IS NOT NULL)
  ),
  CHECK (stage != 'pre_d1_claimed' OR claim_token IS NOT NULL),
  CHECK (stage != 'd2_reconciled_terminal' OR terminal_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manuscript_save_as_operations_active_target
ON manuscript_save_as_operations(target_path_identity_key)
WHERE stage IN (
  'pre_d1_claimed', 'd1_commit_unknown', 'd1_confirmed',
  'd2_commit_unknown', 'd2_confirmed', 'r3_activation_pending',
  'p4_presentation_pending', 'd2_reconciliation_contained',
  'd2_reconciliation_conflict'
);
CREATE INDEX IF NOT EXISTS idx_manuscript_save_as_operations_active_owner_channel_stage
ON manuscript_save_as_operations(owner_type, owner_id, channel, stage);
CREATE INDEX IF NOT EXISTS idx_manuscript_save_as_operations_reconcilable_order
ON manuscript_save_as_operations(updated_at, operation_id)
WHERE reconciliation_state IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS idx_manuscript_save_as_operations_target_file_ref
ON manuscript_save_as_operations(target_file_ref_id)
WHERE target_file_ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manuscript_save_as_operations_unresolved_source
ON manuscript_save_as_operations(owner_type, owner_id, channel, source_file_ref_id, stage)
WHERE source_file_ref_id IS NOT NULL AND stage IN (
  'd2_commit_unknown','d2_reconciliation_contained','d2_reconciliation_conflict'
);

CREATE TABLE IF NOT EXISTS save_as_reconciliation_action_receipts (
  operation_id TEXT NOT NULL REFERENCES manuscript_save_as_operations(operation_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('containment','confirm','dismiss_notice','conflict')),
  action_id TEXT NOT NULL,
  expected_operation_revision INTEGER NOT NULL CHECK (expected_operation_revision >= 0),
  expected_fence_revision INTEGER NOT NULL CHECK (expected_fence_revision >= 0),
  actor_process_generation TEXT NOT NULL,
  result_code TEXT NOT NULL,
  resulting_operation_stage TEXT NOT NULL,
  resulting_operation_revision INTEGER NOT NULL CHECK (resulting_operation_revision >= 0),
  resulting_fence_revision INTEGER NOT NULL CHECK (resulting_fence_revision >= 0),
  target_file_ref_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, action_type, action_id)
);
CREATE INDEX IF NOT EXISTS idx_save_as_reconciliation_receipts_operation
ON save_as_reconciliation_action_receipts(operation_id, created_at);

CREATE TABLE IF NOT EXISTS save_as_reconciliation_audit_events (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES manuscript_save_as_operations(operation_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  action_type TEXT CHECK (action_type IS NULL OR action_type IN ('containment','confirm','dismiss_notice','conflict')),
  action_id TEXT,
  resulting_fence_revision INTEGER NOT NULL CHECK (resulting_fence_revision >= 0),
  actor_process_generation TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_save_as_reconciliation_system_event
ON save_as_reconciliation_audit_events(operation_id, resulting_fence_revision, event_type)
WHERE action_id IS NULL;
INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (42, 'typed_owner_neutral_manuscript_save_as_operations');
INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (49, 'bare_d2_commit_unknown_durable_containment_protocol');
"#;

pub(crate) const COLUMNS: &str = "
operation_id, revision, commit_fence_revision, operation_generation, producer_process_generation,
owner_type, owner_id, channel, source_window_role, source_file_ref_id,
source_path_identity_key, source_revision, source_runtime_generation,
snapshot_sha256, snapshot_byte_length, encoding_contract_version, newline_contract_version,
target_display_path, target_path_identity_key, target_location_mode,
target_parent_path_identity_key, target_parent_physical_identity_hash,
d1_physical_identity_hash, d1_readback_sha256, d1_readback_revision,
d1_byte_length, d1_proof_generation, target_file_ref_id, d2_readback_revision,
containment_fence_token, reconciliation_result_code, reconciliation_resolved_at,
stage, d1_commit_state, d2_commit_state, reconciliation_state, blocking_code,
claim_token, claim_revision, claim_process_generation,
observation_generation, observation_revision, created_at, updated_at, terminal_at";

macro_rules! closed_sql_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
        pub(crate) enum $name {
            $(#[serde(rename = $value)] $variant),+
        }
        impl $name {
            pub(crate) fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }
        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(ToSqlOutput::Borrowed(ValueRef::Text(self.as_str().as_bytes())))
            }
        }
        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value.as_str()? {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(FromSqlError::InvalidType),
                }
            }
        }
    };
}

closed_sql_enum!(SaveAsOperationStage {
    PreD1Claimed => "pre_d1_claimed",
    D1CommitUnknown => "d1_commit_unknown",
    D1Confirmed => "d1_confirmed",
    D2CommitUnknown => "d2_commit_unknown",
    D2Confirmed => "d2_confirmed",
    R3ActivationPending => "r3_activation_pending",
    P4PresentationPending => "p4_presentation_pending",
    Completed => "completed",
    FinalizationCompensated => "finalization_compensated",
    PreD1Closed => "pre_d1_closed",
    ReconciliationBlocked => "reconciliation_blocked",
    D2ReconciliationContained => "d2_reconciliation_contained",
    D2ReconciliationConflict => "d2_reconciliation_conflict",
    D2ReconciledTerminal => "d2_reconciled_terminal",
});
closed_sql_enum!(SaveAsCommitState {
    NotStarted => "not_started",
    Unknown => "unknown",
    Confirmed => "confirmed",
    Blocked => "blocked",
});
closed_sql_enum!(SaveAsReconciliationState {
    NotRequired => "not_required",
    Pending => "pending",
    Claimed => "claimed",
    Resolved => "resolved",
    Blocked => "blocked",
});
closed_sql_enum!(SaveAsFailureCode {
    SaveAsSourceSnapshotInvalid => "SAVE_AS_SOURCE_SNAPSHOT_INVALID",
    SaveAsSourceRevisionStale => "SAVE_AS_SOURCE_REVISION_STALE",
    SaveAsRuntimeGenerationStale => "SAVE_AS_RUNTIME_GENERATION_STALE",
    SaveAsTargetCandidateInvalid => "SAVE_AS_TARGET_CANDIDATE_INVALID",
    SaveAsSourceTargetSamePath => "SAVE_AS_SOURCE_TARGET_SAME_PATH",
    SaveAsSourceTargetSamePhysical => "SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL",
    SaveAsTargetAlreadyExists => "SAVE_AS_TARGET_ALREADY_EXISTS",
    SaveAsParentMissing => "SAVE_AS_PARENT_MISSING",
    SaveAsPermissionDenied => "SAVE_AS_PERMISSION_DENIED",
    SaveAsPathInvalid => "SAVE_AS_PATH_INVALID",
    SaveAsGuardConflict => "SAVE_AS_GUARD_CONFLICT",
    SaveAsGuardStale => "SAVE_AS_GUARD_STALE",
    SaveAsGuardReleaseFailed => "SAVE_AS_GUARD_RELEASE_FAILED",
    SaveAsJ0ClaimConflict => "SAVE_AS_J0_CLAIM_CONFLICT",
    SaveAsJ0CasConflict => "SAVE_AS_J0_CAS_CONFLICT",
    SaveAsJ0ResponseLoss => "SAVE_AS_J0_RESPONSE_LOSS",
    SaveAsD1WriteFailed => "SAVE_AS_D1_WRITE_FAILED",
    SaveAsD1FlushFailed => "SAVE_AS_D1_FLUSH_FAILED",
    SaveAsD1SyncFailed => "SAVE_AS_D1_SYNC_FAILED",
    SaveAsD1ReadbackFailed => "SAVE_AS_D1_READBACK_FAILED",
    SaveAsD1ReadbackMismatch => "SAVE_AS_D1_READBACK_MISMATCH",
    SaveAsEncodingNewlineMismatch => "SAVE_AS_ENCODING_NEWLINE_MISMATCH",
    SaveAsHandoffMismatch => "SAVE_AS_HANDOFF_MISMATCH",
    SaveAsHandoffAlreadyConsumed => "SAVE_AS_HANDOFF_ALREADY_CONSUMED",
    SaveAsOperationStale => "SAVE_AS_OPERATION_STALE",
    SaveAsCancelledPreD1 => "SAVE_AS_CANCELLED_PRE_D1",
    SaveAsPhysicalEffectUnknown => "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN",
    SaveAsFormalResourceIsolationViolation => "SAVE_AS_FORMAL_RESOURCE_ISOLATION_VIOLATION",
    D2UnknownIdentityIncomplete => "D2_UNKNOWN_IDENTITY_INCOMPLETE",
    D2UnknownPhysicalTargetMissing => "D2_UNKNOWN_PHYSICAL_TARGET_MISSING",
    D2UnknownPhysicalProofMismatch => "D2_UNKNOWN_PHYSICAL_PROOF_MISMATCH",
    D2UnknownFenceConflict => "D2_UNKNOWN_FENCE_CONFLICT",
    D2UnknownStalePermit => "D2_UNKNOWN_STALE_PERMIT",
    D2UnknownFileRefConflict => "D2_UNKNOWN_FILE_REF_CONFLICT",
    D2UnknownCompetingOperation => "D2_UNKNOWN_COMPETING_OPERATION",
    D2UnknownUnexpectedFinalization => "D2_UNKNOWN_UNEXPECTED_FINALIZATION",
    D2UnknownUnexpectedCustody => "D2_UNKNOWN_UNEXPECTED_CUSTODY",
    D2UnknownLateWriterRejected => "D2_UNKNOWN_LATE_WRITER_REJECTED",
    D2UnknownTerminalStateConflict => "D2_UNKNOWN_TERMINAL_STATE_CONFLICT",
    D2UnknownSourceUnresolved => "D2_UNKNOWN_SOURCE_UNRESOLVED",
});

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsOperationRecord {
    pub operation_id: String,
    pub revision: i64,
    pub commit_fence_revision: i64,
    pub operation_generation: i64,
    pub producer_process_generation: String,
    pub owner_type: String,
    pub owner_id: String,
    pub channel: String,
    pub source_window_role: String,
    pub source_file_ref_id: Option<String>,
    pub source_path_identity_key: String,
    pub source_revision: String,
    pub source_runtime_generation: i64,
    pub snapshot_sha256: String,
    pub snapshot_byte_length: i64,
    pub encoding_contract_version: String,
    pub newline_contract_version: String,
    pub target_display_path: String,
    pub target_path_identity_key: String,
    pub target_location_mode: String,
    pub target_parent_path_identity_key: String,
    pub target_parent_physical_identity_hash: String,
    pub d1_physical_identity_hash: Option<String>,
    pub d1_readback_sha256: Option<String>,
    pub d1_readback_revision: Option<String>,
    pub d1_byte_length: Option<i64>,
    pub d1_proof_generation: Option<i64>,
    pub target_file_ref_id: Option<String>,
    pub d2_readback_revision: Option<String>,
    pub containment_fence_token: Option<String>,
    pub reconciliation_result_code: Option<String>,
    pub reconciliation_resolved_at: Option<String>,
    pub stage: SaveAsOperationStage,
    pub d1_commit_state: SaveAsCommitState,
    pub d2_commit_state: SaveAsCommitState,
    pub reconciliation_state: SaveAsReconciliationState,
    pub blocking_code: Option<SaveAsFailureCode>,
    pub claim_token: Option<String>,
    pub claim_revision: Option<i64>,
    pub claim_process_generation: Option<String>,
    pub observation_generation: Option<i64>,
    pub observation_revision: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsOperationIdentityExpectation {
    operation_generation: i64,
    producer_process_generation: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    source_window_role: String,
    source_file_ref_id: Option<String>,
    source_path_identity_key: String,
    source_revision: String,
    source_runtime_generation: i64,
    snapshot_sha256: String,
    snapshot_byte_length: i64,
    encoding_contract_version: String,
    newline_contract_version: String,
    target_display_path: String,
    target_path_identity_key: String,
    target_location_mode: String,
    target_parent_path_identity_key: String,
    target_parent_physical_identity_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsOperationExpectation {
    revision: i64,
    commit_fence_revision: i64,
    stage: SaveAsOperationStage,
    d1_commit_state: SaveAsCommitState,
    d2_commit_state: SaveAsCommitState,
    reconciliation_state: SaveAsReconciliationState,
    claim_token: Option<String>,
    claim_revision: Option<i64>,
    claim_process_generation: Option<String>,
    observation_generation: Option<i64>,
    observation_revision: Option<i64>,
    identity: SaveAsOperationIdentityExpectation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "intent", rename_all = "snake_case")]
pub(crate) enum SaveAsOperationMutation {
    EnterD1CommitUnknown,
    ConfirmD1 {
        d1_physical_identity_hash: String,
        d1_readback_sha256: String,
        d1_readback_revision: String,
        d1_byte_length: i64,
        d1_proof_generation: i64,
    },
    ClosePreD1 {
        blocking_code: SaveAsFailureCode,
    },
    EnterD2CommitUnknown,
    EnterR3ActivationPending,
    EnterP4PresentationPending,
    BlockReconciliation {
        blocking_code: SaveAsFailureCode,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsOperationTransitionInput {
    pub(crate) operation_id: String,
    pub(crate) expected: SaveAsOperationExpectation,
    pub(crate) mutation: SaveAsOperationMutation,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsOperationAuthorityError {
    category: &'static str,
    pub(crate) code: &'static str,
    reason: String,
    field_class: &'static str,
    expected_state: Option<String>,
    actual_state: Option<String>,
    retryable: bool,
    must_reread: bool,
    terminal_impact: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsObservationClaimInput {
    operation_id: String,
    expected: SaveAsOperationExpectation,
    observation_generation: i64,
}

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SAVE_AS_OPERATION_SCHEMA_SQL)
}

pub(crate) fn apply_deterministic_ordering_migration(
    connection: &Connection,
) -> rusqlite::Result<()> {
    let legacy_index: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
         AND name='idx_manuscript_save_as_operations_reconciliation_updated'",
        [],
        |row| row.get(0),
    )?;
    if legacy_index == 1 {
        connection.execute_batch(
            "DROP INDEX IF EXISTS uq_manuscript_save_as_operations_active_target;
             DROP INDEX IF EXISTS idx_manuscript_save_as_operations_active_owner_channel_stage;
             DROP INDEX IF EXISTS idx_manuscript_save_as_operations_reconciliation_updated;
             DROP INDEX IF EXISTS idx_manuscript_save_as_operations_target_file_ref;
             ALTER TABLE manuscript_save_as_operations
             RENAME TO manuscript_save_as_operations_v44;",
        )?;
        connection.execute_batch(SAVE_AS_OPERATION_SCHEMA_SQL)?;
        connection.execute(
            &format!(
                "INSERT INTO manuscript_save_as_operations ({COLUMNS})
                 SELECT {COLUMNS} FROM manuscript_save_as_operations_v44"
            ),
            [],
        )?;
        connection.execute_batch("DROP TABLE manuscript_save_as_operations_v44;")?;
    }
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_manuscript_save_as_operations_reconciliation_updated;
         CREATE INDEX IF NOT EXISTS idx_manuscript_save_as_operations_reconcilable_order
         ON manuscript_save_as_operations(updated_at, operation_id)
         WHERE reconciliation_state IN ('pending', 'claimed');
         INSERT OR IGNORE INTO schema_migrations(version, name)
         VALUES (45, 'save_as_j0_invariants_and_deterministic_recovery_order');",
    )
}

pub(crate) fn legacy_v42_schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='manuscript_save_as_operations'",
        [],
        |row| row.get(0),
    )?;
    let legacy_index: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_manuscript_save_as_operations_reconciliation_updated'",
        [],
        |row| row.get(0),
    )?;
    let migration: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version=42 AND name='typed_owner_neutral_manuscript_save_as_operations'",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1 && legacy_index == 1 && migration == 1)
}

fn schema_matches_legacy_finalization_contract(
    connection: &Connection,
    finalization_stage_required: bool,
) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='manuscript_save_as_operations'",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
          'uq_manuscript_save_as_operations_active_target',
          'idx_manuscript_save_as_operations_active_owner_channel_stage',
          'idx_manuscript_save_as_operations_reconcilable_order',
          'idx_manuscript_save_as_operations_target_file_ref'
        )",
        [],
        |row| row.get(0),
    )?;
    let migrations: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE
         (version=42 AND name='typed_owner_neutral_manuscript_save_as_operations')
         OR (version=45 AND name='save_as_j0_invariants_and_deterministic_recovery_order')",
        [],
        |row| row.get(0),
    )?;
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='manuscript_save_as_operations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(table == 1
        && indexes == 4
        && migrations == 2
        && sql.is_some_and(|sql| {
            !sql.contains("record_json")
                && sql.contains("target_parent_physical_identity_hash")
                && sql.contains("SAVE_AS_PHYSICAL_EFFECT_UNKNOWN")
                && sql.contains("operation_id NOT GLOB '*[^A-Za-z0-9:_-]*'")
                && sql.contains("blocking_code IS NOT NULL")
                && sql.contains("length(updated_at) = 24")
                && sql.contains("finalization_compensated")
                    == finalization_stage_required
        }))
}

pub(crate) fn legacy_v46_schema_is_current(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    schema_matches_legacy_finalization_contract(connection, false)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2AtomicCommitInput {
    pub(crate) operation_id: String,
    pub(crate) expected: SaveAsOperationExpectation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2ContainmentInput {
    operation_id: String,
    expected: SaveAsOperationExpectation,
    action_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2ConfirmInput {
    operation_id: String,
    expected: SaveAsOperationExpectation,
    containment_fence_token: String,
    action_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2DismissInput {
    operation_id: String,
    expected_operation_revision: i64,
    expected_fence_revision: i64,
    containment_fence_token: String,
    action_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2TerminalIntegrityInput {
    operation_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2FileRefRecord {
    pub(crate) id: String,
    owner_type: String,
    owner_id: String,
    manuscript_channel: String,
    resource_kind: String,
    file_role: String,
    location_mode: String,
    file_type: String,
    path: String,
    path_identity_key: String,
    title: String,
    description: Option<String>,
    candidate_request_id: Option<String>,
    candidate_occurred_at: Option<String>,
    schema_version: i64,
    source: String,
    custom_fields: serde_json::Value,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2AuthorityResult {
    pub(crate) operation: SaveAsOperationRecord,
    pub(crate) file_ref: Option<SaveAsD2FileRefRecord>,
    state: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD2TerminalIntegrityResult {
    operation: SaveAsOperationRecord,
    integrity_state: &'static str,
    incident_code: Option<SaveAsFailureCode>,
    file_use_allowed: bool,
}

pub(crate) fn legacy_v48_schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    schema_matches_legacy_finalization_contract(connection, true)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
           'manuscript_save_as_operations','save_as_reconciliation_action_receipts',
           'save_as_reconciliation_audit_events'
         )",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
           'uq_manuscript_save_as_operations_active_target',
           'idx_manuscript_save_as_operations_active_owner_channel_stage',
           'idx_manuscript_save_as_operations_reconcilable_order',
           'idx_manuscript_save_as_operations_target_file_ref',
           'idx_manuscript_save_as_operations_unresolved_source',
           'uq_save_as_reconciliation_system_event'
         )",
        [],
        |row| row.get(0),
    )?;
    let migration: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version=49
         AND name='bare_d2_commit_unknown_durable_containment_protocol'",
        [],
        |row| row.get(0),
    )?;
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table'
             AND name='manuscript_save_as_operations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(tables == 3
        && indexes == 6
        && migration == 1
        && sql.is_some_and(|sql| {
            sql.contains("commit_fence_revision")
                && sql.contains("producer_process_generation")
                && sql.contains("containment_fence_token")
                && sql.contains("d2_reconciliation_contained")
                && sql.contains("d2_reconciliation_conflict")
                && sql.contains("d2_reconciled_terminal")
        }))
}

pub(crate) fn bare_d2_rows_prevent_v49_upgrade(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM manuscript_save_as_operations
               WHERE stage='d2_commit_unknown'
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value == 1)
}

pub(crate) fn apply_v49_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         PRAGMA legacy_alter_table=ON;
         BEGIN IMMEDIATE;
         DROP INDEX IF EXISTS uq_manuscript_save_as_operations_active_target;
         DROP INDEX IF EXISTS idx_manuscript_save_as_operations_active_owner_channel_stage;
         DROP INDEX IF EXISTS idx_manuscript_save_as_operations_reconcilable_order;
         DROP INDEX IF EXISTS idx_manuscript_save_as_operations_target_file_ref;
         DROP INDEX IF EXISTS idx_manuscript_save_as_operations_unresolved_source;
         ALTER TABLE manuscript_save_as_operations
           RENAME TO manuscript_save_as_operations_v48;",
    )?;
    let migration = (|| -> rusqlite::Result<()> {
        connection.execute_batch(SAVE_AS_OPERATION_SCHEMA_SQL)?;
        let has_legacy_process_generation: i64 = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('manuscript_save_as_operations_v48')
             WHERE name='process_generation')",
            [],
            |row| row.get(0),
        )?;
        let producer_source = if has_legacy_process_generation == 1 {
            "process_generation"
        } else {
            "producer_process_generation"
        };
        connection.execute(
            &format!("INSERT INTO manuscript_save_as_operations (
               operation_id,revision,commit_fence_revision,operation_generation,
               producer_process_generation,owner_type,owner_id,channel,source_window_role,
               source_file_ref_id,source_path_identity_key,source_revision,
               source_runtime_generation,snapshot_sha256,snapshot_byte_length,
               encoding_contract_version,newline_contract_version,target_display_path,
               target_path_identity_key,target_location_mode,target_parent_path_identity_key,
               target_parent_physical_identity_hash,d1_physical_identity_hash,
               d1_readback_sha256,d1_readback_revision,d1_byte_length,d1_proof_generation,
               target_file_ref_id,d2_readback_revision,containment_fence_token,
               reconciliation_result_code,reconciliation_resolved_at,stage,d1_commit_state,
               d2_commit_state,reconciliation_state,blocking_code,claim_token,claim_revision,
               claim_process_generation,observation_generation,observation_revision,
               created_at,updated_at,terminal_at
             )
             SELECT operation_id,revision,0,operation_generation,{producer_source},
               owner_type,owner_id,channel,source_window_role,source_file_ref_id,
               source_path_identity_key,source_revision,source_runtime_generation,
               snapshot_sha256,snapshot_byte_length,encoding_contract_version,
               newline_contract_version,target_display_path,target_path_identity_key,
               target_location_mode,target_parent_path_identity_key,
               target_parent_physical_identity_hash,d1_physical_identity_hash,
               d1_readback_sha256,d1_readback_revision,d1_byte_length,d1_proof_generation,
               target_file_ref_id,d2_readback_revision,NULL,NULL,NULL,stage,d1_commit_state,
               d2_commit_state,reconciliation_state,blocking_code,claim_token,claim_revision,
               claim_process_generation,observation_generation,observation_revision,
               created_at,updated_at,terminal_at
             FROM manuscript_save_as_operations_v48"),
            [],
        )?;
        connection.execute_batch(
            "DROP TABLE manuscript_save_as_operations_v48;
             PRAGMA user_version=49;
             COMMIT;",
        )
    })();
    if migration.is_err() {
        let _ = connection.execute_batch("ROLLBACK;");
    }
    let _ = connection.execute_batch(
        "PRAGMA legacy_alter_table=OFF;
         PRAGMA foreign_keys=ON;",
    );
    migration?;
    let violations: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check",
        [],
        |row| row.get(0),
    )?;
    if violations != 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SaveAsOperationRecord> {
    Ok(SaveAsOperationRecord {
        operation_id: row.get(0)?,
        revision: row.get(1)?,
        commit_fence_revision: row.get(2)?,
        operation_generation: row.get(3)?,
        producer_process_generation: row.get(4)?,
        owner_type: row.get(5)?,
        owner_id: row.get(6)?,
        channel: row.get(7)?,
        source_window_role: row.get(8)?,
        source_file_ref_id: row.get(9)?,
        source_path_identity_key: row.get(10)?,
        source_revision: row.get(11)?,
        source_runtime_generation: row.get(12)?,
        snapshot_sha256: row.get(13)?,
        snapshot_byte_length: row.get(14)?,
        encoding_contract_version: row.get(15)?,
        newline_contract_version: row.get(16)?,
        target_display_path: row.get(17)?,
        target_path_identity_key: row.get(18)?,
        target_location_mode: row.get(19)?,
        target_parent_path_identity_key: row.get(20)?,
        target_parent_physical_identity_hash: row.get(21)?,
        d1_physical_identity_hash: row.get(22)?,
        d1_readback_sha256: row.get(23)?,
        d1_readback_revision: row.get(24)?,
        d1_byte_length: row.get(25)?,
        d1_proof_generation: row.get(26)?,
        target_file_ref_id: row.get(27)?,
        d2_readback_revision: row.get(28)?,
        containment_fence_token: row.get(29)?,
        reconciliation_result_code: row.get(30)?,
        reconciliation_resolved_at: row.get(31)?,
        stage: row.get(32)?,
        d1_commit_state: row.get(33)?,
        d2_commit_state: row.get(34)?,
        reconciliation_state: row.get(35)?,
        blocking_code: row.get(36)?,
        claim_token: row.get(37)?,
        claim_revision: row.get(38)?,
        claim_process_generation: row.get(39)?,
        observation_generation: row.get(40)?,
        observation_revision: row.get(41)?,
        created_at: row.get(42)?,
        updated_at: row.get(43)?,
        terminal_at: row.get(44)?,
    })
}

pub(crate) fn readback_in_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<SaveAsOperationRecord>, String> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM manuscript_save_as_operations WHERE operation_id = ?1"),
            [operation_id],
            row_record,
        )
        .optional()
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())
}

fn d2_file_ref_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SaveAsD2FileRefRecord> {
    let custom_fields: String = row.get(16)?;
    Ok(SaveAsD2FileRefRecord {
        id: row.get(0)?,
        owner_type: row.get(1)?,
        owner_id: row.get(2)?,
        manuscript_channel: row.get(3)?,
        resource_kind: row.get(4)?,
        file_role: row.get(5)?,
        location_mode: row.get(6)?,
        file_type: row.get(7)?,
        path: row.get(8)?,
        path_identity_key: row.get(9)?,
        title: row.get(10)?,
        description: row.get(11)?,
        candidate_request_id: row.get(12)?,
        candidate_occurred_at: row.get(13)?,
        schema_version: row.get(14)?,
        source: row.get(15)?,
        custom_fields: serde_json::from_str(&custom_fields)
            .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
        deleted_at: row.get(19)?,
    })
}

const D2_FILE_REF_COLUMNS: &str = "id,owner_type,owner_id,manuscript_channel,
resource_kind,file_role,location_mode,file_type,path,path_identity_key,title,description,
candidate_request_id,candidate_occurred_at,schema_version,source,custom_fields,
created_at,updated_at,deleted_at";

fn read_d2_file_ref_by_identity(
    connection: &Connection,
    operation: &SaveAsOperationRecord,
) -> rusqlite::Result<Option<SaveAsD2FileRefRecord>> {
    connection
        .query_row(
            &format!(
                "SELECT {D2_FILE_REF_COLUMNS} FROM file_refs
                 WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel=?3
                   AND path_identity_key=?4 AND resource_kind='file'
                   AND file_role='manuscript' LIMIT 1"
            ),
            params![
                operation.owner_type,
                operation.owner_id,
                operation.channel,
                operation.target_path_identity_key
            ],
            d2_file_ref_row,
        )
        .optional()
}

fn read_d2_file_ref_by_id(
    connection: &Connection,
    file_ref_id: &str,
) -> rusqlite::Result<Option<SaveAsD2FileRefRecord>> {
    connection
        .query_row(
            &format!("SELECT {D2_FILE_REF_COLUMNS} FROM file_refs WHERE id=?1"),
            [file_ref_id],
            d2_file_ref_row,
        )
        .optional()
}

fn d2_file_ref_exact(
    file_ref: &SaveAsD2FileRefRecord,
    operation: &SaveAsOperationRecord,
) -> bool {
    file_ref.deleted_at.is_none()
        && file_ref.owner_type == operation.owner_type
        && file_ref.owner_id == operation.owner_id
        && file_ref.manuscript_channel == operation.channel
        && file_ref.resource_kind == "file"
        && file_ref.file_role == "manuscript"
        && file_ref.location_mode == operation.target_location_mode
        && file_ref.path_identity_key == operation.target_path_identity_key
}

fn register_or_reuse_d2_file_ref(
    connection: &Connection,
    operation: &SaveAsOperationRecord,
    now: &str,
) -> Result<(SaveAsD2FileRefRecord, &'static str), SaveAsOperationAuthorityError> {
    if let Some(existing) = read_d2_file_ref_by_identity(connection, operation)
        .map_err(|_| storage_error("D2 FileRef identity readback failed"))?
    {
        if d2_file_ref_exact(&existing, operation) {
            return Ok((existing, "reused"));
        }
        return Err(authority_error(
            "conflict",
            "D2_UNKNOWN_FILE_REF_CONFLICT",
            "target FileRef identity exists with a non-exact contract",
            "identity",
            None,
            Some(existing.id),
            false,
            true,
        ));
    }
    let file_ref_id = format!("save-as-d2-{}", operation.operation_id);
    let candidate_request_id = format!(
        "{}:{}",
        operation.operation_id, operation.operation_generation
    );
    connection
        .execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,description,
               candidate_request_id,candidate_occurred_at,schema_version,source,
               custom_fields,created_at,updated_at,deleted_at
             ) VALUES (
               ?1,?2,?3,?4,'file','manuscript',?5,'markdown',?6,?7,?6,NULL,
               ?8,?9,2,'system','[]',?9,?9,NULL
             )",
            params![
                file_ref_id,
                operation.owner_type,
                operation.owner_id,
                operation.channel,
                operation.target_location_mode,
                operation.target_display_path,
                operation.target_path_identity_key,
                candidate_request_id,
                now,
            ],
        )
        .map_err(|_| {
            authority_error(
                "conflict",
                "D2_UNKNOWN_FILE_REF_CONFLICT",
                "target FileRef registration conflicted with durable identity",
                "identity",
                None,
                None,
                false,
                true,
            )
        })?;
    let record = read_d2_file_ref_by_id(connection, &file_ref_id)
        .map_err(|_| storage_error("D2 FileRef readback failed"))?
        .ok_or_else(|| storage_error("D2 FileRef readback returned no row"))?;
    if !d2_file_ref_exact(&record, operation) {
        return Err(authority_error(
            "conflict",
            "D2_UNKNOWN_FILE_REF_CONFLICT",
            "registered target FileRef failed exact readback",
            "identity",
            None,
            Some(record.id),
            false,
            true,
        ));
    }
    Ok((record, "created"))
}

fn has_exact_d1_proof(operation: &SaveAsOperationRecord) -> bool {
    operation.d1_physical_identity_hash.as_deref().is_some_and(valid_hash)
        && operation.d1_readback_sha256.as_deref() == Some(operation.snapshot_sha256.as_str())
        && operation.d1_byte_length == Some(operation.snapshot_byte_length)
        && operation.d1_proof_generation.is_some_and(|value| value > 0)
}

fn receipt_exists(
    connection: &Connection,
    operation_id: &str,
    action_type: &str,
    action_id: &str,
) -> rusqlite::Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM save_as_reconciliation_action_receipts
             WHERE operation_id=?1 AND action_type=?2 AND action_id=?3)",
            params![operation_id, action_type, action_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value == 1)
}

#[allow(clippy::too_many_arguments)]
fn record_reconciliation_action(
    connection: &Connection,
    before: &SaveAsOperationRecord,
    after: &SaveAsOperationRecord,
    action_type: &str,
    action_id: &str,
    actor_process_generation: &str,
    result_code: &str,
    event_type: &str,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO save_as_reconciliation_action_receipts (
           operation_id,action_type,action_id,expected_operation_revision,
           expected_fence_revision,actor_process_generation,result_code,
           resulting_operation_stage,resulting_operation_revision,
           resulting_fence_revision,target_file_ref_id,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            before.operation_id,
            action_type,
            action_id,
            before.revision,
            before.commit_fence_revision,
            actor_process_generation,
            result_code,
            after.stage,
            after.revision,
            after.commit_fence_revision,
            after.target_file_ref_id,
            now,
        ],
    )?;
    let event_id = format!(
        "save-as:{}:{}:{}",
        before.operation_id, action_type, action_id
    );
    connection.execute(
        "INSERT INTO save_as_reconciliation_audit_events (
           event_id,operation_id,event_type,action_type,action_id,
           resulting_fence_revision,actor_process_generation,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            event_id,
            before.operation_id,
            event_type,
            action_type,
            action_id,
            after.commit_fence_revision,
            actor_process_generation,
            now,
        ],
    )?;
    Ok(())
}

fn record_system_reconciliation_event(
    connection: &Connection,
    operation: &SaveAsOperationRecord,
    event_type: &str,
    actor_process_generation: &str,
    now: &str,
) -> rusqlite::Result<()> {
    let event_id = format!(
        "save-as:{}:{}:{}",
        operation.operation_id, operation.commit_fence_revision, event_type
    );
    connection.execute(
        "INSERT OR IGNORE INTO save_as_reconciliation_audit_events (
           event_id,operation_id,event_type,action_type,action_id,
           resulting_fence_revision,actor_process_generation,created_at
         ) VALUES (?1,?2,?3,NULL,NULL,?4,?5,?6)",
        params![
            event_id,
            operation.operation_id,
            event_type,
            operation.commit_fence_revision,
            actor_process_generation,
            now,
        ],
    )?;
    Ok(())
}

fn insert(connection: &Connection, record: &SaveAsOperationRecord) -> rusqlite::Result<usize> {
    connection.execute(
        &format!(
            "INSERT INTO manuscript_save_as_operations ({COLUMNS}) VALUES (
             ?1,0,0,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
             ?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,
             ?38,?39,?40,?41,?42,?43)"
        ),
        params![
            record.operation_id,
            record.operation_generation,
            record.producer_process_generation,
            record.owner_type,
            record.owner_id,
            record.channel,
            record.source_window_role,
            record.source_file_ref_id,
            record.source_path_identity_key,
            record.source_revision,
            record.source_runtime_generation,
            record.snapshot_sha256,
            record.snapshot_byte_length,
            record.encoding_contract_version,
            record.newline_contract_version,
            record.target_display_path,
            record.target_path_identity_key,
            record.target_location_mode,
            record.target_parent_path_identity_key,
            record.target_parent_physical_identity_hash,
            record.d1_physical_identity_hash,
            record.d1_readback_sha256,
            record.d1_readback_revision,
            record.d1_byte_length,
            record.d1_proof_generation,
            record.target_file_ref_id,
            record.d2_readback_revision,
            record.containment_fence_token,
            record.reconciliation_result_code,
            record.reconciliation_resolved_at,
            record.stage,
            record.d1_commit_state,
            record.d2_commit_state,
            record.reconciliation_state,
            record.blocking_code,
            record.claim_token,
            record.claim_revision,
            record.claim_process_generation,
            record.observation_generation,
            record.observation_revision,
            record.created_at,
            record.updated_at,
            record.terminal_at,
        ],
    )
}

fn authority_error(
    category: &'static str,
    code: &'static str,
    reason: impl Into<String>,
    field_class: &'static str,
    expected_state: Option<String>,
    actual_state: Option<String>,
    retryable: bool,
    must_reread: bool,
) -> SaveAsOperationAuthorityError {
    SaveAsOperationAuthorityError {
        category,
        code,
        reason: reason.into(),
        field_class,
        expected_state,
        actual_state,
        retryable,
        must_reread,
        terminal_impact: "operation_retained",
    }
}

fn storage_error(reason: &'static str) -> SaveAsOperationAuthorityError {
    authority_error(
        "storage",
        "SAVE_AS_J0_RESPONSE_LOSS",
        reason,
        "storage",
        None,
        None,
        true,
        true,
    )
}

fn operation_identity(record: &SaveAsOperationRecord) -> SaveAsOperationIdentityExpectation {
    SaveAsOperationIdentityExpectation {
        operation_generation: record.operation_generation,
        producer_process_generation: record.producer_process_generation.clone(),
        owner_type: record.owner_type.clone(),
        owner_id: record.owner_id.clone(),
        channel: record.channel.clone(),
        source_window_role: record.source_window_role.clone(),
        source_file_ref_id: record.source_file_ref_id.clone(),
        source_path_identity_key: record.source_path_identity_key.clone(),
        source_revision: record.source_revision.clone(),
        source_runtime_generation: record.source_runtime_generation,
        snapshot_sha256: record.snapshot_sha256.clone(),
        snapshot_byte_length: record.snapshot_byte_length,
        encoding_contract_version: record.encoding_contract_version.clone(),
        newline_contract_version: record.newline_contract_version.clone(),
        target_display_path: record.target_display_path.clone(),
        target_path_identity_key: record.target_path_identity_key.clone(),
        target_location_mode: record.target_location_mode.clone(),
        target_parent_path_identity_key: record.target_parent_path_identity_key.clone(),
        target_parent_physical_identity_hash: record.target_parent_physical_identity_hash.clone(),
    }
}

pub(crate) fn expectation_from_record(
    record: &SaveAsOperationRecord,
) -> SaveAsOperationExpectation {
    SaveAsOperationExpectation {
        revision: record.revision,
        commit_fence_revision: record.commit_fence_revision,
        stage: record.stage,
        d1_commit_state: record.d1_commit_state,
        d2_commit_state: record.d2_commit_state,
        reconciliation_state: record.reconciliation_state,
        claim_token: record.claim_token.clone(),
        claim_revision: record.claim_revision,
        claim_process_generation: record.claim_process_generation.clone(),
        observation_generation: record.observation_generation,
        observation_revision: record.observation_revision,
        identity: operation_identity(record),
    }
}

fn state_label(record: &SaveAsOperationRecord) -> String {
    format!(
        "{}/{}/{}/{}@{}",
        record.stage.as_str(),
        record.d1_commit_state.as_str(),
        record.d2_commit_state.as_str(),
        record.reconciliation_state.as_str(),
        record.revision
    )
}

fn expectation_label(expected: &SaveAsOperationExpectation) -> String {
    format!(
        "{}/{}/{}/{}@{}",
        expected.stage.as_str(),
        expected.d1_commit_state.as_str(),
        expected.d2_commit_state.as_str(),
        expected.reconciliation_state.as_str(),
        expected.revision
    )
}

fn validate_expectation(
    record: &SaveAsOperationRecord,
    expected: &SaveAsOperationExpectation,
) -> Result<(), SaveAsOperationAuthorityError> {
    let actual_identity = operation_identity(record);
    if actual_identity.operation_generation != expected.identity.operation_generation
        || actual_identity.producer_process_generation
            != expected.identity.producer_process_generation
    {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_GENERATION_MISMATCH",
            "operation or process generation expectation does not match durable state",
            "identity",
            None,
            None,
            false,
            true,
        ));
    }
    if actual_identity.owner_type != expected.identity.owner_type
        || actual_identity.owner_id != expected.identity.owner_id
        || actual_identity.channel != expected.identity.channel
    {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_OWNER_IDENTITY_MISMATCH",
            "owner identity expectation does not match durable state",
            "identity",
            None,
            None,
            false,
            true,
        ));
    }
    if actual_identity != expected.identity {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH",
            "immutable operation identity expectation does not match durable state",
            "identity",
            None,
            None,
            false,
            true,
        ));
    }
    if record.revision != expected.revision {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_REVISION_CONFLICT",
            "revision expectation does not match durable state",
            "state",
            Some(expected.revision.to_string()),
            Some(record.revision.to_string()),
            false,
            true,
        ));
    }
    if record.commit_fence_revision != expected.commit_fence_revision {
        return Err(authority_error(
            "conflict",
            "D2_UNKNOWN_FENCE_CONFLICT",
            "commit fence revision expectation does not match durable state",
            "fence",
            Some(expected.commit_fence_revision.to_string()),
            Some(record.commit_fence_revision.to_string()),
            false,
            true,
        ));
    }
    if record.stage != expected.stage
        || record.d1_commit_state != expected.d1_commit_state
        || record.d2_commit_state != expected.d2_commit_state
        || record.reconciliation_state != expected.reconciliation_state
    {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_STAGE_CONFLICT",
            "composite operation state expectation does not match durable state",
            "state",
            Some(expectation_label(expected)),
            Some(state_label(record)),
            false,
            true,
        ));
    }
    if record.claim_token != expected.claim_token
        || record.claim_revision != expected.claim_revision
        || record.claim_process_generation != expected.claim_process_generation
    {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_CLAIM_TOKEN_MISMATCH",
            "claim token expectation does not match durable state",
            "token",
            None,
            None,
            false,
            true,
        ));
    }
    if record.observation_generation != expected.observation_generation
        || record.observation_revision != expected.observation_revision
    {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_OBSERVATION_TOKEN_MISMATCH",
            "observation token expectation does not match durable state",
            "token",
            None,
            None,
            false,
            true,
        ));
    }
    Ok(())
}

fn canonical_now_after(previous: Option<&str>) -> String {
    let now = Utc::now();
    let value = previous
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc) + Duration::milliseconds(1))
        .filter(|minimum| *minimum > now)
        .unwrap_or(now);
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_initial(record: &SaveAsOperationRecord) -> Result<(), SaveAsOperationAuthorityError> {
    if !valid_operation_id(&record.operation_id) {
        return Err(authority_error(
            "validation",
            "SAVE_AS_J0_INPUT_INVALID",
            "operationId must use the canonical ASCII [A-Za-z0-9:_-]+ domain",
            "input",
            None,
            None,
            false,
            false,
        ));
    }
    let exact_initial = record.revision == 0
        && record.commit_fence_revision == 0
        && record.operation_generation > 0
        && !record.producer_process_generation.is_empty()
        && record.stage == SaveAsOperationStage::PreD1Claimed
        && record.d1_commit_state == SaveAsCommitState::NotStarted
        && record.d2_commit_state == SaveAsCommitState::NotStarted
        && record.reconciliation_state == SaveAsReconciliationState::NotRequired
        && record.blocking_code.is_none()
        && record.claim_token.is_some()
        && record.claim_revision == Some(0)
        && record.claim_process_generation.is_some()
        && record.observation_generation == Some(0)
        && record.observation_revision == Some(0)
        && record.d1_physical_identity_hash.is_none()
        && record.d1_readback_sha256.is_none()
        && record.d1_readback_revision.is_none()
        && record.d1_byte_length.is_none()
        && record.d1_proof_generation.is_none()
        && record.target_file_ref_id.is_none()
        && record.d2_readback_revision.is_none()
        && record.containment_fence_token.is_none()
        && record.reconciliation_result_code.is_none()
        && record.reconciliation_resolved_at.is_none()
        && record.terminal_at.is_none()
        && valid_hash(&record.snapshot_sha256);
    if !exact_initial {
        return Err(authority_error(
            "validation",
            "SAVE_AS_J0_INPUT_INVALID",
            "create intent is not the exact canonical pre_d1_claimed composite state",
            "state",
            Some("pre_d1_claimed/not_started/not_started/not_required@0".into()),
            Some(state_label(record)),
            false,
            false,
        ));
    }
    Ok(())
}

pub(crate) fn create_in_connection(
    connection: &mut Connection,
    proposed: &SaveAsOperationRecord,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    validate_initial(proposed)?;
    let mut record = proposed.clone();
    let now = canonical_now_after(None);
    record.created_at = now.clone();
    record.updated_at = now;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin J0 create transaction"))?;
    if let Some(source_file_ref_id) = record.source_file_ref_id.as_deref() {
        let unresolved_operation_id = transaction
            .query_row(
                "SELECT operation_id
                 FROM manuscript_save_as_operations
                 WHERE owner_type=?1 AND owner_id=?2 AND channel=?3
                   AND source_file_ref_id=?4
                   AND stage IN (
                     'd2_commit_unknown','d2_reconciliation_contained',
                     'd2_reconciliation_conflict'
                   )
                 ORDER BY updated_at, operation_id COLLATE BINARY
                 LIMIT 1",
                params![record.owner_type, record.owner_id, record.channel, source_file_ref_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| storage_error("could not inspect unresolved D2 source guard"))?;
        if unresolved_operation_id.is_some() {
            return Err(authority_error(
                "conflict",
                "D2_UNKNOWN_SOURCE_UNRESOLVED",
                "source FileRef already has an unresolved bare D2 operation",
                "identity",
                None,
                unresolved_operation_id,
                false,
                true,
            ));
        }
    }
    let containment_tables: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
               'manuscript_save_as_finalizations','manuscript_save_as_candidate_custody'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|_| storage_error("could not inspect containment authority"))?;
    if containment_tables == 2 {
        let interrupted_operation_id = transaction
            .query_row(
                "SELECT operation.operation_id
                 FROM manuscript_save_as_operations AS operation
                 LEFT JOIN manuscript_save_as_finalizations AS finalization
                   ON finalization.operation_id = operation.operation_id
                 JOIN manuscript_save_as_candidate_custody AS custody
                   ON custody.operation_id = operation.operation_id
                 WHERE operation.owner_type=?1 AND operation.owner_id=?2
                   AND operation.channel=?3
                   AND ((?4 IS NOT NULL AND operation.source_file_ref_id=?4)
                     OR operation.source_path_identity_key=?5)
                   AND operation.stage='reconciliation_blocked'
                   AND operation.reconciliation_state='blocked'
                   AND custody.current_custody_authority='resolved'
                   AND custody.custody_state='process_generation_retired'
                   AND (
                     (operation.blocking_code='SAVE_AS_OPERATION_STALE'
                       AND finalization.finalization_state='presentation_completed')
                     OR
                     (operation.blocking_code IN (
                        'SAVE_AS_RUNTIME_GENERATION_STALE','SAVE_AS_SOURCE_SNAPSHOT_INVALID'
                       ) AND finalization.operation_id IS NULL)
                   )
                 ORDER BY operation.updated_at, operation.operation_id COLLATE BINARY
                 LIMIT 1",
                params![
                    record.owner_type,
                    record.owner_id,
                    record.channel,
                    record.source_file_ref_id,
                    record.source_path_identity_key
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| storage_error("could not inspect interrupted source guard"))?;
        if interrupted_operation_id.is_some() {
            return Err(authority_error(
                "conflict",
                "SAVE_AS_J0_CLAIM_CONFLICT",
                "source FileRef is frozen by an interrupted Save As operation pending explicit reconciliation",
                "identity",
                None,
                interrupted_operation_id,
                false,
                true,
            ));
        }
    }
    let changed = insert(&transaction, &record).map_err(|error| {
        if error.to_string().contains("target_path_identity_key")
            || error.to_string().contains("operation_id")
        {
            authority_error(
                "conflict",
                "SAVE_AS_J0_CLAIM_CONFLICT",
                "operation or target identity is already durably claimed",
                "identity",
                None,
                None,
                false,
                true,
            )
        } else {
            authority_error(
                "validation",
                "SAVE_AS_J0_INPUT_INVALID",
                "durable create rejected the proposed canonical record",
                "input",
                None,
                None,
                false,
                false,
            )
        }
    })?;
    if changed != 1 {
        return Err(storage_error("J0 create did not affect exactly one row"));
    }
    let record = readback_in_connection(&transaction, &record.operation_id)
        .map_err(|_| storage_error("J0 create readback failed"))?
        .ok_or_else(|| storage_error("J0 create readback returned no row"))?;
    transaction
        .commit()
        .map_err(|_| storage_error("J0 create commit response was lost"))?;
    Ok(record)
}

fn apply_mutation(
    current: &SaveAsOperationRecord,
    mutation: &SaveAsOperationMutation,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    let mut next = current.clone();
    if matches!(
        current.stage,
        SaveAsOperationStage::Completed
            | SaveAsOperationStage::FinalizationCompensated
            | SaveAsOperationStage::PreD1Closed
            | SaveAsOperationStage::ReconciliationBlocked
            | SaveAsOperationStage::D2ReconciliationConflict
            | SaveAsOperationStage::D2ReconciledTerminal
    ) {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_TERMINAL_STATE_CONFLICT",
            "terminal Save As operation cannot be reopened or terminalized again",
            "state",
            None,
            Some(state_label(current)),
            false,
            true,
        ));
    }
    let legal = match mutation {
        SaveAsOperationMutation::EnterD1CommitUnknown
            if current.stage == SaveAsOperationStage::PreD1Claimed =>
        {
            next.stage = SaveAsOperationStage::D1CommitUnknown;
            next.d1_commit_state = SaveAsCommitState::Unknown;
            next.reconciliation_state = SaveAsReconciliationState::Pending;
            next.blocking_code = Some(SaveAsFailureCode::SaveAsPhysicalEffectUnknown);
            true
        }
        SaveAsOperationMutation::ConfirmD1 {
            d1_physical_identity_hash,
            d1_readback_sha256,
            d1_readback_revision,
            d1_byte_length,
            d1_proof_generation,
        } if current.stage == SaveAsOperationStage::D1CommitUnknown
            && valid_hash(d1_physical_identity_hash)
            && valid_hash(d1_readback_sha256)
            && !d1_readback_revision.is_empty()
            && *d1_byte_length >= 0
            && *d1_proof_generation > 0 =>
        {
            next.stage = SaveAsOperationStage::D1Confirmed;
            next.d1_commit_state = SaveAsCommitState::Confirmed;
            next.reconciliation_state = SaveAsReconciliationState::Resolved;
            next.blocking_code = None;
            next.d1_physical_identity_hash = Some(d1_physical_identity_hash.clone());
            next.d1_readback_sha256 = Some(d1_readback_sha256.clone());
            next.d1_readback_revision = Some(d1_readback_revision.clone());
            next.d1_byte_length = Some(*d1_byte_length);
            next.d1_proof_generation = Some(*d1_proof_generation);
            true
        }
        SaveAsOperationMutation::ClosePreD1 { blocking_code }
            if current.stage == SaveAsOperationStage::PreD1Claimed =>
        {
            next.stage = SaveAsOperationStage::PreD1Closed;
            next.blocking_code = Some(*blocking_code);
            true
        }
        SaveAsOperationMutation::EnterD2CommitUnknown
            if current.stage == SaveAsOperationStage::D1Confirmed =>
        {
            next.stage = SaveAsOperationStage::D2CommitUnknown;
            next.d2_commit_state = SaveAsCommitState::Unknown;
            next.reconciliation_state = SaveAsReconciliationState::Pending;
            next.blocking_code = None;
            true
        }
        SaveAsOperationMutation::EnterR3ActivationPending
            if current.stage == SaveAsOperationStage::D2Confirmed =>
        {
            next.stage = SaveAsOperationStage::R3ActivationPending;
            true
        }
        SaveAsOperationMutation::EnterP4PresentationPending
            if current.stage == SaveAsOperationStage::R3ActivationPending =>
        {
            next.stage = SaveAsOperationStage::P4PresentationPending;
            true
        }
        SaveAsOperationMutation::BlockReconciliation { blocking_code }
            if matches!(
                current.stage,
                SaveAsOperationStage::D1CommitUnknown
                    | SaveAsOperationStage::D2CommitUnknown
                    | SaveAsOperationStage::R3ActivationPending
                    | SaveAsOperationStage::P4PresentationPending
            ) =>
        {
            next.stage = SaveAsOperationStage::ReconciliationBlocked;
            next.reconciliation_state = SaveAsReconciliationState::Blocked;
            next.blocking_code = Some(*blocking_code);
            if current.stage == SaveAsOperationStage::D1CommitUnknown {
                next.d1_commit_state = SaveAsCommitState::Blocked;
            } else if current.stage == SaveAsOperationStage::D2CommitUnknown {
                next.d2_commit_state = SaveAsCommitState::Blocked;
            }
            true
        }
        _ => false,
    };
    if !legal {
        return Err(authority_error(
            "validation",
            "SAVE_AS_OPERATION_ILLEGAL_TRANSITION",
            "mutation intent is not legal from the authoritative composite state",
            "state",
            None,
            Some(state_label(current)),
            false,
            true,
        ));
    }
    next.updated_at = canonical_now_after(Some(&current.updated_at));
    if matches!(
        next.stage,
        SaveAsOperationStage::Completed
            | SaveAsOperationStage::FinalizationCompensated
            | SaveAsOperationStage::PreD1Closed
            | SaveAsOperationStage::ReconciliationBlocked
            | SaveAsOperationStage::D2ReconciliationConflict
            | SaveAsOperationStage::D2ReconciledTerminal
    ) {
        next.terminal_at = Some(next.updated_at.clone());
    }
    Ok(next)
}

fn update_mutable(
    connection: &Connection,
    next: &SaveAsOperationRecord,
    expected: &SaveAsOperationExpectation,
) -> rusqlite::Result<usize> {
    connection.execute(
        "UPDATE manuscript_save_as_operations SET
         revision=revision+1,
         commit_fence_revision=commit_fence_revision+1,
         d1_physical_identity_hash=?1, d1_readback_sha256=?2,
         d1_readback_revision=?3, d1_byte_length=?4, d1_proof_generation=?5,
         target_file_ref_id=?6, d2_readback_revision=?7,
         stage=?8, d1_commit_state=?9, d2_commit_state=?10,
         reconciliation_state=?11, blocking_code=?12,
         claim_token=?13, claim_revision=?14, claim_process_generation=?15,
         observation_generation=?16, observation_revision=?17,
         updated_at=?18, terminal_at=?19
         WHERE operation_id=?20 AND revision=?21 AND commit_fence_revision=?22 AND stage=?23
           AND d1_commit_state=?24 AND d2_commit_state=?25
           AND reconciliation_state=?26
           AND claim_token IS ?27 AND claim_revision IS ?28
           AND claim_process_generation IS ?29
           AND observation_generation IS ?30 AND observation_revision IS ?31",
        params![
            next.d1_physical_identity_hash,
            next.d1_readback_sha256,
            next.d1_readback_revision,
            next.d1_byte_length,
            next.d1_proof_generation,
            next.target_file_ref_id,
            next.d2_readback_revision,
            next.stage,
            next.d1_commit_state,
            next.d2_commit_state,
            next.reconciliation_state,
            next.blocking_code,
            next.claim_token,
            next.claim_revision,
            next.claim_process_generation,
            next.observation_generation,
            next.observation_revision,
            next.updated_at,
            next.terminal_at,
            next.operation_id,
            expected.revision,
            expected.commit_fence_revision,
            expected.stage,
            expected.d1_commit_state,
            expected.d2_commit_state,
            expected.reconciliation_state,
            expected.claim_token,
            expected.claim_revision,
            expected.claim_process_generation,
            expected.observation_generation,
            expected.observation_revision,
        ],
    )
}

pub(crate) fn transition_in_connection(
    connection: &mut Connection,
    input: &SaveAsOperationTransitionInput,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    if !valid_operation_id(&input.operation_id) {
        return Err(authority_error(
            "validation",
            "SAVE_AS_J0_INPUT_INVALID",
            "operationId must use the canonical ASCII [A-Za-z0-9:_-]+ domain",
            "input",
            None,
            None,
            false,
            false,
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin J0 transition transaction"))?;
    let current = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("J0 transition readback failed"))?
        .ok_or_else(|| {
            authority_error(
                "conflict",
                "SAVE_AS_OPERATION_NOT_FOUND",
                "durable operation does not exist",
                "state",
                None,
                None,
                false,
                true,
            )
        })?;
    validate_expectation(&current, &input.expected)?;
    let next = apply_mutation(&current, &input.mutation)?;
    let changed = update_mutable(&transaction, &next, &input.expected)
        .map_err(|_| storage_error("J0 transition update failed"))?;
    if changed != 1 {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_OPERATION_STAGE_CONFLICT",
            "composite CAS did not affect exactly one row",
            "state",
            Some(expectation_label(&input.expected)),
            None,
            false,
            true,
        ));
    }
    let record = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("J0 transition readback failed"))?
        .ok_or_else(|| storage_error("J0 transition readback returned no row"))?;
    let mut expected_readback = next;
    expected_readback.revision += 1;
    expected_readback.commit_fence_revision += 1;
    if record != expected_readback {
        return Err(authority_error(
            "storage",
            "SAVE_AS_OPERATION_READBACK_MISMATCH",
            "authoritative transition readback did not match the applied mutation",
            "storage",
            None,
            None,
            true,
            true,
        ));
    }
    transaction
        .commit()
        .map_err(|_| storage_error("J0 transition commit response was lost"))?;
    Ok(record)
}

fn d2_action_result(
    connection: &Connection,
    operation_id: &str,
    state: &'static str,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    let operation = readback_in_connection(connection, operation_id)
        .map_err(|_| storage_error("D2 operation readback failed"))?
        .ok_or_else(|| storage_error("D2 operation readback returned no row"))?;
    let file_ref = match operation.target_file_ref_id.as_deref() {
        Some(file_ref_id) => read_d2_file_ref_by_id(connection, file_ref_id)
            .map_err(|_| storage_error("D2 FileRef result readback failed"))?,
        None => None,
    };
    Ok(SaveAsD2AuthorityResult { operation, file_ref, state })
}

pub(crate) fn atomic_d2_commit_in_connection(
    connection: &mut Connection,
    input: &SaveAsD2AtomicCommitInput,
    actor_process_generation: &str,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin atomic D2 transaction"))?;
    let current = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("atomic D2 operation readback failed"))?
        .ok_or_else(|| authority_error(
            "conflict", "SAVE_AS_OPERATION_NOT_FOUND", "durable operation does not exist",
            "state", None, None, false, true,
        ))?;
    if current.producer_process_generation == actor_process_generation
        && matches!(current.stage,
            SaveAsOperationStage::D2ReconciliationContained
                | SaveAsOperationStage::D2ReconciliationConflict
                | SaveAsOperationStage::D2ReconciledTerminal)
    {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_LATE_WRITER_REJECTED",
            "producer D2 writer was fenced by durable containment", "fence",
            None, Some(state_label(&current)), false, true,
        ));
    }
    validate_expectation(&current, &input.expected)?;
    if current.producer_process_generation != actor_process_generation {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_STALE_PERMIT",
            "normal D2 writer is not the durable producer process", "identity",
            Some(current.producer_process_generation.clone()),
            Some(actor_process_generation.to_string()), false, true,
        ));
    }
    if current.stage == SaveAsOperationStage::D2Confirmed
        && current.d2_commit_state == SaveAsCommitState::Confirmed
        && current.target_file_ref_id.is_some()
    {
        let result = d2_action_result(&transaction, &input.operation_id, "reconciled")?;
        if result.file_ref.as_ref().is_some_and(|value| d2_file_ref_exact(value, &current)) {
            transaction.commit()
                .map_err(|_| storage_error("atomic D2 idempotent commit failed"))?;
            return Ok(result);
        }
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_FILE_REF_CONFLICT",
            "confirmed D2 FileRef failed exact durable readback", "identity",
            None, current.target_file_ref_id.clone(), false, true,
        ));
    }
    if current.stage != SaveAsOperationStage::D1Confirmed || !has_exact_d1_proof(&current) {
        return Err(authority_error(
            "validation", "D2_UNKNOWN_PHYSICAL_PROOF_MISMATCH",
            "normal D2 commit requires exact confirmed D1 proof", "state",
            Some("d1_confirmed".into()), Some(state_label(&current)), false, true,
        ));
    }
    let now = canonical_now_after(Some(&current.updated_at));
    let (file_ref, state) = register_or_reuse_d2_file_ref(&transaction, &current, &now)?;
    let changed = transaction.execute(
        "UPDATE manuscript_save_as_operations SET
           revision=revision+1,commit_fence_revision=commit_fence_revision+1,
           target_file_ref_id=?1,d2_readback_revision=?2,stage='d2_confirmed',
           d2_commit_state='confirmed',reconciliation_state='resolved',
           blocking_code=NULL,updated_at=?3
         WHERE operation_id=?4 AND revision=?5 AND commit_fence_revision=?6
           AND stage='d1_confirmed' AND d1_commit_state='confirmed'
           AND d2_commit_state='not_started'",
        params![file_ref.id, file_ref.updated_at, now, current.operation_id,
            current.revision, current.commit_fence_revision],
    ).map_err(|_| storage_error("atomic D2 operation update failed"))?;
    if changed != 1 {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_FENCE_CONFLICT",
            "atomic D2 composite CAS did not affect exactly one row", "fence",
            None, None, false, true,
        ));
    }
    let result = d2_action_result(&transaction, &input.operation_id, state)?;
    record_system_reconciliation_event(
        &transaction, &result.operation, "d2_atomic_commit_confirmed",
        actor_process_generation, &now,
    ).map_err(|_| storage_error("atomic D2 audit write failed"))?;
    transaction.commit()
        .map_err(|_| storage_error("atomic D2 commit response was lost"))?;
    Ok(result)
}

fn d2_physical_conflict(operation: &SaveAsOperationRecord) -> Option<SaveAsFailureCode> {
    if operation.d1_physical_identity_hash.is_none()
        || operation.d1_readback_sha256.is_none()
        || operation.d1_byte_length.is_none()
        || operation.d1_proof_generation.is_none()
    {
        return Some(SaveAsFailureCode::D2UnknownIdentityIncomplete);
    }
    if !has_exact_d1_proof(operation) {
        return Some(SaveAsFailureCode::D2UnknownPhysicalProofMismatch);
    }
    let target_bytes = match fs::read(&operation.target_display_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Some(SaveAsFailureCode::D2UnknownPhysicalTargetMissing);
        }
        Err(_) => return Some(SaveAsFailureCode::D2UnknownPhysicalProofMismatch),
    };
    let target_sha256 = format!("{:x}", Sha256::digest(&target_bytes));
    if operation.d1_byte_length != Some(target_bytes.len() as i64)
        || operation.d1_readback_sha256.as_deref() != Some(target_sha256.as_str())
    {
        return Some(SaveAsFailureCode::D2UnknownPhysicalProofMismatch);
    }
    None
}

fn d2_containment_conflict(
    connection: &Connection,
    operation: &SaveAsOperationRecord,
) -> Result<Option<SaveAsFailureCode>, SaveAsOperationAuthorityError> {
    if let Some(conflict) = d2_physical_conflict(operation) {
        return Ok(Some(conflict));
    }
    if read_d2_file_ref_by_identity(connection, operation)
        .map_err(|_| storage_error("containment FileRef inspection failed"))?.is_some()
    {
        return Ok(Some(SaveAsFailureCode::D2UnknownFileRefConflict));
    }
    let competing: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM manuscript_save_as_operations
         WHERE operation_id<>?1 AND target_path_identity_key=?2
           AND stage IN ('pre_d1_claimed','d1_commit_unknown','d1_confirmed',
             'd2_commit_unknown','d2_confirmed','r3_activation_pending',
             'p4_presentation_pending','d2_reconciliation_contained',
             'd2_reconciliation_conflict'))",
        params![operation.operation_id, operation.target_path_identity_key],
        |row| row.get(0),
    ).map_err(|_| storage_error("containment competing operation inspection failed"))?;
    if competing == 1 {
        return Ok(Some(SaveAsFailureCode::D2UnknownCompetingOperation));
    }
    let has_finalization_table: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'
         AND name='manuscript_save_as_finalizations')",
        [], |row| row.get(0),
    ).map_err(|_| storage_error("containment finalization schema inspection failed"))?;
    let finalization: i64 = if has_finalization_table == 1 {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM manuscript_save_as_finalizations WHERE operation_id=?1)",
            [operation.operation_id.as_str()], |row| row.get(0),
        ).map_err(|_| storage_error("containment finalization inspection failed"))?
    } else { 0 };
    if finalization == 1 {
        return Ok(Some(SaveAsFailureCode::D2UnknownUnexpectedFinalization));
    }
    let has_custody_table: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'
         AND name='manuscript_save_as_candidate_custody')",
        [], |row| row.get(0),
    ).map_err(|_| storage_error("containment custody schema inspection failed"))?;
    let custody: i64 = if has_custody_table == 1 {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM manuscript_save_as_candidate_custody WHERE operation_id=?1)",
            [operation.operation_id.as_str()], |row| row.get(0),
        ).map_err(|_| storage_error("containment custody inspection failed"))?
    } else { 0 };
    if custody == 1 {
        return Ok(Some(SaveAsFailureCode::D2UnknownUnexpectedCustody));
    }
    Ok(None)
}

fn contain_d2_in_connection(
    connection: &mut Connection,
    input: &SaveAsD2ContainmentInput,
    actor_process_generation: &str,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    if input.action_id.is_empty() || actor_process_generation.is_empty() {
        return Err(authority_error(
            "validation", "SAVE_AS_J0_INPUT_INVALID",
            "containment action and actor identity are required", "input",
            None, None, false, false,
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin D2 containment transaction"))?;
    let duplicate = receipt_exists(&transaction, &input.operation_id, "containment", &input.action_id)
        .map_err(|_| storage_error("containment receipt readback failed"))?
        || receipt_exists(&transaction, &input.operation_id, "conflict", &input.action_id)
            .map_err(|_| storage_error("containment receipt readback failed"))?;
    if duplicate {
        let result = d2_action_result(&transaction, &input.operation_id, "idempotent")?;
        transaction.commit().map_err(|_| storage_error("containment idempotent commit failed"))?;
        return Ok(result);
    }
    let current = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("containment operation readback failed"))?
        .ok_or_else(|| authority_error(
            "conflict", "SAVE_AS_OPERATION_NOT_FOUND", "durable operation does not exist",
            "state", None, None, false, true,
        ))?;
    validate_expectation(&current, &input.expected)?;
    if current.producer_process_generation == actor_process_generation {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_STALE_PERMIT",
            "containment requires an independent successor process", "identity",
            None, Some(actor_process_generation.to_string()), false, true,
        ));
    }
    if current.stage != SaveAsOperationStage::D2CommitUnknown
        || current.d1_commit_state != SaveAsCommitState::Confirmed
        || current.d2_commit_state != SaveAsCommitState::Unknown
    {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_TERMINAL_STATE_CONFLICT",
            "only bare d2_commit_unknown may enter containment", "state",
            Some("d2_commit_unknown".into()), Some(state_label(&current)), false, true,
        ));
    }
    let conflict = d2_containment_conflict(&transaction, &current)?;
    let token = Uuid::new_v4().to_string();
    let now = canonical_now_after(Some(&current.updated_at));
    let (stage, d2_state, reconciliation_state, result_code, action_type, event_type) =
        if let Some(code) = conflict {
            (SaveAsOperationStage::D2ReconciliationConflict, SaveAsCommitState::Blocked,
             SaveAsReconciliationState::Blocked, code.as_str(), "conflict",
             "d2_reconciliation_conflict_recorded")
        } else {
            (SaveAsOperationStage::D2ReconciliationContained, SaveAsCommitState::Unknown,
             SaveAsReconciliationState::Pending, "D2_UNKNOWN_CONTAINED", "containment",
             "d2_reconciliation_contained")
        };
    let terminal_at = conflict.map(|_| now.clone());
    let changed = transaction.execute(
        "UPDATE manuscript_save_as_operations SET
           revision=revision+1,commit_fence_revision=commit_fence_revision+1,
           containment_fence_token=?1,reconciliation_result_code=?2,
           stage=?3,d2_commit_state=?4,reconciliation_state=?5,
           blocking_code=?6,updated_at=?7,terminal_at=?8
         WHERE operation_id=?9 AND revision=?10 AND commit_fence_revision=?11
           AND stage='d2_commit_unknown' AND d1_commit_state='confirmed'
           AND d2_commit_state='unknown'",
        params![token, result_code, stage, d2_state, reconciliation_state, conflict,
            now, terminal_at, current.operation_id, current.revision,
            current.commit_fence_revision],
    ).map_err(|_| storage_error("D2 containment update failed"))?;
    if changed != 1 {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_FENCE_CONFLICT",
            "D2 containment composite CAS did not affect exactly one row", "fence",
            None, None, false, true,
        ));
    }
    let result = d2_action_result(&transaction, &input.operation_id, action_type)?;
    record_reconciliation_action(
        &transaction, &current, &result.operation, action_type, &input.action_id,
        actor_process_generation, result_code, event_type, &now,
    ).map_err(|_| storage_error("D2 containment receipt write failed"))?;
    transaction.commit()
        .map_err(|_| storage_error("D2 containment commit response was lost"))?;
    Ok(result)
}

fn confirm_contained_d2_in_connection(
    connection: &mut Connection,
    input: &SaveAsD2ConfirmInput,
    actor_process_generation: &str,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    if input.action_id.is_empty() || input.containment_fence_token.is_empty() {
        return Err(authority_error(
            "validation", "SAVE_AS_J0_INPUT_INVALID",
            "confirm action and containment fence token are required", "input",
            None, None, false, false,
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin D2 confirm transaction"))?;
    if receipt_exists(&transaction, &input.operation_id, "confirm", &input.action_id)
        .map_err(|_| storage_error("D2 confirm receipt readback failed"))?
        || receipt_exists(&transaction, &input.operation_id, "conflict", &input.action_id)
            .map_err(|_| storage_error("D2 confirm conflict receipt readback failed"))?
    {
        let result = d2_action_result(&transaction, &input.operation_id, "idempotent")?;
        transaction.commit().map_err(|_| storage_error("D2 confirm idempotent commit failed"))?;
        return Ok(result);
    }
    let current = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("D2 confirm operation readback failed"))?
        .ok_or_else(|| storage_error("D2 confirm operation readback returned no row"))?;
    validate_expectation(&current, &input.expected)?;
    if current.stage != SaveAsOperationStage::D2ReconciliationContained
        || current.containment_fence_token.as_deref()
            != Some(input.containment_fence_token.as_str())
    {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_STALE_PERMIT",
            "confirm permit does not match the authoritative contained stage", "token",
            None, Some(state_label(&current)), false, true,
        ));
    }
    let containing_actor: Option<String> = transaction.query_row(
        "SELECT actor_process_generation FROM save_as_reconciliation_action_receipts
         WHERE operation_id=?1 AND action_type='containment'
         ORDER BY created_at DESC LIMIT 1",
        [current.operation_id.as_str()], |row| row.get(0),
    ).optional().map_err(|_| storage_error("containment actor receipt readback failed"))?;
    if containing_actor.as_deref() != Some(actor_process_generation) {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_STALE_PERMIT",
            "confirm actor is not the durable containment owner", "identity",
            containing_actor, Some(actor_process_generation.to_string()), false, true,
        ));
    }
    let now = canonical_now_after(Some(&current.updated_at));
    if let Some(conflict) = d2_containment_conflict(&transaction, &current)? {
        let changed = transaction.execute(
            "UPDATE manuscript_save_as_operations SET
               revision=revision+1,commit_fence_revision=commit_fence_revision+1,
               reconciliation_result_code=?1,stage='d2_reconciliation_conflict',
               d2_commit_state='blocked',reconciliation_state='blocked',
               blocking_code=?1,updated_at=?2,terminal_at=?2
             WHERE operation_id=?3 AND revision=?4 AND commit_fence_revision=?5
               AND stage='d2_reconciliation_contained'
               AND containment_fence_token=?6",
            params![conflict, now, current.operation_id, current.revision,
                current.commit_fence_revision, input.containment_fence_token],
        ).map_err(|_| storage_error("D2 confirm conflict update failed"))?;
        if changed != 1 {
            return Err(authority_error(
                "conflict", "D2_UNKNOWN_FENCE_CONFLICT",
                "D2 confirm conflict composite CAS did not affect exactly one row", "fence",
                None, None, false, true,
            ));
        }
        let result = d2_action_result(&transaction, &input.operation_id, "conflict")?;
        record_reconciliation_action(
            &transaction, &current, &result.operation, "conflict", &input.action_id,
            actor_process_generation, conflict.as_str(),
            "d2_confirm_physical_conflict_recorded", &now,
        ).map_err(|_| storage_error("D2 confirm conflict receipt write failed"))?;
        transaction.commit()
            .map_err(|_| storage_error("D2 confirm conflict commit response was lost"))?;
        return Ok(result);
    }
    let (file_ref, _) = register_or_reuse_d2_file_ref(&transaction, &current, &now)?;
    let result_code = "file_ref_reconciled_non_success";
    let changed = transaction.execute(
        "UPDATE manuscript_save_as_operations SET
           revision=revision+1,commit_fence_revision=commit_fence_revision+1,
           target_file_ref_id=?1,d2_readback_revision=?2,
           reconciliation_result_code=?3,reconciliation_resolved_at=?4,
           stage='d2_reconciled_terminal',d2_commit_state='confirmed',
           reconciliation_state='resolved',blocking_code=NULL,
           updated_at=?4,terminal_at=?4
         WHERE operation_id=?5 AND revision=?6 AND commit_fence_revision=?7
           AND stage='d2_reconciliation_contained'
           AND containment_fence_token=?8",
        params![file_ref.id, file_ref.updated_at, result_code, now,
            current.operation_id, current.revision, current.commit_fence_revision,
            input.containment_fence_token],
    ).map_err(|_| storage_error("D2 confirm update failed"))?;
    if changed != 1 {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_FENCE_CONFLICT",
            "D2 confirm composite CAS did not affect exactly one row", "fence",
            None, None, false, true,
        ));
    }
    let result = d2_action_result(&transaction, &input.operation_id, "reconciled")?;
    record_reconciliation_action(
        &transaction, &current, &result.operation, "confirm", &input.action_id,
        actor_process_generation, result_code, "d2_reconciled_terminal", &now,
    ).map_err(|_| storage_error("D2 confirm receipt write failed"))?;
    transaction.commit().map_err(|_| storage_error("D2 confirm commit response was lost"))?;
    Ok(result)
}

fn dismiss_d2_notice_in_connection(
    connection: &mut Connection,
    input: &SaveAsD2DismissInput,
    actor_process_generation: &str,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    if input.action_id.is_empty() || input.containment_fence_token.is_empty() {
        return Err(authority_error(
            "validation", "SAVE_AS_J0_INPUT_INVALID",
            "dismiss action and containment fence token are required", "input",
            None, None, false, false,
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin D2 notice dismiss transaction"))?;
    if receipt_exists(&transaction, &input.operation_id, "dismiss_notice", &input.action_id)
        .map_err(|_| storage_error("dismiss receipt readback failed"))?
    {
        let result = d2_action_result(&transaction, &input.operation_id, "idempotent")?;
        transaction.commit().map_err(|_| storage_error("dismiss idempotent commit failed"))?;
        return Ok(result);
    }
    let current = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("dismiss operation readback failed"))?
        .ok_or_else(|| storage_error("dismiss operation readback returned no row"))?;
    if current.revision != input.expected_operation_revision
        || current.commit_fence_revision != input.expected_fence_revision
        || current.containment_fence_token.as_deref()
            != Some(input.containment_fence_token.as_str())
        || !matches!(current.stage,
            SaveAsOperationStage::D2ReconciliationContained
                | SaveAsOperationStage::D2ReconciliationConflict)
    {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_STALE_PERMIT",
            "dismiss permit does not match authoritative containment state", "token",
            None, Some(state_label(&current)), false, true,
        ));
    }
    let now = canonical_now_after(Some(&current.updated_at));
    record_reconciliation_action(
        &transaction, &current, &current, "dismiss_notice", &input.action_id,
        actor_process_generation, "notice_dismissed",
        "d2_containment_notice_dismissed", &now,
    ).map_err(|_| storage_error("dismiss receipt write failed"))?;
    let result = SaveAsD2AuthorityResult {
        operation: current, file_ref: None, state: "dismissed",
    };
    transaction.commit().map_err(|_| storage_error("dismiss commit response was lost"))?;
    Ok(result)
}

fn audit_terminal_d2_integrity_in_connection(
    connection: &mut Connection,
    input: &SaveAsD2TerminalIntegrityInput,
    actor_process_generation: &str,
) -> Result<SaveAsD2TerminalIntegrityResult, SaveAsOperationAuthorityError> {
    if input.operation_id.is_empty() {
        return Err(authority_error(
            "validation", "SAVE_AS_J0_INPUT_INVALID",
            "terminal integrity operation id is required", "input",
            None, None, false, false,
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin terminal D2 integrity transaction"))?;
    let operation = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("terminal D2 integrity readback failed"))?
        .ok_or_else(|| storage_error("terminal D2 integrity readback returned no row"))?;
    if operation.stage != SaveAsOperationStage::D2ReconciledTerminal {
        return Err(authority_error(
            "conflict", "D2_UNKNOWN_TERMINAL_STATE_CONFLICT",
            "physical integrity audit requires an immutable reconciled terminal operation",
            "state", Some("d2_reconciled_terminal".into()),
            Some(state_label(&operation)), false, true,
        ));
    }
    let incident_code = d2_physical_conflict(&operation);
    if incident_code.is_some() {
        let now = canonical_now_after(Some(&operation.updated_at));
        record_system_reconciliation_event(
            &transaction,
            &operation,
            "post_reconciliation_physical_integrity_incident",
            actor_process_generation,
            &now,
        ).map_err(|_| storage_error("terminal D2 integrity audit write failed"))?;
    }
    let result = SaveAsD2TerminalIntegrityResult {
        operation,
        integrity_state: if incident_code.is_some() { "incident" } else { "verified" },
        incident_code,
        file_use_allowed: incident_code.is_none(),
    };
    transaction.commit()
        .map_err(|_| storage_error("terminal D2 integrity audit commit response was lost"))?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn atomic_commit_save_as_d2(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsD2AtomicCommitInput,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    let mut connection = super::open_connection(&app_handle)
        .map_err(|_| storage_error("could not open D2 authority"))?;
    atomic_d2_commit_in_connection(&mut connection, &input, authority.process_generation())
}

#[tauri::command]
pub(crate) fn contain_unknown_save_as_d2(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsD2ContainmentInput,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    let mut connection = super::open_connection(&app_handle)
        .map_err(|_| storage_error("could not open D2 containment authority"))?;
    contain_d2_in_connection(&mut connection, &input, authority.process_generation())
}

#[tauri::command]
pub(crate) fn confirm_contained_save_as_d2(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsD2ConfirmInput,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    let mut connection = super::open_connection(&app_handle)
        .map_err(|_| storage_error("could not open D2 confirm authority"))?;
    confirm_contained_d2_in_connection(
        &mut connection,
        &input,
        authority.process_generation(),
    )
}

#[tauri::command]
pub(crate) fn dismiss_contained_save_as_d2_notice(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsD2DismissInput,
) -> Result<SaveAsD2AuthorityResult, SaveAsOperationAuthorityError> {
    let mut connection = super::open_connection(&app_handle)
        .map_err(|_| storage_error("could not open D2 dismiss authority"))?;
    dismiss_d2_notice_in_connection(
        &mut connection,
        &input,
        authority.process_generation(),
    )
}

#[tauri::command]
pub(crate) fn audit_terminal_save_as_d2_integrity(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsD2TerminalIntegrityInput,
) -> Result<SaveAsD2TerminalIntegrityResult, SaveAsOperationAuthorityError> {
    let mut connection = super::open_connection(&app_handle)
        .map_err(|_| storage_error("could not open terminal D2 integrity authority"))?;
    audit_terminal_d2_integrity_in_connection(
        &mut connection,
        &input,
        authority.process_generation(),
    )
}

#[tauri::command]
pub(crate) fn create_save_as_operation(
    app_handle: AppHandle,
    record: SaveAsOperationRecord,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    let mut connection =
        super::open_connection(&app_handle).map_err(|_| storage_error("could not open J0"))?;
    create_in_connection(&mut connection, &record)
}

#[tauri::command]
pub(crate) fn transition_save_as_operation(
    app_handle: AppHandle,
    input: SaveAsOperationTransitionInput,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    let mut connection =
        super::open_connection(&app_handle).map_err(|_| storage_error("could not open J0"))?;
    transition_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn readback_save_as_operation(
    app_handle: AppHandle,
    operation_id: String,
) -> Result<Option<SaveAsOperationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    readback_in_connection(&connection, &operation_id)
}

#[tauri::command]
pub(crate) fn list_reconcilable_save_as_operations(
    app_handle: AppHandle,
    limit: u32,
) -> Result<Vec<SaveAsOperationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_reconcilable_in_connection(&connection, limit)
}

pub(crate) fn list_reconcilable_in_connection(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SaveAsOperationRecord>, String> {
    let bounded_limit = limit.clamp(1, 1_000);
    let mut reconciliation_statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM manuscript_save_as_operations
             WHERE reconciliation_state IN ('pending','claimed')
               AND NOT EXISTS (
                 SELECT 1 FROM manuscript_save_as_finalizations AS finalization
                 WHERE finalization.operation_id = manuscript_save_as_operations.operation_id
                   AND finalization.finalization_state = 'presentation_completed'
               )
             ORDER BY updated_at ASC, operation_id COLLATE BINARY ASC LIMIT ?1"
        ))
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;
    let mut records = reconciliation_statement
        .query_map([bounded_limit], row_record)
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;

    let mut continuation_statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM manuscript_save_as_operations
             WHERE stage IN ('d2_confirmed','r3_activation_pending','p4_presentation_pending')
               AND NOT EXISTS (
                 SELECT 1 FROM manuscript_save_as_finalizations AS finalization
                 WHERE finalization.operation_id = manuscript_save_as_operations.operation_id
                   AND finalization.finalization_state = 'presentation_completed'
               )
             ORDER BY updated_at ASC, operation_id COLLATE BINARY ASC LIMIT ?1"
        ))
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;
    records.extend(
        continuation_statement
            .query_map([bounded_limit], row_record)
            .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?,
    );
    records.sort_by(|left, right| {
        left.updated_at
            .cmp(&right.updated_at)
            .then_with(|| left.operation_id.cmp(&right.operation_id))
    });
    records.truncate(bounded_limit as usize);
    Ok(records)
}

fn list_visible_d2_containment_in_connection(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SaveAsOperationRecord>, String> {
    let bounded_limit = limit.clamp(1, 1_000);
    let mut statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM manuscript_save_as_operations AS operation
             WHERE operation.stage IN (
               'd2_reconciliation_contained','d2_reconciliation_conflict'
             )
             AND NOT EXISTS (
               SELECT 1 FROM save_as_reconciliation_action_receipts AS receipt
               WHERE receipt.operation_id=operation.operation_id
                 AND receipt.action_type='dismiss_notice'
             )
             ORDER BY operation.updated_at, operation.operation_id COLLATE BINARY
             LIMIT ?1"
        ))
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;
    let records = statement
        .query_map([i64::from(bounded_limit)], row_record)
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;
    Ok(records)
}

fn list_reconciled_terminal_d2_in_connection(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SaveAsOperationRecord>, String> {
    let bounded_limit = limit.clamp(1, 1_000);
    let mut statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM manuscript_save_as_operations
             WHERE stage='d2_reconciled_terminal'
             ORDER BY updated_at, operation_id COLLATE BINARY
             LIMIT ?1"
        ))
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;
    let records = statement
        .query_map([i64::from(bounded_limit)], row_record)
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "SAVE_AS_J0_RESPONSE_LOSS".to_string())?;
    Ok(records)
}

#[tauri::command]
pub(crate) fn list_visible_save_as_d2_containment(
    app_handle: AppHandle,
    limit: u32,
) -> Result<Vec<SaveAsOperationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_visible_d2_containment_in_connection(&connection, limit)
}

#[tauri::command]
pub(crate) fn list_reconciled_terminal_save_as_d2_operations(
    app_handle: AppHandle,
    limit: u32,
) -> Result<Vec<SaveAsOperationRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_reconciled_terminal_d2_in_connection(&connection, limit)
}

#[tauri::command]
pub(crate) fn claim_save_as_operation_observation(
    app_handle: AppHandle,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsObservationClaimInput,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    let mut connection =
        super::open_connection(&app_handle).map_err(|_| storage_error("could not open J0"))?;
    claim_in_connection(&mut connection, &input, authority.process_generation())
}

fn claim_in_connection(
    connection: &mut Connection,
    input: &SaveAsObservationClaimInput,
    process_generation: &str,
) -> Result<SaveAsOperationRecord, SaveAsOperationAuthorityError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| storage_error("could not begin observation claim transaction"))?;
    let current = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("observation claim readback failed"))?
        .ok_or_else(|| {
            authority_error(
                "conflict",
                "SAVE_AS_OPERATION_NOT_FOUND",
                "durable operation does not exist",
                "state",
                None,
                None,
                false,
                true,
            )
        })?;
    validate_expectation(&current, &input.expected)?;
    if !matches!(
        current.stage,
        SaveAsOperationStage::D1CommitUnknown | SaveAsOperationStage::D2CommitUnknown
    ) || !matches!(
        current.reconciliation_state,
        SaveAsReconciliationState::Pending | SaveAsReconciliationState::Claimed
    ) || input.observation_generation <= current.observation_generation.unwrap_or(-1)
    {
        return Err(authority_error(
            "validation",
            "SAVE_AS_J0_ILLEGAL_SAME_STAGE_INTENT",
            "observation claim is not legal for the authoritative composite state or generation",
            "state",
            None,
            Some(state_label(&current)),
            false,
            true,
        ));
    }
    let token = Uuid::new_v4().to_string();
    let updated_at = canonical_now_after(Some(&current.updated_at));
    let changed = transaction
        .execute(
            "UPDATE manuscript_save_as_operations SET revision=revision+1,
             commit_fence_revision=commit_fence_revision+1,
             claim_token=?1, claim_revision=revision+1, claim_process_generation=?2,
             observation_generation=?3, observation_revision=revision,
             reconciliation_state='claimed', updated_at=?4
             WHERE operation_id=?5 AND revision=?6 AND commit_fence_revision=?7 AND stage=?8
               AND d1_commit_state=?9 AND d2_commit_state=?10
               AND reconciliation_state=?11
               AND claim_token IS ?12 AND claim_revision IS ?13
               AND claim_process_generation IS ?14
               AND observation_generation IS ?15 AND observation_revision IS ?16",
            params![
                token,
                process_generation,
                input.observation_generation,
                updated_at,
                input.operation_id,
                input.expected.revision,
                input.expected.commit_fence_revision,
                input.expected.stage,
                input.expected.d1_commit_state,
                input.expected.d2_commit_state,
                input.expected.reconciliation_state,
                input.expected.claim_token,
                input.expected.claim_revision,
                input.expected.claim_process_generation,
                input.expected.observation_generation,
                input.expected.observation_revision,
            ],
        )
        .map_err(|_| storage_error("observation claim update failed"))?;
    if changed != 1 {
        return Err(authority_error(
            "conflict",
            "SAVE_AS_J0_CLAIM_CONFLICT",
            "observation claim composite CAS did not affect exactly one row",
            "token",
            Some(expectation_label(&input.expected)),
            None,
            false,
            true,
        ));
    }
    let record = readback_in_connection(&transaction, &input.operation_id)
        .map_err(|_| storage_error("observation claim readback failed"))?
        .ok_or_else(|| storage_error("observation claim readback returned no row"))?;
    transaction
        .commit()
        .map_err(|_| storage_error("observation claim commit response was lost"))?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(operation_id: &str, target: &str) -> SaveAsOperationRecord {
        SaveAsOperationRecord {
            operation_id: operation_id.into(),
            revision: 0,
            commit_fence_revision: 0,
            operation_generation: 1,
            producer_process_generation: "process".into(),
            owner_type: "experiment".into(),
            owner_id: operation_id.into(),
            channel: "primary".into(),
            source_window_role: "current".into(),
            source_file_ref_id: None,
            source_path_identity_key: format!("source:{operation_id}"),
            source_revision: "r1".into(),
            source_runtime_generation: 1,
            snapshot_sha256: "a".repeat(64),
            snapshot_byte_length: 4,
            encoding_contract_version: "utf-8-v1".into(),
            newline_contract_version: "lf-v1".into(),
            target_display_path: target.into(),
            target_path_identity_key: target.into(),
            target_location_mode: "external".into(),
            target_parent_path_identity_key: "parent".into(),
            target_parent_physical_identity_hash: "b".repeat(64),
            d1_physical_identity_hash: None,
            d1_readback_sha256: None,
            d1_readback_revision: None,
            d1_byte_length: None,
            d1_proof_generation: None,
            target_file_ref_id: None,
            d2_readback_revision: None,
            containment_fence_token: None,
            reconciliation_result_code: None,
            reconciliation_resolved_at: None,
            stage: SaveAsOperationStage::PreD1Claimed,
            d1_commit_state: SaveAsCommitState::NotStarted,
            d2_commit_state: SaveAsCommitState::NotStarted,
            reconciliation_state: SaveAsReconciliationState::NotRequired,
            blocking_code: None,
            claim_token: Some(format!("claim-{operation_id}")),
            claim_revision: Some(0),
            claim_process_generation: Some("process".into()),
            observation_generation: Some(0),
            observation_revision: Some(0),
            created_at: "2026-07-28T00:00:00.000Z".into(),
            updated_at: "2026-07-28T00:00:00.000Z".into(),
            terminal_at: None,
        }
    }

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL);",
            )
            .unwrap();
        apply_schema_migration(&connection).unwrap();
        apply_deterministic_ordering_migration(&connection).unwrap();
        connection
    }

    fn d2_database() -> Connection {
        let connection = database();
        connection.execute_batch(
            "CREATE TABLE file_refs (
               id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,
               manuscript_channel TEXT NOT NULL,resource_kind TEXT NOT NULL,
               file_role TEXT NOT NULL,location_mode TEXT NOT NULL,file_type TEXT NOT NULL,
               path TEXT NOT NULL,path_identity_key TEXT NOT NULL,title TEXT NOT NULL,
               description TEXT,candidate_request_id TEXT,candidate_occurred_at TEXT,
               schema_version INTEGER NOT NULL,source TEXT NOT NULL,custom_fields TEXT NOT NULL,
               created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT
             );
             CREATE UNIQUE INDEX idx_file_refs_identity ON file_refs(
               owner_type,owner_id,manuscript_channel,path_identity_key,resource_kind,file_role
             );
             CREATE UNIQUE INDEX idx_file_refs_candidate_request ON file_refs(
               owner_type,owner_id,candidate_request_id
             ) WHERE candidate_request_id IS NOT NULL;
             ",
        ).unwrap();
        connection
    }

    fn b7_physical_target(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "labpod-b7-{label}-{}.md",
            Uuid::new_v4()
        ));
        std::fs::write(&path, b"test").unwrap();
        path
    }

    fn d1_confirmed(
        connection: &mut Connection,
        operation_id: &str,
        target: &str,
    ) -> SaveAsOperationRecord {
        let physical = std::fs::read(target).ok();
        let proof_sha256 = physical
            .as_ref()
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .unwrap_or_else(|| "a".repeat(64));
        let proof_byte_length = physical.as_ref().map_or(4, |bytes| bytes.len() as i64);
        let mut proposed = record(operation_id, target);
        proposed.snapshot_sha256 = proof_sha256.clone();
        proposed.snapshot_byte_length = proof_byte_length;
        let initial = create_in_connection(connection, &proposed).unwrap();
        let unknown = transition_in_connection(connection, &SaveAsOperationTransitionInput {
            operation_id: operation_id.into(),
            expected: expectation_from_record(&initial),
            mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
        }).unwrap();
        transition_in_connection(connection, &SaveAsOperationTransitionInput {
            operation_id: operation_id.into(),
            expected: expectation_from_record(&unknown),
            mutation: SaveAsOperationMutation::ConfirmD1 {
                d1_physical_identity_hash: "c".repeat(64),
                d1_readback_sha256: proof_sha256,
                d1_readback_revision: "d1-r1".into(),
                d1_byte_length: proof_byte_length,
                d1_proof_generation: 1,
            },
        }).unwrap()
    }

    fn bare_d2(
        connection: &mut Connection,
        operation_id: &str,
        target: &str,
    ) -> SaveAsOperationRecord {
        let confirmed = d1_confirmed(connection, operation_id, target);
        transition_in_connection(connection, &SaveAsOperationTransitionInput {
            operation_id: operation_id.into(),
            expected: expectation_from_record(&confirmed),
            mutation: SaveAsOperationMutation::EnterD2CommitUnknown,
        }).unwrap()
    }

    fn staged_record(
        operation_id: &str,
        target: &str,
        stage: SaveAsOperationStage,
        updated_at: &str,
    ) -> SaveAsOperationRecord {
        let mut value = record(operation_id, target);
        value.updated_at = updated_at.into();
        value.stage = stage;
        match stage {
            SaveAsOperationStage::PreD1Claimed => {}
            SaveAsOperationStage::D1CommitUnknown => {
                value.d1_commit_state = SaveAsCommitState::Unknown;
                value.reconciliation_state = SaveAsReconciliationState::Pending;
                value.blocking_code = Some(SaveAsFailureCode::SaveAsPhysicalEffectUnknown);
            }
            SaveAsOperationStage::D1Confirmed => {
                set_d1_proof(&mut value);
                value.d1_commit_state = SaveAsCommitState::Confirmed;
                value.reconciliation_state = SaveAsReconciliationState::Resolved;
            }
            SaveAsOperationStage::D2CommitUnknown => {
                set_d1_proof(&mut value);
                value.d1_commit_state = SaveAsCommitState::Confirmed;
                value.d2_commit_state = SaveAsCommitState::Unknown;
                value.reconciliation_state = SaveAsReconciliationState::Pending;
            }
            SaveAsOperationStage::D2ReconciliationContained => {
                set_d1_proof(&mut value);
                value.d1_commit_state = SaveAsCommitState::Confirmed;
                value.d2_commit_state = SaveAsCommitState::Unknown;
                value.reconciliation_state = SaveAsReconciliationState::Pending;
                value.containment_fence_token = Some("containment-token".into());
            }
            SaveAsOperationStage::D2ReconciliationConflict => {
                set_d1_proof(&mut value);
                value.d1_commit_state = SaveAsCommitState::Confirmed;
                value.d2_commit_state = SaveAsCommitState::Blocked;
                value.reconciliation_state = SaveAsReconciliationState::Blocked;
                value.containment_fence_token = Some("containment-token".into());
                value.blocking_code = Some(SaveAsFailureCode::D2UnknownFenceConflict);
            }
            SaveAsOperationStage::D2ReconciledTerminal => {
                set_d1_proof(&mut value);
                value.d1_commit_state = SaveAsCommitState::Confirmed;
                value.d2_commit_state = SaveAsCommitState::Confirmed;
                value.reconciliation_state = SaveAsReconciliationState::Resolved;
                value.target_file_ref_id = Some("target-ref".into());
                value.d2_readback_revision = Some("file-r1".into());
                value.containment_fence_token = Some("containment-token".into());
                value.reconciliation_result_code =
                    Some("file_ref_reconciled_non_success".into());
                value.reconciliation_resolved_at = Some(updated_at.into());
                value.terminal_at = Some(updated_at.into());
            }
            SaveAsOperationStage::D2Confirmed
            | SaveAsOperationStage::R3ActivationPending
            | SaveAsOperationStage::P4PresentationPending
            | SaveAsOperationStage::Completed
            | SaveAsOperationStage::FinalizationCompensated => {
                set_d1_proof(&mut value);
                value.d1_commit_state = SaveAsCommitState::Confirmed;
                value.d2_commit_state = SaveAsCommitState::Confirmed;
                value.reconciliation_state = SaveAsReconciliationState::Resolved;
                value.target_file_ref_id = Some(format!("file-{operation_id}"));
                value.d2_readback_revision = Some("file-r1".into());
                if matches!(
                    stage,
                    SaveAsOperationStage::Completed
                        | SaveAsOperationStage::FinalizationCompensated
                ) {
                    value.terminal_at = Some(updated_at.into());
                }
            }
            SaveAsOperationStage::PreD1Closed => {
                value.blocking_code = Some(SaveAsFailureCode::SaveAsCancelledPreD1);
                value.terminal_at = Some(updated_at.into());
            }
            SaveAsOperationStage::ReconciliationBlocked => {
                value.d1_commit_state = SaveAsCommitState::Blocked;
                value.reconciliation_state = SaveAsReconciliationState::Blocked;
                value.blocking_code = Some(SaveAsFailureCode::SaveAsD1ReadbackMismatch);
                value.terminal_at = Some(updated_at.into());
            }
        }
        value
    }

    fn set_d1_proof(value: &mut SaveAsOperationRecord) {
        value.d1_physical_identity_hash = Some("c".repeat(64));
        value.d1_readback_sha256 = Some("a".repeat(64));
        value.d1_readback_revision = Some("r1".into());
        value.d1_byte_length = Some(4);
        value.d1_proof_generation = Some(1);
    }

    fn valid_mutation(name: &str) -> SaveAsOperationMutation {
        match name {
            "enter_d1" => SaveAsOperationMutation::EnterD1CommitUnknown,
            "confirm_d1" => SaveAsOperationMutation::ConfirmD1 {
                d1_physical_identity_hash: "c".repeat(64),
                d1_readback_sha256: "a".repeat(64),
                d1_readback_revision: "r1".into(),
                d1_byte_length: 4,
                d1_proof_generation: 1,
            },
            "close_pre_d1" => SaveAsOperationMutation::ClosePreD1 {
                blocking_code: SaveAsFailureCode::SaveAsCancelledPreD1,
            },
            "enter_d2" => SaveAsOperationMutation::EnterD2CommitUnknown,
            "enter_r3" => SaveAsOperationMutation::EnterR3ActivationPending,
            "enter_p4" => SaveAsOperationMutation::EnterP4PresentationPending,
            "block" => SaveAsOperationMutation::BlockReconciliation {
                blocking_code: SaveAsFailureCode::SaveAsD1ReadbackMismatch,
            },
            _ => unreachable!(),
        }
    }

    #[test]
    fn schema_is_typed_and_owner_neutral() {
        let connection = database();
        assert!(schema_is_current(&connection).unwrap());
        let sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='manuscript_save_as_operations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!sql.contains("record_json"));
        assert!(!sql.contains("frozenRawText"));
    }

    #[test]
    fn b7_normal_d2_is_one_transaction_and_idempotent_without_bare_stage() {
        let mut connection = d2_database();
        let confirmed = d1_confirmed(&mut connection, "normal-d2", "target-normal");
        let result = atomic_d2_commit_in_connection(
            &mut connection,
            &SaveAsD2AtomicCommitInput {
                operation_id: confirmed.operation_id.clone(),
                expected: expectation_from_record(&confirmed),
            },
            "process",
        ).unwrap();
        assert_eq!(result.operation.stage, SaveAsOperationStage::D2Confirmed);
        assert_eq!(result.operation.d2_commit_state, SaveAsCommitState::Confirmed);
        assert_eq!(result.state, "created");
        assert!(result.file_ref.is_some());
        let retry = atomic_d2_commit_in_connection(
            &mut connection,
            &SaveAsD2AtomicCommitInput {
                operation_id: result.operation.operation_id.clone(),
                expected: expectation_from_record(&result.operation),
            },
            "process",
        ).unwrap();
        assert_eq!(retry.state, "reconciled");
        assert_eq!(retry.operation.revision, result.operation.revision);
        let counts: (i64, i64) = connection.query_row(
            "SELECT (SELECT COUNT(*) FROM file_refs),
                    (SELECT COUNT(*) FROM save_as_reconciliation_audit_events)",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(counts, (1, 1));
    }

    #[test]
    fn b7_successor_containment_fences_late_writer_and_confirm_is_exactly_once() {
        let mut connection = d2_database();
        let target = b7_physical_target("contained");
        let bare = bare_d2(
            &mut connection,
            "contained-d2",
            &target.to_string_lossy(),
        );
        let contained = contain_d2_in_connection(
            &mut connection,
            &SaveAsD2ContainmentInput {
                operation_id: bare.operation_id.clone(),
                expected: expectation_from_record(&bare),
                action_id: "contain-action".into(),
            },
            "successor-process",
        ).unwrap();
        assert_eq!(
            contained.operation.stage,
            SaveAsOperationStage::D2ReconciliationContained
        );
        assert!(contained.operation.containment_fence_token.is_some());
        assert!(contained.file_ref.is_none());
        let late = atomic_d2_commit_in_connection(
            &mut connection,
            &SaveAsD2AtomicCommitInput {
                operation_id: contained.operation.operation_id.clone(),
                expected: expectation_from_record(&contained.operation),
            },
            "process",
        ).unwrap_err();
        assert_eq!(late.code, "D2_UNKNOWN_LATE_WRITER_REJECTED");
        let token = contained.operation.containment_fence_token.clone().unwrap();
        let confirm_input = SaveAsD2ConfirmInput {
            operation_id: contained.operation.operation_id.clone(),
            expected: expectation_from_record(&contained.operation),
            containment_fence_token: token,
            action_id: "confirm-action".into(),
        };
        let reconciled = confirm_contained_d2_in_connection(
            &mut connection, &confirm_input, "successor-process",
        ).unwrap();
        assert_eq!(
            reconciled.operation.stage,
            SaveAsOperationStage::D2ReconciledTerminal
        );
        assert_eq!(
            reconciled.operation.reconciliation_result_code.as_deref(),
            Some("file_ref_reconciled_non_success")
        );
        assert!(reconciled.operation.reconciliation_resolved_at.is_some());
        let retry = confirm_contained_d2_in_connection(
            &mut connection, &confirm_input, "successor-process",
        ).unwrap();
        assert_eq!(retry.state, "idempotent");
        let counts: (i64, i64, i64) = connection.query_row(
            "SELECT (SELECT COUNT(*) FROM file_refs),
                    (SELECT COUNT(*) FROM save_as_reconciliation_action_receipts),
                    (SELECT COUNT(*) FROM save_as_reconciliation_audit_events)",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(counts, (1, 2, 2));
        std::fs::remove_file(target).unwrap();
    }

    #[test]
    fn b7_conflict_is_permanent_and_dismiss_changes_only_receipt_visibility() {
        let mut connection = d2_database();
        let target = b7_physical_target("conflict");
        let bare = bare_d2(
            &mut connection,
            "conflict-d2",
            &target.to_string_lossy(),
        );
        connection.execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,schema_version,
               source,custom_fields,created_at,updated_at
             ) VALUES ('competing',?1,?2,?3,'file','manuscript',?4,'markdown',?5,?6,
               'competing',2,'system','[]',?7,?7)",
            params![bare.owner_type, bare.owner_id, bare.channel, bare.target_location_mode,
                bare.target_display_path, bare.target_path_identity_key,
                "2026-08-05T00:00:00.000Z"],
        ).unwrap();
        let conflicted = contain_d2_in_connection(
            &mut connection,
            &SaveAsD2ContainmentInput {
                operation_id: bare.operation_id.clone(),
                expected: expectation_from_record(&bare),
                action_id: "conflict-action".into(),
            },
            "successor-process",
        ).unwrap();
        assert_eq!(
            conflicted.operation.stage,
            SaveAsOperationStage::D2ReconciliationConflict
        );
        assert_eq!(
            conflicted.operation.blocking_code,
            Some(SaveAsFailureCode::D2UnknownFileRefConflict)
        );
        let token = conflicted.operation.containment_fence_token.clone().unwrap();
        let before = conflicted.operation.clone();
        dismiss_d2_notice_in_connection(
            &mut connection,
            &SaveAsD2DismissInput {
                operation_id: before.operation_id.clone(),
                expected_operation_revision: before.revision,
                expected_fence_revision: before.commit_fence_revision,
                containment_fence_token: token,
                action_id: "dismiss-action".into(),
            },
            "successor-process",
        ).unwrap();
        let after = readback_in_connection(&connection, &before.operation_id)
            .unwrap().unwrap();
        assert_eq!(after, before);
        assert!(list_visible_d2_containment_in_connection(&connection, 10)
            .unwrap().is_empty());
        std::fs::remove_file(target).unwrap();
    }

    #[test]
    fn b7_physical_mismatch_is_a_durable_conflict_before_file_ref_registration() {
        let mut connection = d2_database();
        let target = b7_physical_target("physical-mismatch");
        let bare = bare_d2(
            &mut connection,
            "physical-mismatch-d2",
            &target.to_string_lossy(),
        );
        std::fs::write(&target, b"changed").unwrap();
        let result = contain_d2_in_connection(
            &mut connection,
            &SaveAsD2ContainmentInput {
                operation_id: bare.operation_id.clone(),
                expected: expectation_from_record(&bare),
                action_id: "physical-mismatch-action".into(),
            },
            "successor-process",
        ).unwrap();
        assert_eq!(
            result.operation.stage,
            SaveAsOperationStage::D2ReconciliationConflict
        );
        assert_eq!(
            result.operation.blocking_code,
            Some(SaveAsFailureCode::D2UnknownPhysicalProofMismatch)
        );
        assert!(result.file_ref.is_none());
        assert_eq!(
            connection.query_row("SELECT COUNT(*) FROM file_refs", [], |row| row.get::<_, i64>(0)).unwrap(),
            0
        );
        std::fs::remove_file(target).unwrap();
    }

    #[test]
    fn b7_post_terminal_external_modification_records_one_incident_and_fails_closed() {
        let mut connection = d2_database();
        let target = b7_physical_target("post-terminal-integrity");
        let bare = bare_d2(
            &mut connection,
            "post-terminal-integrity-d2",
            &target.to_string_lossy(),
        );
        let contained = contain_d2_in_connection(
            &mut connection,
            &SaveAsD2ContainmentInput {
                operation_id: bare.operation_id.clone(),
                expected: expectation_from_record(&bare),
                action_id: "post-terminal-contain".into(),
            },
            "successor-process",
        ).unwrap();
        let terminal = confirm_contained_d2_in_connection(
            &mut connection,
            &SaveAsD2ConfirmInput {
                operation_id: contained.operation.operation_id.clone(),
                expected: expectation_from_record(&contained.operation),
                containment_fence_token: contained
                    .operation
                    .containment_fence_token
                    .clone()
                    .unwrap(),
                action_id: "post-terminal-confirm".into(),
            },
            "successor-process",
        ).unwrap().operation;
        std::fs::write(&target, b"externally-modified").unwrap();
        let input = SaveAsD2TerminalIntegrityInput {
            operation_id: terminal.operation_id.clone(),
        };
        for _ in 0..2 {
            let integrity = audit_terminal_d2_integrity_in_connection(
                &mut connection,
                &input,
                "later-process",
            ).unwrap();
            assert_eq!(integrity.integrity_state, "incident");
            assert_eq!(
                integrity.incident_code,
                Some(SaveAsFailureCode::D2UnknownPhysicalProofMismatch)
            );
            assert!(!integrity.file_use_allowed);
            assert_eq!(integrity.operation, terminal);
        }
        let after = readback_in_connection(&connection, &terminal.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(after, terminal);
        let counts: (i64, i64) = connection.query_row(
            "SELECT
               (SELECT COUNT(*) FROM save_as_reconciliation_audit_events
                WHERE event_type='post_reconciliation_physical_integrity_incident'),
               (SELECT COUNT(*) FROM save_as_reconciliation_action_receipts)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(counts, (1, 2));
        assert_eq!(
            list_reconciled_terminal_d2_in_connection(&connection, 10)
                .unwrap(),
            vec![terminal]
        );
        std::fs::remove_file(target).unwrap();
    }

    #[test]
    fn b7_confirm_fault_windows_roll_back_file_ref_terminal_receipt_and_audit_together() {
        for fault in ["file_ref", "receipt", "audit"] {
            let mut connection = d2_database();
            let target = b7_physical_target(fault);
            let bare = bare_d2(
                &mut connection,
                &format!("confirm-fault-{fault}"),
                &target.to_string_lossy(),
            );
            let contained = contain_d2_in_connection(
                &mut connection,
                &SaveAsD2ContainmentInput {
                    operation_id: bare.operation_id.clone(),
                    expected: expectation_from_record(&bare),
                    action_id: format!("contain-{fault}"),
                },
                "successor-process",
            ).unwrap();
            let trigger = match fault {
                "file_ref" => "CREATE TRIGGER b7_fault BEFORE INSERT ON file_refs BEGIN SELECT RAISE(ABORT, 'b7-file-ref-fault'); END;",
                "receipt" => "CREATE TRIGGER b7_fault BEFORE INSERT ON save_as_reconciliation_action_receipts WHEN NEW.action_type='confirm' BEGIN SELECT RAISE(ABORT, 'b7-receipt-fault'); END;",
                "audit" => "CREATE TRIGGER b7_fault BEFORE INSERT ON save_as_reconciliation_audit_events WHEN NEW.event_type='d2_reconciled_terminal' BEGIN SELECT RAISE(ABORT, 'b7-audit-fault'); END;",
                _ => unreachable!(),
            };
            connection.execute_batch(trigger).unwrap();
            let input = SaveAsD2ConfirmInput {
                operation_id: contained.operation.operation_id.clone(),
                expected: expectation_from_record(&contained.operation),
                containment_fence_token: contained
                    .operation
                    .containment_fence_token
                    .clone()
                    .unwrap(),
                action_id: format!("confirm-{fault}"),
            };
            assert!(confirm_contained_d2_in_connection(
                &mut connection,
                &input,
                "successor-process",
            ).is_err());
            let after = readback_in_connection(&connection, &input.operation_id)
                .unwrap()
                .unwrap();
            assert_eq!(after, contained.operation, "{fault}");
            let counts: (i64, i64, i64) = connection.query_row(
                "SELECT (SELECT COUNT(*) FROM file_refs),
                        (SELECT COUNT(*) FROM save_as_reconciliation_action_receipts),
                        (SELECT COUNT(*) FROM save_as_reconciliation_audit_events)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(counts, (0, 1, 1), "{fault}");
            std::fs::remove_file(target).unwrap();
        }
    }

    #[test]
    fn b7_j0_rejects_same_source_while_bare_d2_is_unresolved() {
        let mut connection = d2_database();
        let mut first = record("source-first", "target-source-first");
        first.source_file_ref_id = Some("source-ref".into());
        let initial = create_in_connection(&mut connection, &first).unwrap();
        let unknown = transition_in_connection(&mut connection, &SaveAsOperationTransitionInput {
            operation_id: initial.operation_id.clone(),
            expected: expectation_from_record(&initial),
            mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
        }).unwrap();
        let d1 = transition_in_connection(&mut connection, &SaveAsOperationTransitionInput {
            operation_id: unknown.operation_id.clone(),
            expected: expectation_from_record(&unknown),
            mutation: SaveAsOperationMutation::ConfirmD1 {
                d1_physical_identity_hash: "c".repeat(64),
                d1_readback_sha256: "a".repeat(64),
                d1_readback_revision: "d1-r1".into(), d1_byte_length: 4,
                d1_proof_generation: 1,
            },
        }).unwrap();
        transition_in_connection(&mut connection, &SaveAsOperationTransitionInput {
            operation_id: d1.operation_id.clone(),
            expected: expectation_from_record(&d1),
            mutation: SaveAsOperationMutation::EnterD2CommitUnknown,
        }).unwrap();
        let mut successor = record("source-second", "target-source-second");
        successor.owner_id = first.owner_id;
        successor.source_file_ref_id = first.source_file_ref_id;
        assert_eq!(
            create_in_connection(&mut connection, &successor).unwrap_err().code,
            "D2_UNKNOWN_SOURCE_UNRESOLVED"
        );
    }

    #[test]
    #[ignore = "invoked in separate processes by the B7 formal evidence runner"]
    fn lp12_3_d_6_f_r1_b7_fresh_process_evidence_phase() {
        let phase = std::env::var("LP12_B7_EVIDENCE_PHASE").expect("evidence phase");
        let database_path = std::path::PathBuf::from(
            std::env::var("LP12_B7_EVIDENCE_DB").expect("evidence database path")
        );
        let proof_path = std::path::PathBuf::from(
            std::env::var("LP12_B7_EVIDENCE_PROOF").expect("evidence proof path")
        );
        let target_path = proof_path.with_file_name("b7-fresh-target.md");
        let mut connection = Connection::open(&database_path).expect("open evidence database");
        super::super::schema::run_migrations(&connection).expect("initialize evidence schema");
        match phase.as_str() {
            "seed" => {
                let target_bytes = b"B7\n";
                let target_sha256 = format!("{:x}", Sha256::digest(target_bytes));
                std::fs::write(&target_path, target_bytes).expect("write task-owned target");
                let mut initial = record(
                    "b7-fresh-operation",
                    &target_path.to_string_lossy(),
                );
                initial.owner_type = "review".into();
                initial.owner_id = "b7-review-owner".into();
                initial.source_file_ref_id = Some("b7-source-file-ref".into());
                initial.target_path_identity_key =
                    target_path.to_string_lossy().to_ascii_lowercase();
                initial.snapshot_sha256 = target_sha256.clone();
                initial.snapshot_byte_length = target_bytes.len() as i64;
                let created = create_in_connection(&mut connection, &initial).unwrap();
                let d1_unknown = transition_in_connection(
                    &mut connection,
                    &SaveAsOperationTransitionInput {
                        operation_id: created.operation_id.clone(),
                        expected: expectation_from_record(&created),
                        mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
                    },
                ).unwrap();
                let d1 = transition_in_connection(
                    &mut connection,
                    &SaveAsOperationTransitionInput {
                        operation_id: d1_unknown.operation_id.clone(),
                        expected: expectation_from_record(&d1_unknown),
                        mutation: SaveAsOperationMutation::ConfirmD1 {
                            d1_physical_identity_hash: "c".repeat(64),
                            d1_readback_sha256: target_sha256,
                            d1_readback_revision: "fresh-d1-r1".into(),
                            d1_byte_length: target_bytes.len() as i64,
                            d1_proof_generation: 1,
                        },
                    },
                ).unwrap();
                let bare = transition_in_connection(
                    &mut connection,
                    &SaveAsOperationTransitionInput {
                        operation_id: d1.operation_id.clone(),
                        expected: expectation_from_record(&d1),
                        mutation: SaveAsOperationMutation::EnterD2CommitUnknown,
                    },
                ).unwrap();
                assert_eq!(bare.stage, SaveAsOperationStage::D2CommitUnknown);
            }
            "contain" => {
                let bare = readback_in_connection(&connection, "b7-fresh-operation")
                    .unwrap().unwrap();
                let contained = contain_d2_in_connection(
                    &mut connection,
                    &SaveAsD2ContainmentInput {
                        operation_id: bare.operation_id.clone(),
                        expected: expectation_from_record(&bare),
                        action_id: "fresh-contain-action".into(),
                    },
                    "fresh-successor-process",
                ).unwrap();
                assert_eq!(contained.operation.stage, SaveAsOperationStage::D2ReconciliationContained);
                let mut next = record("b7-fresh-next", "b7-fresh-next-target");
                next.owner_type = "review".into();
                next.owner_id = "b7-review-owner".into();
                next.source_file_ref_id = Some("b7-source-file-ref".into());
                assert_eq!(
                    create_in_connection(&mut connection, &next).unwrap_err().code,
                    "D2_UNKNOWN_SOURCE_UNRESOLVED"
                );
            }
            "confirm" => {
                let contained = readback_in_connection(&connection, "b7-fresh-operation")
                    .unwrap().unwrap();
                let token = contained.containment_fence_token.clone().unwrap();
                let result = confirm_contained_d2_in_connection(
                    &mut connection,
                    &SaveAsD2ConfirmInput {
                        operation_id: contained.operation_id.clone(),
                        expected: expectation_from_record(&contained),
                        containment_fence_token: token,
                        action_id: "fresh-confirm-action".into(),
                    },
                    "fresh-successor-process",
                ).unwrap();
                assert_eq!(result.operation.stage, SaveAsOperationStage::D2ReconciledTerminal);
            }
            "post-terminal-modify" => {
                let terminal = readback_in_connection(&connection, "b7-fresh-operation")
                    .unwrap().unwrap();
                assert_eq!(terminal.stage, SaveAsOperationStage::D2ReconciledTerminal);
                std::fs::write(&target_path, b"B7 externally modified\n")
                    .expect("externally modify task-owned terminal target");
            }
            "post-terminal-audit" => {
                let integrity = audit_terminal_d2_integrity_in_connection(
                    &mut connection,
                    &SaveAsD2TerminalIntegrityInput {
                        operation_id: "b7-fresh-operation".into(),
                    },
                    "fresh-later-process",
                ).unwrap();
                assert_eq!(integrity.integrity_state, "incident");
                assert!(!integrity.file_use_allowed);
                assert_eq!(integrity.operation.stage, SaveAsOperationStage::D2ReconciledTerminal);
            }
            "verify" => {
                let terminal = readback_in_connection(&connection, "b7-fresh-operation")
                    .unwrap().unwrap();
                let integrity = audit_terminal_d2_integrity_in_connection(
                    &mut connection,
                    &SaveAsD2TerminalIntegrityInput {
                        operation_id: terminal.operation_id.clone(),
                    },
                    "fresh-verifier-process",
                ).unwrap();
                assert_eq!(integrity.operation, terminal);
                assert_eq!(integrity.integrity_state, "incident");
                assert!(!integrity.file_use_allowed);
                let counts: (i64, i64, i64, i64, i64, i64) = connection.query_row(
                    "SELECT (SELECT COUNT(*) FROM file_refs WHERE id=?1),
                            (SELECT COUNT(*) FROM save_as_reconciliation_action_receipts
                             WHERE operation_id=?2),
                            (SELECT COUNT(*) FROM save_as_reconciliation_audit_events
                             WHERE operation_id=?2),
                            (SELECT COUNT(*) FROM manuscript_save_as_candidate_custody
                             WHERE operation_id=?2),
                            (SELECT COUNT(*) FROM manuscript_save_as_finalizations
                             WHERE operation_id=?2),
                            (SELECT COUNT(*) FROM manuscript_bindings
                             WHERE owner_type=?3 AND owner_id=?4
                               AND (current_file_ref_id IS NOT NULL
                                 OR default_manuscript_file_ref_id IS NOT NULL))",
                    params![terminal.target_file_ref_id, terminal.operation_id,
                        terminal.owner_type, terminal.owner_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,
                        row.get(3)?, row.get(4)?, row.get(5)?)),
                ).unwrap();
                assert_eq!(terminal.stage, SaveAsOperationStage::D2ReconciledTerminal);
                assert_eq!(counts, (1, 2, 3, 0, 0, 0));
                let terminal_receipt: (i64, i64) = connection.query_row(
                    "SELECT resulting_operation_revision,resulting_fence_revision
                     FROM save_as_reconciliation_action_receipts
                     WHERE operation_id=?1 AND action_type='confirm'",
                    [terminal.operation_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                ).unwrap();
                assert_eq!(terminal_receipt, (terminal.revision, terminal.commit_fence_revision));
                let proof = serde_json::json!({
                    "task": "LP12-3-D-6-F-R1-B7",
                    "verdict": "PASS",
                    "freshProcessPhases": ["seed", "contain", "confirm", "post-terminal-modify", "post-terminal-audit", "verify"],
                    "operationStage": terminal.stage.as_str(),
                    "operationRevision": terminal.revision,
                    "commitFenceRevision": terminal.commit_fence_revision,
                    "resultCode": terminal.reconciliation_result_code,
                    "fileRefCount": counts.0,
                    "receiptCount": counts.1,
                    "auditCount": counts.2,
                    "integrityIncidentCount": 1,
                    "fileUseAllowed": false,
                    "custodyCount": counts.3,
                    "finalizationCount": counts.4,
                    "bindingMutationCount": counts.5,
                    "runtimeResidueCount": 0,
                    "processResidueCount": 0,
                    "portResidueCount": 0,
                    "targetPath": target_path,
                    "repositoryWrite": false
                });
                std::fs::write(
                    &proof_path,
                    serde_json::to_vec_pretty(&proof).unwrap(),
                ).expect("write evidence proof");
            }
            _ => panic!("unknown evidence phase"),
        }
    }

    #[test]
    fn active_target_is_global_and_cas_readback_is_exact() {
        let mut connection = database();
        let first =
            create_in_connection(&mut connection, &record("operation-a", "target")).unwrap();
        assert_eq!(first.revision, 0);
        assert_eq!(
            create_in_connection(&mut connection, &record("operation-b", "target"))
                .unwrap_err()
                .code,
            "SAVE_AS_J0_CLAIM_CONFLICT"
        );
        let changed = transition_in_connection(
            &mut connection,
            &SaveAsOperationTransitionInput {
                operation_id: first.operation_id.clone(),
                expected: expectation_from_record(&first),
                mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
            },
        )
        .unwrap();
        assert_eq!(changed.revision, 1);
        assert_eq!(
            readback_in_connection(&connection, "operation-a").unwrap(),
            Some(changed)
        );
    }

    #[test]
    fn invalid_state_and_stale_cas_are_rejected() {
        let mut connection = database();
        let mut invalid = record("invalid", "target-invalid");
        invalid.stage = SaveAsOperationStage::Completed;
        assert!(create_in_connection(&mut connection, &invalid).is_err());
        let current =
            create_in_connection(&mut connection, &record("operation", "target")).unwrap();
        let mut stale = expectation_from_record(&current);
        stale.revision = 9;
        assert_eq!(
            transition_in_connection(
                &mut connection,
                &SaveAsOperationTransitionInput {
                    operation_id: current.operation_id.clone(),
                    expected: stale,
                    mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
                }
            )
            .unwrap_err()
            .code,
            "SAVE_AS_OPERATION_REVISION_CONFLICT"
        );
    }

    #[test]
    fn observation_claim_is_integer_cas_and_authoritative_readback() {
        let mut connection = database();
        let current =
            create_in_connection(&mut connection, &record("operation", "target")).unwrap();
        let unknown = transition_in_connection(
            &mut connection,
            &SaveAsOperationTransitionInput {
                operation_id: current.operation_id.clone(),
                expected: expectation_from_record(&current),
                mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
            },
        )
        .unwrap();
        let claim = claim_in_connection(
            &mut connection,
            &SaveAsObservationClaimInput {
                operation_id: "operation".into(),
                expected: expectation_from_record(&unknown),
                observation_generation: 9,
            },
            "recovery-process",
        )
        .unwrap();
        assert_eq!(claim.revision, unknown.revision + 1);
        assert_eq!(
            claim.reconciliation_state,
            SaveAsReconciliationState::Claimed
        );
        assert_eq!(
            claim.claim_process_generation.as_deref(),
            Some("recovery-process")
        );
        assert_eq!(
            claim_in_connection(
                &mut connection,
                &SaveAsObservationClaimInput {
                    operation_id: "operation".into(),
                    expected: expectation_from_record(&unknown),
                    observation_generation: 10,
                },
                "losing-process"
            )
            .unwrap_err()
            .code,
            "SAVE_AS_OPERATION_REVISION_CONFLICT"
        );
    }

    #[test]
    fn all_eleven_generic_edges_and_all_unlisted_edges_are_authoritative() {
        let stages = [
            SaveAsOperationStage::PreD1Claimed,
            SaveAsOperationStage::D1CommitUnknown,
            SaveAsOperationStage::D1Confirmed,
            SaveAsOperationStage::D2CommitUnknown,
            SaveAsOperationStage::D2Confirmed,
            SaveAsOperationStage::R3ActivationPending,
            SaveAsOperationStage::P4PresentationPending,
            SaveAsOperationStage::Completed,
            SaveAsOperationStage::FinalizationCompensated,
            SaveAsOperationStage::PreD1Closed,
            SaveAsOperationStage::ReconciliationBlocked,
        ];
        let intents = [
            "enter_d1",
            "confirm_d1",
            "close_pre_d1",
            "enter_d2",
            "enter_r3",
            "enter_p4",
            "block",
        ];
        let legal = [
            (SaveAsOperationStage::PreD1Claimed, "enter_d1"),
            (SaveAsOperationStage::PreD1Claimed, "close_pre_d1"),
            (SaveAsOperationStage::D1CommitUnknown, "confirm_d1"),
            (SaveAsOperationStage::D1CommitUnknown, "block"),
            (SaveAsOperationStage::D1Confirmed, "enter_d2"),
            (SaveAsOperationStage::D2CommitUnknown, "block"),
            (SaveAsOperationStage::D2Confirmed, "enter_r3"),
            (SaveAsOperationStage::R3ActivationPending, "enter_p4"),
            (SaveAsOperationStage::R3ActivationPending, "block"),
            (SaveAsOperationStage::P4PresentationPending, "block"),
        ];
        // The eleventh generic edge is creation from no row. completed and
        // finalization_compensated are owned by the finalization authority.
        let mut create_db = database();
        assert!(
            create_in_connection(&mut create_db, &record("edge-create", "target-edge-create"))
                .is_ok()
        );

        let mut legal_count = 1;
        for (stage_index, stage) in stages.into_iter().enumerate() {
            for (intent_index, intent) in intents.into_iter().enumerate() {
                let mut connection = database();
                let operation_id = format!("edge-{stage_index}-{intent_index}");
                let source = staged_record(
                    &operation_id,
                    &format!("target-{operation_id}"),
                    stage,
                    "2026-07-28T00:00:00.000Z",
                );
                insert(&connection, &source).unwrap();
                let current = readback_in_connection(&connection, &operation_id)
                    .unwrap()
                    .unwrap();
                let result = transition_in_connection(
                    &mut connection,
                    &SaveAsOperationTransitionInput {
                        operation_id,
                        expected: expectation_from_record(&current),
                        mutation: valid_mutation(intent),
                    },
                );
                if legal.contains(&(stage, intent)) {
                    assert!(result.is_ok(), "{stage:?}/{intent}");
                    legal_count += 1;
                } else {
                    let error = result.unwrap_err();
                    let expected = if matches!(
                        stage,
                        SaveAsOperationStage::Completed
                            | SaveAsOperationStage::FinalizationCompensated
                            | SaveAsOperationStage::PreD1Closed
                            | SaveAsOperationStage::ReconciliationBlocked
                    ) {
                        "SAVE_AS_OPERATION_TERMINAL_STATE_CONFLICT"
                    } else {
                        "SAVE_AS_OPERATION_ILLEGAL_TRANSITION"
                    };
                    assert_eq!(error.code, expected, "{stage:?}/{intent}");
                    let unchanged = readback_in_connection(&connection, &current.operation_id)
                        .unwrap()
                        .unwrap();
                    assert_eq!(unchanged, current, "{stage:?}/{intent}");
                }
            }
        }
        assert_eq!(legal_count, 11);
    }

    #[test]
    fn every_immutable_field_is_checked_and_conflict_is_zero_write() {
        let mut connection = database();
        let current =
            create_in_connection(&mut connection, &record("immutable", "target-immutable"))
                .unwrap();

        macro_rules! reject_identity {
            ($field:ident, $value:expr, $code:literal) => {{
                let mut expected = expectation_from_record(&current);
                expected.identity.$field = $value;
                let error = transition_in_connection(
                    &mut connection,
                    &SaveAsOperationTransitionInput {
                        operation_id: current.operation_id.clone(),
                        expected,
                        mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
                    },
                )
                .unwrap_err();
                assert_eq!(error.code, $code, stringify!($field));
                assert_eq!(
                    readback_in_connection(&connection, &current.operation_id)
                        .unwrap()
                        .unwrap(),
                    current,
                    stringify!($field)
                );
            }};
        }

        reject_identity!(
            operation_generation,
            2,
            "SAVE_AS_OPERATION_GENERATION_MISMATCH"
        );
        reject_identity!(
            producer_process_generation,
            "other-process".into(),
            "SAVE_AS_OPERATION_GENERATION_MISMATCH"
        );
        reject_identity!(
            owner_type,
            "review".into(),
            "SAVE_AS_OPERATION_OWNER_IDENTITY_MISMATCH"
        );
        reject_identity!(
            owner_id,
            "other-owner".into(),
            "SAVE_AS_OPERATION_OWNER_IDENTITY_MISMATCH"
        );
        reject_identity!(
            channel,
            "dedicated_notes".into(),
            "SAVE_AS_OPERATION_OWNER_IDENTITY_MISMATCH"
        );
        reject_identity!(
            source_window_role,
            "independent".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            source_file_ref_id,
            Some("source-ref".into()),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            source_path_identity_key,
            "other-source".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            source_revision,
            "r2".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            source_runtime_generation,
            2,
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            snapshot_sha256,
            "b".repeat(64),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            snapshot_byte_length,
            5,
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            encoding_contract_version,
            "utf-16".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            newline_contract_version,
            "crlf-v1".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            target_display_path,
            "other-target".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            target_path_identity_key,
            "other-target-key".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            target_location_mode,
            "managed".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            target_parent_path_identity_key,
            "other-parent".into(),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
        reject_identity!(
            target_parent_physical_identity_hash,
            "d".repeat(64),
            "SAVE_AS_OPERATION_IMMUTABLE_IDENTITY_MISMATCH"
        );
    }

    #[test]
    fn composite_state_and_all_tokens_are_part_of_cas() {
        let mut connection = database();
        let current =
            create_in_connection(&mut connection, &record("composite", "target-composite"))
                .unwrap();
        for mutation in [
            "revision",
            "stage",
            "d1",
            "d2",
            "reconciliation",
            "claim_token",
            "claim_revision",
            "claim_process",
            "observation_generation",
            "observation_revision",
        ] {
            let mut expected = expectation_from_record(&current);
            let code = match mutation {
                "revision" => {
                    expected.revision += 1;
                    "SAVE_AS_OPERATION_REVISION_CONFLICT"
                }
                "stage" => {
                    expected.stage = SaveAsOperationStage::D1Confirmed;
                    "SAVE_AS_OPERATION_STAGE_CONFLICT"
                }
                "d1" => {
                    expected.d1_commit_state = SaveAsCommitState::Confirmed;
                    "SAVE_AS_OPERATION_STAGE_CONFLICT"
                }
                "d2" => {
                    expected.d2_commit_state = SaveAsCommitState::Confirmed;
                    "SAVE_AS_OPERATION_STAGE_CONFLICT"
                }
                "reconciliation" => {
                    expected.reconciliation_state = SaveAsReconciliationState::Pending;
                    "SAVE_AS_OPERATION_STAGE_CONFLICT"
                }
                "claim_token" => {
                    expected.claim_token = Some("stale".into());
                    "SAVE_AS_OPERATION_CLAIM_TOKEN_MISMATCH"
                }
                "claim_revision" => {
                    expected.claim_revision = Some(9);
                    "SAVE_AS_OPERATION_CLAIM_TOKEN_MISMATCH"
                }
                "claim_process" => {
                    expected.claim_process_generation = Some("stale".into());
                    "SAVE_AS_OPERATION_CLAIM_TOKEN_MISMATCH"
                }
                "observation_generation" => {
                    expected.observation_generation = Some(9);
                    "SAVE_AS_OPERATION_OBSERVATION_TOKEN_MISMATCH"
                }
                _ => {
                    expected.observation_revision = Some(9);
                    "SAVE_AS_OPERATION_OBSERVATION_TOKEN_MISMATCH"
                }
            };
            let error = transition_in_connection(
                &mut connection,
                &SaveAsOperationTransitionInput {
                    operation_id: current.operation_id.clone(),
                    expected,
                    mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
                },
            )
            .unwrap_err();
            assert_eq!(error.code, code, "{mutation}");
            assert_eq!(
                readback_in_connection(&connection, &current.operation_id)
                    .unwrap()
                    .unwrap(),
                current
            );
        }
    }

    #[test]
    fn canonical_timestamp_id_domain_total_order_limit_filter_and_query_plan_are_exact() {
        let connection = database();
        connection
            .execute_batch(
                "CREATE TABLE manuscript_save_as_finalizations (
                   operation_id TEXT PRIMARY KEY,
                   finalization_state TEXT NOT NULL
                 );",
            )
            .unwrap();
        for (operation_id, updated_at) in [
            ("op-a", "2026-07-28T00:00:00.001Z"),
            ("op-A", "2026-07-28T00:00:00.001Z"),
            ("op-_", "2026-07-28T00:00:00.001Z"),
            ("op-old", "2026-07-28T00:00:00.000Z"),
        ] {
            insert(
                &connection,
                &staged_record(
                    operation_id,
                    &format!("target-{operation_id}"),
                    SaveAsOperationStage::D1CommitUnknown,
                    updated_at,
                ),
            )
            .unwrap();
        }
        insert(
            &connection,
            &staged_record(
                "op-blocked",
                "target-blocked",
                SaveAsOperationStage::ReconciliationBlocked,
                "2026-07-27T00:00:00.000Z",
            ),
        )
        .unwrap();
        insert(
            &connection,
            &staged_record(
                "op-r3",
                "target-r3",
                SaveAsOperationStage::R3ActivationPending,
                "2026-07-28T00:00:00.000Z",
            ),
        )
        .unwrap();
        insert(
            &connection,
            &staged_record(
                "op-presentation-completed",
                "target-presentation-completed",
                SaveAsOperationStage::P4PresentationPending,
                "2026-07-27T00:00:00.000Z",
            ),
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO manuscript_save_as_finalizations (operation_id, finalization_state)
                 VALUES (?1, 'presentation_completed')",
                ["op-presentation-completed"],
            )
            .unwrap();
        insert(
            &connection,
            &staged_record(
                "op-terminal",
                "target-terminal",
                SaveAsOperationStage::Completed,
                "2026-07-27T00:00:00.000Z",
            ),
        )
        .unwrap();

        let first = list_reconcilable_in_connection(&connection, 3).unwrap();
        let second = list_reconcilable_in_connection(&connection, 3).unwrap();
        let ids = first
            .iter()
            .map(|record| record.operation_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["op-old", "op-r3", "op-A"]);
        assert_eq!(first, second);
        assert!(!first.iter().any(|record| record.operation_id == "op-terminal"));
        assert!(!first
            .iter()
            .any(|record| record.operation_id == "op-presentation-completed"));
        assert!(first
            .iter()
            .all(|record| { record.updated_at.len() == 24 && record.updated_at.ends_with('Z') }));

        let mut plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT operation_id FROM manuscript_save_as_operations
                 WHERE reconciliation_state IN ('pending','claimed')
                   AND NOT EXISTS (
                     SELECT 1 FROM manuscript_save_as_finalizations AS finalization
                     WHERE finalization.operation_id = manuscript_save_as_operations.operation_id
                       AND finalization.finalization_state = 'presentation_completed'
                   )
                 ORDER BY updated_at ASC, operation_id COLLATE BINARY ASC LIMIT 3",
            )
            .unwrap();
        let detail = plan
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join(" | ");
        assert!(
            detail.contains("idx_manuscript_save_as_operations_reconcilable_order"),
            "{detail}"
        );
        assert!(!detail.contains("TEMP B-TREE"), "{detail}");

        let mut invalid = record("bad.id", "target-invalid-id");
        invalid.operation_id = "bad.id".into();
        assert_eq!(
            validate_initial(&invalid).unwrap_err().code,
            "SAVE_AS_J0_INPUT_INVALID"
        );
    }

    #[test]
    fn real_sqlite_parallel_observation_claim_has_one_winner() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let path =
            std::env::temp_dir().join(format!("labpod-save-as-j0-{}.sqlite", Uuid::new_v4()));
        let mut seed = Connection::open(&path).unwrap();
        seed.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        )
        .unwrap();
        apply_schema_migration(&seed).unwrap();
        apply_deterministic_ordering_migration(&seed).unwrap();
        let initial =
            create_in_connection(&mut seed, &record("parallel", "target-parallel")).unwrap();
        let unknown = transition_in_connection(
            &mut seed,
            &SaveAsOperationTransitionInput {
                operation_id: initial.operation_id.clone(),
                expected: expectation_from_record(&initial),
                mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
            },
        )
        .unwrap();
        drop(seed);

        let input = SaveAsObservationClaimInput {
            operation_id: unknown.operation_id.clone(),
            expected: expectation_from_record(&unknown),
            observation_generation: 1,
        };
        let barrier = Arc::new(Barrier::new(2));
        let handles = ["process-a", "process-b"].map(|process| {
            let path = path.clone();
            let barrier = barrier.clone();
            let input = input.clone();
            thread::spawn(move || {
                let mut connection = Connection::open(path).unwrap();
                barrier.wait();
                claim_in_connection(&mut connection, &input, process)
            })
        });
        let results = handles.map(|handle| handle.join().unwrap());
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

        let connection = Connection::open(&path).unwrap();
        let winner = readback_in_connection(&connection, "parallel")
            .unwrap()
            .unwrap();
        assert_eq!(winner.revision, unknown.revision + 1);
        assert_eq!(
            winner.reconciliation_state,
            SaveAsReconciliationState::Claimed
        );
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
}
