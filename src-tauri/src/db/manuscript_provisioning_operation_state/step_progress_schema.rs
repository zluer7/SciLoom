#![allow(dead_code)]

use rusqlite::{Connection, TransactionBehavior};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub(crate) const DURABLE_STEP_PROGRESS_SCHEMA_VERSION: i64 = 41;
pub(crate) const DURABLE_STEP_PROGRESS_MIGRATION_NAME: &str =
    "manuscript_provisioning_durable_step_progress";

pub(crate) const SOURCE_VERSION_UNSUPPORTED: &str = "source-version-unsupported";
pub(crate) const SOURCE_SCHEMA_INVALID: &str = "source-schema-invalid";
pub(crate) const SOURCE_OPERATION_STATE_NONEMPTY: &str = "source-operation-state-nonempty";
pub(crate) const MIGRATION_FAILED: &str = "migration-failed";
pub(crate) const TARGET_SCHEMA_INVALID: &str = "target-schema-invalid";
pub(crate) const ISOLATION_DENIED: &str = "isolation-denied";

const PLAN_TABLE: &str = "manuscript_provisioning_step_plans";
const STEP_TABLE: &str = "manuscript_provisioning_step_progress";
const CHILD_TABLE: &str = "manuscript_provisioning_literature_child_states";
const CHILD_TEMP_TABLE: &str = "manuscript_provisioning_literature_child_states_v41";

pub(crate) const STEP_PLAN_TABLE_SQL: &str = r#"
CREATE TABLE manuscript_provisioning_step_plans (
  plan_id TEXT PRIMARY KEY
    CHECK (
      length(plan_id) = 64
      AND plan_id NOT GLOB '*[^0-9a-f]*'
    ),
  operation_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version = 1),
  plan_template_kind TEXT NOT NULL CHECK (
    plan_template_kind IN (
      'managed-primary',
      'experiment-primary',
      'experiment-run-primary',
      'literature-aggregate',
      'literature-channel'
    )
  ),
  plan_identity_fingerprint TEXT NOT NULL CHECK (
    length(plan_identity_fingerprint) = 64
    AND plan_identity_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  precondition_snapshot_hash TEXT NOT NULL CHECK (
    length(precondition_snapshot_hash) = 64
    AND precondition_snapshot_hash NOT GLOB '*[^0-9a-f]*'
  ),
  fingerprint_profile TEXT NOT NULL DEFAULT 'restricted-jcs-sha256-v1'
    CHECK (fingerprint_profile = 'restricted-jcs-sha256-v1'),
  owner_type TEXT NOT NULL CHECK (
    owner_type IN (
      'experiment', 'experimentRun', 'literature', 'review', 'resultItem',
      'finding', 'outputCandidate', 'outputGap', 'researchOutput'
    )
  ),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('channel', 'literature-aggregate', 'literature-child')
  ),
  manuscript_channel TEXT CHECK (
    manuscript_channel IS NULL
    OR manuscript_channel IN ('primary', 'literature_outline', 'dedicated_notes')
  ),
  intent TEXT NOT NULL CHECK (
    intent IN ('create-default', 'retry', 'repair', 'recover')
  ),
  canonical_resource_identity_hash TEXT NOT NULL CHECK (
    length(canonical_resource_identity_hash) = 64
    AND canonical_resource_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_placement_identity_hash TEXT NOT NULL CHECK (
    length(canonical_placement_identity_hash) = 64
    AND canonical_placement_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  parent_shared_identity_hash TEXT CHECK (
    parent_shared_identity_hash IS NULL
    OR (
      length(parent_shared_identity_hash) = 64
      AND parent_shared_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  step_count INTEGER NOT NULL CHECK (step_count BETWEEN 0 AND 32),
  planner_version TEXT NOT NULL CHECK (length(planner_version) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
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
    OR
    (scope_kind = 'literature-child'
      AND owner_type = 'literature'
      AND manuscript_channel IN ('literature_outline', 'dedicated_notes'))
  ),
  CHECK (step_count > 0 OR intent = 'recover'),
  FOREIGN KEY (operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id)
    ON DELETE RESTRICT
);
"#;

const STEP_PLAN_INDEX_SQL: &[&str] = &[
    "CREATE UNIQUE INDEX uq_manuscript_provisioning_step_plan_operation
     ON manuscript_provisioning_step_plans(operation_id);",
    "CREATE UNIQUE INDEX uq_manuscript_provisioning_step_plan_identity
     ON manuscript_provisioning_step_plans(plan_id, operation_id);",
    "CREATE INDEX idx_manuscript_provisioning_step_plan_owner
     ON manuscript_provisioning_step_plans(
       owner_type, owner_id, manuscript_channel, created_at
     );",
    "CREATE INDEX idx_manuscript_provisioning_step_plan_fingerprint
     ON manuscript_provisioning_step_plans(plan_identity_fingerprint);",
];

pub(crate) const STEP_PROGRESS_TABLE_SQL: &str = r#"
CREATE TABLE manuscript_provisioning_step_progress (
  step_id TEXT PRIMARY KEY
    CHECK (
      length(step_id) = 64
      AND step_id NOT GLOB '*[^0-9a-f]*'
    ),
  plan_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  step_ordinal INTEGER NOT NULL CHECK (step_ordinal BETWEEN 0 AND 31),
  step_kind TEXT NOT NULL CHECK (
    step_kind IN (
      'ensure-directory',
      'ensure-manuscript',
      'register-folder-fileref',
      'register-manuscript-fileref',
      'establish-binding',
      'converge-default-current',
      'converge-owner-metadata'
    )
  ),
  step_scope TEXT NOT NULL CHECK (
    step_scope IN (
      'primary',
      'literature-aggregate',
      'literature_outline',
      'dedicated_notes'
    )
  ),
  step_version INTEGER NOT NULL CHECK (step_version = 1),
  is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required = 1),
  boundary TEXT NOT NULL DEFAULT 'intended' CHECK (
    boundary IN (
      'intended',
      'started',
      'effect-observed',
      'readback-verified',
      'converged'
    )
  ),
  effect_outcome TEXT NOT NULL DEFAULT 'unobserved' CHECK (
    effect_outcome IN (
      'unobserved',
      'created',
      'reused',
      'updated',
      'preserved',
      'no-effect-proven'
    )
  ),
  readback_outcome TEXT NOT NULL DEFAULT 'not-run' CHECK (
    readback_outcome IN (
      'not-run',
      'effect-observed',
      'verified',
      'verified-absent',
      'wrong-type',
      'identity-mismatch',
      'containment-failed',
      'conflict',
      'unavailable'
    )
  ),
  observed_identity_hash TEXT CHECK (
    observed_identity_hash IS NULL
    OR (
      length(observed_identity_hash) = 64
      AND observed_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  resource_record_id TEXT CHECK (
    resource_record_id IS NULL
    OR length(resource_record_id) BETWEEN 1 AND 128
  ),
  effect_facts_schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (effect_facts_schema_version = 1),
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK (progress_revision >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  started_at TEXT,
  effect_observed_at TEXT,
  readback_verified_at TEXT,
  converged_at TEXT,
  CHECK (
    (boundary = 'intended'
      AND effect_outcome = 'unobserved'
      AND readback_outcome = 'not-run'
      AND observed_identity_hash IS NULL
      AND resource_record_id IS NULL
      AND started_at IS NULL
      AND effect_observed_at IS NULL
      AND readback_verified_at IS NULL
      AND converged_at IS NULL)
    OR
    (boundary = 'started'
      AND (
        (effect_outcome = 'unobserved'
          AND readback_outcome IN (
            'not-run', 'wrong-type', 'identity-mismatch',
            'containment-failed', 'conflict', 'unavailable'
          ))
        OR
        (effect_outcome = 'no-effect-proven'
          AND readback_outcome = 'verified-absent')
      )
      AND effect_observed_at IS NULL
      AND readback_verified_at IS NULL
      AND converged_at IS NULL
      AND started_at IS NOT NULL)
    OR
    (boundary = 'effect-observed'
      AND effect_outcome IN ('created', 'reused', 'updated', 'preserved')
      AND readback_outcome = 'effect-observed'
      AND observed_identity_hash IS NOT NULL
      AND started_at IS NOT NULL
      AND effect_observed_at IS NOT NULL
      AND readback_verified_at IS NULL
      AND converged_at IS NULL)
    OR
    (boundary = 'readback-verified'
      AND effect_outcome IN ('created', 'reused', 'updated', 'preserved')
      AND readback_outcome = 'verified'
      AND observed_identity_hash IS NOT NULL
      AND started_at IS NOT NULL
      AND effect_observed_at IS NOT NULL
      AND readback_verified_at IS NOT NULL
      AND converged_at IS NULL)
    OR
    (boundary = 'converged'
      AND effect_outcome IN ('created', 'reused', 'updated', 'preserved')
      AND readback_outcome = 'verified'
      AND observed_identity_hash IS NOT NULL
      AND started_at IS NOT NULL
      AND effect_observed_at IS NOT NULL
      AND readback_verified_at IS NOT NULL
      AND converged_at IS NOT NULL)
  ),
  FOREIGN KEY (plan_id, operation_id)
    REFERENCES manuscript_provisioning_step_plans(plan_id, operation_id)
    ON DELETE RESTRICT
);
"#;

const STEP_PROGRESS_INDEX_SQL: &[&str] = &[
    "CREATE UNIQUE INDEX uq_manuscript_provisioning_step_plan_ordinal
     ON manuscript_provisioning_step_progress(plan_id, step_ordinal);",
    "CREATE UNIQUE INDEX uq_manuscript_provisioning_step_plan_scope_kind
     ON manuscript_provisioning_step_progress(plan_id, step_scope, step_kind);",
    "CREATE INDEX idx_manuscript_provisioning_step_operation_boundary
     ON manuscript_provisioning_step_progress(
       operation_id, boundary, step_ordinal
     );",
    "CREATE INDEX idx_manuscript_provisioning_step_plan_scope
     ON manuscript_provisioning_step_progress(
       plan_id, step_scope, step_ordinal
     );",
    "CREATE INDEX idx_manuscript_provisioning_step_updated
     ON manuscript_provisioning_step_progress(updated_at, operation_id);",
];

pub(crate) const LITERATURE_CHILD_PROJECTION_TABLE_SQL: &str = r#"
CREATE TABLE manuscript_provisioning_literature_child_states_v41 (
  aggregate_operation_id TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'literature' CHECK (owner_type = 'literature'),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  manuscript_channel TEXT NOT NULL CHECK (
    manuscript_channel IN ('literature_outline', 'dedicated_notes')
  ),
  current_operation_id TEXT NOT NULL,
  current_operation_scope_kind TEXT NOT NULL CHECK (
    current_operation_scope_kind IN ('literature-aggregate', 'literature-child')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  child_summary_status TEXT NOT NULL DEFAULT 'assigned' CHECK (
    child_summary_status IN (
      'assigned',
      'terminal-completed',
      'terminal-unresolved'
    )
  ),
  result_classification TEXT CHECK (
    result_classification IS NULL
    OR result_classification IN (
      'completed',
      'retryable',
      'repair-required',
      'provisioning-recovery-required',
      'lifecycle-decision-required',
      'blocked'
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
  original_cause_code TEXT CHECK (
    original_cause_code IS NULL
    OR length(original_cause_code) BETWEEN 1 AND 128
  ),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (aggregate_operation_id, manuscript_channel),
  CHECK (
    (child_summary_status = 'assigned'
      AND result_classification IS NULL
      AND next_action IS NULL)
    OR
    (child_summary_status = 'terminal-completed'
      AND result_classification = 'completed'
      AND next_action = 'none'
      AND default_readiness = 'ready'
      AND final_verification_outcome = 'passed')
    OR
    (child_summary_status = 'terminal-unresolved'
      AND (
        (result_classification = 'retryable' AND next_action = 'retry')
        OR (result_classification = 'repair-required' AND next_action = 'repair')
        OR (
          result_classification = 'provisioning-recovery-required'
          AND next_action = 'recover'
        )
        OR (
          result_classification = 'lifecycle-decision-required'
          AND next_action = 'lifecycle-decision'
        )
        OR (result_classification = 'blocked' AND next_action = 'stop')
      )
    )
  ),
  FOREIGN KEY (aggregate_operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (current_operation_id)
    REFERENCES manuscript_provisioning_operation_attempts(operation_id)
    ON DELETE RESTRICT
);
"#;

const LITERATURE_CHILD_INDEX_SQL: &[&str] = &[
    "CREATE INDEX idx_manuscript_provisioning_literature_child_current_operation
     ON manuscript_provisioning_literature_child_states(current_operation_id);",
    "CREATE INDEX idx_manuscript_provisioning_literature_child_summary
     ON manuscript_provisioning_literature_child_states(
       child_summary_status, updated_at
     );",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V41MigrationOutcome {
    Migrated,
    AlreadyCurrent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableStepSchemaError {
    pub code: &'static str,
    pub stage: &'static str,
}

impl fmt::Display for DurableStepSchemaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "code={} stage={}", self.code, self.stage)
    }
}

impl std::error::Error for DurableStepSchemaError {}

fn error(code: &'static str, stage: &'static str) -> DurableStepSchemaError {
    DurableStepSchemaError { code, stage }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V41MigrationFault {
    PlanTable,
    StepTable,
    ChildTempTable,
    ChildCopy,
    ChildReplace,
    Indexes,
    TransactionValidator,
    Ledger,
    UserVersion,
}

#[cfg(test)]
fn inject_fault(
    expected: Option<V41MigrationFault>,
    actual: V41MigrationFault,
) -> Result<(), DurableStepSchemaError> {
    if expected == Some(actual) {
        Err(error(MIGRATION_FAILED, "fault-injected"))
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn inject_fault(_expected: Option<()>, _actual: ()) -> Result<(), DurableStepSchemaError> {
    Ok(())
}

fn execute_batch(
    connection: &Connection,
    sql: &str,
    stage: &'static str,
) -> Result<(), DurableStepSchemaError> {
    connection
        .execute_batch(sql)
        .map_err(|_| error(MIGRATION_FAILED, stage))
}

fn read_user_version(connection: &Connection) -> Result<i64, DurableStepSchemaError> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| error(SOURCE_SCHEMA_INVALID, "source-version-read"))
}

fn operation_state_is_empty(connection: &Connection) -> Result<bool, DurableStepSchemaError> {
    for table in [
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_literature_child_states",
        "manuscript_provisioning_audit_outbox",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|_| error(SOURCE_SCHEMA_INVALID, "source-operation-state-count"))?;
        if count != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) fn apply_v41_in_transaction_with_fault(
    connection: &Connection,
    fault: Option<V41MigrationFault>,
) -> Result<(), DurableStepSchemaError> {
    apply_v41_in_transaction_inner(connection, fault)
}

pub(crate) fn apply_v41_in_transaction(
    connection: &Connection,
) -> Result<(), DurableStepSchemaError> {
    #[cfg(test)]
    {
        apply_v41_in_transaction_inner(connection, None)
    }
    #[cfg(not(test))]
    {
        apply_v41_in_transaction_inner(connection, None)
    }
}

#[cfg(test)]
type Fault = V41MigrationFault;
#[cfg(not(test))]
type Fault = ();

fn apply_v41_in_transaction_inner(
    connection: &Connection,
    fault: Option<Fault>,
) -> Result<(), DurableStepSchemaError> {
    #[cfg(not(test))]
    let _ = fault;
    if read_user_version(connection)? != 40 {
        return Err(error(SOURCE_VERSION_UNSUPPORTED, "source-version-check"));
    }
    let source_current = super::validate_v40_schema(connection)
        .map_err(|_| error(SOURCE_SCHEMA_INVALID, "source-schema-validator"))?;
    if !source_current {
        return Err(error(SOURCE_SCHEMA_INVALID, "source-schema-validator"));
    }
    if !operation_state_is_empty(connection)? {
        return Err(error(
            SOURCE_OPERATION_STATE_NONEMPTY,
            "source-operation-state-nonempty",
        ));
    }

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::PlanTable)?;
    execute_batch(connection, STEP_PLAN_TABLE_SQL, "plan-table-create")?;

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::StepTable)?;
    execute_batch(connection, STEP_PROGRESS_TABLE_SQL, "step-table-create")?;

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::ChildTempTable)?;
    execute_batch(
        connection,
        LITERATURE_CHILD_PROJECTION_TABLE_SQL,
        "child-temp-table-create",
    )?;

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::ChildCopy)?;
    execute_batch(
        connection,
        "INSERT INTO manuscript_provisioning_literature_child_states_v41 (
           aggregate_operation_id, owner_type, owner_id, manuscript_channel,
           current_operation_id, current_operation_scope_kind, revision,
           child_summary_status, result_classification, next_action,
           default_readiness, final_verification_outcome, original_cause_code, updated_at
         )
         SELECT
           aggregate_operation_id, owner_type, owner_id, manuscript_channel,
           COALESCE(current_child_operation_id, aggregate_operation_id),
           CASE
             WHEN current_child_operation_id IS NULL THEN 'literature-aggregate'
             ELSE current_child_scope_kind
           END,
           revision,
           CASE
             WHEN operation_status = 'terminal-completed' THEN 'terminal-completed'
             WHEN operation_status IS NULL OR operation_status = 'active' THEN 'assigned'
             ELSE 'terminal-unresolved'
           END,
           result_classification, next_action, default_readiness,
           final_verification_outcome, original_cause_code, updated_at
         FROM manuscript_provisioning_literature_child_states;",
        "child-mechanical-copy",
    )?;

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::ChildReplace)?;
    execute_batch(
        connection,
        "DROP TABLE manuscript_provisioning_literature_child_states;
         ALTER TABLE manuscript_provisioning_literature_child_states_v41
         RENAME TO manuscript_provisioning_literature_child_states;",
        "child-table-replace",
    )?;

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::Indexes)?;
    for sql in STEP_PLAN_INDEX_SQL
        .iter()
        .chain(STEP_PROGRESS_INDEX_SQL)
        .chain(LITERATURE_CHILD_INDEX_SQL)
    {
        execute_batch(connection, sql, "target-index-create")?;
    }

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::TransactionValidator)?;
    if !validate_v41_structure(connection)
        .map_err(|_| error(TARGET_SCHEMA_INVALID, "transaction-structure-readback"))?
    {
        return Err(error(
            TARGET_SCHEMA_INVALID,
            "transaction-structure-readback",
        ));
    }

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::Ledger)?;
    connection
        .execute(
            "INSERT INTO schema_migrations(version, name) VALUES (?1, ?2)",
            (
                DURABLE_STEP_PROGRESS_SCHEMA_VERSION,
                DURABLE_STEP_PROGRESS_MIGRATION_NAME,
            ),
        )
        .map_err(|_| error(MIGRATION_FAILED, "migration-ledger-write"))?;

    #[cfg(test)]
    inject_fault(fault, V41MigrationFault::UserVersion)?;
    connection
        .pragma_update(None, "user_version", DURABLE_STEP_PROGRESS_SCHEMA_VERSION)
        .map_err(|_| error(MIGRATION_FAILED, "user-version-write"))?;

    let foreign_key_violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|_| error(TARGET_SCHEMA_INVALID, "foreign-key-check"))?;
    if foreign_key_violations != 0 {
        return Err(error(TARGET_SCHEMA_INVALID, "foreign-key-check"));
    }
    Ok(())
}

pub(crate) fn migrate_v40_to_v41(
    connection: &mut Connection,
) -> Result<V41MigrationOutcome, DurableStepSchemaError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| error(MIGRATION_FAILED, "transaction-begin"))?;
    let source_version = read_user_version(&transaction)?;
    if source_version == DURABLE_STEP_PROGRESS_SCHEMA_VERSION {
        transaction
            .commit()
            .map_err(|_| error(MIGRATION_FAILED, "transaction-commit"))?;
        return if validate_exact_v41_schema(connection)
            .map_err(|_| error(TARGET_SCHEMA_INVALID, "post-commit-validator"))?
        {
            Ok(V41MigrationOutcome::AlreadyCurrent)
        } else {
            Err(error(TARGET_SCHEMA_INVALID, "post-commit-validator"))
        };
    }
    apply_v41_in_transaction(&transaction)?;
    transaction
        .commit()
        .map_err(|_| error(MIGRATION_FAILED, "transaction-commit"))?;
    if !validate_exact_v41_schema(connection)
        .map_err(|_| error(TARGET_SCHEMA_INVALID, "post-commit-validator"))?
    {
        return Err(error(TARGET_SCHEMA_INVALID, "post-commit-validator"));
    }
    Ok(V41MigrationOutcome::Migrated)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnInfo {
    name: String,
    declared_type: String,
    not_null: bool,
    default_value: Option<String>,
    primary_key_position: i64,
}

#[derive(Debug, Clone, Copy)]
struct ColumnContract {
    name: &'static str,
    declared_type: &'static str,
    not_null: bool,
    default_value: Option<&'static str>,
    primary_key_position: i64,
}

fn columns(connection: &Connection, table: &str) -> rusqlite::Result<Vec<ColumnInfo>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let result = statement
        .query_map([], |row| {
            Ok(ColumnInfo {
                name: row.get(1)?,
                declared_type: row.get::<_, String>(2)?.to_ascii_uppercase(),
                not_null: row.get::<_, i64>(3)? != 0,
                default_value: row.get(4)?,
                primary_key_position: row.get(5)?,
            })
        })?
        .collect();
    result
}

fn normalize_default(value: Option<&str>) -> Option<String> {
    value.map(|value| {
        value
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .to_ascii_lowercase()
    })
}

fn columns_match(
    connection: &Connection,
    table: &str,
    expected: &[ColumnContract],
) -> rusqlite::Result<bool> {
    let actual = columns(connection, table)?;
    Ok(actual.len() == expected.len()
        && actual.iter().zip(expected).all(|(actual, expected)| {
            actual.name == expected.name
                && actual.declared_type == expected.declared_type
                && actual.not_null == expected.not_null
                && normalize_default(actual.default_value.as_deref())
                    == normalize_default(expected.default_value)
                && actual.primary_key_position == expected.primary_key_position
        }))
}

const PLAN_COLUMNS: &[ColumnContract] = &[
    ColumnContract {
        name: "plan_id",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 1,
    },
    ColumnContract {
        name: "operation_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "plan_version",
        declared_type: "INTEGER",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "plan_template_kind",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "plan_identity_fingerprint",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "precondition_snapshot_hash",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "fingerprint_profile",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'restricted-jcs-sha256-v1'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "owner_type",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "owner_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "scope_kind",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "manuscript_channel",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "intent",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "canonical_resource_identity_hash",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "canonical_placement_identity_hash",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "parent_shared_identity_hash",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "step_count",
        declared_type: "INTEGER",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "planner_version",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "created_at",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
];

const STEP_COLUMNS: &[ColumnContract] = &[
    ColumnContract {
        name: "step_id",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 1,
    },
    ColumnContract {
        name: "plan_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "operation_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "step_ordinal",
        declared_type: "INTEGER",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "step_kind",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "step_scope",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "step_version",
        declared_type: "INTEGER",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "is_required",
        declared_type: "INTEGER",
        not_null: true,
        default_value: Some("1"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "boundary",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'intended'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "effect_outcome",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'unobserved'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "readback_outcome",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'not-run'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "observed_identity_hash",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "resource_record_id",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "effect_facts_schema_version",
        declared_type: "INTEGER",
        not_null: true,
        default_value: Some("1"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "progress_revision",
        declared_type: "INTEGER",
        not_null: true,
        default_value: Some("0"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "created_at",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "updated_at",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "started_at",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "effect_observed_at",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "readback_verified_at",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "converged_at",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
];

const CHILD_COLUMNS: &[ColumnContract] = &[
    ColumnContract {
        name: "aggregate_operation_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 1,
    },
    ColumnContract {
        name: "owner_type",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'literature'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "owner_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "manuscript_channel",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 2,
    },
    ColumnContract {
        name: "current_operation_id",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "current_operation_scope_kind",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "revision",
        declared_type: "INTEGER",
        not_null: true,
        default_value: Some("0"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "child_summary_status",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'assigned'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "result_classification",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "next_action",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "default_readiness",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'not-verified'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "final_verification_outcome",
        declared_type: "TEXT",
        not_null: true,
        default_value: Some("'not-run'"),
        primary_key_position: 0,
    },
    ColumnContract {
        name: "original_cause_code",
        declared_type: "TEXT",
        not_null: false,
        default_value: None,
        primary_key_position: 0,
    },
    ColumnContract {
        name: "updated_at",
        declared_type: "TEXT",
        not_null: true,
        default_value: None,
        primary_key_position: 0,
    },
];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ForeignKeyContract {
    id: i64,
    sequence: i64,
    target_table: String,
    from_column: String,
    to_column: String,
    on_delete: String,
}

fn foreign_keys(connection: &Connection, table: &str) -> rusqlite::Result<Vec<ForeignKeyContract>> {
    let mut statement = connection.prepare(&format!("PRAGMA foreign_key_list('{table}')"))?;
    let mut result = statement
        .query_map([], |row| {
            Ok(ForeignKeyContract {
                id: row.get(0)?,
                sequence: row.get(1)?,
                target_table: row.get(2)?,
                from_column: row.get(3)?,
                to_column: row.get(4)?,
                on_delete: row.get::<_, String>(6)?.to_ascii_uppercase(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    result.sort();
    Ok(result)
}

fn foreign_key_shape_matches(
    connection: &Connection,
    table: &str,
    expected_groups: &[(&str, &[(&str, &str)])],
) -> rusqlite::Result<bool> {
    let actual = foreign_keys(connection, table)?;
    let mut groups: BTreeMap<i64, Vec<&ForeignKeyContract>> = BTreeMap::new();
    for key in &actual {
        groups.entry(key.id).or_default().push(key);
    }
    if groups.len() != expected_groups.len() {
        return Ok(false);
    }
    let mut actual_shapes = groups
        .values()
        .map(|entries| {
            let first = entries[0];
            (
                first.target_table.clone(),
                first.on_delete.clone(),
                entries
                    .iter()
                    .map(|entry| (entry.from_column.clone(), entry.to_column.clone()))
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    actual_shapes.sort();
    let mut expected_shapes = expected_groups
        .iter()
        .map(|(target, columns)| {
            (
                (*target).to_string(),
                "RESTRICT".to_string(),
                columns
                    .iter()
                    .map(|(from, to)| ((*from).to_string(), (*to).to_string()))
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    expected_shapes.sort();
    Ok(actual_shapes == expected_shapes)
}

fn index_matches(
    connection: &Connection,
    table: &str,
    name: &str,
    columns: &[&str],
    unique: bool,
) -> rusqlite::Result<bool> {
    let mut list = connection.prepare(&format!("PRAGMA index_list('{table}')"))?;
    let entries = list
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let Some((_, actual_unique, origin)) = entries.iter().find(|(index, _, _)| index == name)
    else {
        return Ok(false);
    };
    if *actual_unique != unique || origin != "c" {
        return Ok(false);
    }
    let mut info = connection.prepare(&format!("PRAGMA index_info('{name}')"))?;
    let actual_columns = info
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(actual_columns == columns)
}

fn named_indexes(connection: &Connection, table: &str) -> rusqlite::Result<BTreeSet<String>> {
    let mut list = connection.prepare(&format!("PRAGMA index_list('{table}')"))?;
    let result = list
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let origin: String = row.get(3)?;
            Ok((name, origin))
        })?
        .filter_map(|entry| match entry {
            Ok((name, origin)) if origin == "c" => Some(Ok(name)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect();
    result
}

fn canonicalize_expression(value: &str) -> String {
    let mut result = String::new();
    let mut in_quote = false;
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\'' {
            result.push(character);
            if in_quote && chars.peek() == Some(&'\'') {
                result.push(chars.next().unwrap_or('\''));
            } else {
                in_quote = !in_quote;
            }
        } else if in_quote {
            result.push(character);
        } else if !character.is_whitespace() {
            result.extend(character.to_lowercase());
        }
    }
    result
}

fn check_expressions(create_sql: &str) -> Option<Vec<String>> {
    let lower = create_sql.to_ascii_lowercase();
    let bytes = create_sql.as_bytes();
    let mut cursor = 0;
    let mut expressions = Vec::new();
    while let Some(relative) = lower[cursor..].find("check") {
        let keyword = cursor + relative;
        let before = keyword.checked_sub(1).and_then(|index| bytes.get(index));
        let after = bytes.get(keyword + 5);
        if before.is_some_and(|value| value.is_ascii_alphanumeric() || *value == b'_')
            || after.is_some_and(|value| value.is_ascii_alphanumeric() || *value == b'_')
        {
            cursor = keyword + 5;
            continue;
        }
        let mut open = keyword + 5;
        while bytes
            .get(open)
            .is_some_and(|value| value.is_ascii_whitespace())
        {
            open += 1;
        }
        if bytes.get(open) != Some(&b'(') {
            return None;
        }
        let mut depth = 0_i64;
        let mut in_quote = false;
        let mut index = open;
        let mut close = None;
        while index < bytes.len() {
            let byte = bytes[index];
            if byte == b'\'' {
                if in_quote && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                in_quote = !in_quote;
            } else if !in_quote {
                if byte == b'(' {
                    depth += 1;
                } else if byte == b')' {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(index);
                        break;
                    }
                }
            }
            index += 1;
        }
        let close = close?;
        expressions.push(canonicalize_expression(&create_sql[open + 1..close]));
        cursor = close + 1;
    }
    expressions.sort();
    Some(expressions)
}

fn table_checks_match(
    connection: &Connection,
    table: &str,
    expected_ddl: &str,
) -> rusqlite::Result<bool> {
    let actual: Option<String> = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(actual
        .as_deref()
        .and_then(check_expressions)
        .zip(check_expressions(expected_ddl))
        .is_some_and(|(actual, expected)| actual == expected))
}

pub(crate) fn validate_v41_structure(connection: &Connection) -> rusqlite::Result<bool> {
    if !columns_match(connection, PLAN_TABLE, PLAN_COLUMNS)?
        || !columns_match(connection, STEP_TABLE, STEP_COLUMNS)?
        || !columns_match(connection, CHILD_TABLE, CHILD_COLUMNS)?
    {
        return Ok(false);
    }
    if !table_checks_match(connection, PLAN_TABLE, STEP_PLAN_TABLE_SQL)?
        || !table_checks_match(connection, STEP_TABLE, STEP_PROGRESS_TABLE_SQL)?
        || !table_checks_match(
            connection,
            CHILD_TABLE,
            LITERATURE_CHILD_PROJECTION_TABLE_SQL,
        )?
    {
        return Ok(false);
    }
    if !foreign_key_shape_matches(
        connection,
        PLAN_TABLE,
        &[(
            "manuscript_provisioning_operation_attempts",
            &[("operation_id", "operation_id")],
        )],
    )? || !foreign_key_shape_matches(
        connection,
        STEP_TABLE,
        &[(
            PLAN_TABLE,
            &[("plan_id", "plan_id"), ("operation_id", "operation_id")],
        )],
    )? || !foreign_key_shape_matches(
        connection,
        CHILD_TABLE,
        &[
            (
                "manuscript_provisioning_operation_attempts",
                &[("aggregate_operation_id", "operation_id")],
            ),
            (
                "manuscript_provisioning_operation_attempts",
                &[("current_operation_id", "operation_id")],
            ),
        ],
    )? {
        return Ok(false);
    }

    const INDEXES: &[(&str, &str, &[&str], bool)] = &[
        (
            PLAN_TABLE,
            "uq_manuscript_provisioning_step_plan_operation",
            &["operation_id"],
            true,
        ),
        (
            PLAN_TABLE,
            "uq_manuscript_provisioning_step_plan_identity",
            &["plan_id", "operation_id"],
            true,
        ),
        (
            PLAN_TABLE,
            "idx_manuscript_provisioning_step_plan_owner",
            &["owner_type", "owner_id", "manuscript_channel", "created_at"],
            false,
        ),
        (
            PLAN_TABLE,
            "idx_manuscript_provisioning_step_plan_fingerprint",
            &["plan_identity_fingerprint"],
            false,
        ),
        (
            STEP_TABLE,
            "uq_manuscript_provisioning_step_plan_ordinal",
            &["plan_id", "step_ordinal"],
            true,
        ),
        (
            STEP_TABLE,
            "uq_manuscript_provisioning_step_plan_scope_kind",
            &["plan_id", "step_scope", "step_kind"],
            true,
        ),
        (
            STEP_TABLE,
            "idx_manuscript_provisioning_step_operation_boundary",
            &["operation_id", "boundary", "step_ordinal"],
            false,
        ),
        (
            STEP_TABLE,
            "idx_manuscript_provisioning_step_plan_scope",
            &["plan_id", "step_scope", "step_ordinal"],
            false,
        ),
        (
            STEP_TABLE,
            "idx_manuscript_provisioning_step_updated",
            &["updated_at", "operation_id"],
            false,
        ),
        (
            CHILD_TABLE,
            "idx_manuscript_provisioning_literature_child_current_operation",
            &["current_operation_id"],
            false,
        ),
        (
            CHILD_TABLE,
            "idx_manuscript_provisioning_literature_child_summary",
            &["child_summary_status", "updated_at"],
            false,
        ),
    ];
    for (table, index, columns, unique) in INDEXES {
        if !index_matches(connection, table, index, columns, *unique)? {
            return Ok(false);
        }
    }
    for table in [PLAN_TABLE, STEP_TABLE, CHILD_TABLE] {
        let expected = INDEXES
            .iter()
            .filter(|(expected_table, _, _, _)| expected_table == &table)
            .map(|(_, index, _, _)| (*index).to_string())
            .collect::<BTreeSet<_>>();
        if named_indexes(connection, table)? != expected {
            return Ok(false);
        }
    }
    let temp_exists: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
        [CHILD_TEMP_TABLE],
        |row| row.get(0),
    )?;
    Ok(temp_exists == 0)
}

pub(crate) fn validate_provisioning_contract(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    if !super::schema_is_current(connection)? || !validate_v41_structure(connection)? {
        return Ok(false);
    }
    let ledger: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=?1 AND name=?2",
        (
            DURABLE_STEP_PROGRESS_SCHEMA_VERSION,
            DURABLE_STEP_PROGRESS_MIGRATION_NAME,
        ),
        |row| row.get(0),
    )?;
    let ledger_name_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE name=?1",
        [DURABLE_STEP_PROGRESS_MIGRATION_NAME],
        |row| row.get(0),
    )?;
    Ok(ledger == 1 && ledger_name_count == 1)
}

fn validate_exact_v41_schema(connection: &Connection) -> rusqlite::Result<bool> {
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(
        user_version == DURABLE_STEP_PROGRESS_SCHEMA_VERSION
            && validate_provisioning_contract(connection)?,
    )
}
