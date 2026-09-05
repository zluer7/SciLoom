#![allow(dead_code)]

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

mod chained_atomic_initialization;
#[cfg(test)]
mod chained_atomic_initialization_tests;
pub(crate) mod claim_ownership;
mod mainline_atomic_initialization;
mod ownership_supervision;
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use chained_atomic_initialization::initialize_chained_operation_atomically;
#[allow(unused_imports)]
pub(crate) use chained_atomic_initialization::{
    initialize_chained_operation_in_connection,
    initialize_chained_operation_with_ownership_context, ChainedAtomicInitializationRequest,
    ChainedAtomicInitializationResult, ChainedInitializationAuthority, ChainedInitializationIntent,
};
pub(crate) use mainline_atomic_initialization::{
    initialize_mainline_operation_atomically, MainlineAtomicInitializationRequest,
};
mod durable_precondition;
#[cfg(test)]
mod durable_precondition_tests;
mod recovery_runtime_entry;
pub(crate) use recovery_runtime_entry::*;
mod runtime;
pub(crate) mod step_progress;
pub(crate) mod step_progress_repository;
pub(crate) mod step_progress_schema;
pub(crate) use ownership_supervision::*;
#[allow(unused_imports)]
pub(crate) use runtime::*;
#[allow(unused_imports)]
pub(crate) use step_progress_repository::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeDurableRevalidation {
    Matched,
    DurableAuthorityStale,
    IdentityConflict,
    RepositoryUnavailable,
}

pub(crate) fn short_revalidate_runtime_boundary(
    transaction: &Transaction<'_>,
    operation_id: &str,
) -> RuntimeDurableRevalidation {
    use durable_precondition::DurableRevalidationResult;
    match durable_precondition::DurablePreconditionBuilder::short_revalidate_in_transaction(
        transaction,
        operation_id,
    ) {
        DurableRevalidationResult::Matched(_) => RuntimeDurableRevalidation::Matched,
        DurableRevalidationResult::DurableAuthorityStale => {
            RuntimeDurableRevalidation::DurableAuthorityStale
        }
        DurableRevalidationResult::RepositoryUnavailable => {
            RuntimeDurableRevalidation::RepositoryUnavailable
        }
        DurableRevalidationResult::IdentityConflict
        | DurableRevalidationResult::NotFound
        | DurableRevalidationResult::InvalidOperationState
        | DurableRevalidationResult::InternalFailure => {
            RuntimeDurableRevalidation::IdentityConflict
        }
    }
}

pub(crate) use crate::manuscript_provisioning_contract::{
    PROVISIONING_ACTIVE_CLAIM_CONFLICT, PROVISIONING_OPERATION_CAS_CONFLICT,
    PROVISIONING_OPERATION_INVALID_INPUT,
};
pub(crate) const PROVISIONING_OPERATION_NOT_FOUND: &str = "PROVISIONING_OPERATION_NOT_FOUND";
pub(crate) const PROVISIONING_OPERATION_DATABASE_ERROR: &str =
    "PROVISIONING_OPERATION_DATABASE_ERROR";

pub(crate) const PROVISIONING_OPERATION_STATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS manuscript_provisioning_operation_attempts (
  operation_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('channel', 'literature-aggregate', 'literature-child')
  ),
  owner_type TEXT NOT NULL CHECK (
    owner_type IN (
      'experiment', 'experimentRun', 'literature', 'review', 'resultItem',
      'finding', 'outputCandidate', 'outputGap', 'researchOutput'
    )
  ),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  manuscript_channel TEXT CHECK (
    manuscript_channel IS NULL
    OR manuscript_channel IN ('primary', 'literature_outline', 'dedicated_notes')
  ),
  aggregate_operation_id TEXT,
  intent TEXT NOT NULL CHECK (intent IN ('create-default', 'retry', 'repair', 'recover')),
  trigger_kind TEXT NOT NULL CHECK (
    trigger_kind IN ('owner-create', 'explicit-retry', 'explicit-repair', 'explicit-recovery')
  ),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'preflight', 'inspection', 'physical-create-or-reuse', 'file-ref-register',
      'binding-write', 'authoritative-readback', 'final-verification',
      'completed', 'blocked', 'partial', 'failed'
    )
  ),
  operation_status TEXT NOT NULL CHECK (
    operation_status IN (
      'active', 'terminal-completed', 'terminal-failed', 'terminal-partial',
      'terminal-blocked', 'terminal-recovery-required', 'terminal-lifecycle-required'
    )
  ),
  result_classification TEXT CHECK (
    result_classification IS NULL
    OR result_classification IN (
      'completed', 'retryable', 'repair-required',
      'provisioning-recovery-required', 'lifecycle-decision-required', 'blocked'
    )
  ),
  next_action TEXT CHECK (
    next_action IS NULL
    OR next_action IN ('none', 'retry', 'repair', 'recover', 'lifecycle-decision', 'stop')
  ),
  original_cause_code TEXT,
  partial_kind TEXT CHECK (
    partial_kind IS NULL
    OR partial_kind IN (
      'physical-only', 'file-ref-registered', 'binding-written-not-verified',
      'multi-channel', 'parent-ready-child-failed'
    )
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  previous_operation_id TEXT,
  root_operation_id TEXT,
  folder_effect TEXT NOT NULL DEFAULT 'none' CHECK (
    folder_effect IN ('none', 'created', 'reused')
  ),
  manuscript_effect TEXT NOT NULL DEFAULT 'none' CHECK (
    manuscript_effect IN ('none', 'created', 'reused')
  ),
  file_ref_effect TEXT NOT NULL DEFAULT 'none' CHECK (
    file_ref_effect IN ('none', 'created', 'reused')
  ),
  binding_effect TEXT NOT NULL DEFAULT 'none' CHECK (
    binding_effect IN ('none', 'created', 'reused', 'updated')
  ),
  default_folder_file_ref_id TEXT,
  default_manuscript_file_ref_id TEXT,
  binding_id TEXT,
  final_verification_outcome TEXT NOT NULL DEFAULT 'not-run' CHECK (
    final_verification_outcome IN ('not-run', 'passed', 'not-passed', 'not-verified')
  ),
  inspector_version TEXT,
  verifier_version TEXT,
  facts_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (facts_schema_version = 1),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (scope_kind = 'channel'
      AND aggregate_operation_id IS NULL
      AND manuscript_channel IS NOT NULL
      AND (
        (owner_type = 'literature'
          AND manuscript_channel IN ('literature_outline', 'dedicated_notes'))
        OR (owner_type <> 'literature' AND manuscript_channel = 'primary')
      ))
    OR
    (scope_kind = 'literature-aggregate'
      AND owner_type = 'literature'
      AND manuscript_channel IS NULL
      AND aggregate_operation_id IS NULL)
    OR
    (scope_kind = 'literature-child'
      AND owner_type = 'literature'
      AND manuscript_channel IN ('literature_outline', 'dedicated_notes')
      AND aggregate_operation_id IS NOT NULL)
  ),
  CHECK (
    (intent = 'create-default' AND trigger_kind = 'owner-create')
    OR (intent = 'retry' AND trigger_kind = 'explicit-retry')
    OR (intent = 'repair' AND trigger_kind = 'explicit-repair')
    OR (intent = 'recover' AND trigger_kind = 'explicit-recovery')
  ),
  CHECK (
    (previous_operation_id IS NULL AND root_operation_id IS NULL)
    OR (previous_operation_id IS NOT NULL AND root_operation_id IS NOT NULL)
  ),
  CHECK (previous_operation_id IS NULL OR previous_operation_id <> operation_id),
  CHECK (root_operation_id IS NULL OR root_operation_id <> operation_id),
  CHECK (aggregate_operation_id IS NULL OR aggregate_operation_id <> operation_id),
  CHECK (
    (operation_status = 'active'
      AND phase IN (
        'preflight', 'inspection', 'physical-create-or-reuse', 'file-ref-register',
        'binding-write', 'authoritative-readback', 'final-verification'
      )
      AND result_classification IS NULL
      AND next_action IS NULL
      AND terminal_at IS NULL)
    OR
    (operation_status = 'terminal-completed'
      AND phase = 'completed'
      AND result_classification = 'completed'
      AND next_action = 'none'
      AND final_verification_outcome = 'passed'
      AND terminal_at IS NOT NULL)
    OR
    (operation_status = 'terminal-failed'
      AND phase = 'failed'
      AND (
        (result_classification = 'retryable' AND next_action = 'retry')
        OR (result_classification = 'repair-required' AND next_action = 'repair')
      )
      AND terminal_at IS NOT NULL)
    OR
    (operation_status = 'terminal-partial'
      AND phase = 'partial'
      AND partial_kind IS NOT NULL
      AND (
        (result_classification = 'retryable' AND next_action = 'retry')
        OR (result_classification = 'repair-required' AND next_action = 'repair')
      )
      AND terminal_at IS NOT NULL)
    OR
    (operation_status = 'terminal-recovery-required'
      AND phase IN ('failed', 'partial')
      AND result_classification = 'provisioning-recovery-required'
      AND next_action = 'recover'
      AND partial_kind IS NOT NULL
      AND terminal_at IS NOT NULL)
    OR
    (operation_status = 'terminal-lifecycle-required'
      AND phase IN ('blocked', 'failed')
      AND result_classification = 'lifecycle-decision-required'
      AND next_action = 'lifecycle-decision'
      AND terminal_at IS NOT NULL)
    OR
    (operation_status = 'terminal-blocked'
      AND phase IN ('blocked', 'failed')
      AND (
        (result_classification = 'repair-required'
          AND next_action = 'repair'
          AND phase = 'blocked')
        OR (result_classification = 'blocked' AND next_action = 'stop')
      )
      AND terminal_at IS NOT NULL)
  ),
  UNIQUE (operation_id, owner_type, owner_id, scope_kind),
  UNIQUE (
    operation_id, owner_type, owner_id, scope_kind,
    manuscript_channel, aggregate_operation_id
  ),
  FOREIGN KEY (previous_operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (root_operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (aggregate_operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manuscript_provisioning_active_claims (
  claim_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('channel', 'literature-aggregate')),
  owner_type TEXT NOT NULL CHECK (
    owner_type IN (
      'experiment', 'experimentRun', 'literature', 'review', 'resultItem',
      'finding', 'outputCandidate', 'outputGap', 'researchOutput'
    )
  ),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  manuscript_channel TEXT CHECK (
    manuscript_channel IS NULL
    OR manuscript_channel IN ('primary', 'literature_outline', 'dedicated_notes')
  ),
  operation_id TEXT NOT NULL UNIQUE,
  claim_owner_token TEXT NOT NULL CHECK (length(claim_owner_token) > 0),
  claim_revision INTEGER NOT NULL DEFAULT 0 CHECK (claim_revision >= 0),
  claimed_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  last_progress_at TEXT NOT NULL,
  stale_observed_at TEXT,
  stale_observed_by_token TEXT,
  CHECK (
    (scope_kind = 'channel'
      AND manuscript_channel IS NOT NULL
      AND (
        (owner_type = 'literature'
          AND manuscript_channel IN ('literature_outline', 'dedicated_notes'))
        OR (owner_type <> 'literature' AND manuscript_channel = 'primary')
      ))
    OR
    (scope_kind = 'literature-aggregate'
      AND owner_type = 'literature'
      AND manuscript_channel IS NULL)
  ),
  CHECK (
    (stale_observed_at IS NULL AND stale_observed_by_token IS NULL)
    OR (stale_observed_at IS NOT NULL AND stale_observed_by_token IS NOT NULL)
  ),
  FOREIGN KEY (operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manuscript_provisioning_literature_child_states (
  aggregate_operation_id TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'literature' CHECK (owner_type = 'literature'),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  aggregate_scope_kind TEXT NOT NULL DEFAULT 'literature-aggregate'
    CHECK (aggregate_scope_kind = 'literature-aggregate'),
  manuscript_channel TEXT NOT NULL CHECK (
    manuscript_channel IN ('literature_outline', 'dedicated_notes')
  ),
  current_child_operation_id TEXT,
  current_child_scope_kind TEXT NOT NULL DEFAULT 'literature-child'
    CHECK (current_child_scope_kind = 'literature-child'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  phase TEXT CHECK (
    phase IS NULL OR phase IN (
      'preflight', 'inspection', 'physical-create-or-reuse', 'file-ref-register',
      'binding-write', 'authoritative-readback', 'final-verification',
      'completed', 'blocked', 'partial', 'failed'
    )
  ),
  operation_status TEXT CHECK (
    operation_status IS NULL OR operation_status IN (
      'active', 'terminal-completed', 'terminal-failed', 'terminal-partial',
      'terminal-blocked', 'terminal-recovery-required', 'terminal-lifecycle-required'
    )
  ),
  result_classification TEXT CHECK (
    result_classification IS NULL OR result_classification IN (
      'completed', 'retryable', 'repair-required',
      'provisioning-recovery-required', 'lifecycle-decision-required', 'blocked'
    )
  ),
  next_action TEXT CHECK (
    next_action IS NULL
    OR next_action IN ('none', 'retry', 'repair', 'recover', 'lifecycle-decision', 'stop')
  ),
  default_readiness TEXT NOT NULL DEFAULT 'not-verified' CHECK (
    default_readiness IN ('ready', 'not-ready', 'not-verified')
  ),
  final_verification_outcome TEXT NOT NULL DEFAULT 'not-run' CHECK (
    final_verification_outcome IN ('not-run', 'passed', 'not-passed', 'not-verified')
  ),
  original_cause_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (aggregate_operation_id, manuscript_channel),
  CHECK (
    (current_child_operation_id IS NULL
      AND phase IS NULL
      AND operation_status IS NULL
      AND result_classification IS NULL
      AND next_action IS NULL)
    OR
    (current_child_operation_id IS NOT NULL
      AND phase IS NOT NULL
      AND operation_status IS NOT NULL
      AND (
        (operation_status = 'active'
          AND phase IN (
            'preflight', 'inspection', 'physical-create-or-reuse', 'file-ref-register',
            'binding-write', 'authoritative-readback', 'final-verification'
          )
          AND result_classification IS NULL
          AND next_action IS NULL)
        OR
        (operation_status = 'terminal-completed'
          AND phase = 'completed'
          AND result_classification = 'completed'
          AND next_action = 'none')
        OR
        (operation_status = 'terminal-failed'
          AND phase = 'failed'
          AND (
            (result_classification = 'retryable' AND next_action = 'retry')
            OR (result_classification = 'repair-required' AND next_action = 'repair')
          ))
        OR
        (operation_status = 'terminal-partial'
          AND phase = 'partial'
          AND result_classification IN ('retryable', 'repair-required')
          AND next_action IN ('retry', 'repair'))
        OR
        (operation_status = 'terminal-recovery-required'
          AND phase IN ('failed', 'partial')
          AND result_classification = 'provisioning-recovery-required'
          AND next_action = 'recover')
        OR
        (operation_status = 'terminal-lifecycle-required'
          AND phase IN ('blocked', 'failed')
          AND result_classification = 'lifecycle-decision-required'
          AND next_action = 'lifecycle-decision')
        OR
        (operation_status = 'terminal-blocked'
          AND phase IN ('blocked', 'failed')
          AND (
            (result_classification = 'repair-required' AND next_action = 'repair')
            OR (result_classification = 'blocked' AND next_action = 'stop')
          ))
      ))
  ),
  FOREIGN KEY (
    aggregate_operation_id, owner_type, owner_id, aggregate_scope_kind
  ) REFERENCES manuscript_provisioning_operation_attempts(
    operation_id, owner_type, owner_id, scope_kind
  ) ON DELETE CASCADE,
  FOREIGN KEY (
    current_child_operation_id, owner_type, owner_id, current_child_scope_kind,
    manuscript_channel, aggregate_operation_id
  ) REFERENCES manuscript_provisioning_operation_attempts(
    operation_id, owner_type, owner_id, scope_kind,
    manuscript_channel, aggregate_operation_id
  ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manuscript_provisioning_audit_outbox (
  operation_id TEXT PRIMARY KEY,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    delivery_status IN ('pending', 'delivered', 'failed')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  delivery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt_count >= 0),
  operation_log_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  CHECK (
    (delivery_status = 'pending'
      AND operation_log_id IS NULL
      AND delivered_at IS NULL)
    OR
    (delivery_status = 'delivered'
      AND operation_log_id IS NOT NULL
      AND error_code IS NULL
      AND delivered_at IS NOT NULL)
    OR
    (delivery_status = 'failed'
      AND operation_log_id IS NULL
      AND error_code IS NOT NULL
      AND delivered_at IS NULL)
  ),
  FOREIGN KEY (operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manuscript_provisioning_channel_claim
ON manuscript_provisioning_active_claims(owner_type, owner_id, manuscript_channel)
WHERE scope_kind = 'channel';

CREATE UNIQUE INDEX IF NOT EXISTS uq_manuscript_provisioning_literature_aggregate_claim
ON manuscript_provisioning_active_claims(owner_type, owner_id)
WHERE scope_kind = 'literature-aggregate';

CREATE UNIQUE INDEX IF NOT EXISTS uq_manuscript_provisioning_current_child_operation
ON manuscript_provisioning_literature_child_states(current_child_operation_id)
WHERE current_child_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_attempt_resource_history
ON manuscript_provisioning_operation_attempts(
  owner_type, owner_id, manuscript_channel, started_at
);

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_attempt_status_updated
ON manuscript_provisioning_operation_attempts(operation_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_attempt_previous
ON manuscript_provisioning_operation_attempts(previous_operation_id);

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_attempt_root
ON manuscript_provisioning_operation_attempts(root_operation_id);

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_attempt_aggregate
ON manuscript_provisioning_operation_attempts(aggregate_operation_id);

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_claim_progress
ON manuscript_provisioning_active_claims(last_progress_at);

CREATE INDEX IF NOT EXISTS idx_manuscript_provisioning_outbox_delivery
ON manuscript_provisioning_audit_outbox(delivery_status, updated_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (40, 'manuscript_provisioning_operation_state');
"#;

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(PROVISIONING_OPERATION_STATE_SCHEMA_SQL)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    validate_operation_state_contract(connection, false)
}

pub(crate) fn validate_v40_schema(connection: &Connection) -> rusqlite::Result<bool> {
    validate_operation_state_contract(connection, true)
}

fn validate_operation_state_contract(
    connection: &Connection,
    validate_legacy_child_projection: bool,
) -> rusqlite::Result<bool> {
    const TABLE_COLUMNS: &[(&str, &[&str])] = &[
        (
            "manuscript_provisioning_operation_attempts",
            &[
                "operation_id",
                "scope_kind",
                "owner_type",
                "owner_id",
                "manuscript_channel",
                "aggregate_operation_id",
                "intent",
                "trigger_kind",
                "phase",
                "operation_status",
                "result_classification",
                "next_action",
                "original_cause_code",
                "partial_kind",
                "revision",
                "previous_operation_id",
                "root_operation_id",
                "folder_effect",
                "manuscript_effect",
                "file_ref_effect",
                "binding_effect",
                "default_folder_file_ref_id",
                "default_manuscript_file_ref_id",
                "binding_id",
                "final_verification_outcome",
                "inspector_version",
                "verifier_version",
                "facts_schema_version",
                "started_at",
                "updated_at",
                "terminal_at",
            ],
        ),
        (
            "manuscript_provisioning_active_claims",
            &[
                "claim_id",
                "scope_kind",
                "owner_type",
                "owner_id",
                "manuscript_channel",
                "operation_id",
                "claim_owner_token",
                "claim_revision",
                "claimed_at",
                "last_heartbeat_at",
                "last_progress_at",
                "stale_observed_at",
                "stale_observed_by_token",
            ],
        ),
        (
            "manuscript_provisioning_literature_child_states",
            &[
                "aggregate_operation_id",
                "owner_type",
                "owner_id",
                "aggregate_scope_kind",
                "manuscript_channel",
                "current_child_operation_id",
                "current_child_scope_kind",
                "revision",
                "phase",
                "operation_status",
                "result_classification",
                "next_action",
                "default_readiness",
                "final_verification_outcome",
                "original_cause_code",
                "updated_at",
            ],
        ),
        (
            "manuscript_provisioning_audit_outbox",
            &[
                "operation_id",
                "delivery_status",
                "revision",
                "delivery_attempt_count",
                "operation_log_id",
                "error_code",
                "created_at",
                "updated_at",
                "delivered_at",
            ],
        ),
    ];
    for (table, expected) in TABLE_COLUMNS {
        if !validate_legacy_child_projection
            && *table == "manuscript_provisioning_literature_child_states"
        {
            continue;
        }
        let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
        let actual = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if actual
            != expected
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        {
            return Ok(false);
        }
    }
    const TABLE_SQL_REQUIRED_FRAGMENTS: &[(&str, &[&str])] = &[
        (
            "manuscript_provisioning_operation_attempts",
            &[
                "check (revision >= 0)",
                "facts_schema_version = 1",
                "foreign key (previous_operation_id)",
                "foreign key (root_operation_id)",
                "foreign key (aggregate_operation_id)",
                "on delete restrict",
            ],
        ),
        (
            "manuscript_provisioning_active_claims",
            &[
                "check (claim_revision >= 0)",
                "stale_observed_at is null and stale_observed_by_token is null",
                "foreign key (operation_id)",
                "on delete restrict",
            ],
        ),
        (
            "manuscript_provisioning_literature_child_states",
            &[
                "check (revision >= 0)",
                "default_readiness in ('ready', 'not-ready', 'not-verified')",
                "foreign key ( aggregate_operation_id, owner_type, owner_id, aggregate_scope_kind )",
                "on delete cascade",
                "on delete restrict",
            ],
        ),
        (
            "manuscript_provisioning_audit_outbox",
            &[
                "delivery_status in ('pending', 'delivered', 'failed')",
                "check (revision >= 0)",
                "check (delivery_attempt_count >= 0)",
                "foreign key (operation_id)",
                "on delete restrict",
            ],
        ),
    ];
    for (table, required_fragments) in TABLE_SQL_REQUIRED_FRAGMENTS {
        if !validate_legacy_child_projection
            && *table == "manuscript_provisioning_literature_child_states"
        {
            continue;
        }
        let sql: Option<String> = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get(0),
        )?;
        let Some(sql) = sql else {
            return Ok(false);
        };
        let normalized = sql
            .to_ascii_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if required_fragments
            .iter()
            .any(|fragment| !normalized.contains(fragment))
        {
            return Ok(false);
        }
    }
    const INDEX_CONTRACTS: &[(&str, &str, &[&str], bool, Option<&str>)] = &[
        (
            "manuscript_provisioning_active_claims",
            "uq_manuscript_provisioning_channel_claim",
            &["owner_type", "owner_id", "manuscript_channel"],
            true,
            Some("where scope_kind = 'channel'"),
        ),
        (
            "manuscript_provisioning_active_claims",
            "uq_manuscript_provisioning_literature_aggregate_claim",
            &["owner_type", "owner_id"],
            true,
            Some("where scope_kind = 'literature-aggregate'"),
        ),
        (
            "manuscript_provisioning_literature_child_states",
            "uq_manuscript_provisioning_current_child_operation",
            &["current_child_operation_id"],
            true,
            Some("where current_child_operation_id is not null"),
        ),
        (
            "manuscript_provisioning_operation_attempts",
            "idx_manuscript_provisioning_attempt_resource_history",
            &["owner_type", "owner_id", "manuscript_channel", "started_at"],
            false,
            None,
        ),
        (
            "manuscript_provisioning_operation_attempts",
            "idx_manuscript_provisioning_attempt_status_updated",
            &["operation_status", "updated_at"],
            false,
            None,
        ),
        (
            "manuscript_provisioning_operation_attempts",
            "idx_manuscript_provisioning_attempt_previous",
            &["previous_operation_id"],
            false,
            None,
        ),
        (
            "manuscript_provisioning_operation_attempts",
            "idx_manuscript_provisioning_attempt_root",
            &["root_operation_id"],
            false,
            None,
        ),
        (
            "manuscript_provisioning_operation_attempts",
            "idx_manuscript_provisioning_attempt_aggregate",
            &["aggregate_operation_id"],
            false,
            None,
        ),
        (
            "manuscript_provisioning_active_claims",
            "idx_manuscript_provisioning_claim_progress",
            &["last_progress_at"],
            false,
            None,
        ),
        (
            "manuscript_provisioning_audit_outbox",
            "idx_manuscript_provisioning_outbox_delivery",
            &["delivery_status", "updated_at"],
            false,
            None,
        ),
    ];
    for (table, index, expected_columns, expected_unique, predicate) in INDEX_CONTRACTS {
        if !validate_legacy_child_projection
            && *table == "manuscript_provisioning_literature_child_states"
        {
            continue;
        }
        let mut index_list = connection.prepare(&format!("PRAGMA index_list('{table}')"))?;
        let entries = index_list
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, i64>(4)? != 0,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some((_, unique, partial)) = entries.iter().find(|(name, _, _)| name == index) else {
            return Ok(false);
        };
        if unique != expected_unique || *partial != predicate.is_some() {
            return Ok(false);
        }
        let mut index_info = connection.prepare(&format!("PRAGMA index_info('{index}')"))?;
        let actual_columns = index_info
            .query_map([], |row| row.get::<_, String>(2))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if actual_columns
            != expected_columns
                .iter()
                .map(|column| column.to_string())
                .collect::<Vec<_>>()
        {
            return Ok(false);
        }
        if let Some(predicate) = predicate {
            let sql: String = connection.query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?1",
                [index],
                |row| row.get(0),
            )?;
            let normalized = sql
                .to_ascii_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !normalized.contains(predicate) {
                return Ok(false);
            }
        }
    }
    let ledger: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=40 AND name='manuscript_provisioning_operation_state'",
        [],
        |row| row.get(0),
    )?;
    Ok(ledger == 1)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningOperationAttempt {
    pub operation_id: String,
    pub scope_kind: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: Option<String>,
    pub aggregate_operation_id: Option<String>,
    pub intent: String,
    pub trigger_kind: String,
    pub phase: String,
    pub operation_status: String,
    pub result_classification: Option<String>,
    pub next_action: Option<String>,
    pub original_cause_code: Option<String>,
    pub partial_kind: Option<String>,
    pub revision: i64,
    pub previous_operation_id: Option<String>,
    pub root_operation_id: Option<String>,
    pub folder_effect: String,
    pub manuscript_effect: String,
    pub file_ref_effect: String,
    pub binding_effect: String,
    pub default_folder_file_ref_id: Option<String>,
    pub default_manuscript_file_ref_id: Option<String>,
    pub binding_id: Option<String>,
    pub final_verification_outcome: String,
    pub inspector_version: Option<String>,
    pub verifier_version: Option<String>,
    pub facts_schema_version: i64,
    pub started_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningActiveClaim {
    pub claim_id: String,
    pub scope_kind: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: Option<String>,
    pub operation_id: String,
    pub claim_owner_token: String,
    pub claim_revision: i64,
    pub claimed_at: String,
    pub last_heartbeat_at: String,
    pub last_progress_at: String,
    pub stale_observed_at: Option<String>,
    pub stale_observed_by_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningAuditOutbox {
    pub operation_id: String,
    pub delivery_status: String,
    pub revision: i64,
    pub delivery_attempt_count: i64,
    pub operation_log_id: Option<String>,
    pub error_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub delivered_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRootAttemptInput {
    pub operation_id: String,
    pub claim_id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub intent: String,
    pub trigger_kind: String,
    pub expected_attempt_revision: i64,
    pub expected_claim_revision: i64,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAttemptInput {
    pub operation_id: String,
    pub claim_id: String,
    pub claim_owner_token: String,
    pub expected_operation_revision: i64,
    pub expected_claim_revision: i64,
    pub expected_phase: String,
    pub expected_operation_status: String,
    pub phase: String,
    pub operation_status: String,
    pub result_classification: String,
    pub next_action: String,
    pub partial_kind: Option<String>,
    pub original_cause_code: Option<String>,
    pub folder_effect: String,
    pub manuscript_effect: String,
    pub file_ref_effect: String,
    pub binding_effect: String,
    pub default_folder_file_ref_id: Option<String>,
    pub default_manuscript_file_ref_id: Option<String>,
    pub binding_id: Option<String>,
    pub final_verification_outcome: String,
    pub inspector_version: Option<String>,
    pub verifier_version: Option<String>,
    pub occurred_at: String,
}

impl TerminalAttemptInput {
    #[cfg(test)]
    pub(crate) fn completed(
        operation_id: &str,
        claim_id: &str,
        claim_owner_token: &str,
        expected_operation_revision: i64,
        expected_claim_revision: i64,
        occurred_at: &str,
    ) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            claim_id: claim_id.to_string(),
            claim_owner_token: claim_owner_token.to_string(),
            expected_operation_revision,
            expected_claim_revision,
            expected_phase: "preflight".to_string(),
            expected_operation_status: "active".to_string(),
            phase: "completed".to_string(),
            operation_status: "terminal-completed".to_string(),
            result_classification: "completed".to_string(),
            next_action: "none".to_string(),
            partial_kind: None,
            original_cause_code: None,
            folder_effect: "reused".to_string(),
            manuscript_effect: "created".to_string(),
            file_ref_effect: "created".to_string(),
            binding_effect: "updated".to_string(),
            default_folder_file_ref_id: Some("folder-ref-1".to_string()),
            default_manuscript_file_ref_id: Some("manuscript-ref-1".to_string()),
            binding_id: Some("binding-1".to_string()),
            final_verification_outcome: "passed".to_string(),
            inspector_version: Some("p2-v1".to_string()),
            verifier_version: Some("p3a2-v1".to_string()),
            occurred_at: occurred_at.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootAttemptWithClaim {
    pub attempt: ProvisioningOperationAttempt,
    pub claim: ProvisioningActiveClaim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAttemptResult {
    pub attempt: ProvisioningOperationAttempt,
    pub outbox: ProvisioningAuditOutbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisioningOperationRepositoryError {
    pub code: &'static str,
    pub message: String,
    pub authoritative_attempt: Option<ProvisioningOperationAttempt>,
    pub authoritative_claim: Option<ProvisioningActiveClaim>,
}

type RepositoryResult<T> = Result<T, ProvisioningOperationRepositoryError>;

fn repository_error(
    code: &'static str,
    message: impl Into<String>,
) -> ProvisioningOperationRepositoryError {
    ProvisioningOperationRepositoryError {
        code,
        message: message.into(),
        authoritative_attempt: None,
        authoritative_claim: None,
    }
}

fn database_error(context: &str, _error: rusqlite::Error) -> ProvisioningOperationRepositoryError {
    repository_error(
        PROVISIONING_OPERATION_DATABASE_ERROR,
        format!("{context}: bounded SQLite operation failure"),
    )
}

fn attempt_from_row(row: &Row<'_>) -> rusqlite::Result<ProvisioningOperationAttempt> {
    Ok(ProvisioningOperationAttempt {
        operation_id: row.get(0)?,
        scope_kind: row.get(1)?,
        owner_type: row.get(2)?,
        owner_id: row.get(3)?,
        manuscript_channel: row.get(4)?,
        aggregate_operation_id: row.get(5)?,
        intent: row.get(6)?,
        trigger_kind: row.get(7)?,
        phase: row.get(8)?,
        operation_status: row.get(9)?,
        result_classification: row.get(10)?,
        next_action: row.get(11)?,
        original_cause_code: row.get(12)?,
        partial_kind: row.get(13)?,
        revision: row.get(14)?,
        previous_operation_id: row.get(15)?,
        root_operation_id: row.get(16)?,
        folder_effect: row.get(17)?,
        manuscript_effect: row.get(18)?,
        file_ref_effect: row.get(19)?,
        binding_effect: row.get(20)?,
        default_folder_file_ref_id: row.get(21)?,
        default_manuscript_file_ref_id: row.get(22)?,
        binding_id: row.get(23)?,
        final_verification_outcome: row.get(24)?,
        inspector_version: row.get(25)?,
        verifier_version: row.get(26)?,
        facts_schema_version: row.get(27)?,
        started_at: row.get(28)?,
        updated_at: row.get(29)?,
        terminal_at: row.get(30)?,
    })
}

const ATTEMPT_SELECT: &str = "SELECT operation_id, scope_kind, owner_type, owner_id,
 manuscript_channel, aggregate_operation_id, intent, trigger_kind, phase,
 operation_status, result_classification, next_action, original_cause_code,
 partial_kind, revision, previous_operation_id, root_operation_id, folder_effect,
 manuscript_effect, file_ref_effect, binding_effect, default_folder_file_ref_id,
 default_manuscript_file_ref_id, binding_id, final_verification_outcome,
 inspector_version, verifier_version, facts_schema_version, started_at, updated_at,
 terminal_at FROM manuscript_provisioning_operation_attempts";

pub(crate) fn read_operation_attempt(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Option<ProvisioningOperationAttempt>> {
    connection
        .query_row(
            &format!("{ATTEMPT_SELECT} WHERE operation_id=?1"),
            [operation_id],
            attempt_from_row,
        )
        .optional()
        .map_err(|error| database_error("read operation attempt", error))
}

fn claim_from_row(row: &Row<'_>) -> rusqlite::Result<ProvisioningActiveClaim> {
    Ok(ProvisioningActiveClaim {
        claim_id: row.get(0)?,
        scope_kind: row.get(1)?,
        owner_type: row.get(2)?,
        owner_id: row.get(3)?,
        manuscript_channel: row.get(4)?,
        operation_id: row.get(5)?,
        claim_owner_token: row.get(6)?,
        claim_revision: row.get(7)?,
        claimed_at: row.get(8)?,
        last_heartbeat_at: row.get(9)?,
        last_progress_at: row.get(10)?,
        stale_observed_at: row.get(11)?,
        stale_observed_by_token: row.get(12)?,
    })
}

const CLAIM_SELECT: &str = "SELECT claim_id, scope_kind, owner_type, owner_id,
 manuscript_channel, operation_id, claim_owner_token, claim_revision, claimed_at,
 last_heartbeat_at, last_progress_at, stale_observed_at, stale_observed_by_token
 FROM manuscript_provisioning_active_claims";

pub(crate) fn read_active_claim_for_operation(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Option<ProvisioningActiveClaim>> {
    connection
        .query_row(
            &format!("{CLAIM_SELECT} WHERE operation_id=?1"),
            [operation_id],
            claim_from_row,
        )
        .optional()
        .map_err(|error| database_error("read active claim", error))
}

fn outbox_from_row(row: &Row<'_>) -> rusqlite::Result<ProvisioningAuditOutbox> {
    Ok(ProvisioningAuditOutbox {
        operation_id: row.get(0)?,
        delivery_status: row.get(1)?,
        revision: row.get(2)?,
        delivery_attempt_count: row.get(3)?,
        operation_log_id: row.get(4)?,
        error_code: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        delivered_at: row.get(8)?,
    })
}

fn list_attempts_by_predicate(
    connection: &Connection,
    predicate: &str,
) -> RepositoryResult<Vec<ProvisioningOperationAttempt>> {
    let mut statement = connection
        .prepare(&format!(
            "{ATTEMPT_SELECT} WHERE {predicate} ORDER BY started_at, operation_id"
        ))
        .map_err(|error| database_error("prepare operation query", error))?;
    let rows = statement
        .query_map([], attempt_from_row)
        .map_err(|error| database_error("query operation attempts", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("collect operation attempts", error))?;
    Ok(rows)
}

pub(crate) fn list_active_operation_attempts(
    connection: &Connection,
) -> RepositoryResult<Vec<ProvisioningOperationAttempt>> {
    list_attempts_by_predicate(connection, "operation_status='active'")
}

pub(crate) fn list_unfinished_operation_attempts(
    connection: &Connection,
) -> RepositoryResult<Vec<ProvisioningOperationAttempt>> {
    list_attempts_by_predicate(
        connection,
        "operation_status IN (
          'active', 'terminal-recovery-required', 'terminal-lifecycle-required'
        )",
    )
}

pub(crate) fn list_recovery_candidate_attempts(
    connection: &Connection,
) -> RepositoryResult<Vec<ProvisioningOperationAttempt>> {
    list_attempts_by_predicate(connection, "operation_status='terminal-recovery-required'")
}

pub(crate) fn list_runtime_issue_candidate_attempts(
    connection: &Connection,
) -> RepositoryResult<Vec<ProvisioningOperationAttempt>> {
    list_attempts_by_predicate(
        connection,
        "operation_status IN (
          'active', 'terminal-failed', 'terminal-partial', 'terminal-blocked',
          'terminal-recovery-required', 'terminal-lifecycle-required'
        )",
    )
}

fn validate_initial_revisions(
    operation_revision: i64,
    claim_revision: i64,
) -> RepositoryResult<()> {
    if operation_revision != 0 || claim_revision != 0 {
        return Err(repository_error(
            PROVISIONING_OPERATION_INVALID_INPUT,
            "new attempt and claim revisions must both be zero",
        ));
    }
    Ok(())
}

fn validate_owner_channel(owner_type: &str, channel: &str) -> RepositoryResult<()> {
    let valid = match owner_type {
        "literature" => matches!(channel, "literature_outline" | "dedicated_notes"),
        "experiment" | "experimentRun" | "review" | "resultItem" | "finding"
        | "outputCandidate" | "outputGap" | "researchOutput" => channel == "primary",
        _ => false,
    };
    if !valid {
        return Err(repository_error(
            PROVISIONING_OPERATION_INVALID_INPUT,
            format!("invalid owner/channel: {owner_type}/{channel}"),
        ));
    }
    Ok(())
}

fn validate_intent_trigger(intent: &str, trigger: &str) -> RepositoryResult<()> {
    let valid = matches!(
        (intent, trigger),
        ("create-default", "owner-create")
            | ("retry", "explicit-retry")
            | ("repair", "explicit-repair")
            | ("recover", "explicit-recovery")
    );
    if !valid {
        return Err(repository_error(
            PROVISIONING_OPERATION_INVALID_INPUT,
            format!("invalid intent/trigger: {intent}/{trigger}"),
        ));
    }
    Ok(())
}

fn find_resource_claim(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
    channel: Option<&str>,
) -> RepositoryResult<Option<ProvisioningActiveClaim>> {
    let (sql, values): (String, Vec<&str>) = if let Some(channel) = channel {
        (
            format!(
                "{CLAIM_SELECT} WHERE owner_type=?1 AND owner_id=?2
                 AND ((scope_kind='channel' AND manuscript_channel=?3)
                   OR (scope_kind='literature-aggregate' AND ?1='literature'))
                 ORDER BY scope_kind LIMIT 1"
            ),
            vec![owner_type, owner_id, channel],
        )
    } else {
        (
            format!(
                "{CLAIM_SELECT} WHERE owner_type='literature' AND owner_id=?1
                 AND (scope_kind='literature-aggregate'
                   OR (scope_kind='channel'
                     AND manuscript_channel IN ('literature_outline', 'dedicated_notes')))
                 ORDER BY scope_kind, manuscript_channel LIMIT 1"
            ),
            vec![owner_id],
        )
    };
    connection
        .query_row(&sql, rusqlite::params_from_iter(values), claim_from_row)
        .optional()
        .map_err(|error| database_error("read resource claim", error))
}

fn insert_attempt(
    transaction: &Transaction<'_>,
    operation_id: &str,
    scope_kind: &str,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: Option<&str>,
    aggregate_operation_id: Option<&str>,
    intent: &str,
    trigger_kind: &str,
    occurred_at: &str,
) -> RepositoryResult<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               aggregate_operation_id, intent, trigger_kind, phase, operation_status,
               revision, folder_effect, manuscript_effect, file_ref_effect, binding_effect,
               final_verification_outcome, facts_schema_version, started_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'preflight', 'active',
               0, 'none', 'none', 'none', 'none', 'not-run', 1, ?9, ?9
             )",
            params![
                operation_id,
                scope_kind,
                owner_type,
                owner_id,
                manuscript_channel,
                aggregate_operation_id,
                intent,
                trigger_kind,
                occurred_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| database_error("insert operation attempt", error))
}

fn insert_claim(
    transaction: &Transaction<'_>,
    claim_id: &str,
    scope_kind: &str,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: Option<&str>,
    operation_id: &str,
    owner_token: &str,
    claimed_at: &str,
    sealed_heartbeat_at: &str,
) -> RepositoryResult<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_active_claims (
               claim_id, scope_kind, owner_type, owner_id, manuscript_channel,
               operation_id, claim_owner_token, claim_revision, claimed_at,
               last_heartbeat_at, last_progress_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?8)",
            params![
                claim_id,
                scope_kind,
                owner_type,
                owner_id,
                manuscript_channel,
                operation_id,
                owner_token,
                claimed_at,
                sealed_heartbeat_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| database_error("insert active claim", error))
}

pub(crate) fn create_root_attempt_and_claim(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    input: &CreateRootAttemptInput,
) -> RepositoryResult<RootAttemptWithClaim> {
    validate_initial_revisions(
        input.expected_attempt_revision,
        input.expected_claim_revision,
    )?;
    validate_owner_channel(&input.owner_type, &input.manuscript_channel)?;
    validate_intent_trigger(&input.intent, &input.trigger_kind)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin root attempt transaction", error))?;
    let sealed_heartbeat = ownership_context.sample_sealed_heartbeat().map_err(|_| {
        repository_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "repository ownership clock unavailable",
        )
    })?;
    if let Some(claim) = find_resource_claim(
        &transaction,
        &input.owner_type,
        &input.owner_id,
        Some(&input.manuscript_channel),
    )? {
        let mut error = repository_error(
            PROVISIONING_ACTIVE_CLAIM_CONFLICT,
            "mutation resource already has an active claim",
        );
        error.authoritative_claim = Some(claim);
        return Err(error);
    }
    insert_attempt(
        &transaction,
        &input.operation_id,
        "channel",
        &input.owner_type,
        &input.owner_id,
        Some(&input.manuscript_channel),
        None,
        &input.intent,
        &input.trigger_kind,
        &input.occurred_at,
    )?;
    insert_claim(
        &transaction,
        &input.claim_id,
        "channel",
        &input.owner_type,
        &input.owner_id,
        Some(&input.manuscript_channel),
        &input.operation_id,
        ownership_context.claim_owner_token(),
        &input.occurred_at,
        &sealed_heartbeat.persisted_value(),
    )?;
    let attempt = read_operation_attempt(&transaction, &input.operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "attempt readback missing")
    })?;
    let claim =
        read_active_claim_for_operation(&transaction, &input.operation_id)?.ok_or_else(|| {
            repository_error(PROVISIONING_OPERATION_NOT_FOUND, "claim readback missing")
        })?;
    transaction
        .commit()
        .map_err(|error| database_error("commit root attempt transaction", error))?;
    Ok(RootAttemptWithClaim { attempt, claim })
}

pub(crate) fn valid_terminal_tuple(input: &TerminalAttemptInput) -> bool {
    matches!(
        (
            input.phase.as_str(),
            input.operation_status.as_str(),
            input.result_classification.as_str(),
            input.next_action.as_str(),
        ),
        ("completed", "terminal-completed", "completed", "none")
            | ("failed", "terminal-failed", "retryable", "retry")
            | ("failed", "terminal-failed", "repair-required", "repair")
            | ("partial", "terminal-partial", "retryable", "retry")
            | ("partial", "terminal-partial", "repair-required", "repair")
            | (
                "failed" | "partial",
                "terminal-recovery-required",
                "provisioning-recovery-required",
                "recover"
            )
            | (
                "blocked" | "failed",
                "terminal-lifecycle-required",
                "lifecycle-decision-required",
                "lifecycle-decision"
            )
            | ("blocked", "terminal-blocked", "repair-required", "repair")
            | ("blocked" | "failed", "terminal-blocked", "blocked", "stop")
    ) && (input.phase != "partial" || input.partial_kind.is_some())
        && (input.operation_status != "terminal-recovery-required" || input.partial_kind.is_some())
        && (input.operation_status != "terminal-completed"
            || input.final_verification_outcome == "passed")
}

pub(crate) fn apply_terminal_attempt_cas(
    transaction: &Transaction<'_>,
    input: &TerminalAttemptInput,
) -> RepositoryResult<ProvisioningOperationAttempt> {
    if !valid_terminal_tuple(input) {
        return Err(repository_error(
            PROVISIONING_OPERATION_INVALID_INPUT,
            "terminal tuple is not part of the frozen taxonomy",
        ));
    }
    let attempt = read_operation_attempt(transaction, &input.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "attempt not found"))?;
    if attempt.operation_status != "active"
        || attempt.revision != input.expected_operation_revision
        || attempt.phase != input.expected_phase
        || attempt.operation_status != input.expected_operation_status
    {
        let mut error = repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "attempt expected revision or state no longer matches",
        );
        error.authoritative_attempt = Some(attempt);
        return Err(error);
    }
    validate_terminal_progress(transaction, &input.operation_id, &input.operation_status)?;
    let affected = transaction
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase=?1, operation_status=?2, result_classification=?3,
                 next_action=?4, partial_kind=?5, original_cause_code=?6,
                 folder_effect=?7, manuscript_effect=?8, file_ref_effect=?9,
                 binding_effect=?10, default_folder_file_ref_id=?11,
                 default_manuscript_file_ref_id=?12, binding_id=?13,
                 final_verification_outcome=?14, inspector_version=?15,
                 verifier_version=?16, revision=revision+1, updated_at=?17, terminal_at=?17
             WHERE operation_id=?18 AND revision=?19 AND phase=?20
               AND operation_status=?21",
            params![
                input.phase,
                input.operation_status,
                input.result_classification,
                input.next_action,
                input.partial_kind,
                input.original_cause_code,
                input.folder_effect,
                input.manuscript_effect,
                input.file_ref_effect,
                input.binding_effect,
                input.default_folder_file_ref_id,
                input.default_manuscript_file_ref_id,
                input.binding_id,
                input.final_verification_outcome,
                input.inspector_version,
                input.verifier_version,
                input.occurred_at,
                input.operation_id,
                input.expected_operation_revision,
                input.expected_phase,
                input.expected_operation_status,
            ],
        )
        .map_err(|error| database_error("CAS terminal attempt", error))?;
    if affected != 1 {
        let mut error = repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "attempt CAS affected no row",
        );
        error.authoritative_attempt = read_operation_attempt(transaction, &input.operation_id)?;
        return Err(error);
    }
    read_operation_attempt(transaction, &input.operation_id)?.ok_or_else(|| {
        repository_error(
            PROVISIONING_OPERATION_NOT_FOUND,
            "terminal readback missing",
        )
    })
}

pub(crate) fn release_active_claim_cas(
    transaction: &Transaction<'_>,
    claim: &ProvisioningActiveClaim,
) -> RepositoryResult<()> {
    let released = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_active_claims
             WHERE claim_id=?1 AND operation_id=?2 AND claim_owner_token=?3
               AND claim_revision=?4",
            params![
                claim.claim_id,
                claim.operation_id,
                claim.claim_owner_token,
                claim.claim_revision,
            ],
        )
        .map_err(|error| database_error("CAS release claim", error))?;
    if released != 1 {
        return Err(repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "claim CAS affected no row",
        ));
    }
    Ok(())
}

pub(crate) fn insert_pending_audit_outbox(
    transaction: &Transaction<'_>,
    operation_id: &str,
    occurred_at: &str,
) -> RepositoryResult<ProvisioningAuditOutbox> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id, delivery_status, revision, delivery_attempt_count,
               created_at, updated_at
             ) VALUES (?1, 'pending', 0, 0, ?2, ?2)",
            params![operation_id, occurred_at],
        )
        .map_err(|error| database_error("insert pending audit outbox", error))?;
    transaction
        .query_row(
            "SELECT operation_id, delivery_status, revision, delivery_attempt_count,
                    operation_log_id, error_code, created_at, updated_at, delivered_at
             FROM manuscript_provisioning_audit_outbox WHERE operation_id=?1",
            [operation_id],
            outbox_from_row,
        )
        .map_err(|error| database_error("read pending audit outbox", error))
}

pub(crate) fn terminalize_attempt_release_claim_and_enqueue_audit(
    connection: &mut Connection,
    input: &TerminalAttemptInput,
) -> RepositoryResult<TerminalAttemptResult> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin terminal transaction", error))?;
    let attempt = read_operation_attempt(&transaction, &input.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "attempt not found"))?;
    let claim = read_active_claim_for_operation(&transaction, &input.operation_id)?;
    let cas_matches = claim.as_ref().is_some_and(|claim| {
        claim.claim_id == input.claim_id && claim.claim_owner_token == input.claim_owner_token
    });
    if !cas_matches {
        let mut error = repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "attempt or claim expected revision/owner no longer matches",
        );
        error.authoritative_attempt = Some(attempt);
        error.authoritative_claim = claim;
        return Err(error);
    }
    let terminal_attempt = apply_terminal_attempt_cas(&transaction, input)?;
    sync_literature_terminal_projection(&transaction, &attempt, input)?;
    let claim = claim.expect("validated claim");
    release_active_claim_cas(&transaction, &claim)?;
    let outbox =
        insert_pending_audit_outbox(&transaction, &input.operation_id, &input.occurred_at)?;
    transaction
        .commit()
        .map_err(|error| database_error("commit terminal transaction", error))?;
    Ok(TerminalAttemptResult {
        attempt: terminal_attempt,
        outbox,
    })
}

/// Terminalizes an indeterminate-effect Attempt while retaining the exact Claim
/// for the existing recovery authority. This is the fail-closed counterpart to
/// ordinary terminalization: no caller may turn an unknown effect into a retry.
pub(crate) fn terminalize_attempt_retain_claim_and_enqueue_audit(
    connection: &mut Connection,
    input: &TerminalAttemptInput,
) -> RepositoryResult<TerminalAttemptResult> {
    if input.operation_status != "terminal-recovery-required"
        || input.result_classification != "provisioning-recovery-required"
        || input.next_action != "recover"
    {
        return Err(repository_error(
            PROVISIONING_OPERATION_INVALID_INPUT,
            "retained Claim requires the frozen recovery-required terminal tuple",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin retained recovery terminal transaction", error))?;
    let attempt = read_operation_attempt(&transaction, &input.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "attempt not found"))?;
    let claim = read_active_claim_for_operation(&transaction, &input.operation_id)?;
    let cas_matches = claim.as_ref().is_some_and(|claim| {
        claim.claim_id == input.claim_id
            && claim.claim_owner_token == input.claim_owner_token
            && claim.claim_revision == input.expected_claim_revision
    });
    if !cas_matches {
        let mut error = repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "attempt or retained claim expected revision/owner no longer matches",
        );
        error.authoritative_attempt = Some(attempt);
        error.authoritative_claim = claim;
        return Err(error);
    }
    let terminal_attempt = apply_terminal_attempt_cas(&transaction, input)?;
    sync_literature_terminal_projection(&transaction, &attempt, input)?;
    let outbox =
        insert_pending_audit_outbox(&transaction, &input.operation_id, &input.occurred_at)?;
    transaction
        .commit()
        .map_err(|error| database_error("commit retained recovery terminal transaction", error))?;
    Ok(TerminalAttemptResult {
        attempt: terminal_attempt,
        outbox,
    })
}
