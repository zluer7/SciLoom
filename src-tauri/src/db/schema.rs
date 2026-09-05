use rusqlite::{Connection, Result};
use super::formal_switch_foundation::FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION;
use super::review_structured_state::REVIEW_STRUCTURED_STATE_SCHEMA_VERSION;
use super::ai_durable_foundation::{
    AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION, AI_CONTEXT_REQUEST_SCHEMA_VERSION,
    AI_DURABLE_FOUNDATION_SCHEMA_VERSION, AI_STANDARD_RESULT_SCHEMA_VERSION,
};

use std::collections::{HashMap, HashSet};
use std::fmt;

const INITIAL_SCHEMA_VERSION: i64 = 1;
const EXPERIMENT_DATA_SCHEMA_VERSION: i64 = 5;
const OUTPUT_CONVERSION_SCHEMA_VERSION: i64 = 6;
const LITERATURE_DATA_SCHEMA_VERSION: i64 = 7;
const FORMAL_OUTPUT_CONTRACT_SCHEMA_VERSION: i64 = 8;
const OUTPUT_GAP_CLOSURE_SCHEMA_VERSION: i64 = 9;
const OPERATION_AUDIT_SCHEMA_VERSION: i64 = 10;
const OUTPUT_FIVE_LAYER_CONTRACT_SCHEMA_VERSION: i64 = 11;
const OUTPUT_CONVERSION_RELATION_SCHEMA_VERSION: i64 = 12;
const OUTPUT_FILE_REF_CONTRACT_SCHEMA_VERSION: i64 = 13;
const OUTPUT_SOURCE_LINK_SCHEMA_VERSION: i64 = 14;
const OUTPUT_GAP_FEEDBACK_CARD_SCHEMA_VERSION: i64 = 15;
const RESEARCH_TRACE_EVENT_PREFERENCE_SCHEMA_VERSION: i64 = 16;
const FILE_IDENTITY_BINDING_SCHEMA_VERSION: i64 = 17;
const MANAGED_ROOT_SETTING_SCHEMA_VERSION: i64 = 18;
const MANUSCRIPT_CHANNEL_SCHEMA_VERSION: i64 = 19;
const LITERATURE_CHANNEL_PARTIAL_REPAIR_SCHEMA_VERSION: i64 = 20;
const LITERATURE_CANDIDATE_METADATA_SCHEMA_VERSION: i64 = 21;
const EXPERIMENT_BUSINESS_MODEL_SCHEMA_VERSION: i64 = 22;
const EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION: i64 = 23;
const EXPERIMENT_WORKSPACE_TITLE_IDENTITY_SCHEMA_VERSION: i64 = 24;
const EXPERIMENT_PROVISIONING_IDENTITY_SCHEMA_VERSION: i64 = 25;
const EXPERIMENT_RUN_PROVISIONING_IDENTITY_SCHEMA_VERSION: i64 = 26;
const EXPERIMENT_REPRESENTATIVE_RUN_SCHEMA_VERSION: i64 = 27;
const EXPERIMENT_FILE_BODY_SINGLE_SOURCE_SCHEMA_VERSION: i64 = 28;
const EXPERIMENT_WORKSPACE_IDENTITY_ENFORCEMENT_SCHEMA_VERSION: i64 = 29;
const EXPERIMENT_SHARED_OPEN_FILE_REF_IDENTITY_SCHEMA_VERSION: i64 = 30;
const EXPERIMENT_RUN_MULTI_MANUSCRIPT_IDENTITY_SCHEMA_VERSION: i64 = 31;
const EXPERIMENT_RUN_SWITCH_DURABLE_RECOVERY_SCHEMA_VERSION: i64 = 32;
const EXPERIMENT_RUN_SAVE_AS_DURABLE_OPERATION_SCHEMA_VERSION: i64 = 33;
const EXPERIMENT_RUN_SWITCH_CONTEXT_SNAPSHOT_SCHEMA_VERSION: i64 = 34;
const EXPERIMENT_RUN_SWITCH_CANONICAL_WRITEBACK_SCHEMA_VERSION: i64 = 35;
const EXPERIMENT_MANUSCRIPT_FINAL_CONVERGENCE_SCHEMA_VERSION: i64 = 36;
const EXPERIMENT_MANUSCRIPT_CANONICAL_RECOVERY_SCHEMA_VERSION: i64 = 37;
const EXPERIMENT_GENERATED_FIELD_RECONCILIATION_SCHEMA_VERSION: i64 = 39;
pub(crate) const MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION: i64 = 40;
pub(crate) const MANUSCRIPT_PROVISIONING_DURABLE_STEP_PROGRESS_SCHEMA_VERSION: i64 = 41;
pub(crate) const MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION: i64 = 42;
const EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION: i64 = 43;
const RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION: i64 = 44;
pub(crate) const SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION: i64 = 45;
pub(crate) const SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION: i64 = 46;
pub(crate) const SAVE_AS_FINALIZATION_SCHEMA_VERSION: i64 = 47;
pub(crate) const SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION: i64 = 48;
pub(crate) const SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION: i64 = 49;
pub(crate) const REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION: i64 = 50;
pub(crate) const REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION: i64 = 51;
pub(crate) const EXPERIMENT_SIX_FIELD_SCHEMA_VERSION: i64 = 52;
pub const CURRENT_SCHEMA_VERSION: i64 = super::experiment_planning_relation::VERSION;

#[derive(Debug)]
pub struct SchemaInitializationError {
    pub code: &'static str,
    pub stage: &'static str,
    pub version: i64,
    pub table: Option<&'static str>,
    pub message: String,
    pub retryable: bool,
}

impl fmt::Display for SchemaInitializationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "code={} stage={} version={} table={} retryable={} message={}",
            self.code,
            self.stage,
            self.version,
            self.table.unwrap_or("none"),
            self.retryable,
            self.message
        )
    }
}

impl std::error::Error for SchemaInitializationError {}

type SchemaResult<T> = std::result::Result<T, SchemaInitializationError>;

fn schema_error(
    code: &'static str,
    stage: &'static str,
    version: i64,
    table: Option<&'static str>,
    message: impl Into<String>,
) -> SchemaInitializationError {
    SchemaInitializationError {
        code,
        stage,
        version,
        table,
        message: message.into(),
        retryable: false,
    }
}

fn run_schema_stage(
    stage: &'static str,
    version: i64,
    table: Option<&'static str>,
    operation: impl FnOnce() -> Result<()>,
) -> SchemaResult<()> {
    operation().map_err(|error| {
        schema_error(
            "DB_MIGRATION_FAILED",
            stage,
            version,
            table,
            error.to_string(),
        )
    })
}

fn apply_experiment_six_field_foundation(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage(
        "experiment-six-field-schema-foundation",
        EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
        Some("experiments"),
        || super::experiment_six_field_schema::apply_schema_migration(connection),
    )
}

fn apply_formal_switch_foundation(connection: &Connection) -> SchemaResult<()> {
    super::formal_switch_foundation::apply_schema_migration(connection).map_err(|error| {
        schema_error(
            "DB_MIGRATION_FAILED",
            "formal-switch-shared-durable-persistence-foundation",
            FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION,
            Some("formal_switch_operations"),
            error,
        )
    })
}

fn apply_review_structured_state_foundation(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage(
        "review-structured-state-canonical-authority",
        REVIEW_STRUCTURED_STATE_SCHEMA_VERSION,
        Some("review_structured_states"),
        || super::review_structured_state::apply_schema_migration(connection),
    )
}

fn apply_ai_durable_foundation(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage(
        "canonical-conversation-message-call-attempt-foundation",
        AI_DURABLE_FOUNDATION_SCHEMA_VERSION,
        Some("ai_call_attempts"),
        || super::ai_durable_foundation::apply_schema_migration(connection),
    )
}

fn apply_ai_attachment_authorization_foundation(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage(
        "ai-call-attempt-file-ref-explicit-authorization",
        AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION,
        Some("ai_call_attempt_file_ref_authorizations"),
        || {
            super::ai_durable_foundation::apply_attachment_authorization_schema_migration(
                connection,
            )
        },
    )
}

fn apply_ai_context_request_foundation(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage(
        "same-conversation-ai-context-request-approval-loop",
        AI_CONTEXT_REQUEST_SCHEMA_VERSION,
        Some("ai_context_requests"),
        || super::ai_durable_foundation::apply_context_request_schema_migration(connection),
    )
}

fn apply_ai_standard_result_foundation(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage(
        "parse-draft-minimal-standard-result-task-action-closure",
        AI_STANDARD_RESULT_SCHEMA_VERSION,
        Some("ai_standard_results"),
        || super::ai_durable_foundation::apply_standard_result_schema_migration(connection),
    )
}

const INITIAL_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  time_scale TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  milestone_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  task_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  start_date TEXT,
  due_date TEXT,
  estimated_hours REAL,
  actual_hours REAL,
  acceptance_criteria TEXT NOT NULL,
  blocker TEXT,
  review TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (milestone_id) REFERENCES milestones(id)
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  experiment_name TEXT NOT NULL,
  machine_object TEXT NOT NULL,
  fault_type TEXT NOT NULL,
  speed REAL,
  load REAL,
  sensor_config TEXT NOT NULL,
  data_path TEXT NOT NULL,
  sampling_rate REAL,
  duration REAL,
  result_summary TEXT NOT NULL,
  summary_other TEXT,
  problem_notes TEXT,
  next_action TEXT,
  created_local_date TEXT NOT NULL CHECK (
    length(created_local_date) = 10
    AND created_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(created_local_date) = created_local_date
  ),
  created_local_time TEXT NOT NULL CHECK (
    length(created_local_time) = 4
    AND created_local_time GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(substr(created_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_local_time, 3, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  experiment_id TEXT,
  output_name TEXT NOT NULL,
  output_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  usable_for_paper INTEGER NOT NULL DEFAULT 0 CHECK (usable_for_paper IN (0, 1)),
  description TEXT NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE INDEX IF NOT EXISTS idx_milestones_project_id ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone_id ON tasks(milestone_id);
CREATE INDEX IF NOT EXISTS idx_experiments_project_id ON experiments(project_id);
CREATE INDEX IF NOT EXISTS idx_experiments_task_id ON experiments(task_id);
CREATE INDEX IF NOT EXISTS idx_outputs_project_id ON outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_outputs_task_id ON outputs(task_id);
CREATE INDEX IF NOT EXISTS idx_outputs_experiment_id ON outputs(experiment_id);

CREATE INDEX IF NOT EXISTS idx_milestones_deleted_at ON milestones(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_experiments_deleted_at ON experiments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_outputs_deleted_at ON outputs(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (1, 'initial_labpod_schema');
"#;

const LEGACY_EXPERIMENT_PRIVATE_SAVE_AS_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS experiment_manuscript_save_as_operations (
  operation_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  target_path_identity TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared','create_unknown','file_created','metadata_unknown',
    'metadata_registered','activation_pending','resolved','blocked','cancelled_safe'
  )),
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_save_as_unresolved_target
  ON experiment_manuscript_save_as_operations(experiment_id, target_path_identity)
  WHERE phase NOT IN ('resolved','cancelled_safe');
CREATE INDEX IF NOT EXISTS idx_experiment_save_as_unresolved_owner
  ON experiment_manuscript_save_as_operations(experiment_id, phase);
INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (36, 'experiment_manuscript_final_convergence');
"#;

const LEGACY_RUN_PRIVATE_SAVE_AS_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS experiment_run_manuscript_save_as_operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  target_path_identity TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'prepared','file_create_unknown','file_created','metadata_commit_unknown',
    'metadata_committed','session_activation_pending','resolved','blocked','cancelled_safe'
  )),
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_save_as_unresolved_target
  ON experiment_run_manuscript_save_as_operations(run_id, target_path_identity)
  WHERE phase NOT IN ('resolved','cancelled_safe');
CREATE INDEX IF NOT EXISTS idx_run_save_as_unresolved_owner
  ON experiment_run_manuscript_save_as_operations(run_id, phase);
INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (33, 'experiment_run_save_as_durable_operation');
"#;

pub fn run_migrations(connection: &Connection) -> SchemaResult<()> {
    run_schema_stage("pragma", CURRENT_SCHEMA_VERSION, None, || {
        connection.execute_batch("PRAGMA foreign_keys = ON;")
    })?;
    let source_user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| {
            schema_error(
                "source-version-unsupported",
                "source-version-read",
                CURRENT_SCHEMA_VERSION,
                None,
                error.to_string(),
            )
        })?;
    if source_user_version == CURRENT_SCHEMA_VERSION {
        run_schema_stage("v59-relation-contract", CURRENT_SCHEMA_VERSION, Some("experiments"), || {
            super::experiment_planning_relation::validate_target(connection)
        })?;
        validate_current_schema(connection)?;
        validate_user_version(connection)?;
        return Ok(());
    }
    if source_user_version == AI_STANDARD_RESULT_SCHEMA_VERSION {
        validate_current_schema(connection)?;
        run_schema_stage("v59-predecessor-admission-all-four-relations-null", CURRENT_SCHEMA_VERSION, Some("experiments"), || {
            super::experiment_planning_relation::preflight(connection)
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage("v59-foreign-key-suspension", CURRENT_SCHEMA_VERSION, None, || connection.execute_batch("PRAGMA foreign_keys=OFF;"))?;
            run_schema_stage("v59-transaction-begin", CURRENT_SCHEMA_VERSION, None, || connection.execute_batch("BEGIN IMMEDIATE;"))?;
            run_schema_stage("v59-relation-migration", CURRENT_SCHEMA_VERSION, Some("experiments"), || super::experiment_planning_relation::apply(connection))?;
            run_schema_stage("v59-user-version", CURRENT_SCHEMA_VERSION, None, || connection.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION))?;
            run_schema_stage("v59-transaction-commit", CURRENT_SCHEMA_VERSION, None, || connection.execute_batch("COMMIT;"))
        })();
        if upgrade.is_err() { let _ = connection.execute_batch("ROLLBACK;"); }
        let restore = run_schema_stage("v59-foreign-key-restore", CURRENT_SCHEMA_VERSION, None, || connection.execute_batch("PRAGMA foreign_keys=ON;"));
        upgrade?;
        restore?;
        validate_current_schema(connection)?;
        validate_user_version(connection)?;
        return Ok(());
    }
    // D4 admits one predecessor family, not an implicit chain through older data.
    if source_user_version != 0 {
        return Err(schema_error("source-version-unsupported", "v59-predecessor-version", CURRENT_SCHEMA_VERSION, None,
            format!("Only fresh databases and admitted v58 predecessors are supported; found {source_user_version}")));
    }
    let existing_objects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'", [], |row| row.get(0)
    ).map_err(|error| schema_error("source-version-unsupported", "v59-fresh-admission", CURRENT_SCHEMA_VERSION, None, error.to_string()))?;
    if existing_objects != 0 {
        return Err(schema_error("source-version-unsupported", "v59-fresh-admission", CURRENT_SCHEMA_VERSION, None,
            "An unversioned existing schema is not a fresh database"));
    }
    if source_user_version == AI_CONTEXT_REQUEST_SCHEMA_VERSION {
        run_schema_stage(
            "v57-to-v58-foreign-key-suspension",
            CURRENT_SCHEMA_VERSION,
            None,
            || connection.execute_batch("PRAGMA foreign_keys=OFF;"),
        )?;
        run_schema_stage("v57-to-v58-transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            apply_ai_standard_result_foundation(connection)?;
            run_schema_stage("v58-user-version", CURRENT_SCHEMA_VERSION, None, || {
                connection.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
            })?;
            let current = super::ai_durable_foundation::standard_result_schema_is_current(connection)
                .map_err(|error| {
                    schema_error(
                        "DB_SCHEMA_INVARIANT_FAILED",
                        "v58-standard-result-schema-check",
                        AI_STANDARD_RESULT_SCHEMA_VERSION,
                        Some("ai_standard_results"),
                        error.to_string(),
                    )
                })?;
            if !current {
                return Err(schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "v58-standard-result-schema-check",
                    AI_STANDARD_RESULT_SCHEMA_VERSION,
                    Some("ai_standard_results"),
                    "v58 Standard Result authority is incomplete",
                ));
            }
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            let _ = connection.execute_batch("PRAGMA foreign_keys=ON;");
            return Err(error);
        }
        run_schema_stage("v57-to-v58-transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        run_schema_stage("v57-to-v58-foreign-key-restore", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("PRAGMA foreign_keys=ON;")
        })?;
        validate_current_schema(connection)?;
        validate_user_version(connection)?;
        return Ok(());
    }
    if source_user_version == AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION {
        run_schema_stage(
            "v56-to-v57-transaction-begin",
            AI_CONTEXT_REQUEST_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            let context_request_current =
                super::ai_durable_foundation::context_request_schema_is_current(connection)
                    .map_err(|error| {
                        schema_error(
                            "DB_SCHEMA_INVARIANT_FAILED",
                            "v57-preflight-schema-check",
                            AI_CONTEXT_REQUEST_SCHEMA_VERSION,
                            Some("ai_context_requests"),
                            error.to_string(),
                        )
                    })?;
            if !context_request_current {
                apply_ai_context_request_foundation(connection)?;
            }
            let context_request_current =
                super::ai_durable_foundation::context_request_schema_is_current(connection)
                    .map_err(|error| {
                        schema_error(
                            "DB_SCHEMA_INVARIANT_FAILED",
                            "v57-post-migration-schema-check",
                            AI_CONTEXT_REQUEST_SCHEMA_VERSION,
                            Some("ai_context_requests"),
                            error.to_string(),
                        )
                    })?;
            if !context_request_current {
                return Err(schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "v57-post-migration-schema-check",
                    AI_CONTEXT_REQUEST_SCHEMA_VERSION,
                    Some("ai_context_requests"),
                    "v57 Same-Conversation Context Request authority is incomplete",
                ));
            }
            run_schema_stage(
                "v57-user-version",
                AI_CONTEXT_REQUEST_SCHEMA_VERSION,
                None,
                || {
                    connection.pragma_update(
                        None,
                        "user_version",
                        AI_CONTEXT_REQUEST_SCHEMA_VERSION,
                    )
                },
            )?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v56-to-v57-transaction-commit",
            AI_CONTEXT_REQUEST_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == AI_DURABLE_FOUNDATION_SCHEMA_VERSION {
        run_schema_stage("v55-to-v56-transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            apply_ai_attachment_authorization_foundation(connection)?;
            run_schema_stage("v56-user-version", AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION, None, || {
                connection.pragma_update(None, "user_version", AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION)
            })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage("v55-to-v56-transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        return run_migrations(connection);
    }
    if source_user_version == REVIEW_STRUCTURED_STATE_SCHEMA_VERSION {
        run_schema_stage("v54-to-v55-transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            apply_ai_durable_foundation(connection)?;
            run_schema_stage(
                "v55-user-version",
                AI_DURABLE_FOUNDATION_SCHEMA_VERSION,
                None,
                || {
                    connection.pragma_update(
                        None,
                        "user_version",
                        AI_DURABLE_FOUNDATION_SCHEMA_VERSION,
                    )
                },
            )?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage("v54-to-v55-transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        return run_migrations(connection);
    }
    if source_user_version == FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION {
        run_schema_stage("v53-to-v54-transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            apply_review_structured_state_foundation(connection)?;
            run_schema_stage("v54-user-version", REVIEW_STRUCTURED_STATE_SCHEMA_VERSION, None, || {
                connection.pragma_update(None, "user_version", REVIEW_STRUCTURED_STATE_SCHEMA_VERSION)
            })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage("v53-to-v54-transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        return run_migrations(connection);
    }
    if source_user_version == EXPERIMENT_SIX_FIELD_SCHEMA_VERSION {
        run_schema_stage("v52-to-v53-transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            apply_formal_switch_foundation(connection)?;
            run_schema_stage("v53-user-version", FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION, None, || {
                connection.pragma_update(None, "user_version", FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION)
            })?;
            if !super::formal_switch_foundation::schema_is_current(connection)
                .map_err(|error| schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "v53-formal-switch-foundation-check",
                    FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION,
                    Some("formal_switch_operations"),
                    error,
                ))?
            {
                return Err(schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "v53-formal-switch-foundation-check",
                    FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION,
                    Some("formal_switch_operations"),
                    "v53 Formal Switch foundation schema is incomplete",
                ));
            }
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage("v52-to-v53-transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        return run_migrations(connection);
    }
    if source_user_version == REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION {
        run_schema_stage("v51-to-v52-foreign-key-suspension", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("PRAGMA foreign_keys=OFF;")
        })?;
        run_schema_stage("v51-to-v52-transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            apply_experiment_six_field_foundation(connection)?;
            run_schema_stage("v52-foreign-key-check", CURRENT_SCHEMA_VERSION, Some("experiments"), || {
                let violations: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)
                )?;
                if violations == 0 { Ok(()) } else { Err(rusqlite::Error::InvalidQuery) }
            })?;
            run_schema_stage(
                "v52-user-version",
                EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
                None,
                || {
                    connection.pragma_update(
                        None,
                        "user_version",
                        EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
                    )
                },
            )?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            let _ = connection.execute_batch("PRAGMA foreign_keys=ON;");
            return Err(error);
        }
        run_schema_stage("v51-to-v52-transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        run_schema_stage("v51-to-v52-foreign-key-restore", CURRENT_SCHEMA_VERSION, None, || {
            connection.execute_batch("PRAGMA foreign_keys=ON;")
        })?;
        return run_migrations(connection);
    }
    if source_user_version > CURRENT_SCHEMA_VERSION {
        return Err(schema_error(
            "source-version-unsupported",
            "source-version-check",
            CURRENT_SCHEMA_VERSION,
            None,
            "database schema version is newer than this application",
        ));
    }
    if source_user_version == REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION {
        let source_current = super::review_lifecycle_action::legacy_v50_schema_is_current(connection)
            .map_err(|error| schema_error(
                "source-schema-invalid",
                "v50-to-v51-source-validator",
                REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                error.to_string(),
            ))?;
        if !source_current {
            return Err(schema_error(
                "source-schema-invalid",
                "v50-to-v51-source-validator",
                REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                "v50 Review lifecycle authority is invalid",
            ));
        }
        run_schema_stage("v50-to-v51-transaction-begin", CURRENT_SCHEMA_VERSION, None, || connection.execute_batch("BEGIN IMMEDIATE;"))?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "review-permanent-delete-durable-authority-foundation",
                REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                || super::review_permanent_delete::apply_schema_migration(connection),
            )?;
            apply_experiment_six_field_foundation(connection)?;
            connection.pragma_update(None, "user_version", EXPERIMENT_SIX_FIELD_SCHEMA_VERSION)
                .map_err(|error| schema_error("migration-failed","v52-user-version",EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,None,error.to_string()))?;
            Ok(())
        })();
        if let Err(error)=upgrade { let _=connection.execute_batch("ROLLBACK;"); return Err(error); }
        run_schema_stage("v50-to-v51-transaction-commit",CURRENT_SCHEMA_VERSION,None,||connection.execute_batch("COMMIT;"))?;
        return run_migrations(connection);
    }
    if source_user_version == SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION {
        if super::review_permanent_delete::schema_is_current(connection).unwrap_or(false) {
            apply_experiment_six_field_foundation(connection)?;
            connection
                .pragma_update(None, "user_version", EXPERIMENT_SIX_FIELD_SCHEMA_VERSION)
                .map_err(|error| schema_error(
                    "migration-failed",
                    "v52-existing-contract-user-version",
                    EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
                    None,
                    error.to_string(),
                ))?;
            return run_migrations(connection);
        }
        if super::review_lifecycle_action::legacy_v50_schema_is_current(connection).unwrap_or(false) {
            super::review_permanent_delete::apply_schema_migration(connection)
                .map_err(|error| schema_error("migration-failed","v49-existing-contract-v51",CURRENT_SCHEMA_VERSION,Some("review_lifecycle_actions"),error.to_string()))?;
            apply_experiment_six_field_foundation(connection)?;
            connection
                .pragma_update(None, "user_version", EXPERIMENT_SIX_FIELD_SCHEMA_VERSION)
                .map_err(|error| schema_error(
                    "migration-failed",
                    "v52-existing-contract-user-version",
                    EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
                    None,
                    error.to_string(),
                ))?;
            return run_migrations(connection);
        }
        let source_current = super::review_lifecycle_action::legacy_v49_schema_is_current(connection)
            .map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v49-to-v50-source-validator",
                    SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION,
                    Some("review_lifecycle_actions"),
                    error.to_string(),
                )
            })?;
        if !source_current {
            return Err(schema_error(
                "source-schema-invalid",
                "v49-to-v50-source-validator",
                SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                "v49 operation/recycle lifecycle boundary is invalid",
            ));
        }
        run_schema_stage("v49-to-v50-transaction-begin", REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION, None, || {
            connection.execute_batch("BEGIN IMMEDIATE;")
        })?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "review-lifecycle-durable-action-authority",
                REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                || super::review_lifecycle_action::apply_schema_migration(connection),
            )?;
            run_schema_stage(
                "review-permanent-delete-durable-authority-foundation",
                REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                || super::review_permanent_delete::apply_schema_migration(connection),
            )?;
            apply_experiment_six_field_foundation(connection)?;
            connection
                .pragma_update(None, "user_version", EXPERIMENT_SIX_FIELD_SCHEMA_VERSION)
                .map_err(|error| schema_error(
                    "migration-failed",
                    "v52-user-version",
                    EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
                    None,
                    error.to_string(),
                ))?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage("v49-to-v50-transaction-commit", REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION, None, || {
            connection.execute_batch("COMMIT;")
        })?;
        return run_migrations(connection);
    }
    if source_user_version == SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION {
        let operation_v48 =
            super::manuscript_save_as_operation::legacy_v48_schema_is_current(connection)
                .map_err(|error| {
                    schema_error(
                        "source-schema-invalid",
                        "v48-to-v49-operation-validator",
                        SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                        Some("manuscript_save_as_operations"),
                        error.to_string(),
                    )
                })?;
        if !operation_v48 {
            return Err(schema_error(
                "source-schema-invalid",
                "v48-to-v49-source-validator",
                SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                "v48 Save As operation contract is invalid",
            ));
        }
        let bare_d2 = super::manuscript_save_as_operation::bare_d2_rows_prevent_v49_upgrade(
            connection,
        )
        .map_err(|error| {
            schema_error(
                "migration-preflight-failed",
                "v48-to-v49-bare-d2-preflight",
                SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                error.to_string(),
            )
        })?;
        if bare_d2 {
            return Err(schema_error(
                "D2_UNKNOWN_ACTIVE_ROW_MIGRATION_BLOCKED",
                "v48-to-v49-bare-d2-preflight",
                SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                "bare d2_commit_unknown rows require explicit resolution before schema v49",
            ));
        }
        run_schema_stage(
            "v48-to-v49-durable-containment-rebuild",
            SAVE_AS_D2_DURABLE_CONTAINMENT_SCHEMA_VERSION,
            Some("manuscript_save_as_operations"),
            || super::manuscript_save_as_operation::apply_v49_schema_migration(connection),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == SAVE_AS_FINALIZATION_SCHEMA_VERSION {
        let operation_current =
            super::manuscript_save_as_operation::legacy_v48_schema_is_current(connection).map_err(
                |error| {
                    schema_error(
                        "source-schema-invalid",
                        "v47-to-v48-operation-validator",
                        SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                        Some("manuscript_save_as_operations"),
                        error.to_string(),
                    )
                },
            )?;
        let custody_current =
            super::manuscript_save_as_candidate_custody::schema_is_current(connection)
                .map_err(|error| {
                    schema_error(
                        "source-schema-invalid",
                        "v47-to-v48-custody-validator",
                        SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                        Some("manuscript_save_as_candidate_custody"),
                        error.to_string(),
                    )
                })?;
        let finalization_v47 =
            super::manuscript_save_as_finalization::legacy_v47_schema_is_current(
                connection,
            )
            .map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v47-to-v48-finalization-validator",
                    SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                    Some("manuscript_save_as_finalizations"),
                    error.to_string(),
                )
            })?;
        if !operation_current || !custody_current || !finalization_v47 {
            return Err(schema_error(
                "source-schema-invalid",
                "v47-to-v48-source-validator",
                SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                None,
                "v47 Save As operation/custody/finalization contract is invalid",
            ));
        }
        run_schema_stage(
            "v47-to-v48-transaction-begin",
            SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "save-as-p4-exact-outcome-acceptance",
                SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                Some("manuscript_save_as_finalizations"),
                || {
                    super::manuscript_save_as_finalization::apply_schema_migration(
                        connection,
                    )
                },
            )?;
            connection
                .pragma_update(
                    None,
                    "user_version",
                    SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                )
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v48-user-version",
                        SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v47-to-v48-transaction-commit",
            SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION {
        let operation_is_v46 =
            super::manuscript_save_as_operation::legacy_v46_schema_is_current(connection)
                .map_err(|error| {
                    schema_error(
                        "source-schema-invalid",
                        "v46-to-v47-operation-validator",
                        SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                        Some("manuscript_save_as_operations"),
                        error.to_string(),
                    )
                })?;
        let operation_already_has_v47_check =
            super::manuscript_save_as_operation::legacy_v48_schema_is_current(connection).map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v46-to-v47-operation-validator",
                    SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                    Some("manuscript_save_as_operations"),
                    error.to_string(),
                )
            })?;
        if !(operation_is_v46 || operation_already_has_v47_check)
            || !super::manuscript_save_as_candidate_custody::schema_is_current(connection)
                .map_err(|error| {
                    schema_error(
                        "source-schema-invalid",
                        "v46-to-v47-custody-validator",
                        SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                        Some("manuscript_save_as_candidate_custody"),
                        error.to_string(),
                    )
                })?
        {
            return Err(schema_error(
                "source-schema-invalid",
                "v46-to-v47-source-validator",
                SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                None,
                "v46 Save As operation/custody contract is invalid",
            ));
        }
        run_schema_stage(
            "v46-to-v48-transaction-begin",
            SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "save-as-finalization-operation-and-custody-rebuild",
                SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                || {
                    connection.execute_batch(
                        "DROP TABLE manuscript_save_as_candidate_custody;
                         DROP TABLE manuscript_save_as_operations;",
                    )?;
                    super::manuscript_save_as_operation::apply_schema_migration(connection)?;
                    super::manuscript_save_as_candidate_custody::apply_schema_migration(connection)
                },
            )?;
            run_schema_stage(
                "save-as-lifecycle-finalization-atomicity",
                SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                Some("manuscript_save_as_finalizations"),
                || {
                    super::manuscript_save_as_finalization::apply_schema_migration(
                        connection,
                    )
                },
            )?;
            connection
                .pragma_update(
                    None,
                    "user_version",
                    SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                )
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v48-user-version",
                        SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v46-to-v48-transaction-commit",
            SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION {
        if !super::manuscript_save_as_operation::legacy_v48_schema_is_current(connection)
            .map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v45-to-v46-source-validator",
                    SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                    Some("manuscript_save_as_operations"),
                    error.to_string(),
                )
            })?
        {
            return Err(schema_error(
                "source-schema-invalid",
                "v45-to-v46-source-validator",
                SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                "v45 shared J0 contract is invalid",
            ));
        }
        run_schema_stage(
            "v45-to-v46-transaction-begin",
            SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "save-as-candidate-custody-receipt-and-exact-cleanup",
                SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                Some("manuscript_save_as_candidate_custody"),
                || {
                    super::manuscript_save_as_candidate_custody::apply_schema_migration(
                        connection,
                    )
                },
            )?;
            apply_experiment_six_field_foundation(connection)?;
            connection
                .pragma_update(
                    None,
                    "user_version",
                    SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                )
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v46-user-version",
                        SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v45-to-v46-transaction-commit",
            SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION {
        if !super::manuscript_save_as_operation::legacy_v42_schema_is_current(connection)
            .map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v44-to-v45-source-validator",
                    RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                    Some("manuscript_save_as_operations"),
                    error.to_string(),
                )
            })?
        {
            return Err(schema_error(
                "source-schema-invalid",
                "v44-to-v45-source-validator",
                RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                "v44 shared J0 contract is invalid",
            ));
        }
        run_schema_stage(
            "v44-to-v45-transaction-begin",
            SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "save-as-j0-invariants-and-deterministic-recovery-order",
                SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                || {
                    super::manuscript_save_as_operation::apply_deterministic_ordering_migration(
                        connection,
                    )
                },
            )?;
            run_schema_stage(
                "save-as-candidate-custody-receipt-and-exact-cleanup",
                SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                Some("manuscript_save_as_candidate_custody"),
                || {
                    super::manuscript_save_as_candidate_custody::apply_schema_migration(
                        connection,
                    )
                },
            )?;
            connection
                .pragma_update(None, "user_version", SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION)
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v45-user-version",
                        SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v44-to-v45-transaction-commit",
            SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION {
        for table in [
            "manuscript_save_as_operations",
            "experiment_run_manuscript_save_as_operations",
        ] {
            if !table_exists(connection, table).map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v43-to-v44-source-validator",
                    EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                    Some(table),
                    error.to_string(),
                )
            })? {
                return Err(schema_error(
                    "source-schema-invalid",
                    "v43-to-v44-source-validator",
                    EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                    Some(table),
                    "v43 source table is missing",
                ));
            }
        }
        if table_exists(connection, "experiment_manuscript_save_as_operations")
            .map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v43-to-v44-removed-table-validator",
                    EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                    Some("experiment_manuscript_save_as_operations"),
                    error.to_string(),
                )
            })?
        {
            return Err(schema_error(
                "source-schema-invalid",
                "v43-to-v44-removed-table-validator",
                EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("experiment_manuscript_save_as_operations"),
                "v43 source retained removed Experiment private J0",
            ));
        }
        run_schema_stage(
            "v43-to-v44-transaction-begin",
            RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "drop-run-private-save-as-operation",
                RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("experiment_run_manuscript_save_as_operations"),
                || {
                    connection.execute_batch(
                        "DROP TABLE experiment_run_manuscript_save_as_operations;
                         INSERT OR IGNORE INTO schema_migrations(version,name)
                         VALUES (44,'drop_run_private_save_as_operations');",
                    )
                },
            )?;
            connection
                .pragma_update(
                    None,
                    "user_version",
                    RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                )
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v44-user-version",
                        RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v43-to-v44-transaction-commit",
            RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION {
        for table in [
            "manuscript_save_as_operations",
            "experiment_manuscript_save_as_operations",
            "experiment_run_manuscript_save_as_operations",
        ] {
            if !table_exists(connection, table).map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v42-to-v43-source-validator",
                    MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION,
                    Some(table),
                    error.to_string(),
                )
            })? {
                return Err(schema_error(
                    "source-schema-invalid",
                    "v42-to-v43-source-validator",
                    MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION,
                    Some(table),
                    "v42 source table is missing",
                ));
            }
        }
        if !super::manuscript_save_as_operation::legacy_v42_schema_is_current(connection)
            .map_err(|error| {
                schema_error(
                    "source-schema-invalid",
                    "v42-to-v43-shared-j0-validator",
                    MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION,
                    Some("manuscript_save_as_operations"),
                    error.to_string(),
                )
            })?
        {
            return Err(schema_error(
                "source-schema-invalid",
                "v42-to-v43-shared-j0-validator",
                SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                "v42 shared J0 contract is invalid",
            ));
        }
        run_schema_stage(
            "v42-to-v43-transaction-begin",
            EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "drop-experiment-private-save-as-operation",
                EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("experiment_manuscript_save_as_operations"),
                || {
                    connection.execute_batch(
                        "DROP TABLE experiment_manuscript_save_as_operations;
                         INSERT OR IGNORE INTO schema_migrations(version,name)
                         VALUES (43,'drop_experiment_private_save_as_operations');",
                    )
                },
            )?;
            connection
                .pragma_update(
                    None,
                    "user_version",
                    EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                )
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v43-user-version",
                        EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            run_schema_stage(
                "drop-run-private-save-as-operation",
                RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("experiment_run_manuscript_save_as_operations"),
                || {
                    connection.execute_batch(
                        "DROP TABLE experiment_run_manuscript_save_as_operations;
                         INSERT OR IGNORE INTO schema_migrations(version,name)
                         VALUES (44,'drop_run_private_save_as_operations');",
                    )
                },
            )?;
            connection
                .pragma_update(
                    None,
                    "user_version",
                    RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                )
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v44-user-version",
                        RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v42-to-v43-transaction-commit",
            EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    if source_user_version == MANUSCRIPT_PROVISIONING_DURABLE_STEP_PROGRESS_SCHEMA_VERSION {
        let source_current =
            super::manuscript_provisioning_operation_state::step_progress_schema::
                validate_provisioning_contract(connection)
                    .map_err(|error| {
                        schema_error(
                            "source-schema-invalid",
                            "v41-to-v42-source-validator",
                            MANUSCRIPT_PROVISIONING_DURABLE_STEP_PROGRESS_SCHEMA_VERSION,
                            None,
                            error.to_string(),
                        )
                    })?;
        if !source_current {
            return Err(schema_error(
                "source-schema-invalid",
                "v41-to-v42-source-validator",
                MANUSCRIPT_PROVISIONING_DURABLE_STEP_PROGRESS_SCHEMA_VERSION,
                None,
                "v41 source failed exact validation",
            ));
        }
        run_schema_stage(
            "v41-to-v42-transaction-begin",
            CURRENT_SCHEMA_VERSION,
            None,
            || connection.execute_batch("BEGIN IMMEDIATE;"),
        )?;
        let upgrade = (|| -> SchemaResult<()> {
            run_schema_stage(
                "typed-owner-neutral-manuscript-save-as-operation",
                MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                || super::manuscript_save_as_operation::apply_schema_migration(connection),
            )?;
            run_schema_stage(
                "drop-experiment-private-save-as-operation",
                EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("experiment_manuscript_save_as_operations"),
                || {
                    connection.execute_batch(
                        "DROP TABLE experiment_manuscript_save_as_operations;
                         INSERT OR IGNORE INTO schema_migrations(version,name)
                         VALUES (43,'drop_experiment_private_save_as_operations');",
                    )
                },
            )?;
            run_schema_stage(
                "drop-run-private-save-as-operation",
                RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
                Some("experiment_run_manuscript_save_as_operations"),
                || {
                    connection.execute_batch(
                        "DROP TABLE experiment_run_manuscript_save_as_operations;
                         INSERT OR IGNORE INTO schema_migrations(version,name)
                         VALUES (44,'drop_run_private_save_as_operations');",
                    )
                },
            )?;
            run_schema_stage(
                "save-as-j0-invariants-and-deterministic-recovery-order",
                SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                || {
                    super::manuscript_save_as_operation::apply_deterministic_ordering_migration(
                        connection,
                    )
                },
            )?;
            run_schema_stage(
                "save-as-candidate-custody-receipt-and-exact-cleanup",
                SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                Some("manuscript_save_as_candidate_custody"),
                || {
                    super::manuscript_save_as_candidate_custody::apply_schema_migration(
                        connection,
                    )
                },
            )?;
            connection
                .pragma_update(None, "user_version", EXPERIMENT_SIX_FIELD_SCHEMA_VERSION)
                .map_err(|error| {
                    schema_error(
                        "migration-failed",
                        "v42-user-version",
                        EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
                        None,
                        error.to_string(),
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = upgrade {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        run_schema_stage(
            "v41-to-v42-transaction-commit",
            EXPERIMENT_SIX_FIELD_SCHEMA_VERSION,
            None,
            || connection.execute_batch("COMMIT;"),
        )?;
        return run_migrations(connection);
    }
    run_schema_stage("transaction-begin", CURRENT_SCHEMA_VERSION, None, || {
        connection.execute_batch("BEGIN IMMEDIATE;")
    })?;

    let result = (|| -> SchemaResult<()> {
        run_schema_stage(
            "review-permanent-delete-guard-replay-suspension",
            REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
            None,
            || {
                super::review_permanent_delete::suspend_terminal_guards_for_historical_replay(
                    connection,
                )
            },
        )?;
        run_schema_stage("initial-schema", INITIAL_SCHEMA_VERSION, None, || {
            connection.execute_batch(INITIAL_SCHEMA_SQL)
        })?;
        run_schema_stage("legacy-output-gap-repair", 11, Some("output_gaps"), || {
            repair_legacy_output_gaps_table(connection)
        })?;
        run_schema_stage("legacy-output-conversion-repair", 11, None, || {
            repair_legacy_output_conversion_tables(connection)
        })?;
        run_schema_stage(
            "experiment-schema",
            EXPERIMENT_DATA_SCHEMA_VERSION,
            None,
            || apply_experiment_data_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-conversion-schema",
            OUTPUT_CONVERSION_SCHEMA_VERSION,
            None,
            || apply_output_conversion_schema_migration(connection),
        )?;
        run_schema_stage(
            "literature-schema",
            LITERATURE_DATA_SCHEMA_VERSION,
            Some("literatures"),
            || apply_literature_data_schema_migration(connection),
        )?;
        run_schema_stage(
            "formal-output-schema",
            FORMAL_OUTPUT_CONTRACT_SCHEMA_VERSION,
            Some("outputs"),
            || apply_formal_output_contract_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-gap-closure-schema",
            OUTPUT_GAP_CLOSURE_SCHEMA_VERSION,
            Some("output_gaps"),
            || apply_output_gap_closure_schema_migration(connection),
        )?;
        run_schema_stage(
            "operation-audit-schema",
            OPERATION_AUDIT_SCHEMA_VERSION,
            None,
            || apply_operation_audit_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-five-layer-schema",
            OUTPUT_FIVE_LAYER_CONTRACT_SCHEMA_VERSION,
            None,
            || apply_output_five_layer_contract_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-relation-schema",
            OUTPUT_CONVERSION_RELATION_SCHEMA_VERSION,
            None,
            || apply_output_conversion_relation_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-file-ref-schema",
            OUTPUT_FILE_REF_CONTRACT_SCHEMA_VERSION,
            Some("file_refs"),
            || apply_output_file_ref_contract_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-source-link-schema",
            OUTPUT_SOURCE_LINK_SCHEMA_VERSION,
            None,
            || apply_output_source_link_schema_migration(connection),
        )?;
        run_schema_stage(
            "output-gap-feedback-schema",
            OUTPUT_GAP_FEEDBACK_CARD_SCHEMA_VERSION,
            None,
            || apply_output_gap_feedback_card_schema_migration(connection),
        )?;
        run_schema_stage(
            "research-trace-schema",
            RESEARCH_TRACE_EVENT_PREFERENCE_SCHEMA_VERSION,
            None,
            || apply_research_trace_event_preference_schema_migration(connection),
        )?;
        run_schema_stage(
            "file-identity-binding-schema",
            FILE_IDENTITY_BINDING_SCHEMA_VERSION,
            Some("manuscript_bindings"),
            || apply_file_identity_binding_schema_migration(connection),
        )?;
        run_schema_stage(
            "managed-root-schema",
            MANAGED_ROOT_SETTING_SCHEMA_VERSION,
            Some("managed_root_settings"),
            || apply_managed_root_setting_schema_migration(connection),
        )?;
        run_schema_stage(
            "manuscript-channel-schema",
            MANUSCRIPT_CHANNEL_SCHEMA_VERSION,
            Some("manuscript_bindings"),
            || apply_manuscript_channel_schema_migration(connection),
        )?;
        run_schema_stage(
            "literature-channel-partial-repair",
            LITERATURE_CHANNEL_PARTIAL_REPAIR_SCHEMA_VERSION,
            Some("manuscript_bindings"),
            || apply_literature_channel_partial_repair_migration(connection),
        )?;
        run_schema_stage(
            "literature-candidate-metadata",
            LITERATURE_CANDIDATE_METADATA_SCHEMA_VERSION,
            Some("file_refs"),
            || apply_literature_candidate_metadata_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-business-model",
            EXPERIMENT_BUSINESS_MODEL_SCHEMA_VERSION,
            Some("experiment_runs"),
            || apply_experiment_business_model_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-created-local-time",
            EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION,
            Some("experiments"),
            || apply_experiment_created_local_time_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-workspace-title-identity",
            EXPERIMENT_WORKSPACE_TITLE_IDENTITY_SCHEMA_VERSION,
            Some("experiments"),
            || apply_experiment_workspace_title_identity_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-provisioning-identity",
            EXPERIMENT_PROVISIONING_IDENTITY_SCHEMA_VERSION,
            Some("file_refs"),
            || apply_experiment_provisioning_identity_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-run-provisioning-identity",
            EXPERIMENT_RUN_PROVISIONING_IDENTITY_SCHEMA_VERSION,
            Some("file_refs"),
            || apply_experiment_run_provisioning_identity_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-representative-run",
            EXPERIMENT_REPRESENTATIVE_RUN_SCHEMA_VERSION,
            Some("experiment_representative_runs"),
            || apply_experiment_representative_run_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-file-body-single-source",
            EXPERIMENT_FILE_BODY_SINGLE_SOURCE_SCHEMA_VERSION,
            Some("experiments"),
            || apply_experiment_file_body_single_source_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-workspace-identity-enforcement",
            EXPERIMENT_WORKSPACE_IDENTITY_ENFORCEMENT_SCHEMA_VERSION,
            Some("experiments"),
            || apply_experiment_workspace_identity_enforcement_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-shared-open-file-ref-identity",
            EXPERIMENT_SHARED_OPEN_FILE_REF_IDENTITY_SCHEMA_VERSION,
            Some("file_refs"),
            || apply_experiment_shared_open_file_ref_identity_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-run-multi-manuscript-identity",
            EXPERIMENT_RUN_MULTI_MANUSCRIPT_IDENTITY_SCHEMA_VERSION,
            Some("file_refs"),
            || apply_experiment_run_multi_manuscript_identity_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-run-switch-durable-recovery",
            EXPERIMENT_RUN_SWITCH_DURABLE_RECOVERY_SCHEMA_VERSION,
            Some("experiment_run_manuscript_switch_recoveries"),
            || connection.execute_batch(super::experiment_run_manuscript_switch_recovery::RECOVERY_SCHEMA_SQL),
        )?;
        run_schema_stage(
            "experiment-run-save-as-durable-operation",
            EXPERIMENT_RUN_SAVE_AS_DURABLE_OPERATION_SCHEMA_VERSION,
            Some("experiment_run_manuscript_save_as_operations"),
            || connection.execute_batch(LEGACY_RUN_PRIVATE_SAVE_AS_SCHEMA_SQL),
        )?;
        run_schema_stage(
            "experiment-run-switch-context-snapshot",
            EXPERIMENT_RUN_SWITCH_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
            Some("experiment_run_manuscript_switch_recoveries"),
            || apply_experiment_run_switch_context_snapshot_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-run-switch-canonical-writeback",
            EXPERIMENT_RUN_SWITCH_CANONICAL_WRITEBACK_SCHEMA_VERSION,
            Some("experiment_run_manuscript_switch_recoveries"),
            || apply_experiment_run_switch_canonical_writeback_schema_migration(connection),
        )?;
        run_schema_stage(
            "experiment-manuscript-final-convergence",
            EXPERIMENT_MANUSCRIPT_FINAL_CONVERGENCE_SCHEMA_VERSION,
            Some("experiment_manuscript_save_as_operations"),
            || connection.execute_batch(LEGACY_EXPERIMENT_PRIVATE_SAVE_AS_SCHEMA_SQL),
        )?;
        run_schema_stage(
            "experiment-manuscript-canonical-recovery-schema",
            EXPERIMENT_MANUSCRIPT_CANONICAL_RECOVERY_SCHEMA_VERSION,
            Some("experiment_manuscript_switch_recoveries"),
            || connection.execute_batch(super::experiment_manuscript_switch_recovery::RECOVERY_SCHEMA_SQL),
        )?;
        run_schema_stage(
            "experiment-manuscript-legacy-recovery-reconciliation",
            EXPERIMENT_MANUSCRIPT_CANONICAL_RECOVERY_SCHEMA_VERSION,
            Some("experiment_manuscript_switch_recoveries"),
            || super::experiment_manuscript_switch_recovery::migrate_legacy_experiment_switch_recoveries_in_connection(connection),
        )?;
        run_schema_stage(
            "experiment-title-purpose-sentinel-cleanup",
            EXPERIMENT_GENERATED_FIELD_RECONCILIATION_SCHEMA_VERSION,
            Some("experiments"),
            || apply_experiment_generated_field_reconciliation_schema_migration(connection),
        )?;
        run_schema_stage(
            "manuscript-provisioning-operation-state",
            MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
            Some("manuscript_provisioning_operation_attempts"),
            || {
                if source_user_version < MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION {
                    super::manuscript_provisioning_operation_state::apply_schema_migration(
                        connection,
                    )?;
                }
                Ok(())
            },
        )?;
        let v40_current =
            super::manuscript_provisioning_operation_state::validate_v40_schema(connection)
                .map_err(|error| {
                    schema_error(
                        "source-schema-invalid",
                        "manuscript-provisioning-v40-source-validator",
                        MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
                        Some("manuscript_provisioning_operation_attempts"),
                        error.to_string(),
                    )
                })?;
        if !v40_current {
            return Err(schema_error(
                "source-schema-invalid",
                "manuscript-provisioning-v40-source-validator",
                MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
                Some("manuscript_provisioning_operation_attempts"),
                "v40 provisioning operation-state schema is invalid",
            ));
        }
        run_schema_stage(
            "manuscript-provisioning-v40-source-version",
            MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
            None,
            || {
                connection.pragma_update(
                    None,
                    "user_version",
                    MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
                )
            },
        )?;
        super::manuscript_provisioning_operation_state::step_progress_schema::
            apply_v41_in_transaction(connection)
            .map_err(|error| {
                schema_error(
                    error.code,
                    error.stage,
                    MANUSCRIPT_PROVISIONING_DURABLE_STEP_PROGRESS_SCHEMA_VERSION,
                    None,
                    "v41 durable step progress migration rejected",
                )
            })?;
            run_schema_stage(
                "typed-owner-neutral-manuscript-save-as-operation",
                MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION,
            Some("manuscript_save_as_operations"),
            || super::manuscript_save_as_operation::apply_schema_migration(connection),
        )?;
        run_schema_stage(
            "drop-experiment-private-save-as-operation",
            EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            Some("experiment_manuscript_save_as_operations"),
            || {
                connection.execute_batch(
                    "DROP TABLE experiment_manuscript_save_as_operations;
                     INSERT OR IGNORE INTO schema_migrations(version,name)
                     VALUES (43,'drop_experiment_private_save_as_operations');",
                )
            },
        )?;
        run_schema_stage(
            "drop-run-private-save-as-operation",
            RUN_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            Some("experiment_run_manuscript_save_as_operations"),
            || {
                connection.execute_batch(
                    "DROP TABLE experiment_run_manuscript_save_as_operations;
                     INSERT OR IGNORE INTO schema_migrations(version,name)
                     VALUES (44,'drop_run_private_save_as_operations');",
                )
            },
        )?;
        run_schema_stage(
            "save-as-j0-invariants-and-deterministic-recovery-order",
            SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
            Some("manuscript_save_as_operations"),
            || {
                super::manuscript_save_as_operation::apply_deterministic_ordering_migration(
                    connection,
                )
            },
        )?;
        run_schema_stage(
            "save-as-candidate-custody-receipt-and-exact-cleanup",
            SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
            Some("manuscript_save_as_candidate_custody"),
            || {
                super::manuscript_save_as_candidate_custody::apply_schema_migration(
                    connection,
                )
            },
        )?;
        run_schema_stage(
            "save-as-lifecycle-finalization-atomicity",
            SAVE_AS_FINALIZATION_SCHEMA_VERSION,
            Some("manuscript_save_as_finalizations"),
            || {
                super::manuscript_save_as_finalization::apply_schema_migration(
                    connection,
                )
            },
        )?;
        run_schema_stage(
            "review-lifecycle-durable-action-authority",
            REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
            Some("review_lifecycle_actions"),
            || {
                if source_user_version < REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION {
                    super::review_lifecycle_action::apply_schema_migration(connection)
                } else {
                    Ok(())
                }
            },
        )?;
        run_schema_stage(
            "review-permanent-delete-durable-authority-foundation",
            REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
            Some("review_lifecycle_actions"),
            || {
                if source_user_version < REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION {
                    super::review_permanent_delete::apply_schema_migration(connection)
                } else {
                    Ok(())
                }
            },
        )?;
        apply_experiment_six_field_foundation(connection)?;
        apply_formal_switch_foundation(connection)?;
        apply_review_structured_state_foundation(connection)?;
        apply_ai_durable_foundation(connection)?;
        apply_ai_attachment_authorization_foundation(connection)?;
        apply_ai_context_request_foundation(connection)?;
        apply_ai_standard_result_foundation(connection)?;
        run_schema_stage("v59-fresh-relation-contract", CURRENT_SCHEMA_VERSION, Some("experiments"), || {
            super::experiment_planning_relation::apply(connection)
        })?;
        validate_current_schema(connection)?;
        run_schema_stage(
            "experiment-created-local-time-foreign-key-release",
            EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION,
            Some("experiments"),
            || connection.execute_batch("PRAGMA defer_foreign_keys = OFF;"),
        )?;
        run_schema_stage("schema-version", CURRENT_SCHEMA_VERSION, None, || {
            connection.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
        })?;
        validate_user_version(connection)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            run_schema_stage("transaction-commit", CURRENT_SCHEMA_VERSION, None, || {
                connection.execute_batch("COMMIT;")
            })?;
            let target_current =
                super::manuscript_provisioning_operation_state::step_progress_schema::
                    validate_provisioning_contract(connection)
                    .map_err(|error| {
                        schema_error(
                            "target-schema-invalid",
                            "post-commit-provisioning-contract-validator",
                            CURRENT_SCHEMA_VERSION,
                            None,
                            error.to_string(),
                        )
                    })?;
            if !target_current {
                return Err(schema_error(
                    "target-schema-invalid",
                    "post-commit-provisioning-contract-validator",
                    CURRENT_SCHEMA_VERSION,
                    None,
                    "committed provisioning contract failed exact validation",
                ));
            }
            let save_as_current =
                super::manuscript_save_as_operation::schema_is_current(connection).map_err(
                    |error| {
                        schema_error(
                            "target-schema-invalid",
                            "post-commit-v42-validator",
                            CURRENT_SCHEMA_VERSION,
                            Some("manuscript_save_as_operations"),
                            error.to_string(),
                        )
                    },
                )?;
            if !save_as_current {
                return Err(schema_error(
                    "target-schema-invalid",
                    "post-commit-v42-validator",
                    CURRENT_SCHEMA_VERSION,
                    Some("manuscript_save_as_operations"),
                    "committed v42 typed Save As operation schema failed exact validation",
                ));
            }
            Ok(())
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

const MANAGED_ROOT_SETTING_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS managed_root_settings (
  id TEXT PRIMARY KEY CHECK (id = 'managed-root'),
  configured_root TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (18, 'managed_root_setting_schema');
"#;

fn apply_managed_root_setting_schema_migration(connection: &Connection) -> Result<()> {
    if table_exists(connection, "managed_root_settings")?
        && !managed_root_setting_schema_is_current(connection)?
    {
        connection.execute_batch("DROP TABLE managed_root_settings;")?;
    }
    connection.execute_batch(MANAGED_ROOT_SETTING_SCHEMA_SQL)
}

#[derive(Debug)]
struct TableColumnInfo {
    name: String,
    not_null: bool,
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table_name],
        |row| row.get(0),
    )
}

fn table_columns(connection: &Connection, table_name: &str) -> Result<Vec<TableColumnInfo>> {
    let pragma = format!("PRAGMA table_info({table_name})");
    let mut statement = connection.prepare(&pragma)?;
    let columns = statement.query_map([], |row| {
        Ok(TableColumnInfo {
            name: row.get(1)?,
            not_null: row.get::<_, i64>(3)? != 0,
        })
    })?;
    columns.collect()
}

fn table_sql(connection: &Connection, table_name: &str) -> Result<Option<String>> {
    let mut statement = connection
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1")?;
    let mut rows = statement.query([table_name])?;
    Ok(rows
        .next()?
        .and_then(|row| row.get::<_, Option<String>>(0).ok().flatten()))
}

fn table_has_exact_columns(
    connection: &Connection,
    table_name: &str,
    expected: &[&str],
) -> Result<bool> {
    if !table_exists(connection, table_name)? {
        return Ok(false);
    }
    let actual = table_columns(connection, table_name)?
        .into_iter()
        .map(|column| column.name)
        .collect::<HashSet<_>>();
    let expected = expected
        .iter()
        .map(|column| (*column).to_string())
        .collect::<HashSet<_>>();
    Ok(actual == expected)
}

fn managed_root_setting_schema_is_current(connection: &Connection) -> Result<bool> {
    if !table_has_exact_columns(
        connection,
        "managed_root_settings",
        &[
            "id",
            "configured_root",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
        ],
    )? {
        return Ok(false);
    }
    let normalized_sql = table_sql(connection, "managed_root_settings")?
        .unwrap_or_default()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<String>();
    Ok(normalized_sql.contains("check(id='managed-root')")
        && normalized_sql.contains("check(schema_version=1)"))
}

fn index_exists(connection: &Connection, index_name: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
        [index_name],
        |row| row.get(0),
    )
}

fn index_matches_contract(
    connection: &Connection,
    table_name: &str,
    index_name: &str,
    expected_columns: &[&str],
    expected_unique: bool,
) -> Result<bool> {
    let pragma = format!("PRAGMA index_list({table_name})");
    let mut statement = connection.prepare(&pragma)?;
    let indexes = statement.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0))
    })?;
    let mut actual_unique = None;
    for index in indexes {
        let (name, unique) = index?;
        if name == index_name {
            actual_unique = Some(unique);
            break;
        }
    }
    if actual_unique != Some(expected_unique) {
        return Ok(false);
    }

    let pragma = format!("PRAGMA index_info({index_name})");
    let mut statement = connection.prepare(&pragma)?;
    let columns = statement.query_map([], |row| row.get::<_, String>(2))?;
    let actual_columns = columns.collect::<Result<Vec<_>>>()?;
    Ok(actual_columns
        == expected_columns
            .iter()
            .map(|column| (*column).to_string())
            .collect::<Vec<_>>())
}

fn ensure_named_index(
    connection: &Connection,
    table_name: &str,
    index_name: &str,
    expected_columns: &[&str],
    expected_unique: bool,
    create_sql: &str,
) -> Result<()> {
    if index_exists(connection, index_name)?
        && !index_matches_contract(
            connection,
            table_name,
            index_name,
            expected_columns,
            expected_unique,
        )?
    {
        connection.execute_batch(&format!("DROP INDEX IF EXISTS {index_name};"))?;
    }
    connection.execute_batch(create_sql)
}

fn validate_current_schema(connection: &Connection) -> SchemaResult<()> {
    const REQUIRED_TABLES: &[&str] = &[
        "schema_migrations",
        "milestones",
        "tasks",
        "experiments",
        "experiment_runs",
        "experiment_representative_runs",
        "result_metrics",
        "file_refs",
        "manuscript_bindings",
        "manuscript_save_as_candidate_custody",
        "managed_root_settings",
        "literatures",
        "literature_links",
        "result_items",
        "findings",
        "output_candidates",
        "output_gaps",
        "outputs",
        "output_conversion_relations",
        "output_source_links",
        "output_gap_feedback_cards",
        "research_trace_event_preferences",
        "operation_logs",
        "recycle_entries",
        "review_lifecycle_actions",
        "review_structured_states",
        "experiment_run_manuscript_switch_recoveries",
        "experiment_manuscript_switch_recoveries",
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_literature_child_states",
        "manuscript_provisioning_audit_outbox",
        "manuscript_provisioning_step_plans",
        "manuscript_provisioning_step_progress",
        "manuscript_save_as_operations",
        "formal_switch_operations",
        "ai_conversations",
        "ai_messages",
        "ai_call_attempts",
        "ai_call_attempt_file_ref_authorizations",
    ];
    for &table in REQUIRED_TABLES {
        let exists = table_exists(connection, table).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "required-table-check",
                CURRENT_SCHEMA_VERSION,
                None,
                error.to_string(),
            )
        })?;
        if !exists {
            return Err(schema_error(
                "DB_REQUIRED_TABLE_MISSING",
                "required-table-check",
                CURRENT_SCHEMA_VERSION,
                Some(table),
                format!("required table is missing: {table}"),
            ));
        }
    }
    super::experiment_six_field_schema::validate_current_schema(connection).map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-six-field-column-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiments"),
            error.to_string(),
        )
    })?;
    if !super::formal_switch_foundation::schema_is_current(connection).map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "formal-switch-foundation-schema-check",
            CURRENT_SCHEMA_VERSION,
            Some("formal_switch_operations"),
            error,
        )
    })? {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "formal-switch-foundation-schema-check",
            CURRENT_SCHEMA_VERSION,
            Some("formal_switch_operations"),
            "v53 Formal Switch foundation schema is incomplete",
        ));
    }
    if !super::review_structured_state::schema_is_current(connection).map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "review-structured-state-schema-check",
            REVIEW_STRUCTURED_STATE_SCHEMA_VERSION,
            Some("review_structured_states"),
            error.to_string(),
        )
    })? {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "review-structured-state-schema-check",
            REVIEW_STRUCTURED_STATE_SCHEMA_VERSION,
            Some("review_structured_states"),
            "v54 Review structured-state canonical authority is incomplete",
        ));
    }
    if !super::ai_durable_foundation::schema_is_current(connection).map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "ai-durable-foundation-schema-check",
            AI_DURABLE_FOUNDATION_SCHEMA_VERSION,
            Some("ai_call_attempts"),
            error.to_string(),
        )
    })? {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "ai-durable-foundation-schema-check",
            AI_DURABLE_FOUNDATION_SCHEMA_VERSION,
            Some("ai_call_attempts"),
            "v55 Conversation / Message / CallAttempt durable authority is incomplete",
        ));
    }
    if !super::ai_durable_foundation::attachment_authorization_schema_is_current(connection)
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "ai-attachment-authorization-schema-check",
                AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION,
                Some("ai_call_attempt_file_ref_authorizations"),
                error.to_string(),
            )
        })?
    {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "ai-attachment-authorization-schema-check",
            AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION,
            Some("ai_call_attempt_file_ref_authorizations"),
            "v56 CallAttempt FileRef authorization authority is incomplete",
        ));
    }
    if !super::ai_durable_foundation::context_request_schema_is_current(connection)
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "ai-context-request-schema-check",
                AI_CONTEXT_REQUEST_SCHEMA_VERSION,
                Some("ai_context_requests"),
                error.to_string(),
            )
        })?
    {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "ai-context-request-schema-check",
            AI_CONTEXT_REQUEST_SCHEMA_VERSION,
            Some("ai_context_requests"),
            "v57 Same-Conversation Context Request authority is incomplete",
        ));
    }
    if !super::ai_durable_foundation::standard_result_schema_is_current(connection)
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "ai-standard-result-schema-check",
                AI_STANDARD_RESULT_SCHEMA_VERSION,
                Some("ai_standard_results"),
                error.to_string(),
            )
        })?
    {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "ai-standard-result-schema-check",
            AI_STANDARD_RESULT_SCHEMA_VERSION,
            Some("ai_standard_results"),
            "v58 Parse Draft / Standard Result durable authority is incomplete",
        ));
    }
    for removed_table in [
        "experiment_manuscript_save_as_operations",
        "experiment_run_manuscript_save_as_operations",
    ] {
    if table_exists(connection, removed_table)
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "removed-table-check",
                CURRENT_SCHEMA_VERSION,
                Some(removed_table),
                error.to_string(),
            )
        })?
    {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "removed-table-check",
            CURRENT_SCHEMA_VERSION,
            Some(removed_table),
            "removed owner-private Save As table is present",
        ));
    }
    }

    let recovery_columns = table_columns(
        connection,
        "experiment_run_manuscript_switch_recoveries",
    )
    .map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-run-switch-recovery-column-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiment_run_manuscript_switch_recoveries"),
            error.to_string(),
        )
    })?;
    let recovery_column_names = recovery_columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let recovery_schema = table_sql(
        connection,
        "experiment_run_manuscript_switch_recoveries",
    )
    .map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-run-switch-recovery-sql-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiment_run_manuscript_switch_recoveries"),
            error.to_string(),
        )
    })?
    .unwrap_or_default();
    let required_writeback_columns = [
        "deterministic_writeback_version",
        "writeback_digest",
        "writeback_byte_length",
        "writeback_verification_result",
    ];
    if recovery_column_names
        .iter()
        .any(|name| name.to_ascii_lowercase().contains("append"))
        || required_writeback_columns
            .iter()
            .any(|name| !recovery_column_names.contains(name))
        || recovery_schema.to_ascii_lowercase().contains("append")
        || !recovery_schema.contains("writeback_unknown")
        || !recovery_schema.contains("writeback_applied")
    {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-run-switch-recovery-canonical-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiment_run_manuscript_switch_recoveries"),
            "Run switch recovery schema is not canonical writeback-only",
        ));
    }

    let experiment_recovery_columns = table_columns(
        connection,
        "experiment_manuscript_switch_recoveries",
    )
    .map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-switch-recovery-column-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiment_manuscript_switch_recoveries"),
            error.to_string(),
        )
    })?;
    let experiment_recovery_column_names = experiment_recovery_columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let experiment_recovery_schema = table_sql(
        connection,
        "experiment_manuscript_switch_recoveries",
    )
    .map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-switch-recovery-sql-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiment_manuscript_switch_recoveries"),
            error.to_string(),
        )
    })?
    .unwrap_or_default();
    let required_experiment_recovery_columns = [
        "operation_id", "experiment_id", "manuscript_channel", "phase", "binding_id",
        "outline_replacements_json", "deterministic_writeback_version", "writeback_digest",
        "writeback_byte_length", "writeback_verification_result", "target_physical_revision",
    ];
    let lower_experiment_recovery_schema = experiment_recovery_schema.to_ascii_lowercase();
    if experiment_recovery_column_names
        .iter()
        .any(|name| name.to_ascii_lowercase().contains("append"))
        || required_experiment_recovery_columns
            .iter()
            .any(|name| !experiment_recovery_column_names.contains(name))
        || lower_experiment_recovery_schema.contains("append")
        || !lower_experiment_recovery_schema.contains("operation_id text primary key")
        || !experiment_recovery_schema.contains("writeback_unknown")
        || !experiment_recovery_schema.contains("writeback_applied")
        || !experiment_recovery_schema.contains("cancelled_safe")
    {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "experiment-switch-recovery-canonical-check",
            CURRENT_SCHEMA_VERSION,
            Some("experiment_manuscript_switch_recoveries"),
            "Experiment switch recovery schema is not canonical writeback-only",
        ));
    }

    let binding_current = manuscript_channel_schema_is_current(connection).map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "manuscript-binding-check",
            MANUSCRIPT_CHANNEL_SCHEMA_VERSION,
            Some("manuscript_bindings"),
            error.to_string(),
        )
    })?;
    if !binding_current {
        return Err(schema_error(
            "DB_REQUIRED_COLUMN_MISSING",
            "manuscript-binding-check",
            MANUSCRIPT_CHANNEL_SCHEMA_VERSION,
            Some("manuscript_bindings"),
            "manuscript binding channel columns, owner/channel uniqueness, or FileRef foreign keys are invalid",
        ));
    }
    if !column_exists(connection, "file_refs", "manuscript_channel").map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "file-ref-channel-check",
            MANUSCRIPT_CHANNEL_SCHEMA_VERSION,
            Some("file_refs"),
            error.to_string(),
        )
    })? {
        return Err(schema_error(
            "DB_REQUIRED_COLUMN_MISSING",
            "file-ref-channel-check",
            MANUSCRIPT_CHANNEL_SCHEMA_VERSION,
            Some("file_refs"),
            "file_refs.manuscript_channel is missing",
        ));
    }
    for column in ["candidate_request_id", "candidate_occurred_at"] {
        if !column_exists(connection, "file_refs", column).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "candidate-file-ref-metadata-check",
                LITERATURE_CANDIDATE_METADATA_SCHEMA_VERSION,
                Some("file_refs"),
                error.to_string(),
            )
        })? {
            return Err(schema_error(
                "DB_REQUIRED_COLUMN_MISSING",
                "candidate-file-ref-metadata-check",
                LITERATURE_CANDIDATE_METADATA_SCHEMA_VERSION,
                Some("file_refs"),
                format!("file_refs.{column} is missing"),
            ));
        }
    }
    for (table, column) in [
        ("experiments", "other"),
        ("experiment_runs", "variable_parameter_summary"),
        ("experiment_runs", "summary_other"),
    ] {
        if !column_exists(connection, table, column).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "experiment-business-model-check",
                EXPERIMENT_BUSINESS_MODEL_SCHEMA_VERSION,
                Some(table),
                error.to_string(),
            )
        })? {
            return Err(schema_error(
                "DB_REQUIRED_COLUMN_MISSING",
                "experiment-business-model-check",
                EXPERIMENT_BUSINESS_MODEL_SCHEMA_VERSION,
                Some(table),
                format!("{table}.{column} is missing"),
            ));
        }
    }
    for table in ["experiments", "experiment_runs"] {
        let column = "workspace_title_identity";
        let required = column_exists(connection, table, column)
            .and_then(|exists| {
                if exists {
                    column_is_not_null(connection, table, column)
                } else {
                    Ok(false)
                }
            })
            .map_err(|error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "experiment-workspace-title-identity-check",
                    EXPERIMENT_WORKSPACE_TITLE_IDENTITY_SCHEMA_VERSION,
                    Some(table),
                    error.to_string(),
                )
            })?;
        if !required {
            return Err(schema_error(
                "DB_REQUIRED_COLUMN_MISSING",
                "experiment-workspace-title-identity-check",
                EXPERIMENT_WORKSPACE_TITLE_IDENTITY_SCHEMA_VERSION,
                Some(table),
                format!("{table}.{column} must exist and be NOT NULL"),
            ));
        }
    }
    for (table, column) in [
        ("experiments", "created_local_date"),
        ("experiments", "created_local_time"),
        ("experiment_runs", "created_local_date"),
        ("experiment_runs", "created_local_time"),
    ] {
        let required = column_exists(connection, table, column)
            .and_then(|exists| {
                if exists {
                    column_is_not_null(connection, table, column)
                } else {
                    Ok(false)
                }
            })
            .map_err(|error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "experiment-created-local-time-check",
                    EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION,
                    Some(table),
                    error.to_string(),
                )
            })?;
        if !required {
            return Err(schema_error(
                "DB_REQUIRED_COLUMN_MISSING",
                "experiment-created-local-time-check",
                EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION,
                Some(table),
                format!("{table}.{column} must exist and be NOT NULL"),
            ));
        }
    }
    let invalid_literature_channels: i64 = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM file_refs
                WHERE owner_type = 'literature' AND file_role = 'manuscript'
                  AND manuscript_channel = 'primary')
               +
               (SELECT COUNT(*) FROM manuscript_bindings
                WHERE owner_type = 'literature' AND manuscript_channel = 'primary')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "literature-channel-data-check",
                LITERATURE_CHANNEL_PARTIAL_REPAIR_SCHEMA_VERSION,
                Some("manuscript_bindings"),
                error.to_string(),
            )
        })?;
    if invalid_literature_channels != 0 {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "literature-channel-data-check",
            LITERATURE_CHANNEL_PARTIAL_REPAIR_SCHEMA_VERSION,
            Some("manuscript_bindings"),
            "Literature manuscript FileRefs and bindings must not use primary",
        ));
    }

    let root_current = managed_root_setting_schema_is_current(connection).map_err(|error| {
        schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "managed-root-check",
            MANAGED_ROOT_SETTING_SCHEMA_VERSION,
            Some("managed_root_settings"),
            error.to_string(),
        )
    })?;
    if !root_current {
        return Err(schema_error(
            "DB_REQUIRED_COLUMN_MISSING",
            "managed-root-check",
            MANAGED_ROOT_SETTING_SCHEMA_VERSION,
            Some("managed_root_settings"),
            "managed root singleton schema is invalid",
        ));
    }

    for (table, index, columns, unique) in [
        (
            "file_refs",
            "idx_file_refs_identity",
            &[
                "owner_type",
                "owner_id",
                "manuscript_channel",
                "resource_kind",
                "file_role",
                "location_mode",
                "path_identity_key",
            ][..],
            true,
        ),
        (
            "file_refs",
            "idx_file_refs_experiment_default_folder_owner",
            &["owner_type", "owner_id"][..],
            true,
        ),
        (
            "file_refs",
            "idx_file_refs_experiment_run_default_folder_owner",
            &["owner_type", "owner_id"][..],
            true,
        ),
        (
            "manuscript_bindings",
            "idx_manuscript_bindings_default_folder",
            &["default_folder_file_ref_id"][..],
            false,
        ),
        (
            "file_refs",
            "idx_file_refs_candidate_request",
            &["owner_type", "owner_id", "candidate_request_id"][..],
            true,
        ),
        (
            "manuscript_bindings",
            "idx_manuscript_bindings_default_manuscript",
            &["default_manuscript_file_ref_id"][..],
            false,
        ),
        (
            "manuscript_bindings",
            "idx_manuscript_bindings_current",
            &["current_file_ref_id"][..],
            false,
        ),
    ] {
        let valid =
            index_matches_contract(connection, table, index, columns, unique).map_err(|error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "required-index-check",
                    CURRENT_SCHEMA_VERSION,
                    Some("manuscript_bindings"),
                    error.to_string(),
                )
            })?;
        if !valid {
            return Err(schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "required-index-check",
                CURRENT_SCHEMA_VERSION,
                Some("manuscript_bindings"),
                format!("required index is missing or malformed: {index}"),
            ));
        }
    }
    for (index, owner_label) in [
        ("idx_file_refs_experiment_managed_manuscript_owner", "Experiment"),
        (
            "idx_file_refs_experiment_run_managed_manuscript_owner",
            "ExperimentRun",
        ),
    ] {
        if index_exists(connection, index).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "obsolete-index-check",
                CURRENT_SCHEMA_VERSION,
                Some("file_refs"),
                error.to_string(),
            )
        })? {
            return Err(schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "obsolete-index-check",
                CURRENT_SCHEMA_VERSION,
                Some("file_refs"),
                format!("obsolete {owner_label} per-owner manuscript index still exists"),
            ));
        }
    }

    let foreign_key_violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "foreign-key-check",
                CURRENT_SCHEMA_VERSION,
                None,
                error.to_string(),
            )
        })?;
    if foreign_key_violations != 0 {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "foreign-key-check",
            CURRENT_SCHEMA_VERSION,
            None,
            format!("SQLite foreign_key_check found {foreign_key_violations} violation(s)"),
        ));
    }

    let foreign_keys_enabled: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "foreign-key-check",
                CURRENT_SCHEMA_VERSION,
                None,
                error.to_string(),
            )
        })?;
    if foreign_keys_enabled != 1 {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "foreign-key-check",
            CURRENT_SCHEMA_VERSION,
            None,
            "SQLite foreign_keys pragma is not enabled",
        ));
    }

    let provisioning_state_current =
        super::manuscript_provisioning_operation_state::step_progress_schema::
            validate_provisioning_contract(connection)
        .map_err(
            |error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "manuscript-provisioning-operation-state-check",
                    MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
                    Some("manuscript_provisioning_operation_attempts"),
                    error.to_string(),
                )
            },
        )?;
    if !provisioning_state_current {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "manuscript-provisioning-operation-state-check",
            MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
            Some("manuscript_provisioning_operation_attempts"),
            "Provisioning operation-state table, column, index, or ledger contract is invalid",
        ));
    }

    let save_as_operation_current =
        super::manuscript_save_as_operation::schema_is_current(connection).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "manuscript-save-as-operation-check",
                SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
                Some("manuscript_save_as_operations"),
                error.to_string(),
            )
        })?;
    if !save_as_operation_current {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "manuscript-save-as-operation-check",
            SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
            Some("manuscript_save_as_operations"),
            "Typed owner-neutral Save As operation table or index contract is invalid",
        ));
    }
    let candidate_custody_current =
        super::manuscript_save_as_candidate_custody::schema_is_current(connection).map_err(
            |error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "manuscript-save-as-candidate-custody-check",
                    SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
                    Some("manuscript_save_as_candidate_custody"),
                    error.to_string(),
                )
            },
        )?;
    if !candidate_custody_current {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "manuscript-save-as-candidate-custody-check",
            SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
            Some("manuscript_save_as_candidate_custody"),
            "Candidate custody receipt table or index contract is invalid",
        ));
    }
    let finalization_current =
        super::manuscript_save_as_finalization::schema_is_current(connection).map_err(
            |error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "manuscript-save-as-finalization-check",
                    SAVE_AS_FINALIZATION_SCHEMA_VERSION,
                    Some("manuscript_save_as_finalizations"),
                    error.to_string(),
                )
            },
        )?;
    if !finalization_current {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "manuscript-save-as-finalization-check",
            SAVE_AS_FINALIZATION_SCHEMA_VERSION,
            Some("manuscript_save_as_finalizations"),
            "Save As finalization request/decision/claim contract is invalid",
        ));
    }

    let review_lifecycle_current =
        super::review_lifecycle_action::schema_is_current(connection).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "review-lifecycle-action-check",
                REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                error.to_string(),
            )
        })?;
    if !review_lifecycle_current {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "review-lifecycle-action-check",
            REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
            Some("review_lifecycle_actions"),
            "Review lifecycle action/effect schema contract is invalid",
        ));
    }
    let review_permanent_delete_current =
        super::review_permanent_delete::schema_is_current(connection).map_err(|error| {
            schema_error(
                "DB_SCHEMA_INVARIANT_FAILED",
                "review-permanent-delete-foundation-check",
                REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
                Some("review_lifecycle_actions"),
                error.to_string(),
            )
        })?;
    if !review_permanent_delete_current {
        return Err(schema_error(
            "DB_SCHEMA_INVARIANT_FAILED",
            "review-permanent-delete-foundation-check",
            REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
            Some("review_lifecycle_actions"),
            "Review permanent-delete durable authority foundation is invalid",
        ));
    }

    for version in [
        FILE_IDENTITY_BINDING_SCHEMA_VERSION,
        MANAGED_ROOT_SETTING_SCHEMA_VERSION,
        MANUSCRIPT_CHANNEL_SCHEMA_VERSION,
        LITERATURE_CHANNEL_PARTIAL_REPAIR_SCHEMA_VERSION,
        LITERATURE_CANDIDATE_METADATA_SCHEMA_VERSION,
        EXPERIMENT_BUSINESS_MODEL_SCHEMA_VERSION,
        EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION,
        EXPERIMENT_WORKSPACE_TITLE_IDENTITY_SCHEMA_VERSION,
        EXPERIMENT_PROVISIONING_IDENTITY_SCHEMA_VERSION,
        EXPERIMENT_RUN_PROVISIONING_IDENTITY_SCHEMA_VERSION,
        EXPERIMENT_REPRESENTATIVE_RUN_SCHEMA_VERSION,
        EXPERIMENT_FILE_BODY_SINGLE_SOURCE_SCHEMA_VERSION,
        EXPERIMENT_WORKSPACE_IDENTITY_ENFORCEMENT_SCHEMA_VERSION,
        EXPERIMENT_RUN_SWITCH_DURABLE_RECOVERY_SCHEMA_VERSION,
        EXPERIMENT_RUN_SWITCH_CANONICAL_WRITEBACK_SCHEMA_VERSION,
        EXPERIMENT_GENERATED_FIELD_RECONCILIATION_SCHEMA_VERSION,
        MANUSCRIPT_PROVISIONING_OPERATION_STATE_SCHEMA_VERSION,
        MANUSCRIPT_PROVISIONING_DURABLE_STEP_PROGRESS_SCHEMA_VERSION,
        MANUSCRIPT_SAVE_AS_OPERATION_SCHEMA_VERSION,
        SAVE_AS_J0_INVARIANTS_SCHEMA_VERSION,
        SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
        SAVE_AS_FINALIZATION_SCHEMA_VERSION,
        SAVE_AS_P4_EXACT_ACCEPTANCE_SCHEMA_VERSION,
        REVIEW_LIFECYCLE_ACTION_SCHEMA_VERSION,
        REVIEW_PERMANENT_DELETE_FOUNDATION_SCHEMA_VERSION,
        FORMAL_SWITCH_FOUNDATION_SCHEMA_VERSION,
        REVIEW_STRUCTURED_STATE_SCHEMA_VERSION,
        AI_DURABLE_FOUNDATION_SCHEMA_VERSION,
        AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION,
        AI_CONTEXT_REQUEST_SCHEMA_VERSION,
        AI_STANDARD_RESULT_SCHEMA_VERSION,
    ] {
        let applied: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                [version],
                |row| row.get(0),
            )
            .map_err(|error| {
                schema_error(
                    "DB_SCHEMA_INVARIANT_FAILED",
                    "migration-marker-check",
                    version,
                    None,
                    error.to_string(),
                )
            })?;
        if applied != 1 {
            return Err(schema_error(
                "DB_SCHEMA_VERSION_INVALID",
                "migration-marker-check",
                version,
                None,
                format!("schema migration marker {version} is missing"),
            ));
        }
    }
    Ok(())
}

fn validate_user_version(connection: &Connection) -> SchemaResult<()> {
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| {
            schema_error(
                "DB_SCHEMA_VERSION_INVALID",
                "user-version-check",
                CURRENT_SCHEMA_VERSION,
                None,
                error.to_string(),
            )
        })?;
    if user_version != CURRENT_SCHEMA_VERSION {
        return Err(schema_error(
            "DB_SCHEMA_VERSION_INVALID",
            "user-version-check",
            CURRENT_SCHEMA_VERSION,
            None,
            format!("PRAGMA user_version is {user_version}, expected {CURRENT_SCHEMA_VERSION}"),
        ));
    }
    Ok(())
}

pub(crate) fn validate_global_schema_current(connection: &Connection) -> SchemaResult<()> {
    validate_current_schema(connection)?;
    validate_user_version(connection)
}

fn output_gaps_has_legacy_shape(connection: &Connection) -> Result<bool> {
    if !table_exists(connection, "output_gaps")? {
        return Ok(false);
    }

    let columns = table_columns(connection, "output_gaps")?;
    let column_names = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let expected_columns = OUTPUT_GAPS_CURRENT_COLUMNS
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let legacy_candidate_not_null = columns
        .iter()
        .any(|column| column.name == "output_candidate_id" && column.not_null);

    Ok(legacy_candidate_not_null
        || column_names.contains("output_candidate_id")
        || column_names.contains("resolved_by_result_item_id")
        || column_names != expected_columns)
}

fn table_matches_expected_plus_column(
    connection: &Connection,
    table_name: &str,
    expected_columns: &[&str],
    extra_column: &str,
) -> Result<bool> {
    if !table_exists(connection, table_name)? {
        return Ok(false);
    }
    let actual = table_columns(connection, table_name)?
        .into_iter()
        .map(|column| column.name)
        .collect::<HashSet<_>>();
    let mut expected = expected_columns
        .iter()
        .map(|column| (*column).to_string())
        .collect::<HashSet<_>>();
    expected.insert(extra_column.to_string());
    Ok(actual == expected)
}

fn drop_output_database_body_column(
    connection: &Connection,
    table_name: &str,
    expected_columns: &[&str],
) -> Result<bool> {
    if !table_matches_expected_plus_column(
        connection,
        table_name,
        expected_columns,
        "markdown_body",
    )? {
        return Ok(false);
    }
    connection.execute_batch(&format!(
        "ALTER TABLE {table_name} DROP COLUMN markdown_body;"
    ))?;
    Ok(true)
}

fn repair_legacy_output_gaps_table(connection: &Connection) -> Result<()> {
    if !output_gaps_has_legacy_shape(connection)? {
        return Ok(());
    }

    if drop_output_database_body_column(connection, "output_gaps", OUTPUT_GAPS_CURRENT_COLUMNS)? {
        return Ok(());
    }

    if table_exists(connection, "output_conversion_relations")? {
        connection.execute(
            "DELETE FROM output_conversion_relations
             WHERE source_type = 'outputGap' OR target_type = 'outputGap'",
            [],
        )?;
    }
    connection.execute_batch(OUTPUT_GAPS_DESTRUCTIVE_REBUILD_SQL)
}

struct OutputConversionTableRepair {
    table_name: &'static str,
    entity_type: Option<&'static str>,
    expected_columns: &'static [&'static str],
    rebuild_sql: &'static str,
}

fn table_has_legacy_shape(
    connection: &Connection,
    table_name: &str,
    expected_columns: &[&str],
) -> Result<bool> {
    if !table_exists(connection, table_name)? {
        return Ok(true);
    }

    let columns = table_columns(connection, table_name)?;
    let column_names = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let expected = expected_columns.iter().copied().collect::<HashSet<_>>();
    Ok(column_names != expected)
}

fn clear_relations_for_entity_type(connection: &Connection, entity_type: &str) -> Result<()> {
    if !table_exists(connection, "output_conversion_relations")? {
        return Ok(());
    }

    connection.execute(
        "DELETE FROM output_conversion_relations
         WHERE source_type = ?1 OR target_type = ?1",
        [entity_type],
    )?;
    Ok(())
}

fn repair_legacy_output_conversion_table(
    connection: &Connection,
    repair: &OutputConversionTableRepair,
) -> Result<()> {
    if !table_has_legacy_shape(connection, repair.table_name, repair.expected_columns)? {
        return Ok(());
    }

    if drop_output_database_body_column(connection, repair.table_name, repair.expected_columns)? {
        return Ok(());
    }

    if let Some(entity_type) = repair.entity_type {
        clear_relations_for_entity_type(connection, entity_type)?;
    }
    connection.execute_batch(repair.rebuild_sql)
}

fn repair_legacy_output_conversion_tables(connection: &Connection) -> Result<()> {
    for repair in OUTPUT_CONVERSION_TABLE_REPAIRS {
        repair_legacy_output_conversion_table(connection, repair)?;
    }
    Ok(())
}

fn column_exists(connection: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let pragma = format!("PRAGMA table_info({table_name})");
    let mut statement = connection.prepare(&pragma)?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;

    for column in columns {
        if column? == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn add_column_if_missing(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> Result<()> {
    if column_exists(connection, table_name, column_name)? {
        return Ok(());
    }

    let sql = format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}");
    connection.execute(&sql, [])?;
    Ok(())
}

fn apply_experiment_data_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [EXPERIMENT_DATA_SCHEMA_VERSION],
        |row| row.get(0),
    )?;

    if applied > 0 {
        return Ok(());
    }

    for (column_name, column_definition) in [
        ("route_id", "TEXT"),
        ("title", "TEXT"),
        ("purpose", "TEXT"),
        ("hypothesis", "TEXT"),
        ("research_question", "TEXT"),
        ("condition_summary", "TEXT"),
        ("method_summary", "TEXT"),
        ("conclusion", "TEXT"),
        ("status", "TEXT"),
        ("rating", "TEXT"),
        ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("usable_for_paper", "INTEGER NOT NULL DEFAULT 0"),
        ("usable_for_report", "INTEGER NOT NULL DEFAULT 0"),
        ("usable_for_patent", "INTEGER NOT NULL DEFAULT 0"),
        ("schema_version", "INTEGER NOT NULL DEFAULT 2"),
        ("source", "TEXT NOT NULL DEFAULT 'user'"),
        ("condition_items", "TEXT NOT NULL DEFAULT '[]'"),
        ("method_steps", "TEXT NOT NULL DEFAULT '[]'"),
        ("variables", "TEXT NOT NULL DEFAULT '[]'"),
        ("materials", "TEXT NOT NULL DEFAULT '[]'"),
        ("custom_fields", "TEXT NOT NULL DEFAULT '[]'"),
        ("legacy", "TEXT"),
        ("migrated_from_legacy", "INTEGER"),
    ] {
        add_column_if_missing(connection, "experiments", column_name, column_definition)?;
    }

    connection.execute_batch(EXPERIMENT_DATA_SCHEMA_SQL)?;
    Ok(())
}

fn apply_output_conversion_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch(OUTPUT_CONVERSION_SCHEMA_SQL)?;
    Ok(())
}

fn apply_literature_data_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch(LITERATURE_DATA_SCHEMA_SQL)?;
    Ok(())
}

fn apply_formal_output_contract_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [FORMAL_OUTPUT_CONTRACT_SCHEMA_VERSION],
        |row| row.get(0),
    )?;

    if applied > 0 {
        return Ok(());
    }

    add_column_if_missing(connection, "outputs", "provenance", "TEXT")?;
    connection.execute_batch(FORMAL_OUTPUT_CONTRACT_SCHEMA_SQL)?;
    Ok(())
}

fn apply_output_gap_closure_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [OUTPUT_GAP_CLOSURE_SCHEMA_VERSION],
        |row| row.get(0),
    )?;

    if applied > 0 {
        return Ok(());
    }

    add_column_if_missing(connection, "output_gaps", "related_route_node_id", "TEXT")?;
    connection.execute_batch(OUTPUT_GAP_CLOSURE_SCHEMA_SQL)?;
    Ok(())
}

fn apply_operation_audit_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch(OPERATION_AUDIT_SCHEMA_SQL)?;
    Ok(())
}

fn apply_output_five_layer_contract_schema_migration(connection: &Connection) -> Result<()> {
    // Run this repair even when version 11 is already recorded. Some development
    // databases were initialized before these OutputGap columns joined the contract.
    add_column_if_missing(
        connection,
        "output_gaps",
        "structured_summary",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [OUTPUT_FIVE_LAYER_CONTRACT_SCHEMA_VERSION],
        |row| row.get(0),
    )?;

    if applied > 0 {
        return Ok(());
    }

    add_column_if_missing(
        connection,
        "result_items",
        "status",
        "TEXT NOT NULL DEFAULT 'pending_review'",
    )?;
    add_column_if_missing(
        connection,
        "result_items",
        "structured_summary",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        connection,
        "findings",
        "status",
        "TEXT NOT NULL DEFAULT 'pending_confirmation'",
    )?;
    add_column_if_missing(
        connection,
        "findings",
        "structured_summary",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        connection,
        "output_candidates",
        "structured_summary",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        connection,
        "outputs",
        "status",
        "TEXT NOT NULL DEFAULT 'draft'",
    )?;
    add_column_if_missing(
        connection,
        "outputs",
        "structured_summary",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    connection.execute_batch(OUTPUT_FIVE_LAYER_CONTRACT_SCHEMA_SQL)?;
    Ok(())
}

fn apply_output_conversion_relation_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch(OUTPUT_CONVERSION_RELATION_SCHEMA_SQL)?;
    Ok(())
}

fn apply_output_file_ref_contract_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [OUTPUT_FILE_REF_CONTRACT_SCHEMA_VERSION],
        |row| row.get(0),
    )?;

    if applied > 0 {
        return Ok(());
    }

    if column_exists(connection, "outputs", "file_path")? {
        connection.execute_batch(
            r#"
CREATE TABLE IF NOT EXISTS outputs_without_file_path (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  experiment_id TEXT,
  output_name TEXT NOT NULL,
  output_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  usable_for_paper INTEGER NOT NULL DEFAULT 0 CHECK (usable_for_paper IN (0, 1)),
  description TEXT NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

INSERT INTO outputs_without_file_path (
  id, project_id, task_id, experiment_id, output_name, output_type, status,
  structured_summary, usable_for_paper, description, provenance,
  created_at, updated_at, deleted_at
)
SELECT
  id, project_id, task_id, experiment_id, output_name, output_type,
  COALESCE(status, 'draft'),
  COALESCE(structured_summary, '[]'),
  usable_for_paper, description, provenance, created_at, updated_at, deleted_at
FROM outputs;

DROP TABLE outputs;
ALTER TABLE outputs_without_file_path RENAME TO outputs;
"#,
        )?;
    }

    connection.execute_batch(OUTPUT_FILE_REF_CONTRACT_SCHEMA_SQL)?;
    Ok(())
}

fn apply_output_source_link_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [OUTPUT_SOURCE_LINK_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    connection.execute_batch(OUTPUT_SOURCE_LINK_SCHEMA_SQL)?;
    debug_assert!(applied >= 0);
    debug_assert_eq!(
        table_columns(connection, "output_source_links")?
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>(),
        OUTPUT_SOURCE_LINKS_CURRENT_COLUMNS
            .iter()
            .copied()
            .collect::<HashSet<_>>()
    );
    Ok(())
}

fn apply_output_gap_feedback_card_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [OUTPUT_GAP_FEEDBACK_CARD_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    connection.execute_batch(OUTPUT_GAP_FEEDBACK_CARD_SCHEMA_SQL)?;
    debug_assert!(applied >= 0);
    Ok(())
}

fn apply_research_trace_event_preference_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [RESEARCH_TRACE_EVENT_PREFERENCE_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    connection.execute_batch(RESEARCH_TRACE_EVENT_PREFERENCE_SCHEMA_SQL)?;
    debug_assert!(applied >= 0);
    debug_assert_eq!(
        table_columns(connection, "research_trace_event_preferences")?
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>(),
        RESEARCH_TRACE_EVENT_PREFERENCES_CURRENT_COLUMNS
            .iter()
            .copied()
            .collect::<HashSet<_>>()
    );
    Ok(())
}

const OPERATION_AUDIT_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS operation_logs (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  source TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  target TEXT NOT NULL,
  summary TEXT NOT NULL,
  related_entities TEXT NOT NULL DEFAULT '[]',
  impact_summary TEXT,
  confirmation TEXT,
  feedback TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  skipped TEXT NOT NULL DEFAULT '[]',
  is_recoverable INTEGER NOT NULL DEFAULT 0 CHECK (is_recoverable IN (0, 1)),
  recycle_entry_id TEXT,
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  refresh_keys TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS recycle_entries (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  module TEXT NOT NULL,
  entity_deleted_at TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  operation_log_id TEXT,
  can_restore INTEGER NOT NULL DEFAULT 0 CHECK (can_restore IN (0, 1)),
  cannot_restore_reason TEXT,
  known_impact_summary TEXT,
  restore_status TEXT NOT NULL,
  refresh_keys TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_operation_logs_status ON operation_logs(status);
CREATE INDEX IF NOT EXISTS idx_operation_logs_module ON operation_logs(module);
CREATE INDEX IF NOT EXISTS idx_operation_logs_deleted_at ON operation_logs(deleted_at);
CREATE INDEX IF NOT EXISTS idx_recycle_entries_entity ON recycle_entries(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_recycle_entries_entity_deleted_at ON recycle_entries(entity_deleted_at);
CREATE INDEX IF NOT EXISTS idx_recycle_entries_deleted_at ON recycle_entries(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (10, 'operation_audit_schema');
"#;

const OUTPUT_FIVE_LAYER_CONTRACT_SCHEMA_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_result_items_status ON result_items(status);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_outputs_status ON outputs(status);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (11, 'output_five_layer_contract_schema');
"#;

const OUTPUT_CONVERSION_RELATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS output_conversion_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  note TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_output_conversion_relations_source
  ON output_conversion_relations(source_type, source_id, relation_type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_output_conversion_relations_target
  ON output_conversion_relations(target_type, target_id, relation_type, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_output_conversion_relations_active_unique
  ON output_conversion_relations(source_type, source_id, target_type, target_id, relation_type)
  WHERE deleted_at IS NULL;

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (12, 'output_conversion_relation_schema');
"#;

const OUTPUT_FILE_REF_CONTRACT_SCHEMA_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_outputs_project_id ON outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_outputs_task_id ON outputs(task_id);
CREATE INDEX IF NOT EXISTS idx_outputs_experiment_id ON outputs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_outputs_status ON outputs(status);
CREATE INDEX IF NOT EXISTS idx_outputs_deleted_at ON outputs(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (13, 'output_file_ref_contract_schema');
"#;

const OUTPUT_SOURCE_LINK_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS output_source_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_title_snapshot TEXT NOT NULL,
  source_summary_snapshot TEXT,
  source_note TEXT,
  relation_type TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_output_source_links_owner
  ON output_source_links(owner_type, owner_id, order_index, deleted_at);
CREATE INDEX IF NOT EXISTS idx_output_source_links_source
  ON output_source_links(source_type, source_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_output_source_links_project_id
  ON output_source_links(project_id);
CREATE INDEX IF NOT EXISTS idx_output_source_links_deleted_at
  ON output_source_links(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (14, 'output_source_link_schema');
"#;

const OUTPUT_GAP_FEEDBACK_CARD_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS output_gap_feedback_cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  output_gap_id TEXT NOT NULL,
  card_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (output_gap_id) REFERENCES output_gaps(id)
);

CREATE INDEX IF NOT EXISTS idx_output_gap_feedback_cards_gap
  ON output_gap_feedback_cards(output_gap_id);
CREATE INDEX IF NOT EXISTS idx_output_gap_feedback_cards_project
  ON output_gap_feedback_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_output_gap_feedback_cards_type_status
  ON output_gap_feedback_cards(card_type, status);
CREATE INDEX IF NOT EXISTS idx_output_gap_feedback_cards_archived
  ON output_gap_feedback_cards(archived_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (15, 'output_gap_feedback_card_schema');
"#;

const RESEARCH_TRACE_EVENT_PREFERENCE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS research_trace_event_preferences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('auto', 'pinned', 'hidden')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_trace_event_preferences_target
  ON research_trace_event_preferences(project_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_research_trace_event_preferences_project
  ON research_trace_event_preferences(project_id);
CREATE INDEX IF NOT EXISTS idx_research_trace_event_preferences_deleted_at
  ON research_trace_event_preferences(deleted_at);
CREATE INDEX IF NOT EXISTS idx_research_trace_event_preferences_visibility
  ON research_trace_event_preferences(visibility);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (16, 'research_trace_event_preference_schema');
"#;

const EXPERIMENT_DATA_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  project_id TEXT,
  route_id TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  run_label TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  condition_summary TEXT,
  variable_parameter_summary TEXT,
  method_summary TEXT,
  result_summary TEXT,
  conclusion TEXT,
  summary_other TEXT,
  rating TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  condition_items TEXT NOT NULL DEFAULT '[]',
  method_steps TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]',
  materials TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  legacy TEXT,
  created_local_date TEXT NOT NULL CHECK (
    length(created_local_date) = 10
    AND created_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(created_local_date) = created_local_date
  ),
  created_local_time TEXT NOT NULL CHECK (
    length(created_local_time) = 4
    AND created_local_time GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(substr(created_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_local_time, 3, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE TABLE IF NOT EXISTS result_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  experiment_id TEXT,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  description TEXT,
  metric_group TEXT,
  higher_is_better INTEGER,
  value_type TEXT,
  baseline_value TEXT,
  target_value TEXT,
  order_index INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (run_id) REFERENCES experiment_runs(id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE TABLE IF NOT EXISTS file_refs (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  experiment_id TEXT,
  run_id TEXT,
  file_type TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_experiment_runs_experiment_id ON experiment_runs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_project_id ON experiment_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_result_metrics_run_id ON result_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_result_metrics_experiment_id ON result_metrics(experiment_id);
CREATE INDEX IF NOT EXISTS idx_file_refs_owner ON file_refs(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_file_refs_experiment_id ON file_refs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_file_refs_run_id ON file_refs(run_id);

CREATE INDEX IF NOT EXISTS idx_experiment_runs_deleted_at ON experiment_runs(deleted_at);
CREATE INDEX IF NOT EXISTS idx_result_metrics_deleted_at ON result_metrics(deleted_at);
CREATE INDEX IF NOT EXISTS idx_file_refs_deleted_at ON file_refs(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (5, 'experiment_data_standard_schema');
"#;

const OUTPUT_CONVERSION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS result_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  experiment_id TEXT,
  experiment_run_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  result_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  value_json TEXT,
  unit TEXT,
  file_ref_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_asset INTEGER NOT NULL DEFAULT 0,
  asset_marked_at TEXT,
  asset_reason TEXT,
  asset_quality TEXT,
  usable_for TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  FOREIGN KEY (experiment_run_id) REFERENCES experiment_runs(id),
  FOREIGN KEY (file_ref_id) REFERENCES file_refs(id)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  experiment_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  finding_type TEXT,
  confidence TEXT,
  maturity TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE TABLE IF NOT EXISTS output_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  candidate_type TEXT NOT NULL,
  status TEXT NOT NULL,
  structured_summary TEXT NOT NULL DEFAULT '[]',
  maturity TEXT,
  priority TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS output_gaps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  gap_type TEXT NOT NULL,
  status TEXT NOT NULL,
  structured_summary TEXT NOT NULL DEFAULT '[]',
  priority TEXT,
  related_task_id TEXT,
  related_route_node_id TEXT,
  resolved_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (related_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_result_items_project_id ON result_items(project_id);
CREATE INDEX IF NOT EXISTS idx_result_items_experiment_id ON result_items(experiment_id);
CREATE INDEX IF NOT EXISTS idx_result_items_experiment_run_id ON result_items(experiment_run_id);
CREATE INDEX IF NOT EXISTS idx_result_items_source ON result_items(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_result_items_is_asset ON result_items(is_asset);
CREATE INDEX IF NOT EXISTS idx_result_items_deleted_at ON result_items(deleted_at);

CREATE INDEX IF NOT EXISTS idx_findings_project_id ON findings(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_experiment_id ON findings(experiment_id);
CREATE INDEX IF NOT EXISTS idx_findings_deleted_at ON findings(deleted_at);

CREATE INDEX IF NOT EXISTS idx_output_candidates_project_id ON output_candidates(project_id);
CREATE INDEX IF NOT EXISTS idx_output_candidates_status ON output_candidates(status);
CREATE INDEX IF NOT EXISTS idx_output_candidates_candidate_type ON output_candidates(candidate_type);
CREATE INDEX IF NOT EXISTS idx_output_candidates_deleted_at ON output_candidates(deleted_at);

CREATE INDEX IF NOT EXISTS idx_output_gaps_project_id ON output_gaps(project_id);
CREATE INDEX IF NOT EXISTS idx_output_gaps_related_route_node_id ON output_gaps(related_route_node_id);
CREATE INDEX IF NOT EXISTS idx_output_gaps_status ON output_gaps(status);
CREATE INDEX IF NOT EXISTS idx_output_gaps_gap_type ON output_gaps(gap_type);
CREATE INDEX IF NOT EXISTS idx_output_gaps_deleted_at ON output_gaps(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (6, 'output_conversion_data_schema');
"#;

const OUTPUT_GAPS_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "title",
    "description",
    "gap_type",
    "status",
    "structured_summary",
    "priority",
    "related_task_id",
    "related_route_node_id",
    "resolved_at",
    "schema_version",
    "custom_fields",
    "created_at",
    "updated_at",
    "deleted_at",
];

const RESULT_ITEMS_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "route_id",
    "task_id",
    "experiment_id",
    "experiment_run_id",
    "source_type",
    "source_id",
    "title",
    "result_type",
    "status",
    "structured_summary",
    "summary",
    "value_json",
    "unit",
    "file_ref_id",
    "tags",
    "is_asset",
    "asset_marked_at",
    "asset_reason",
    "asset_quality",
    "usable_for",
    "schema_version",
    "custom_fields",
    "created_at",
    "updated_at",
    "deleted_at",
];

const FINDINGS_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "route_id",
    "task_id",
    "experiment_id",
    "title",
    "summary",
    "status",
    "structured_summary",
    "finding_type",
    "confidence",
    "maturity",
    "tags",
    "schema_version",
    "custom_fields",
    "created_at",
    "updated_at",
    "deleted_at",
];

const OUTPUT_CANDIDATES_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "route_id",
    "task_id",
    "title",
    "description",
    "candidate_type",
    "status",
    "structured_summary",
    "maturity",
    "priority",
    "tags",
    "schema_version",
    "custom_fields",
    "created_at",
    "updated_at",
    "deleted_at",
];

const OUTPUTS_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "task_id",
    "experiment_id",
    "output_name",
    "output_type",
    "status",
    "structured_summary",
    "usable_for_paper",
    "description",
    "provenance",
    "created_at",
    "updated_at",
    "deleted_at",
];

const OUTPUT_CONVERSION_RELATIONS_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "source_type",
    "source_id",
    "target_type",
    "target_id",
    "relation_type",
    "note",
    "schema_version",
    "created_at",
    "updated_at",
    "deleted_at",
];

const OUTPUT_SOURCE_LINKS_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "owner_type",
    "owner_id",
    "source_type",
    "source_id",
    "source_title_snapshot",
    "source_summary_snapshot",
    "source_note",
    "relation_type",
    "order_index",
    "schema_version",
    "created_at",
    "updated_at",
    "deleted_at",
];

const RESEARCH_TRACE_EVENT_PREFERENCES_CURRENT_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "target_type",
    "target_id",
    "visibility",
    "note",
    "created_at",
    "updated_at",
    "deleted_at",
];

const OUTPUT_GAPS_DESTRUCTIVE_REBUILD_SQL: &str = r#"
DROP TABLE IF EXISTS output_gaps;

CREATE TABLE output_gaps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  gap_type TEXT NOT NULL,
  status TEXT NOT NULL,
  structured_summary TEXT NOT NULL DEFAULT '[]',
  priority TEXT,
  related_task_id TEXT,
  related_route_node_id TEXT,
  resolved_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (related_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_output_gaps_project_id ON output_gaps(project_id);
CREATE INDEX IF NOT EXISTS idx_output_gaps_related_route_node_id ON output_gaps(related_route_node_id);
CREATE INDEX IF NOT EXISTS idx_output_gaps_status ON output_gaps(status);
CREATE INDEX IF NOT EXISTS idx_output_gaps_gap_type ON output_gaps(gap_type);
CREATE INDEX IF NOT EXISTS idx_output_gaps_deleted_at ON output_gaps(deleted_at);
"#;

const RESULT_ITEMS_DESTRUCTIVE_REBUILD_SQL: &str = r#"
DROP TABLE IF EXISTS result_items;

CREATE TABLE result_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  experiment_id TEXT,
  experiment_run_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  result_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  value_json TEXT,
  unit TEXT,
  file_ref_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_asset INTEGER NOT NULL DEFAULT 0,
  asset_marked_at TEXT,
  asset_reason TEXT,
  asset_quality TEXT,
  usable_for TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  FOREIGN KEY (experiment_run_id) REFERENCES experiment_runs(id),
  FOREIGN KEY (file_ref_id) REFERENCES file_refs(id)
);

CREATE INDEX IF NOT EXISTS idx_result_items_project_id ON result_items(project_id);
CREATE INDEX IF NOT EXISTS idx_result_items_experiment_id ON result_items(experiment_id);
CREATE INDEX IF NOT EXISTS idx_result_items_experiment_run_id ON result_items(experiment_run_id);
CREATE INDEX IF NOT EXISTS idx_result_items_source ON result_items(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_result_items_is_asset ON result_items(is_asset);
CREATE INDEX IF NOT EXISTS idx_result_items_status ON result_items(status);
CREATE INDEX IF NOT EXISTS idx_result_items_deleted_at ON result_items(deleted_at);
"#;

const FINDINGS_DESTRUCTIVE_REBUILD_SQL: &str = r#"
DROP TABLE IF EXISTS findings;

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  experiment_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  finding_type TEXT,
  confidence TEXT,
  maturity TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE INDEX IF NOT EXISTS idx_findings_project_id ON findings(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_experiment_id ON findings(experiment_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_deleted_at ON findings(deleted_at);
"#;

const OUTPUT_CANDIDATES_DESTRUCTIVE_REBUILD_SQL: &str = r#"
DROP TABLE IF EXISTS output_candidates;

CREATE TABLE output_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  candidate_type TEXT NOT NULL,
  status TEXT NOT NULL,
  structured_summary TEXT NOT NULL DEFAULT '[]',
  maturity TEXT,
  priority TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_output_candidates_project_id ON output_candidates(project_id);
CREATE INDEX IF NOT EXISTS idx_output_candidates_status ON output_candidates(status);
CREATE INDEX IF NOT EXISTS idx_output_candidates_candidate_type ON output_candidates(candidate_type);
CREATE INDEX IF NOT EXISTS idx_output_candidates_deleted_at ON output_candidates(deleted_at);
"#;

const OUTPUTS_DESTRUCTIVE_REBUILD_SQL: &str = r#"
DROP TABLE IF EXISTS outputs;

CREATE TABLE outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  experiment_id TEXT,
  output_name TEXT NOT NULL,
  output_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  structured_summary TEXT NOT NULL DEFAULT '[]',
  usable_for_paper INTEGER NOT NULL DEFAULT 0 CHECK (usable_for_paper IN (0, 1)),
  description TEXT NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE INDEX IF NOT EXISTS idx_outputs_project_id ON outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_outputs_task_id ON outputs(task_id);
CREATE INDEX IF NOT EXISTS idx_outputs_experiment_id ON outputs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_outputs_status ON outputs(status);
CREATE INDEX IF NOT EXISTS idx_outputs_deleted_at ON outputs(deleted_at);
"#;

const OUTPUT_CONVERSION_RELATIONS_DESTRUCTIVE_REBUILD_SQL: &str = r#"
DROP TABLE IF EXISTS output_conversion_relations;

CREATE TABLE output_conversion_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  note TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_output_conversion_relations_source
  ON output_conversion_relations(source_type, source_id, relation_type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_output_conversion_relations_target
  ON output_conversion_relations(target_type, target_id, relation_type, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_output_conversion_relations_active_unique
  ON output_conversion_relations(source_type, source_id, target_type, target_id, relation_type)
  WHERE deleted_at IS NULL;
"#;

const OUTPUT_CONVERSION_TABLE_REPAIRS: &[OutputConversionTableRepair] = &[
    OutputConversionTableRepair {
        table_name: "result_items",
        entity_type: Some("resultItem"),
        expected_columns: RESULT_ITEMS_CURRENT_COLUMNS,
        rebuild_sql: RESULT_ITEMS_DESTRUCTIVE_REBUILD_SQL,
    },
    OutputConversionTableRepair {
        table_name: "findings",
        entity_type: Some("finding"),
        expected_columns: FINDINGS_CURRENT_COLUMNS,
        rebuild_sql: FINDINGS_DESTRUCTIVE_REBUILD_SQL,
    },
    OutputConversionTableRepair {
        table_name: "output_candidates",
        entity_type: Some("outputCandidate"),
        expected_columns: OUTPUT_CANDIDATES_CURRENT_COLUMNS,
        rebuild_sql: OUTPUT_CANDIDATES_DESTRUCTIVE_REBUILD_SQL,
    },
    OutputConversionTableRepair {
        table_name: "outputs",
        entity_type: Some("researchOutput"),
        expected_columns: OUTPUTS_CURRENT_COLUMNS,
        rebuild_sql: OUTPUTS_DESTRUCTIVE_REBUILD_SQL,
    },
    OutputConversionTableRepair {
        table_name: "output_conversion_relations",
        entity_type: None,
        expected_columns: OUTPUT_CONVERSION_RELATIONS_CURRENT_COLUMNS,
        rebuild_sql: OUTPUT_CONVERSION_RELATIONS_DESTRUCTIVE_REBUILD_SQL,
    },
];

const FORMAL_OUTPUT_CONTRACT_SCHEMA_SQL: &str = r#"
INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (8, 'formal_output_contract_provenance_schema');
"#;

const OUTPUT_GAP_CLOSURE_SCHEMA_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_output_gaps_related_route_node_id
  ON output_gaps(related_route_node_id);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (9, 'output_gap_closure_schema');
"#;

const LITERATURE_DATA_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS literatures (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT,
  publication_type TEXT,
  abstract TEXT,
  keywords TEXT,
  doi TEXT,
  url TEXT,
  pdf_path TEXT,
  local_file_path TEXT,
  bibtex_key TEXT,
  citation_key TEXT,
  external_ids TEXT,
  reading_status TEXT NOT NULL,
  importance TEXT,
  primary_project_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_archived INTEGER,
  archived_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT,
  custom_fields TEXT,
  ai_metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS literature_links (
  id TEXT PRIMARY KEY,
  literature_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  project_id TEXT,
  relation_type TEXT NOT NULL,
  role TEXT,
  description TEXT,
  note TEXT,
  strength TEXT,
  confidence TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  tags TEXT,
  custom_fields TEXT,
  ai_metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (literature_id) REFERENCES literatures(id)
);

CREATE INDEX IF NOT EXISTS idx_literatures_primary_project_id ON literatures(primary_project_id);
CREATE INDEX IF NOT EXISTS idx_literatures_reading_status ON literatures(reading_status);
CREATE INDEX IF NOT EXISTS idx_literatures_deleted_at ON literatures(deleted_at);

CREATE INDEX IF NOT EXISTS idx_literature_links_literature_id ON literature_links(literature_id);
CREATE INDEX IF NOT EXISTS idx_literature_links_target ON literature_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_literature_links_project_id ON literature_links(project_id);
CREATE INDEX IF NOT EXISTS idx_literature_links_deleted_at ON literature_links(deleted_at);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (7, 'literature_data_schema');
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v56_upgrade_advances_through_v57_before_applying_v58() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                "DROP TABLE ai_standard_results;
                 DELETE FROM schema_migrations WHERE version=58;
                 PRAGMA user_version=56;",
            )
            .expect("construct v56 marker with materialized v57 contract");
        assert!(
            super::super::ai_durable_foundation::context_request_schema_is_current(&connection)
                .expect("read v57 contract")
        );
        assert!(
            !super::super::ai_durable_foundation::standard_result_schema_is_current(&connection)
                .expect("read missing v58 contract")
        );

        run_migrations(&connection).expect("upgrade v56 through v57 to v58");

        assert!(
            super::super::ai_durable_foundation::standard_result_schema_is_current(&connection)
                .expect("read repaired v58 contract")
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("read current user_version"),
            CURRENT_SCHEMA_VERSION
        );
    }

    fn downgrade_v41_fixture_for_legacy_repair(connection: &Connection, version: i64) {
        super::super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(connection)
            .expect("remove v53 foundation from isolated legacy fixture");
        connection
            .execute_batch(
                "PRAGMA foreign_keys=OFF;
                 DROP TABLE manuscript_provisioning_step_progress;
                 DROP TABLE manuscript_provisioning_step_plans;
                 DROP TABLE manuscript_provisioning_literature_child_states;
                 DELETE FROM schema_migrations WHERE version=41;",
            )
            .expect("remove isolated v41-only schema");
        connection
            .pragma_update(None, "user_version", version)
            .expect("set isolated legacy fixture version");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("restore isolated fixture foreign keys");
    }

    #[test]
    fn representative_experiment_run_schema_has_canonical_constraints() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");

        assert_eq!(CURRENT_SCHEMA_VERSION, AI_STANDARD_RESULT_SCHEMA_VERSION);
        let recovery_schema: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='experiment_run_manuscript_switch_recoveries'",
                [],
                |row| row.get(0),
            )
            .expect("read canonical Run switch recovery schema");
        assert!(!recovery_schema.to_ascii_lowercase().contains("append"));
        assert!(recovery_schema.contains("writeback_unknown"));
        assert!(recovery_schema.contains("writeback_applied"));
        assert!(table_has_exact_columns(
            &connection,
            "experiment_representative_runs",
            &[
                "id",
                "experiment_id",
                "run_id",
                "sort_order",
                "created_at",
                "updated_at",
            ],
        )
        .expect("inspect representative relation columns"));
        assert!(index_matches_contract(
            &connection,
            "experiment_representative_runs",
            "uq_experiment_representative_runs_experiment_run",
            &["experiment_id", "run_id"],
            true,
        )
        .expect("inspect representative relation uniqueness"));
        assert!(index_matches_contract(
            &connection,
            "experiment_representative_runs",
            "uq_experiment_representative_runs_experiment_sort",
            &["experiment_id", "sort_order"],
            true,
        )
        .expect("inspect representative ordering uniqueness"));

        let foreign_keys = {
            let mut statement = connection
                .prepare("PRAGMA foreign_key_list(experiment_representative_runs)")
                .expect("prepare foreign key inspection");
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .expect("query foreign keys")
                .collect::<Result<Vec<_>>>()
                .expect("collect foreign keys")
        };
        assert!(foreign_keys.contains(&(
            "experiment_id".to_string(),
            "experiments".to_string(),
            "id".to_string(),
            "CASCADE".to_string(),
        )));
        assert!(foreign_keys.contains(&(
            "run_id".to_string(),
            "experiment_runs".to_string(),
            "id".to_string(),
            "CASCADE".to_string(),
        )));
    }

    #[test]
    fn v39_clears_only_the_proven_generated_experiment_fields_and_audits_them() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
                INSERT INTO experiments (
                  id, project_id, title, experiment_name, machine_object, fault_type,
                  sensor_config, data_path, result_summary, condition_summary, condition_items,
                  created_local_date, created_local_time, workspace_title_identity,
                  created_at, updated_at
                ) VALUES
                (
                  'generated-sentinel', 'project-1', 'Generated', 'Generated', '', 'unknown',
                  '', '', '', 'faultType: unknown',
                  '[{"id":"legacy-fault-type","name":"faultType","value":"unknown","role":"sample"}]',
                  '2026-07-21', '1200', 'generated', '2026-07-21T04:00:00Z', '2026-07-21T04:00:00Z'
                ),
                (
                  'user-authored-same-text', 'project-1', 'Authored', 'Authored', '', 'unknown',
                  '', '', '', 'faultType: unknown', '[]',
                  '2026-07-21', '1201', 'authored', '2026-07-21T04:01:00Z', '2026-07-21T04:01:00Z'
                ),
                (
                  'generated-item-only', 'project-1', 'Preserved', 'Preserved', '', 'unknown',
                  '', '', '', '3',
                  '[{"id":"legacy-fault-type","name":"faultType","value":"unknown","role":"sample"}]',
                  '2026-07-21', '1202', 'preserved', '2026-07-21T04:02:00Z', '2026-07-21T04:02:00Z'
                );
                UPDATE experiments SET purpose=title
                 WHERE id IN ('generated-sentinel', 'user-authored-same-text');
                UPDATE experiments SET purpose='Real purpose'
                 WHERE id='generated-item-only';
                DROP TABLE manuscript_provisioning_step_progress;
                DROP TABLE manuscript_provisioning_step_plans;
                DROP TABLE manuscript_provisioning_literature_child_states;
                DELETE FROM schema_migrations WHERE version IN (39, 41);
                PRAGMA user_version = 37;
                "#,
            )
            .expect("seed v37 sentinel cases");

        run_migrations(&connection).expect("migrate sentinel cases");

        let generated: (Option<String>, String, String, Option<String>) = connection
            .query_row(
                "SELECT condition_summary, condition_items, updated_at, purpose FROM experiments WHERE id = 'generated-sentinel'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read generated sentinel");
        assert_eq!(generated.0, None);
        assert_eq!(generated.1, "[]");
        assert_eq!(generated.2, "2026-07-21T04:00:00Z");
        assert_eq!(generated.3, None);

        let authored: (Option<String>, String, Option<String>) = connection
            .query_row(
                "SELECT condition_summary, condition_items, purpose FROM experiments WHERE id = 'user-authored-same-text'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read authored text");
        assert_eq!(authored.0.as_deref(), Some("faultType: unknown"));
        assert_eq!(authored.1, "[]");
        assert_eq!(authored.2.as_deref(), Some("Authored"));

        let item_only: (Option<String>, String, Option<String>, String) = connection
            .query_row(
                "SELECT condition_summary, condition_items, purpose, updated_at FROM experiments WHERE id = 'generated-item-only'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read generated condition item with authored fields");
        assert_eq!(item_only.0.as_deref(), Some("3"));
        assert_eq!(item_only.1, "[]");
        assert_eq!(item_only.2.as_deref(), Some("Real purpose"));
        assert_eq!(item_only.3, "2026-07-21T04:02:00Z");

        run_migrations(&connection).expect("re-run current reconciliation idempotently");

        let audit_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE id = 'schema-v39-experiment-generated-fields-generated-sentinel' AND status = 'success' AND is_recoverable = 0",
                [],
                |row| row.get(0),
            )
            .expect("read generated-field migration audit");
        assert_eq!(audit_count, 1);
        let marker_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 39",
                [],
                |row| row.get(0),
            )
            .expect("read v38 marker");
        assert_eq!(marker_count, 1);
    }

    #[test]
    fn experiment_business_model_migration_removes_formal_custom_field_keys_without_fallback() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary, custom_fields,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-a', 'project-a', 'Experiment A', '', 'unknown', '', '', '',
                   '[{\"name\":\"summaryOther\",\"value\":\"legacy\"},{\"name\":\"generalNotes\",\"value\":\"body\"}]',
                   '2026-07-17', '0905', 'experiment-a', '2026-07-17', '2026-07-17'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status, custom_fields,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-a', 'experiment-a', 'project-a', 'Run A', 'planned',
                   '[{\"name\":\"runVariableParameterSummary\",\"value\":\"legacy\"},{\"name\":\"runSummaryOther\",\"value\":\"legacy\"},{\"name\":\"generalNotes\",\"value\":\"body\"}]',
                   '2026-07-17', '0910', 'run-a', '2026-07-17', '2026-07-17'
                 );
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version IN (22, 41);
                 PRAGMA user_version = 21;",
            )
            .expect("prepare pre-B-1 custom fields");

        run_migrations(&connection).expect("apply B-1 migration");
        let experiment_fields: String = connection
            .query_row(
                "SELECT custom_fields FROM experiments WHERE id = 'experiment-a'",
                [],
                |row| row.get(0),
            )
            .expect("read Experiment customFields");
        let run_fields: String = connection
            .query_row(
                "SELECT custom_fields FROM experiment_runs WHERE id = 'run-a'",
                [],
                |row| row.get(0),
            )
            .expect("read Run customFields");
        assert!(!experiment_fields.contains("summaryOther"));
        assert!(!run_fields.contains("runVariableParameterSummary"));
        assert!(!run_fields.contains("runSummaryOther"));
        assert!(!experiment_fields.contains("generalNotes"));
        assert!(run_fields.contains("generalNotes"));
        let promoted_values: (Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT e.summary_other, r.variable_parameter_summary, r.summary_other
                 FROM experiments e JOIN experiment_runs r ON r.experiment_id = e.id
                 WHERE e.id = 'experiment-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read promoted fields");
        assert_eq!(promoted_values, (None, None, None));
    }

    #[test]
    fn canonical_writeback_migration_removes_legacy_run_body_custom_fields() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary, custom_fields,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-j1', 'project-j1', 'Experiment J1', '', 'unknown', '', '', '', '[]',
                   '2026-07-20', '2300', 'experiment-j1', '2026-07-20', '2026-07-20'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status, custom_fields,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-j1', 'experiment-j1', 'project-j1', 'Run J1', 'planned',
                   '[{\"name\":\"generalNotes\",\"value\":\"legacy body\"},{\"name\":\"recordNotes\",\"value\":\"legacy record\"},{\"name\":\"keepMe\",\"value\":\"kept\"}]',
                   '2026-07-20', '2301', 'run-j1', '2026-07-20', '2026-07-20'
                 );
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version IN (35, 41);
                 PRAGMA user_version = 34;",
            )
            .expect("prepare pre-J-1 Run custom fields");

        run_migrations(&connection).expect("apply J-1 migration");
        let run_fields: String = connection
            .query_row(
                "SELECT custom_fields FROM experiment_runs WHERE id = 'run-j1'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated Run custom fields");
        assert!(!run_fields.contains("generalNotes"));
        assert!(!run_fields.contains("recordNotes"));
        assert!(run_fields.contains("keepMe"));
    }

    #[test]
    fn managed_root_setting_schema_is_singleton_and_idempotent() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");

        connection
            .execute(
                "INSERT INTO managed_root_settings (
                   id, configured_root, schema_version, created_at, updated_at
                 ) VALUES ('managed-root', 'C:/LabPodFiles', 1, '2026-07-13', '2026-07-13')",
                [],
            )
            .expect("insert managed root setting");

        let invalid_id = connection.execute(
            "INSERT INTO managed_root_settings (
               id, configured_root, schema_version, created_at, updated_at
             ) VALUES ('other-root', 'D:/Other', 1, '2026-07-13', '2026-07-13')",
            [],
        );
        assert!(invalid_id.is_err());

        run_migrations(&connection).expect("rerun managed root migration");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM managed_root_settings", [], |row| {
                row.get(0)
            })
            .expect("count managed root settings");
        assert_eq!(count, 1);
    }

    #[test]
    fn rebuilds_legacy_output_gaps_and_clears_gap_relations() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                r#"
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE output_gaps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  output_candidate_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  gap_type TEXT NOT NULL,
  status TEXT NOT NULL,
  structured_summary TEXT NOT NULL DEFAULT '[]',
  markdown_body TEXT NOT NULL DEFAULT '',
  priority TEXT,
  related_task_id TEXT,
  related_route_node_id TEXT,
  resolved_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE output_conversion_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  note TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO output_conversion_relations (
  id, source_type, source_id, target_type, target_id, relation_type,
  created_at, updated_at
) VALUES (
  'legacy-relation', 'outputGap', 'legacy-gap', 'outputCandidate',
  'candidate-1', 'blocks', '2026-01-01', '2026-01-01'
);
"#,
            )
            .expect("create legacy schema");

        run_migrations(&connection).expect("repair legacy output_gaps");

        let columns = table_columns(&connection, "output_gaps").expect("read repaired columns");
        let names = columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        let expected = OUTPUT_GAPS_CURRENT_COLUMNS
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        assert_eq!(names, expected);
        assert!(!names.contains("output_candidate_id"));
        assert!(!names.contains("resolved_by_result_item_id"));

        let relation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_conversion_relations
                 WHERE source_type = 'outputGap' OR target_type = 'outputGap'",
                [],
                |row| row.get(0),
            )
            .expect("count repaired relations");
        assert_eq!(relation_count, 0);
    }

    #[test]
    fn current_output_gaps_shape_is_idempotent_and_preserves_rows() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute(
                "INSERT INTO output_gaps (
                   id, project_id, title, gap_type, status, structured_summary,
                   schema_version, custom_fields, created_at, updated_at
                 ) VALUES (
                   'gap-current', 'project-1', 'Gap', 'analysis', 'pending', '[]',
                   1, '[]', '2026-01-01', '2026-01-01'
                 )",
                [],
            )
            .expect("insert current gap");

        run_migrations(&connection).expect("rerun migrations");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_gaps WHERE id = 'gap-current'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved gap");
        assert_eq!(count, 1);
    }

    #[test]
    fn rebuilds_legacy_output_conversion_tables_and_scopes_relation_cleanup() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                r#"
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  linked_result_item_ids TEXT,
  linked_asset_ids TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE output_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  candidate_type TEXT NOT NULL,
  status TEXT NOT NULL,
  linked_finding_ids TEXT,
  linked_result_item_ids TEXT,
  formal_output_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  experiment_id TEXT,
  output_name TEXT NOT NULL,
  output_type TEXT NOT NULL,
  usable_for_paper INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  source_candidate_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE output_conversion_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  note TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO output_conversion_relations (
  id, source_type, source_id, target_type, target_id, relation_type,
  created_at, updated_at
) VALUES
  ('finding-relation', 'resultItem', 'result-1', 'finding', 'finding-1', 'evidence_for', '2026-01-01', '2026-01-01'),
  ('candidate-relation', 'finding', 'finding-1', 'outputCandidate', 'candidate-1', 'supports', '2026-01-01', '2026-01-01'),
  ('output-relation', 'outputCandidate', 'candidate-1', 'researchOutput', 'output-1', 'converted_to', '2026-01-01', '2026-01-01'),
  ('gap-relation', 'outputGap', 'gap-1', 'outputCandidate', 'candidate-1', 'blocks', '2026-01-01', '2026-01-01');
"#,
            )
            .expect("create legacy output conversion tables");

        run_migrations(&connection).expect("repair legacy output conversion tables");

        let findings = table_columns(&connection, "findings").expect("read findings columns");
        let finding_names = findings
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            finding_names,
            FINDINGS_CURRENT_COLUMNS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        );
        assert!(!finding_names.contains("linked_result_item_ids"));

        let candidates =
            table_columns(&connection, "output_candidates").expect("read candidate columns");
        let candidate_names = candidates
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            candidate_names,
            OUTPUT_CANDIDATES_CURRENT_COLUMNS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        );
        assert!(!candidate_names.contains("formal_output_id"));

        let outputs = table_columns(&connection, "outputs").expect("read output columns");
        let output_names = outputs
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            output_names,
            OUTPUTS_CURRENT_COLUMNS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        );
        assert!(!output_names.contains("source_candidate_id"));

        let non_gap_relations: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_conversion_relations
                 WHERE id IN ('finding-relation', 'candidate-relation', 'output-relation')",
                [],
                |row| row.get(0),
            )
            .expect("count cleaned target relations");
        assert_eq!(non_gap_relations, 0);

        let gap_relations: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_conversion_relations WHERE id = 'gap-relation'",
                [],
                |row| row.get(0),
            )
            .expect("count cleared relation to rebuilt candidate");
        assert_eq!(gap_relations, 0);
    }

    #[test]
    fn current_output_conversion_shapes_are_idempotent_and_preserve_rows() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute(
                "INSERT INTO findings (
                   id, project_id, title, summary, status, structured_summary,
                   tags, schema_version, custom_fields, created_at, updated_at
                 ) VALUES (
                   'finding-current', 'project-1', 'Finding', 'Summary',
                   'pending_confirmation', '[]', '[]', 1, '[]',
                   '2026-01-01', '2026-01-01'
                 )",
                [],
            )
            .expect("insert current finding");

        run_migrations(&connection).expect("rerun migrations");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM findings WHERE id = 'finding-current'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved finding");
        assert_eq!(count, 1);
    }

    #[test]
    fn drops_only_three_layer_database_body_columns_and_preserves_graph_rows() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
ALTER TABLE findings ADD COLUMN markdown_body TEXT NOT NULL DEFAULT '';
ALTER TABLE output_candidates ADD COLUMN markdown_body TEXT NOT NULL DEFAULT '';
ALTER TABLE output_gaps ADD COLUMN markdown_body TEXT NOT NULL DEFAULT '';

INSERT INTO findings (
  id, project_id, title, summary, status, structured_summary, tags,
  schema_version, custom_fields, created_at, updated_at, markdown_body
) VALUES (
  'finding-body-only', 'project-1', 'Finding', 'Summary',
  'pending_confirmation', '[]', '[]', 1, '[]',
  '2026-01-01', '2026-01-01', '# legacy finding body'
);
INSERT INTO output_candidates (
  id, project_id, title, description, candidate_type, status,
  structured_summary, tags, schema_version, custom_fields,
  created_at, updated_at, markdown_body
) VALUES (
  'candidate-body-only', 'project-1', 'Candidate', 'Description', 'paper',
  'pending_evaluation', '[]', '[]', 1, '[]',
  '2026-01-01', '2026-01-01', '# legacy candidate body'
);
INSERT INTO output_gaps (
  id, project_id, title, description, gap_type, status,
  structured_summary, schema_version, custom_fields,
  created_at, updated_at, markdown_body
) VALUES (
  'gap-body-only', 'project-1', 'Gap', 'Description', 'analysis', 'pending',
  '[]', 1, '[]', '2026-01-01', '2026-01-01', '# legacy gap body'
);
INSERT INTO output_conversion_relations (
  id, project_id, source_type, source_id, target_type, target_id,
  relation_type, schema_version, created_at, updated_at
) VALUES (
  'relation-body-only', 'project-1', 'outputCandidate', 'candidate-body-only',
  'outputGap', 'gap-body-only', 'blocks', 1, '2026-01-01', '2026-01-01'
);
INSERT INTO output_gap_feedback_cards (
  id, project_id, output_gap_id, card_type, title, description,
  status, priority, created_at, updated_at
) VALUES (
  'feedback-body-only', 'project-1', 'gap-body-only', 'route',
  'Feedback', 'Description', 'pending', 'medium', '2026-01-01', '2026-01-01'
);
"#,
            )
            .expect("create body-only drift with graph rows");

        downgrade_v41_fixture_for_legacy_repair(&connection, 39);
        run_migrations(&connection).expect("drop only database body columns");

        for table in ["findings", "output_candidates", "output_gaps"] {
            let columns = table_columns(&connection, table).expect("read repaired columns");
            assert!(!columns.iter().any(|column| column.name == "markdown_body"));
        }
        for (table, id) in [
            ("findings", "finding-body-only"),
            ("output_candidates", "candidate-body-only"),
            ("output_gaps", "gap-body-only"),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .expect("count preserved owner row");
            assert_eq!(count, 1, "owner row should survive for {table}");
        }
        let relation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_conversion_relations WHERE id = 'relation-body-only'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved output relation");
        assert_eq!(relation_count, 1);
        let feedback_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_gap_feedback_cards WHERE id = 'feedback-body-only'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved feedback card");
        assert_eq!(feedback_count, 1);
    }

    #[test]
    fn drops_result_item_database_body_and_preserves_source_relation_graph() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
ALTER TABLE result_items ADD COLUMN markdown_body TEXT NOT NULL DEFAULT '';
INSERT INTO result_items (
  id, project_id, source_type, source_id, title, result_type, status,
  structured_summary, summary, tags, is_asset, usable_for, schema_version,
  custom_fields, created_at, updated_at, markdown_body
) VALUES (
  'result-item-body-only', 'project-1', 'experimentRun', 'run-source-1',
  'Result item', 'metric', 'pending_review', '[]', 'Structured source summary',
  '[]', 1, '["paper"]', 1, '[]', '2026-01-01', '2026-01-01',
  '# database body to remove'
);
INSERT INTO output_conversion_relations (
  id, project_id, source_type, source_id, target_type, target_id,
  relation_type, schema_version, created_at, updated_at
) VALUES (
  'relation-result-item-body-only', 'project-1', 'resultItem',
  'result-item-body-only', 'finding', 'finding-source-1', 'supports', 1,
  '2026-01-01', '2026-01-01'
);
INSERT INTO file_refs (
  id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
  location_mode, file_type, path, path_identity_key, title, schema_version,
  source, custom_fields, created_at, updated_at
) VALUES
  ('result-item-folder-ref', 'resultItem', 'result-item-body-only', 'primary',
   'folder', 'defaultFolder', 'managed', 'folder', 'C:/managed/result-item',
   'c:/managed/result-item', 'Result item folder', 2, 'system', '[]',
   '2026-01-01', '2026-01-01'),
  ('result-item-body-ref', 'resultItem', 'result-item-body-only', 'primary',
   'file', 'manuscript', 'managed', 'markdown',
   'C:/managed/result-item/result-item.md',
   'c:/managed/result-item/result-item.md', 'result-item.md', 2, 'system', '[]',
   '2026-01-01', '2026-01-01');
INSERT INTO manuscript_bindings (
  id, owner_type, owner_id, manuscript_channel, default_folder_file_ref_id,
  default_manuscript_file_ref_id, current_file_ref_id, schema_version,
  created_at, updated_at
) VALUES (
  'result-item-binding', 'resultItem', 'result-item-body-only', 'primary',
  'result-item-folder-ref', 'result-item-body-ref', 'result-item-body-ref', 1,
  '2026-01-01', '2026-01-01'
);
"#,
            )
            .expect("create ResultItem body-only drift with identity graph");

        downgrade_v41_fixture_for_legacy_repair(&connection, 39);
        run_migrations(&connection).expect("drop ResultItem database body column");

        let columns =
            table_columns(&connection, "result_items").expect("read repaired ResultItem columns");
        assert!(!columns.iter().any(|column| column.name == "markdown_body"));
        let source: (String, String, String, i64) = connection
            .query_row(
                "SELECT source_type, source_id, summary, is_asset
                 FROM result_items WHERE id = 'result-item-body-only'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read preserved ResultItem source fields");
        assert_eq!(source, (
            "experimentRun".to_string(),
            "run-source-1".to_string(),
            "Structured source summary".to_string(),
            1,
        ));
        for (table, id) in [
            ("output_conversion_relations", "relation-result-item-body-only"),
            ("file_refs", "result-item-folder-ref"),
            ("file_refs", "result-item-body-ref"),
            ("manuscript_bindings", "result-item-binding"),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .expect("count preserved ResultItem graph row");
            assert_eq!(count, 1, "{table}/{id} should survive body-column repair");
        }
    }

    #[test]
    fn drops_research_output_database_body_and_preserves_identity_graph() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
ALTER TABLE outputs ADD COLUMN markdown_body TEXT NOT NULL DEFAULT '';
INSERT INTO output_candidates (
  id, project_id, title, candidate_type, status, structured_summary, tags,
  schema_version, custom_fields, created_at, updated_at
) VALUES (
  'candidate-output-body-only', 'project-1', 'Candidate', 'paper', 'converted',
  '[]', '[]', 1, '[]', '2026-01-01', '2026-01-01'
);
INSERT INTO outputs (
  id, project_id, output_name, output_type, status, structured_summary,
  usable_for_paper, description, provenance, created_at, updated_at, markdown_body
) VALUES (
  'research-output-body-only', 'project-1', 'Research output', 'paper_draft',
  'draft', '[]', 1, 'Description',
  '{"sourceType":"output_candidate","sourceCandidateId":"candidate-output-body-only"}',
  '2026-01-01', '2026-01-01', 'legacy body'
);
INSERT INTO output_conversion_relations (
  id, project_id, source_type, source_id, target_type, target_id,
  relation_type, schema_version, created_at, updated_at
) VALUES (
  'relation-output-body-only', 'project-1', 'outputCandidate',
  'candidate-output-body-only', 'researchOutput', 'research-output-body-only',
  'converted_to', 1, '2026-01-01', '2026-01-01'
);
INSERT INTO file_refs (
  id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
  location_mode, file_type, path, path_identity_key, title, schema_version,
  source, custom_fields, created_at, updated_at
) VALUES
  ('output-folder-ref', 'researchOutput', 'research-output-body-only', 'primary',
   'folder', 'defaultFolder', 'managed', 'folder', 'C:/managed/output',
   'c:/managed/output', 'Output folder', 2, 'system', '[]', '2026-01-01', '2026-01-01'),
  ('output-body-ref', 'researchOutput', 'research-output-body-only', 'primary',
   'file', 'manuscript', 'managed', 'markdown', 'C:/managed/output/research-output.md',
   'c:/managed/output/research-output.md', 'research-output.md', 2, 'system', '[]',
   '2026-01-01', '2026-01-01');
INSERT INTO manuscript_bindings (
  id, owner_type, owner_id, manuscript_channel, default_folder_file_ref_id,
  default_manuscript_file_ref_id, current_file_ref_id, schema_version,
  created_at, updated_at
) VALUES (
  'output-binding', 'researchOutput', 'research-output-body-only', 'primary',
  'output-folder-ref', 'output-body-ref', 'output-body-ref', 1,
  '2026-01-01', '2026-01-01'
);
"#,
            )
            .expect("create ResearchOutput body-only drift with identity graph");

        downgrade_v41_fixture_for_legacy_repair(&connection, 39);
        run_migrations(&connection).expect("drop ResearchOutput database body column");

        let columns = table_columns(&connection, "outputs").expect("read repaired output columns");
        assert!(!columns.iter().any(|column| column.name == "markdown_body"));
        for (table, id) in [
            ("outputs", "research-output-body-only"),
            ("output_conversion_relations", "relation-output-body-only"),
            ("file_refs", "output-body-ref"),
            ("manuscript_bindings", "output-binding"),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .expect("count preserved ResearchOutput graph row");
            assert_eq!(count, 1, "{table}/{id} should survive body-column repair");
        }
    }

    #[test]
    fn output_source_links_schema_is_idempotent_and_preserves_rows() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");

        let columns =
            table_columns(&connection, "output_source_links").expect("read source link columns");
        let names = columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            names,
            OUTPUT_SOURCE_LINKS_CURRENT_COLUMNS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        );

        connection
            .execute(
                "INSERT INTO output_source_links (
                   id, project_id, owner_type, owner_id, source_type, source_id,
                   source_title_snapshot, relation_type, order_index, schema_version,
                   created_at, updated_at
                 ) VALUES (
                   'source-link-current', 'project-1', 'finding', 'finding-1',
                   'resultItem', 'result-1', 'Result item snapshot', 'primary', 0, 1,
                   '2026-01-01', '2026-01-01'
                 )",
                [],
            )
            .expect("insert current output source link");

        run_migrations(&connection).expect("rerun migrations");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM output_source_links WHERE id = 'source-link-current'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved source link");
        assert_eq!(count, 1);
    }

    #[test]
    fn research_trace_event_preferences_schema_is_idempotent_and_preserves_rows() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        run_migrations(&connection).expect("create current schema");

        let columns = table_columns(&connection, "research_trace_event_preferences")
            .expect("read preference columns");
        let names = columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            names,
            RESEARCH_TRACE_EVENT_PREFERENCES_CURRENT_COLUMNS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        );

        connection
            .execute(
                "INSERT INTO research_trace_event_preferences (
                   id, project_id, target_type, target_id, visibility,
                   created_at, updated_at
                 ) VALUES (
                   'research-trace-preference:project-1:task:task-1',
                   'project-1', 'task', 'task-1', 'pinned',
                   '2026-01-01', '2026-01-01'
                 )",
                [],
            )
            .expect("insert current preference");

        run_migrations(&connection).expect("rerun migrations");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM research_trace_event_preferences
                 WHERE id = 'research-trace-preference:project-1:task:task-1'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved preference");
        assert_eq!(count, 1);

        let duplicate = connection.execute(
            "INSERT INTO research_trace_event_preferences (
               id, project_id, target_type, target_id, visibility,
               created_at, updated_at
             ) VALUES (
               'research-trace-preference:project-1:task:task-1-duplicate',
               'project-1', 'task', 'task-1', 'hidden',
               '2026-01-01', '2026-01-01'
             )",
            [],
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn lp11_file_identity_and_binding_schema_enforces_invariants() {
        assert_eq!(
            migration_path_identity_key(" C:\\Lab\\Draft.md "),
            "c:/lab/draft.md"
        );
        assert_eq!(
            migration_path_identity_key("file:///C:/Lab/Draft.md"),
            "c:/lab/draft.md"
        );
        assert_eq!(
            migration_path_identity_key("file:///C:/Lab/My%20Draft.md"),
            "c:/lab/my draft.md"
        );
        assert_eq!(migration_path_identity_key("C:/Ä.md"), "c:/ä.md");
        assert_eq!(
            migration_path_identity_key("\\\\Server\\Share\\Draft.md"),
            "//server/share/draft.md"
        );
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        run_migrations(&connection).expect("create LP11-2 schema");

        let file_ref_columns =
            table_columns(&connection, "file_refs").expect("read file_refs columns");
        let file_ref_names = file_ref_columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        for column in [
            "resource_kind",
            "file_role",
            "location_mode",
            "path_identity_key",
        ] {
            assert!(file_ref_names.contains(column), "missing {column}");
        }
        assert!(!file_ref_names.contains("experiment_id"));
        assert!(!file_ref_names.contains("run_id"));

        let binding_columns = table_columns(&connection, "manuscript_bindings")
            .expect("read manuscript_bindings columns");
        let binding_names = binding_columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<HashSet<_>>();
        for column in [
            "owner_type",
            "owner_id",
            "default_folder_file_ref_id",
            "default_manuscript_file_ref_id",
            "current_file_ref_id",
        ] {
            assert!(binding_names.contains(column), "missing {column}");
        }

        connection
            .execute(
                "INSERT INTO file_refs (
               id, owner_type, owner_id, resource_kind, file_role, location_mode,
               path, path_identity_key, file_type, title, schema_version, source,
               custom_fields, created_at, updated_at
             ) VALUES (
               'file-1', 'review', 'review-1', 'file', 'manuscript', 'managed',
               'C:/Lab/body.md', 'c:/lab/body.md', 'external_note', 'Body', 2, 'user',
               '[]', '2026-01-01', '2026-01-01'
             )",
                [],
            )
            .expect("insert file ref");

        let duplicate_identity = connection.execute(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, resource_kind, file_role, location_mode,
               path, path_identity_key, file_type, title, schema_version, source,
               custom_fields, created_at, updated_at, deleted_at
             ) VALUES (
               'file-2', 'review', 'review-1', 'file', 'manuscript', 'managed',
               'c:/lab/body.md', 'c:/lab/body.md', 'external_note', 'Duplicate', 2, 'user',
               '[]', '2026-01-01', '2026-01-01', '2026-01-02'
             )",
            [],
        );
        assert!(duplicate_identity.is_err());

        connection
            .execute(
                "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, current_file_ref_id, created_at, updated_at
             ) VALUES (
               'binding-1', 'review', 'review-1', 'file-1', '2026-01-01', '2026-01-01'
             )",
                [],
            )
            .expect("insert binding");

        let binding_round_trip: (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT owner_type, owner_id, default_folder_file_ref_id,
                        default_manuscript_file_ref_id, current_file_ref_id
                 FROM manuscript_bindings WHERE id = 'binding-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("round-trip binding");
        assert_eq!(binding_round_trip.0, "review");
        assert_eq!(binding_round_trip.1, "review-1");
        assert_eq!(binding_round_trip.2, None);
        assert_eq!(binding_round_trip.3, None);
        assert_eq!(binding_round_trip.4.as_deref(), Some("file-1"));

        connection
            .execute(
                "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, created_at, updated_at
             ) VALUES (
               'binding-partial', 'review', 'review-2', '2026-01-01', '2026-01-01'
             )",
                [],
            )
            .expect("insert partial binding with nullable refs");

        let duplicate_owner = connection.execute(
            "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, created_at, updated_at
             ) VALUES (
               'binding-2', 'review', 'review-1', '2026-01-01', '2026-01-01'
             )",
            [],
        );
        assert!(duplicate_owner.is_err());

        assert!(connection
            .execute("DELETE FROM file_refs WHERE id = 'file-1'", [])
            .is_err());
        connection
            .execute("DELETE FROM manuscript_bindings WHERE id = 'binding-1'", [])
            .expect("remove binding explicitly");
        assert_eq!(
            connection
                .execute("DELETE FROM file_refs WHERE id = 'file-1'", [])
                .expect("delete unreferenced file ref metadata"),
            1
        );
        run_migrations(&connection).expect("rerun LP11-2 migration idempotently");
    }

    fn assert_lp11_schema_current(connection: &Connection) {
        for table in ["file_refs", "manuscript_bindings", "managed_root_settings"] {
            assert!(
                table_exists(connection, table).expect("check table"),
                "missing {table}"
            );
        }
        for (table, index, columns, unique) in [
            (
                "file_refs",
                "idx_file_refs_identity",
                &[
                    "owner_type",
                    "owner_id",
                    "manuscript_channel",
                    "resource_kind",
                    "file_role",
                    "location_mode",
                    "path_identity_key",
                ][..],
                true,
            ),
            (
                "file_refs",
                "idx_file_refs_experiment_default_folder_owner",
                &["owner_type", "owner_id"][..],
                true,
            ),
            (
                "file_refs",
                "idx_file_refs_experiment_run_default_folder_owner",
                &["owner_type", "owner_id"][..],
                true,
            ),
            (
                "manuscript_bindings",
                "idx_manuscript_bindings_default_folder",
                &["default_folder_file_ref_id"][..],
                false,
            ),
            (
                "manuscript_bindings",
                "idx_manuscript_bindings_default_manuscript",
                &["default_manuscript_file_ref_id"][..],
                false,
            ),
            (
                "manuscript_bindings",
                "idx_manuscript_bindings_current",
                &["current_file_ref_id"][..],
                false,
            ),
        ] {
            assert!(
                index_matches_contract(connection, table, index, columns, unique)
                    .expect("check index"),
                "missing or malformed {index}"
            );
        }
        assert!(
            !index_exists(
                connection,
                "idx_file_refs_experiment_managed_manuscript_owner"
            )
            .expect("check obsolete Experiment manuscript index"),
            "obsolete Experiment per-owner manuscript index must be absent"
        );
        assert!(
            !index_exists(
                connection,
                "idx_file_refs_experiment_run_managed_manuscript_owner"
            )
            .expect("check obsolete ExperimentRun manuscript index"),
            "obsolete ExperimentRun per-owner manuscript index must be absent"
        );
        assert!(manuscript_channel_schema_is_current(connection).expect("binding channel schema"));
        assert!(column_exists(connection, "file_refs", "manuscript_channel")
            .expect("file-ref channel schema"));
        assert!(managed_root_setting_schema_is_current(connection).expect("root schema"));
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");
        assert_eq!(user_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn experiment_allows_multiple_managed_manuscripts_with_exact_identity_uniqueness() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'experiment-folder-1', 'experiment', 'experiment-c2', 'primary',
               'folder', 'defaultFolder', 'managed', 'C:/Lab/one', 'c:/lab/one',
               'folder', 'One', 2, 'system', '[]', '2026-07-17', '2026-07-17'
             );
             INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'experiment-manuscript-1', 'experiment', 'experiment-c2', 'primary',
               'file', 'manuscript', 'managed', 'C:/Lab/one/experiment.md',
               'c:/lab/one/experiment.md', 'markdown', 'experiment.md', 2, 'system',
               '[]', '2026-07-17', '2026-07-17'
             );"
        ).expect("insert formal Experiment identities");

        let second_folder = connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'experiment-folder-2', 'experiment', 'experiment-c2', 'primary',
               'folder', 'defaultFolder', 'managed', 'C:/Lab/two', 'c:/lab/two',
               'folder', 'Two', 2, 'system', '[]', '2026-07-17', '2026-07-17'
             );"
        );
        assert!(second_folder.is_err(), "a second Experiment default folder must be rejected");

        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'experiment-manuscript-2', 'experiment', 'experiment-c2', 'primary',
               'file', 'manuscript', 'managed', 'C:/Lab/two/experiment.md',
               'c:/lab/two/experiment.md', 'markdown', 'experiment.md', 2, 'system',
               '[]', '2026-07-17', '2026-07-17'
             );"
        ).expect("a second managed primary Experiment manuscript must be allowed");

        let duplicate_manuscript = connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'experiment-manuscript-duplicate', 'experiment', 'experiment-c2', 'primary',
               'file', 'manuscript', 'managed', 'C:/LAB/TWO/experiment.md',
               'c:/lab/two/experiment.md', 'markdown', 'experiment.md', 2, 'system',
               '[]', '2026-07-17', '2026-07-17'
             );"
        );
        assert!(
            duplicate_manuscript.is_err(),
            "the same final FileRef identity must remain unique"
        );

        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'experiment-attachment', 'experiment', 'experiment-c2', 'primary',
               'file', 'attachment', 'external', 'C:/External/notes.md',
               'c:/external/notes.md', 'markdown', 'notes.md', 2, 'user',
               '[]', '2026-07-17', '2026-07-17'
             );
             INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-manuscript', 'experimentRun', 'run-c2', 'primary',
               'file', 'manuscript', 'managed', 'C:/Lab/run/experiment-run.md',
               'c:/lab/run/experiment-run.md', 'markdown', 'experiment-run.md', 2,
               'system', '[]', '2026-07-17', '2026-07-17'
             );"
        ).expect("attachments and Run identities remain outside the Experiment-only indexes");
    }

    #[test]
    fn experiment_run_allows_additional_managed_manuscripts_with_exact_identity_uniqueness() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-folder-1', 'experimentRun', 'run-c3', 'primary',
               'folder', 'defaultFolder', 'managed', 'C:/Lab/run-one', 'c:/lab/run-one',
               'folder', 'Run one', 2, 'system', '[]', '2026-07-17', '2026-07-17'
             );
             INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-manuscript-1', 'experimentRun', 'run-c3', 'primary',
               'file', 'manuscript', 'managed', 'C:/Lab/run-one/experiment-run.md',
               'c:/lab/run-one/experiment-run.md', 'markdown', 'experiment-run.md', 2,
               'system', '[]', '2026-07-17', '2026-07-17'
             );"
        ).expect("insert formal ExperimentRun identities");

        let second_folder = connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-folder-2', 'experimentRun', 'run-c3', 'primary',
               'folder', 'defaultFolder', 'managed', 'C:/Lab/run-two', 'c:/lab/run-two',
               'folder', 'Run two', 2, 'system', '[]', '2026-07-17', '2026-07-17'
             );"
        );
        assert!(second_folder.is_err(), "a second ExperimentRun default folder must be rejected");

        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-manuscript-2', 'experimentRun', 'run-c3', 'primary',
               'file', 'manuscript', 'managed', 'C:/Lab/run-two/experiment-run.md',
               'c:/lab/run-two/experiment-run.md', 'markdown', 'experiment-run.md', 2,
               'system', '[]', '2026-07-17', '2026-07-17'
             );"
        ).expect("a second managed primary ExperimentRun manuscript must be allowed");

        let duplicate_manuscript = connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-manuscript-duplicate', 'experimentRun', 'run-c3', 'primary',
               'file', 'manuscript', 'managed', 'C:/LAB/RUN-TWO/experiment-run.md',
               'c:/lab/run-two/experiment-run.md', 'markdown', 'experiment-run.md', 2,
               'system', '[]', '2026-07-17', '2026-07-17'
             );"
        );
        assert!(
            duplicate_manuscript.is_err(),
            "the same ExperimentRun FileRef identity must remain unique"
        );

        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, path, path_identity_key, file_type, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES (
               'run-sibling-folder', 'experimentRun', 'run-c3-sibling', 'primary',
               'folder', 'defaultFolder', 'managed', 'C:/Lab/sibling', 'c:/lab/sibling',
               'folder', 'Sibling', 2, 'system', '[]', '2026-07-17', '2026-07-17'
             );"
        ).expect("a sibling Run keeps its own identity");
    }

    #[test]
    fn fresh_database_has_complete_lp11_schema_and_final_version() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize fresh schema");
        assert_lp11_schema_current(&connection);
        run_migrations(&connection).expect("rerun fresh schema initialization");
        assert_lp11_schema_current(&connection);
    }

    #[test]
    fn upgrades_v29_by_removing_experiment_per_owner_manuscript_index() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "DROP INDEX idx_file_refs_identity;
                 CREATE UNIQUE INDEX idx_file_refs_identity
                   ON file_refs(owner_type, owner_id, path_identity_key, resource_kind, file_role);
                 CREATE UNIQUE INDEX idx_file_refs_experiment_managed_manuscript_owner
                   ON file_refs(owner_type, owner_id)
                   WHERE owner_type = 'experiment'
                     AND manuscript_channel = 'primary'
                     AND resource_kind = 'file'
                     AND file_role = 'manuscript'
                     AND location_mode = 'managed';
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version IN (30, 41);
                 PRAGMA user_version = 29;",
            )
            .expect("prepare v29 identity indexes");

        run_migrations(&connection).expect("upgrade v29 identity indexes");
        assert_lp11_schema_current(&connection);
    }

    #[test]
    fn upgrades_v30_by_removing_experiment_run_per_owner_manuscript_index() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "CREATE UNIQUE INDEX idx_file_refs_experiment_run_managed_manuscript_owner
                   ON file_refs(owner_type, owner_id)
                   WHERE owner_type = 'experimentRun'
                     AND manuscript_channel = 'primary'
                     AND resource_kind = 'file'
                     AND file_role = 'manuscript'
                     AND location_mode = 'managed';
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version IN (31, 41);
                 PRAGMA user_version = 30;",
            )
            .expect("prepare v30 ExperimentRun identity index");

        run_migrations(&connection).expect("upgrade v30 ExperimentRun identity index");
        assert_lp11_schema_current(&connection);
    }

    #[test]
    fn experiment_created_local_time_schema_is_required_checked_and_stable() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");

        for (table, column) in [
            ("experiments", "created_local_date"),
            ("experiments", "created_local_time"),
            ("experiment_runs", "created_local_date"),
            ("experiment_runs", "created_local_time"),
            ("experiments", "workspace_title_identity"),
            ("experiment_runs", "workspace_title_identity"),
        ] {
            assert!(
                column_is_not_null(&connection, table, column).expect("read column constraint"),
                "{table}.{column} must be NOT NULL"
            );
        }

        let missing = connection.execute_batch(
            "INSERT INTO experiments (
               id, project_id, experiment_name, machine_object, fault_type,
               sensor_config, data_path, result_summary, created_at, updated_at
             ) VALUES (
               'experiment-missing-time', 'project-a', 'Missing', '', 'unknown',
               '', '', '', '2026-07-17T01:05:00Z', '2026-07-17T01:05:00Z'
             );",
        );
        assert!(missing.is_err(), "missing frozen values must fail");

        for (suffix, identity_clause, values_clause) in [
            ("missing", "", ""),
            ("blank", ", workspace_title_identity", ", ''"),
        ] {
            let invalid_identity = connection.execute_batch(&format!(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, created_at, updated_at{identity_clause}
                 ) VALUES (
                   'experiment-invalid-identity-{suffix}', 'project-a', 'Invalid identity', '', 'unknown',
                   '', '', '', '2026-07-17', '0905',
                   '2026-07-17T01:05:00Z', '2026-07-17T01:05:00Z'{values_clause}
                 );"
            ));
            assert!(
                invalid_identity.is_err(),
                "missing and blank workspace-title identities must fail at the schema boundary"
            );
        }

        for (date, time) in [
            ("2026-02-30", "0905"),
            ("2026-07-17", "2400"),
            ("2026/07/17", "09:05"),
        ] {
            let invalid = connection.execute(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   ?1, 'project-a', 'Invalid', '', 'unknown', '', '', '',
                   ?2, ?3, '2026-07-17T01:05:00Z', '2026-07-17T01:05:00Z'
                 )",
                rusqlite::params![format!("experiment-{date}-{time}"), date, time],
            );
            assert!(invalid.is_err(), "{date} {time} must fail schema checks");
        }

        let marker: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 23",
                [],
                |row| row.get(0),
            )
            .expect("read migration marker");
        assert_eq!(marker, 1);

        let workspace_marker: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 24",
                [],
                |row| row.get(0),
            )
            .expect("read workspace-title identity migration marker");
        assert_eq!(workspace_marker, 1);
    }

    #[test]
    fn workspace_identity_v29_cleans_only_database_metadata_and_leaves_no_orphans() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, title, purpose, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary, created_local_date, created_local_time,
                   workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-v28-invalid', 'project-a', '开发测试', '开发测试', '开发测试', '',
                   'unknown', '', '', '', '2026-07-18', '1600', 'experiment',
                   '2026-07-18T08:00:00Z', '2026-07-18T08:00:00Z'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status, created_local_date,
                   created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-v28-invalid', 'experiment-v28-invalid', 'project-a', 'Run', 'planned',
                   '2026-07-18', '1601', 'run',
                   '2026-07-18T08:01:00Z', '2026-07-18T08:01:00Z'
                 );
                 INSERT INTO file_refs (
                   id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
                   location_mode, path, path_identity_key, file_type, title, schema_version,
                   source, custom_fields, created_at, updated_at
                 ) VALUES (
                   'file-v28-invalid', 'experiment', 'experiment-v28-invalid', 'primary',
                   'file', 'manuscript', 'managed', 'C:/Lab/experiment.md',
                   'c:/lab/experiment.md', 'markdown', 'experiment.md', 2, 'system', '[]',
                   '2026-07-18T08:00:00Z', '2026-07-18T08:00:00Z'
                 );
                 INSERT INTO manuscript_bindings (
                   id, owner_type, owner_id, manuscript_channel,
                   default_manuscript_file_ref_id, current_file_ref_id,
                   schema_version, created_at, updated_at
                 ) VALUES (
                   'binding-v28-invalid', 'experiment', 'experiment-v28-invalid', 'primary',
                   'file-v28-invalid', 'file-v28-invalid', 2,
                   '2026-07-18T08:00:00Z', '2026-07-18T08:00:00Z'
                 );
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version IN (29, 41);
                 PRAGMA user_version = 28;",
            )
            .expect("seed v28 invalid development metadata");

        run_migrations(&connection).expect("apply v29 destructive development metadata cleanup");
        for table in ["experiments", "experiment_runs", "file_refs", "manuscript_bindings"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .expect("count cleaned metadata");
            assert_eq!(count, 0, "{table} invalid metadata must be removed");
        }
        let foreign_key_violations: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
            .expect("check foreign keys");
        assert_eq!(foreign_key_violations, 0);
    }

    #[test]
    fn experiment_created_local_time_migration_freezes_legacy_rows_once() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'experiment-legacy-time', 'project-a', 'Legacy Experiment', '', 'unknown',
                   '', '', '', '1999-01-01', '0000', 'experiment-legacy-time',
                   '2026-07-17T01:05:45.678Z', '2026-07-17T01:05:45.678Z'
                 );
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, status,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES (
                   'run-legacy-time', 'experiment-legacy-time', 'project-a', 'Legacy Run', 'planned',
                   '1999-01-01', '0000', 'run-legacy-time',
                   '2026-07-18T15:59:00.000Z', '2026-07-18T15:59:00.000Z'
                 );
                 PRAGMA foreign_keys = OFF;
                 ALTER TABLE experiment_runs DROP COLUMN created_local_date;
                 ALTER TABLE experiment_runs DROP COLUMN created_local_time;
                 ALTER TABLE experiments DROP COLUMN created_local_date;
                 ALTER TABLE experiments DROP COLUMN created_local_time;
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version IN (23, 41);
                 PRAGMA user_version = 22;",
            )
            .expect("simulate schema 22 database without frozen fields");

        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("restore foreign key enforcement");
        let violations_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
            .expect("check simulated schema 22 foreign keys");
        assert_eq!(violations_before, 0, "schema 22 fixture must start valid");

        run_migrations(&connection).expect("migrate schema 22 database");

        let experiment: (String, String) = connection
            .query_row(
                "SELECT created_local_date, created_local_time
                 FROM experiments WHERE id = 'experiment-legacy-time'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated Experiment time");
        let run: (String, String) = connection
            .query_row(
                "SELECT created_local_date, created_local_time
                 FROM experiment_runs WHERE id = 'run-legacy-time'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated Run time");
        assert_eq!(experiment, ("2026-07-17".into(), "0105".into()));
        assert_eq!(run, ("2026-07-18".into(), "1559".into()));
    }

    #[test]
    fn literature_candidate_file_ref_metadata_is_formal_and_request_unique_per_owner() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, file_type, path, path_identity_key, title, description,
               candidate_request_id, candidate_occurred_at, schema_version, source,
               custom_fields, created_at, updated_at
             ) VALUES (
               'candidate-1', 'literature', 'lit-1', 'literature_outline', 'file', 'manuscript',
               'managed', 'markdown', 'C:/lit/candidate.md', 'c:/lit/candidate.md', 'candidate.md', NULL,
               'request-1', '2026-07-14T00:59:59+08:00', 2, 'ai',
               '[]', '2026-07-14', '2026-07-14'
             );",
        ).expect("insert Candidate FileRef");
        let metadata: (String, String, String, String) = connection.query_row(
            "SELECT candidate_request_id, candidate_occurred_at, manuscript_channel, source
             FROM file_refs WHERE id = 'candidate-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).expect("read Candidate metadata");
        assert_eq!(metadata, (
            "request-1".to_string(),
            "2026-07-14T00:59:59+08:00".to_string(),
            "literature_outline".to_string(),
            "ai".to_string(),
        ));
        let duplicate = connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, file_type, path, path_identity_key, title,
               candidate_request_id, candidate_occurred_at, schema_version, source,
               custom_fields, created_at, updated_at
             ) VALUES (
               'candidate-2', 'literature', 'lit-1', 'dedicated_notes', 'file', 'manuscript',
               'managed', 'markdown', 'C:/lit/other.md', 'c:/lit/other.md', 'other.md',
               'request-1', '2026-07-14T01:00:00+08:00', 2, 'user',
               '[]', '2026-07-14', '2026-07-14'
             );",
        );
        assert!(duplicate.is_err(), "one request ID must not produce two FileRefs for one owner");
    }

    #[test]
    fn migrates_literature_binding_to_outline_channel_and_allows_shared_folder_dual_bindings() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, file_type, path, path_identity_key, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES
               ('folder-1', 'literature', 'lit-1', 'primary', 'folder', 'defaultFolder',
                'managed', 'folder', 'C:/lit', 'c:/lit', 'Workspace', 2,
                'system', '[]', '2026-07-13', '2026-07-13'),
               ('outline-1', 'literature', 'lit-1', 'primary', 'file', 'manuscript',
                'managed', 'markdown', 'C:/lit/body.md', 'c:/lit/body.md', 'body.md', 2,
                'system', '[]', '2026-07-13', '2026-07-13'),
               ('notes-1', 'literature', 'lit-1', 'dedicated_notes', 'file', 'manuscript',
                'managed', 'markdown', 'C:/lit/dedicated-notes.md', 'c:/lit/dedicated-notes.md', 'Dedicated Notes', 2,
                'system', '[]', '2026-07-13', '2026-07-13');
             DROP TABLE manuscript_bindings;",
        ).expect("prepare legacy Literature refs");
        connection.execute_batch(MANUSCRIPT_BINDING_SCHEMA_SQL).expect("create v18 binding schema");
        connection.execute_batch(
            "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, default_folder_file_ref_id,
               default_manuscript_file_ref_id, current_file_ref_id,
               schema_version, created_at, updated_at
             ) VALUES (
               'binding-outline', 'literature', 'lit-1', 'folder-1',
               'outline-1', 'outline-1', 1, '2026-07-13', '2026-07-13'
             );
             DROP TABLE manuscript_provisioning_step_progress;
             DROP TABLE manuscript_provisioning_step_plans;
             DROP TABLE manuscript_provisioning_literature_child_states;
             DELETE FROM schema_migrations WHERE version IN (19, 41);
             PRAGMA user_version = 18;",
        ).expect("prepare v18 binding row");

        run_migrations(&connection).expect("migrate Literature binding channel");
        let migrated_channel: String = connection.query_row(
            "SELECT manuscript_channel FROM manuscript_bindings WHERE id = 'binding-outline'",
            [],
            |row| row.get(0),
        ).expect("read migrated channel");
        assert_eq!(migrated_channel, "literature_outline");
        let file_channel: String = connection.query_row(
            "SELECT manuscript_channel FROM file_refs WHERE id = 'outline-1'",
            [],
            |row| row.get(0),
        ).expect("read migrated FileRef channel");
        assert_eq!(file_channel, "literature_outline");

        connection.execute(
            "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, manuscript_channel, default_folder_file_ref_id,
               default_manuscript_file_ref_id, current_file_ref_id,
               schema_version, created_at, updated_at
             ) VALUES (
               'binding-notes', 'literature', 'lit-1', 'dedicated_notes', 'folder-1',
               'notes-1', 'notes-1', 2, '2026-07-13', '2026-07-13'
             )",
            [],
        ).expect("insert second channel sharing workspace");
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM manuscript_bindings WHERE owner_type = 'literature' AND owner_id = 'lit-1'",
            [],
            |row| row.get(0),
        ).expect("count dual bindings");
        assert_eq!(count, 2);
        run_migrations(&connection).expect("rerun dual-channel migration");
        let preserved: i64 = connection.query_row(
            "SELECT COUNT(*) FROM manuscript_bindings WHERE owner_type = 'literature' AND owner_id = 'lit-1'",
            [],
            |row| row.get(0),
        ).expect("count preserved dual bindings");
        assert_eq!(preserved, 2);
    }

    #[test]
    fn repairs_a7_primary_channel_partial_metadata_and_allows_idempotent_retry() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection.execute_batch(
            "INSERT INTO file_refs (
               id, owner_type, owner_id, manuscript_channel, resource_kind, file_role,
               location_mode, file_type, path, path_identity_key, title, schema_version,
               source, custom_fields, created_at, updated_at
             ) VALUES
               ('partial-folder', 'literature', 'partial-lit', 'primary', 'folder', 'defaultFolder',
                'managed', 'folder', 'C:\\partial-lit', 'c:/partial-lit', 'Workspace', 2,
                'system', '[]', '2026-07-14', '2026-07-14'),
               ('partial-outline', 'literature', 'partial-lit', 'primary', 'file', 'manuscript',
                'managed', 'markdown', 'C:\\partial-lit\\literature-outline.md',
                'c:/partial-lit/literature-outline.md', 'Literature Outline', 2,
                'system', '[]', '2026-07-14', '2026-07-14'),
               ('partial-notes', 'literature', 'partial-lit', 'primary', 'file', 'manuscript',
                'managed', 'markdown', 'C:\\partial-lit\\dedicated-notes.md',
                'c:/partial-lit/dedicated-notes.md', 'Dedicated Notes', 2,
                'system', '[]', '2026-07-14', '2026-07-14');
             INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, manuscript_channel, default_folder_file_ref_id,
               default_manuscript_file_ref_id, current_file_ref_id,
               schema_version, created_at, updated_at
             ) VALUES (
               'partial-binding', 'literature', 'partial-lit', 'primary', NULL,
               NULL, NULL, 2, '2026-07-14', '2026-07-14'
             );
             DROP TABLE manuscript_provisioning_step_progress;
             DROP TABLE manuscript_provisioning_step_plans;
             DROP TABLE manuscript_provisioning_literature_child_states;
             DELETE FROM schema_migrations WHERE version IN (20, 41);
             PRAGMA user_version = 19;",
        ).expect("prepare A7 partial metadata");

        run_migrations(&connection).expect("repair A7 partial metadata");
        let outline_channel: String = connection.query_row(
            "SELECT manuscript_channel FROM file_refs WHERE id = 'partial-outline'",
            [],
            |row| row.get(0),
        ).expect("read repaired outline channel");
        let notes_channel: String = connection.query_row(
            "SELECT manuscript_channel FROM file_refs WHERE id = 'partial-notes'",
            [],
            |row| row.get(0),
        ).expect("read repaired notes channel");
        let binding_channel: String = connection.query_row(
            "SELECT manuscript_channel FROM manuscript_bindings WHERE id = 'partial-binding'",
            [],
            |row| row.get(0),
        ).expect("read repaired binding channel");
        assert_eq!(outline_channel, "literature_outline");
        assert_eq!(notes_channel, "dedicated_notes");
        assert_eq!(binding_channel, "literature_outline");

        connection.execute(
            "UPDATE manuscript_bindings
             SET default_folder_file_ref_id = 'partial-folder',
                 default_manuscript_file_ref_id = 'partial-outline',
                 current_file_ref_id = 'partial-outline'
             WHERE id = 'partial-binding'",
            [],
        ).expect("retry fills the repaired outline binding");
        connection.execute(
            "INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, manuscript_channel, default_folder_file_ref_id,
               default_manuscript_file_ref_id, current_file_ref_id,
               schema_version, created_at, updated_at
             ) VALUES (
               'partial-notes-binding', 'literature', 'partial-lit', 'dedicated_notes',
               'partial-folder', 'partial-notes', 'partial-notes', 2,
               '2026-07-14', '2026-07-14'
             )",
            [],
        ).expect("retry inserts only the missing dedicated-notes binding");
        run_migrations(&connection).expect("rerun repaired dual-channel schema");
        let binding_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM manuscript_bindings
             WHERE owner_type = 'literature' AND owner_id = 'partial-lit'",
            [],
            |row| row.get(0),
        ).expect("count repaired bindings");
        assert_eq!(binding_count, 2);
    }

    #[test]
    fn current_v41_exact_validator_rejects_missing_lp11_tables_without_repair() {
        for missing in [
            vec!["manuscript_bindings"],
            vec!["managed_root_settings"],
            vec!["manuscript_bindings", "managed_root_settings"],
        ] {
            let connection = Connection::open_in_memory().expect("open database");
            run_migrations(&connection).expect("initialize current schema");
            for table in missing {
                connection
                    .execute_batch(&format!("DROP TABLE {table};"))
                    .expect("drop LP11 table");
            }
            connection
                .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
                .expect("retain latest user version");
            let error = run_migrations(&connection)
                .expect_err("current v41 validator must not repair missing tables");
            assert_eq!(error.code, "DB_REQUIRED_TABLE_MISSING");
        }
    }

    #[test]
    fn repairs_pre_lp11_partial_schema_and_missing_indexes() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "DROP TABLE manuscript_bindings;
                 DROP TABLE managed_root_settings;
                 DROP TABLE manuscript_provisioning_step_progress;
                 DROP TABLE manuscript_provisioning_step_plans;
                 DROP TABLE manuscript_provisioning_literature_child_states;
                 DELETE FROM schema_migrations WHERE version IN (17, 18, 41);
                 PRAGMA user_version = 16;",
            )
            .expect("downgrade to partial pre-LP11 schema");
        run_migrations(&connection).expect("upgrade partial pre-LP11 schema");
        assert_lp11_schema_current(&connection);

        connection
            .execute_batch(
                "DROP INDEX idx_manuscript_bindings_default_folder;
                 DROP INDEX idx_manuscript_bindings_default_manuscript;
                 DROP INDEX idx_manuscript_bindings_current;
                 DROP INDEX idx_file_refs_identity;",
            )
            .expect("drop required indexes");
        downgrade_v41_fixture_for_legacy_repair(&connection, 16);
        run_migrations(&connection).expect("repair missing indexes");
        assert_lp11_schema_current(&connection);

        connection
            .execute_batch(
                "DROP INDEX idx_manuscript_bindings_default_folder;
                 CREATE INDEX idx_manuscript_bindings_default_folder
                 ON manuscript_bindings(owner_id);
                 DROP INDEX idx_manuscript_bindings_current;
                 CREATE UNIQUE INDEX idx_manuscript_bindings_current
                 ON manuscript_bindings(owner_id);
                 DROP INDEX idx_file_refs_identity;
                 CREATE INDEX idx_file_refs_identity ON file_refs(owner_id);",
            )
            .expect("replace required indexes with malformed same-name definitions");
        downgrade_v41_fixture_for_legacy_repair(&connection, 16);
        run_migrations(&connection).expect("repair malformed same-name indexes");
        assert_lp11_schema_current(&connection);
    }

    #[test]
    fn rebuilds_malformed_lp11_tables_to_formal_contracts() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "DROP TABLE manuscript_bindings;
                 CREATE TABLE manuscript_bindings (id TEXT PRIMARY KEY, owner_type TEXT);
                 DROP TABLE managed_root_settings;
                 CREATE TABLE managed_root_settings (id TEXT PRIMARY KEY, configured_root TEXT);",
            )
            .expect("create malformed LP11 tables");
        downgrade_v41_fixture_for_legacy_repair(&connection, 16);
        run_migrations(&connection).expect("rebuild malformed LP11 tables");
        assert_lp11_schema_current(&connection);
    }

    #[test]
    fn interrupted_file_identity_migration_deduplicates_and_completes() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize current schema");
        connection
            .execute_batch(
                "DROP INDEX idx_file_refs_identity;
                 INSERT INTO file_refs (
                   id, owner_type, owner_id, resource_kind, file_role, location_mode,
                   file_type, path, path_identity_key, title, schema_version, source,
                   custom_fields, created_at, updated_at
                 ) VALUES
                 ('duplicate-old', 'literature', 'lit-1', 'file', 'attachment', 'external',
                  'pdf', 'C:/Paper.pdf', 'c:/paper.pdf', 'Paper old', 2, 'user', '[]',
                  '2026-01-01', '2026-01-01'),
                 ('duplicate-new', 'literature', 'lit-1', 'file', 'attachment', 'external',
                  'pdf', 'C:/Paper.pdf', 'c:/paper.pdf', 'Paper new', 2, 'user', '[]',
                  '2026-01-02', '2026-01-02');
                  DROP TABLE manuscript_provisioning_step_progress;
                  DROP TABLE manuscript_provisioning_step_plans;
                  DROP TABLE manuscript_provisioning_literature_child_states;
                  DELETE FROM schema_migrations WHERE version = 41;
                  PRAGMA user_version = 18;",
            )
            .expect("simulate interrupted v17 migration");
        run_migrations(&connection).expect("complete interrupted v17 migration");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM file_refs
                 WHERE owner_type = 'literature' AND owner_id = 'lit-1'
                   AND path_identity_key = 'c:/paper.pdf'",
                [],
                |row| row.get(0),
            )
            .expect("count deduplicated FileRefs");
        assert_eq!(count, 1);
        assert_lp11_schema_current(&connection);
    }

    #[test]
    fn managed_root_and_binding_empty_and_upsert_smoke() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize schema");
        let missing_binding: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_bindings
                 WHERE owner_type = 'literature' AND owner_id = 'missing'",
                [],
                |row| row.get(0),
            )
            .expect("query missing binding");
        assert_eq!(missing_binding, 0);
        let missing_root: i64 = connection
            .query_row("SELECT COUNT(*) FROM managed_root_settings", [], |row| {
                row.get(0)
            })
            .expect("query unconfigured root");
        assert_eq!(missing_root, 0);

        connection
            .execute_batch(
                "INSERT INTO managed_root_settings (
                   id, configured_root, schema_version, created_at, updated_at
                 ) VALUES ('managed-root', 'C:/LabPod', 1, '2026-01-01', '2026-01-01')
                 ON CONFLICT(id) DO UPDATE SET
                   configured_root = excluded.configured_root,
                   updated_at = excluded.updated_at;",
            )
            .expect("upsert managed root");
        run_migrations(&connection).expect("restart after root configuration");
        let configured_root: String = connection
            .query_row(
                "SELECT configured_root FROM managed_root_settings WHERE id = 'managed-root'",
                [],
                |row| row.get(0),
            )
            .expect("read persisted root");
        assert_eq!(configured_root, "C:/LabPod");
    }

    #[test]
    fn save_as_v48_fresh_v42_chain_v43_upgrade_and_reopen_remove_private_j0() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize v48");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        assert!(super::super::manuscript_save_as_operation::schema_is_current(&connection).unwrap());
        assert!(!table_exists(&connection, "experiment_manuscript_save_as_operations").unwrap());
        assert!(!table_exists(&connection, "experiment_run_manuscript_save_as_operations").unwrap());

        super::super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(
            &connection,
        )
        .expect("remove v53 foundation from isolated v42 fixture");

        connection
            .execute_batch(
                LEGACY_EXPERIMENT_PRIVATE_SAVE_AS_SCHEMA_SQL,
            )
            .expect("recreate isolated v42 Experiment private authority");
        connection
            .execute_batch(LEGACY_RUN_PRIVATE_SAVE_AS_SCHEMA_SQL)
            .expect("recreate isolated v42 Run private authority");
        connection
            .execute_batch(
                 "DROP INDEX idx_manuscript_save_as_operations_reconcilable_order;
                  CREATE INDEX idx_manuscript_save_as_operations_reconciliation_updated
                  ON manuscript_save_as_operations(reconciliation_state,updated_at);
                  DELETE FROM schema_migrations WHERE version=45;
                  INSERT INTO experiment_manuscript_save_as_operations
                   (operation_id,experiment_id,target_path_identity,phase,record_json,created_at,updated_at)
                 VALUES ('legacy','exp','target','prepared','{}','x','x');
                 PRAGMA user_version=42;",
            )
            .expect("populate isolated v42");
        run_migrations(&connection).expect("upgrade populated v42 through v48");
        run_migrations(&connection).expect("reopen v48 idempotently");
        assert!(super::super::manuscript_save_as_operation::schema_is_current(&connection).unwrap());
        assert!(!table_exists(&connection, "experiment_manuscript_save_as_operations").unwrap());
        assert!(!table_exists(&connection, "experiment_run_manuscript_save_as_operations").unwrap());

        super::super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(
            &connection,
        )
        .expect("remove v53 foundation from isolated v43 fixture");
        connection
            .execute_batch(&format!(
                "{LEGACY_RUN_PRIVATE_SAVE_AS_SCHEMA_SQL}
                 DROP INDEX idx_manuscript_save_as_operations_reconcilable_order;
                 CREATE INDEX idx_manuscript_save_as_operations_reconciliation_updated
                 ON manuscript_save_as_operations(reconciliation_state,updated_at);
                 DELETE FROM schema_migrations WHERE version=45;"
            ))
            .expect("recreate isolated v43 Run private authority");
        connection
            .pragma_update(
                None,
                "user_version",
                EXPERIMENT_PRIVATE_SAVE_AS_REMOVAL_SCHEMA_VERSION,
            )
            .expect("set isolated v43");
        run_migrations(&connection).expect("upgrade v43 to v48");
        assert!(!table_exists(&connection, "experiment_run_manuscript_save_as_operations").unwrap());
    }

    #[test]
    fn save_as_v48_to_v49_fails_closed_with_bare_d2_and_does_not_advance_version() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize v49");
        connection.execute_batch(
            "INSERT INTO manuscript_save_as_operations (
               operation_id,revision,commit_fence_revision,operation_generation,
               producer_process_generation,owner_type,owner_id,channel,source_window_role,
               source_file_ref_id,source_path_identity_key,source_revision,
               source_runtime_generation,snapshot_sha256,snapshot_byte_length,
               encoding_contract_version,newline_contract_version,target_display_path,
               target_path_identity_key,target_location_mode,target_parent_path_identity_key,
               target_parent_physical_identity_hash,d1_physical_identity_hash,
               d1_readback_sha256,d1_readback_revision,d1_byte_length,d1_proof_generation,
               stage,d1_commit_state,d2_commit_state,reconciliation_state,
               claim_token,claim_revision,claim_process_generation,
               observation_generation,observation_revision,created_at,updated_at
             ) VALUES (
               'v48-bare-d2',3,0,1,'producer','review','owner','primary','current',
               'source-ref','source-path','source-r1',1,
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',4,
               'utf-8-v1','lf-v1','target.md','target-path','external','parent-path',
               'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
               'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               'd1-r1',4,1,'d2_commit_unknown','confirmed','unknown','pending',
               'claim',0,'producer',0,0,
               '2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z'
             );
             PRAGMA user_version=48;",
        ).expect("construct v48 bare D2 fixture");
        let error = run_migrations(&connection).expect_err("bare D2 must block v49 migration");
        assert_eq!(error.code, "D2_UNKNOWN_ACTIVE_ROW_MIGRATION_BLOCKED");
        assert_eq!(
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(),
            48
        );
        assert_eq!(
            connection.query_row(
                "SELECT stage FROM manuscript_save_as_operations WHERE operation_id='v48-bare-d2'",
                [], |row| row.get::<_, String>(0),
            ).unwrap(),
            "d2_commit_unknown"
        );
    }

    #[test]
    fn save_as_v46_to_v48_rebuilds_operation_check_for_compensation_terminal() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize v48");
        super::super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(
            &connection,
        )
        .expect("remove v53 foundation from isolated v46 fixture");
        connection
            .execute_batch(
                "DROP TABLE manuscript_save_as_finalizations;
                 DROP TABLE manuscript_save_as_candidate_custody;
                 DROP TABLE manuscript_save_as_operations;
                 DELETE FROM schema_migrations WHERE version IN (47,48);",
            )
            .expect("remove v47-only structures");
        let legacy_operation_schema =
            super::super::manuscript_save_as_operation::SAVE_AS_OPERATION_SCHEMA_SQL
                .replace(", 'finalization_compensated'", "");
        connection
            .execute_batch(&legacy_operation_schema)
            .expect("create exact v46 operation contract");
        super::super::manuscript_save_as_candidate_custody::apply_schema_migration(
            &connection,
        )
        .expect("create v46 custody contract");
        connection
            .pragma_update(
                None,
                "user_version",
                SAVE_AS_CANDIDATE_CUSTODY_SCHEMA_VERSION,
            )
            .expect("set v46 user version");

        assert!(
            super::super::manuscript_save_as_operation::legacy_v46_schema_is_current(
                &connection
            )
            .unwrap()
        );

        run_migrations(&connection).expect("upgrade exact v46 through v48");
        assert!(
            super::super::manuscript_save_as_operation::schema_is_current(&connection)
                .unwrap()
        );
        assert!(
            super::super::manuscript_save_as_candidate_custody::schema_is_current(
                &connection
            )
            .unwrap()
        );
        assert!(
            super::super::manuscript_save_as_finalization::schema_is_current(&connection)
                .unwrap()
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn save_as_v47_to_v48_replaces_non_exact_finalization_acceptance() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize v48");
        super::super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(
            &connection,
        )
        .expect("remove v53 foundation from isolated v47 fixture");
        connection
            .execute_batch(
                "DROP TABLE manuscript_save_as_finalizations;
                 DELETE FROM schema_migrations WHERE version=48;
                 CREATE TABLE manuscript_save_as_finalizations (
                   operation_id TEXT PRIMARY KEY,
                   finalization_request_id TEXT,
                   claim_namespace TEXT CHECK (
                     claim_namespace IS NULL OR claim_namespace='save_as_finalization'
                   )
                 );
                 PRAGMA user_version=47;",
            )
            .expect("construct exact admission shape for v47 finalization");
        assert!(
            super::super::manuscript_save_as_finalization::legacy_v47_schema_is_current(
                &connection
            )
            .unwrap()
        );
        run_migrations(&connection).expect("upgrade v47 through v48");
        assert!(
            super::super::manuscript_save_as_finalization::schema_is_current(
                &connection
            )
            .unwrap()
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn current_v45_validator_rejects_tampered_shared_index_without_repair() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize v45");
        connection
            .execute_batch("DROP INDEX uq_manuscript_save_as_operations_active_target;")
            .expect("tamper v42");
        let error = run_migrations(&connection).expect_err("current v45 must reject tamper");
        assert_eq!(error.code, "DB_SCHEMA_INVARIANT_FAILED");
        let index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='uq_manuscript_save_as_operations_active_target'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 0);
    }

    #[test]
    fn provisioning_contract_is_version_independent_but_global_authority_is_exact_v42() {
        let connection = Connection::open_in_memory().expect("open database");
        run_migrations(&connection).expect("initialize v42");
        assert!(validate_global_schema_current(&connection).is_ok());
        assert!(
            super::super::manuscript_provisioning_operation_state::step_progress_schema::
                validate_provisioning_contract(&connection)
                .unwrap()
        );

        for non_current_version in [41, CURRENT_SCHEMA_VERSION + 1] {
            connection
                .pragma_update(None, "user_version", non_current_version)
                .expect("set non-current global version");
            assert!(
                super::super::manuscript_provisioning_operation_state::step_progress_schema::
                    validate_provisioning_contract(&connection)
                    .unwrap(),
                "embedded provisioning contract must ignore global user_version"
            );
            let error = validate_global_schema_current(&connection)
                .expect_err("global authority must reject every non-current version");
            assert_eq!(error.code, "DB_SCHEMA_VERSION_INVALID");
        }

        connection
            .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
            .expect("restore current global version");
        connection
            .execute_batch("DROP INDEX uq_manuscript_provisioning_step_plan_operation;")
            .expect("tamper provisioning contract");
        assert!(
            !super::super::manuscript_provisioning_operation_state::step_progress_schema::
                validate_provisioning_contract(&connection)
                .unwrap()
        );
        assert!(validate_global_schema_current(&connection).is_err());
    }
}

const CURRENT_FILE_REFS_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS file_refs (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL DEFAULT 'file' CHECK (resource_kind IN ('file', 'folder')),
  file_role TEXT NOT NULL DEFAULT 'attachment' CHECK (file_role IN ('manuscript', 'defaultFolder', 'attachment')),
  location_mode TEXT NOT NULL DEFAULT 'external' CHECK (location_mode IN ('managed', 'external')),
  file_type TEXT NOT NULL,
  path TEXT NOT NULL,
  path_identity_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT,
  candidate_request_id TEXT,
  candidate_occurred_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_refs_owner ON file_refs(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_file_refs_deleted_at ON file_refs(deleted_at);
"#;

const MANUSCRIPT_BINDING_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS manuscript_bindings (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  default_folder_file_ref_id TEXT,
  default_manuscript_file_ref_id TEXT,
  current_file_ref_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(owner_type, owner_id),
  FOREIGN KEY (default_folder_file_ref_id) REFERENCES file_refs(id) ON DELETE RESTRICT,
  FOREIGN KEY (default_manuscript_file_ref_id) REFERENCES file_refs(id) ON DELETE RESTRICT,
  FOREIGN KEY (current_file_ref_id) REFERENCES file_refs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_manuscript_bindings_default_folder
ON manuscript_bindings(default_folder_file_ref_id);
CREATE INDEX IF NOT EXISTS idx_manuscript_bindings_default_manuscript
ON manuscript_bindings(default_manuscript_file_ref_id);
CREATE INDEX IF NOT EXISTS idx_manuscript_bindings_current
ON manuscript_bindings(current_file_ref_id);
INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (17, 'file_identity_and_current_manuscript_binding');
"#;

fn deduplicate_file_ref_identities(connection: &Connection) -> Result<()> {
    let rows = {
        let mut statement = connection.prepare(
            "SELECT id, owner_type, owner_id, path_identity_key, resource_kind, file_role
             FROM file_refs
             ORDER BY owner_type, owner_id, path_identity_key, resource_kind, file_role,
                      (deleted_at IS NOT NULL), updated_at DESC, id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>>>()?;
        rows
    };
    let mut canonical_by_identity =
        HashMap::<(String, String, String, String, String), String>::new();
    for (id, owner_type, owner_id, path_identity_key, resource_kind, file_role) in rows {
        let identity = (
            owner_type,
            owner_id,
            path_identity_key,
            resource_kind,
            file_role,
        );
        if let Some(canonical_id) = canonical_by_identity.get(&identity) {
            if table_exists(connection, "result_items")?
                && column_exists(connection, "result_items", "file_ref_id")?
            {
                connection.execute(
                    "UPDATE result_items SET file_ref_id = ?1 WHERE file_ref_id = ?2",
                    rusqlite::params![canonical_id, id],
                )?;
            }
            if table_exists(connection, "manuscript_bindings")? {
                for column in [
                    "default_folder_file_ref_id",
                    "default_manuscript_file_ref_id",
                    "current_file_ref_id",
                ] {
                    if column_exists(connection, "manuscript_bindings", column)? {
                        let sql = format!(
                            "UPDATE manuscript_bindings SET {column} = ?1 WHERE {column} = ?2"
                        );
                        connection.execute(&sql, rusqlite::params![canonical_id, id])?;
                    }
                }
            }
            connection.execute("DELETE FROM file_refs WHERE id = ?1", [&id])?;
        } else {
            canonical_by_identity.insert(identity, id);
        }
    }
    Ok(())
}

fn manuscript_binding_schema_is_current(connection: &Connection) -> Result<bool> {
    if !table_has_exact_columns(
        connection,
        "manuscript_bindings",
        &[
            "id",
            "owner_type",
            "owner_id",
            "default_folder_file_ref_id",
            "default_manuscript_file_ref_id",
            "current_file_ref_id",
            "schema_version",
            "created_at",
            "updated_at",
            "deleted_at",
        ],
    )? {
        return Ok(false);
    }
    let normalized_sql = table_sql(connection, "manuscript_bindings")?
        .unwrap_or_default()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<String>();
    Ok(normalized_sql.contains("unique(owner_type,owner_id)")
        && normalized_sql
            .matches("referencesfile_refs(id)ondeleterestrict")
            .count()
            == 3)
}

fn manuscript_channel_schema_is_current(connection: &Connection) -> Result<bool> {
    let base_columns = [
        "id",
        "owner_type",
        "owner_id",
        "manuscript_channel",
        "default_folder_file_ref_id",
        "default_manuscript_file_ref_id",
        "current_file_ref_id",
        "schema_version",
        "created_at",
        "updated_at",
        "deleted_at",
    ];
    let mut durable_columns = base_columns.to_vec();
    durable_columns.push("revision");
    if !table_has_exact_columns(connection, "manuscript_bindings", &base_columns)?
        && !table_has_exact_columns(connection, "manuscript_bindings", &durable_columns)?
    {
        return Ok(false);
    }
    let normalized_sql = table_sql(connection, "manuscript_bindings")?
        .unwrap_or_default()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<String>();
    Ok(normalized_sql.contains("unique(owner_type,owner_id,manuscript_channel)")
        && normalized_sql.contains("check(manuscript_channelin('primary','literature_outline','dedicated_notes'))")
        && normalized_sql
            .matches("referencesfile_refs(id)ondeleterestrict")
            .count()
            == 3)
}

fn apply_file_identity_binding_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch(CURRENT_FILE_REFS_TABLE_SQL)?;

    add_column_if_missing(
        connection,
        "file_refs",
        "resource_kind",
        "TEXT NOT NULL DEFAULT 'file' CHECK (resource_kind IN ('file', 'folder'))",
    )?;
    add_column_if_missing(
        connection,
        "file_refs",
        "file_role",
        "TEXT NOT NULL DEFAULT 'attachment' CHECK (file_role IN ('manuscript', 'defaultFolder', 'attachment'))",
    )?;
    add_column_if_missing(
        connection,
        "file_refs",
        "location_mode",
        "TEXT NOT NULL DEFAULT 'external' CHECK (location_mode IN ('managed', 'external'))",
    )?;
    add_column_if_missing(
        connection,
        "file_refs",
        "path_identity_key",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    let legacy_paths = {
        let mut statement =
            connection.prepare("SELECT id, path FROM file_refs WHERE path_identity_key = ''")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>>>()?;
        rows
    };
    for (id, path) in legacy_paths {
        connection.execute(
            "UPDATE file_refs SET path_identity_key = ?1 WHERE id = ?2",
            rusqlite::params![migration_path_identity_key(&path), id],
        )?;
    }

    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_file_refs_experiment_id; DROP INDEX IF EXISTS idx_file_refs_run_id;",
    )?;
    if column_exists(connection, "file_refs", "experiment_id")? {
        connection.execute_batch("ALTER TABLE file_refs DROP COLUMN experiment_id;")?;
    }
    if column_exists(connection, "file_refs", "run_id")? {
        connection.execute_batch("ALTER TABLE file_refs DROP COLUMN run_id;")?;
    }

    deduplicate_file_ref_identities(connection)?;

    if table_exists(connection, "manuscript_bindings")?
        && !manuscript_binding_schema_is_current(connection)?
        && !manuscript_channel_schema_is_current(connection)?
    {
        connection.execute_batch("DROP TABLE manuscript_bindings;")?;
    }

    ensure_named_index(
        connection,
        "file_refs",
        "idx_file_refs_identity",
        &[
            "owner_type",
            "owner_id",
            "path_identity_key",
            "resource_kind",
            "file_role",
        ],
        true,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_file_refs_identity
         ON file_refs(owner_type, owner_id, path_identity_key, resource_kind, file_role);",
    )?;
    connection.execute_batch(MANUSCRIPT_BINDING_SCHEMA_SQL)?;
    ensure_named_index(
        connection,
        "manuscript_bindings",
        "idx_manuscript_bindings_default_folder",
        &["default_folder_file_ref_id"],
        false,
        "CREATE INDEX IF NOT EXISTS idx_manuscript_bindings_default_folder
         ON manuscript_bindings(default_folder_file_ref_id);",
    )?;
    ensure_named_index(
        connection,
        "manuscript_bindings",
        "idx_manuscript_bindings_default_manuscript",
        &["default_manuscript_file_ref_id"],
        false,
        "CREATE INDEX IF NOT EXISTS idx_manuscript_bindings_default_manuscript
         ON manuscript_bindings(default_manuscript_file_ref_id);",
    )?;
    ensure_named_index(
        connection,
        "manuscript_bindings",
        "idx_manuscript_bindings_current",
        &["current_file_ref_id"],
        false,
        "CREATE INDEX IF NOT EXISTS idx_manuscript_bindings_current
         ON manuscript_bindings(current_file_ref_id);",
    )?;
    Ok(())
}

fn apply_manuscript_channel_schema_migration(connection: &Connection) -> Result<()> {
    add_column_if_missing(
        connection,
        "file_refs",
        "manuscript_channel",
        "TEXT NOT NULL DEFAULT 'primary' CHECK (manuscript_channel IN ('primary', 'literature_outline', 'dedicated_notes'))",
    )?;

    connection.execute(
        "UPDATE file_refs SET manuscript_channel = 'literature_outline'
         WHERE owner_type = 'literature' AND file_role = 'manuscript'
           AND manuscript_channel = 'primary'",
        [],
    )?;

    if !manuscript_channel_schema_is_current(connection)? {
        connection.execute_batch(
            "ALTER TABLE manuscript_bindings RENAME TO manuscript_bindings_v18;
             CREATE TABLE manuscript_bindings (
               id TEXT PRIMARY KEY,
               owner_type TEXT NOT NULL,
               owner_id TEXT NOT NULL,
               manuscript_channel TEXT NOT NULL DEFAULT 'primary'
                 CHECK (manuscript_channel IN ('primary', 'literature_outline', 'dedicated_notes')),
               default_folder_file_ref_id TEXT,
               default_manuscript_file_ref_id TEXT,
               current_file_ref_id TEXT,
               schema_version INTEGER NOT NULL DEFAULT 2,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               deleted_at TEXT,
               UNIQUE(owner_type, owner_id, manuscript_channel),
               FOREIGN KEY (default_folder_file_ref_id) REFERENCES file_refs(id) ON DELETE RESTRICT,
               FOREIGN KEY (default_manuscript_file_ref_id) REFERENCES file_refs(id) ON DELETE RESTRICT,
               FOREIGN KEY (current_file_ref_id) REFERENCES file_refs(id) ON DELETE RESTRICT
             );
             INSERT INTO manuscript_bindings (
               id, owner_type, owner_id, manuscript_channel,
               default_folder_file_ref_id, default_manuscript_file_ref_id, current_file_ref_id,
               schema_version, created_at, updated_at, deleted_at
             )
             SELECT id, owner_type, owner_id,
               CASE WHEN owner_type = 'literature' THEN 'literature_outline' ELSE 'primary' END,
               default_folder_file_ref_id, default_manuscript_file_ref_id, current_file_ref_id,
               2, created_at, updated_at, deleted_at
             FROM manuscript_bindings_v18;
             DROP TABLE manuscript_bindings_v18;",
        )?;
    }

    for (name, column) in [
        ("idx_manuscript_bindings_default_folder", "default_folder_file_ref_id"),
        ("idx_manuscript_bindings_default_manuscript", "default_manuscript_file_ref_id"),
        ("idx_manuscript_bindings_current", "current_file_ref_id"),
    ] {
        let sql = format!("CREATE INDEX IF NOT EXISTS {name} ON manuscript_bindings({column});");
        connection.execute_batch(&sql)?;
    }
    connection.execute_batch(
        "INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (19, 'manuscript_channel_schema');",
    )?;
    Ok(())
}

fn apply_literature_channel_partial_repair_migration(connection: &Connection) -> Result<()> {
    let already_applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = 20",
        [],
        |row| row.get(0),
    )?;
    if already_applied == 1 {
        return Ok(());
    }
    connection.execute_batch(
        r#"
        UPDATE file_refs
        SET manuscript_channel = 'dedicated_notes'
        WHERE owner_type = 'literature'
          AND file_role = 'manuscript'
          AND manuscript_channel IN ('primary', 'literature_outline')
          AND lower(replace(path, '\', '/')) GLOB '*/dedicated-notes*.md';

        UPDATE file_refs
        SET manuscript_channel = 'literature_outline'
        WHERE owner_type = 'literature'
          AND file_role = 'manuscript'
          AND manuscript_channel = 'primary';

        UPDATE manuscript_bindings
        SET manuscript_channel = 'literature_outline',
            schema_version = 2
        WHERE owner_type = 'literature'
          AND manuscript_channel = 'primary'
          AND NOT EXISTS (
            SELECT 1
            FROM manuscript_bindings AS existing_outline
            WHERE existing_outline.owner_type = manuscript_bindings.owner_type
              AND existing_outline.owner_id = manuscript_bindings.owner_id
              AND existing_outline.manuscript_channel = 'literature_outline'
          );

        UPDATE manuscript_bindings AS outline_binding
        SET default_folder_file_ref_id = COALESCE(
              outline_binding.default_folder_file_ref_id,
              (SELECT primary_binding.default_folder_file_ref_id
               FROM manuscript_bindings AS primary_binding
               WHERE primary_binding.owner_type = outline_binding.owner_type
                 AND primary_binding.owner_id = outline_binding.owner_id
                 AND primary_binding.manuscript_channel = 'primary')
            ),
            default_manuscript_file_ref_id = COALESCE(
              outline_binding.default_manuscript_file_ref_id,
              (SELECT primary_binding.default_manuscript_file_ref_id
               FROM manuscript_bindings AS primary_binding
               WHERE primary_binding.owner_type = outline_binding.owner_type
                 AND primary_binding.owner_id = outline_binding.owner_id
                 AND primary_binding.manuscript_channel = 'primary')
            ),
            current_file_ref_id = COALESCE(
              outline_binding.current_file_ref_id,
              (SELECT primary_binding.current_file_ref_id
               FROM manuscript_bindings AS primary_binding
               WHERE primary_binding.owner_type = outline_binding.owner_type
                 AND primary_binding.owner_id = outline_binding.owner_id
                 AND primary_binding.manuscript_channel = 'primary')
            ),
            schema_version = 2
        WHERE outline_binding.owner_type = 'literature'
          AND outline_binding.manuscript_channel = 'literature_outline'
          AND EXISTS (
            SELECT 1
            FROM manuscript_bindings AS primary_binding
            WHERE primary_binding.owner_type = outline_binding.owner_type
              AND primary_binding.owner_id = outline_binding.owner_id
              AND primary_binding.manuscript_channel = 'primary'
          );

        DELETE FROM manuscript_bindings
        WHERE owner_type = 'literature' AND manuscript_channel = 'primary';

        INSERT OR IGNORE INTO schema_migrations (version, name)
        VALUES (20, 'literature_channel_partial_repair');
        "#,
    )
}

fn apply_literature_candidate_metadata_schema_migration(connection: &Connection) -> Result<()> {
    add_column_if_missing(
        connection,
        "file_refs",
        "candidate_request_id",
        "TEXT",
    )?;
    add_column_if_missing(
        connection,
        "file_refs",
        "candidate_occurred_at",
        "TEXT",
    )?;
    ensure_named_index(
        connection,
        "file_refs",
        "idx_file_refs_candidate_request",
        &["owner_type", "owner_id", "candidate_request_id"],
        true,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_file_refs_candidate_request
         ON file_refs(owner_type, owner_id, candidate_request_id)
         WHERE candidate_request_id IS NOT NULL;",
    )?;
    connection.execute_batch(
        "INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (21, 'literature_candidate_file_ref_metadata');",
    )?;
    Ok(())
}

fn column_is_not_null(connection: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(3)?))
    })?;
    for row in rows {
        let (name, not_null) = row?;
        if name == column_name {
            return Ok(not_null == 1);
        }
    }

    Ok(false)
}

fn apply_experiment_business_model_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [EXPERIMENT_BUSINESS_MODEL_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    add_column_if_missing(connection, "experiments", "summary_other", "TEXT")?;
    add_column_if_missing(
        connection,
        "experiment_runs",
        "variable_parameter_summary",
        "TEXT",
    )?;
    add_column_if_missing(connection, "experiment_runs", "summary_other", "TEXT")?;
    if applied == 0 {
        remove_formal_outline_custom_fields(connection, "experiments", &["summaryOther"])?;
        remove_formal_outline_custom_fields(
            connection,
            "experiment_runs",
            &[
                "summaryOther",
                "variableParameterSummary",
                "runVariableParameterSummary",
                "runSummaryOther",
            ],
        )?;
    }
    connection.execute_batch(
        "INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (22, 'experiment_run_business_model_and_structured_fields');",
    )?;
    Ok(())
}

const EXPERIMENT_CREATED_LOCAL_TIME_TABLE_SQL: &str = r#"
CREATE TABLE experiments_created_local_time (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  title TEXT,
  purpose TEXT,
  hypothesis TEXT,
  research_question TEXT,
  condition_summary TEXT,
  method_summary TEXT,
  conclusion TEXT,
  summary_other TEXT,
  status TEXT,
  rating TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  usable_for_paper INTEGER NOT NULL DEFAULT 0,
  usable_for_report INTEGER NOT NULL DEFAULT 0,
  usable_for_patent INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  condition_items TEXT NOT NULL DEFAULT '[]',
  method_steps TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]',
  materials TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  legacy TEXT,
  migrated_from_legacy INTEGER,
  experiment_name TEXT NOT NULL,
  machine_object TEXT NOT NULL,
  fault_type TEXT NOT NULL,
  speed REAL,
  load REAL,
  sensor_config TEXT NOT NULL,
  data_path TEXT NOT NULL,
  sampling_rate REAL,
  duration REAL,
  result_summary TEXT NOT NULL,
  problem_notes TEXT,
  next_action TEXT,
  created_local_date TEXT NOT NULL CHECK (
    length(created_local_date) = 10
    AND created_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(created_local_date) = created_local_date
  ),
  created_local_time TEXT NOT NULL CHECK (
    length(created_local_time) = 4
    AND created_local_time GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(substr(created_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_local_time, 3, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE experiment_runs_created_local_time (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  run_label TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  condition_summary TEXT,
  variable_parameter_summary TEXT,
  method_summary TEXT,
  result_summary TEXT,
  conclusion TEXT,
  summary_other TEXT,
  rating TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  condition_items TEXT NOT NULL DEFAULT '[]',
  method_steps TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]',
  materials TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  legacy TEXT,
  created_local_date TEXT NOT NULL CHECK (
    length(created_local_date) = 10
    AND created_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(created_local_date) = created_local_date
  ),
  created_local_time TEXT NOT NULL CHECK (
    length(created_local_time) = 4
    AND created_local_time GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(substr(created_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_local_time, 3, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);
"#;

fn created_local_value_expression(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    fallback: &str,
) -> Result<String> {
    if column_exists(connection, table_name, column_name)? {
        Ok(format!("COALESCE(NULLIF({column_name}, ''), {fallback})"))
    } else {
        Ok(fallback.to_string())
    }
}

fn apply_experiment_created_local_time_schema_migration(connection: &Connection) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [EXPERIMENT_CREATED_LOCAL_TIME_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    if applied > 0 {
        return Ok(());
    }

    // A partially versioned development database may contain the later D1 relation table
    // while still requiring this destructive v23 parent-table rebuild. Its metadata is not
    // a valid v22 contract, so v27 recreates it after the parent tables are current.
    connection.execute_batch("DROP TABLE IF EXISTS experiment_representative_runs;")?;

    let experiment_date = created_local_value_expression(
        connection,
        "experiments",
        "created_local_date",
        "strftime('%Y-%m-%d', created_at)",
    )?;
    let experiment_time = created_local_value_expression(
        connection,
        "experiments",
        "created_local_time",
        "strftime('%H%M', created_at)",
    )?;
    let run_date = created_local_value_expression(
        connection,
        "experiment_runs",
        "created_local_date",
        "strftime('%Y-%m-%d', created_at)",
    )?;
    let run_time = created_local_value_expression(
        connection,
        "experiment_runs",
        "created_local_time",
        "strftime('%H%M', created_at)",
    )?;

    connection.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    connection.execute_batch(
        "DROP TABLE IF EXISTS experiments_created_local_time;
         DROP TABLE IF EXISTS experiment_runs_created_local_time;",
    )?;
    connection.execute_batch(EXPERIMENT_CREATED_LOCAL_TIME_TABLE_SQL)?;

    connection.execute_batch(&format!(
        "INSERT INTO experiments_created_local_time (
           id, project_id, route_id, task_id, title, purpose, hypothesis, research_question,
           condition_summary, method_summary, conclusion, summary_other, status, rating, tags,
           usable_for_paper, usable_for_report, usable_for_patent, schema_version, source,
           condition_items, method_steps, variables, materials, custom_fields, legacy,
           migrated_from_legacy, experiment_name, machine_object, fault_type, speed, load,
           sensor_config, data_path, sampling_rate, duration, result_summary, problem_notes,
           next_action, created_local_date, created_local_time, created_at, updated_at, deleted_at
         )
         SELECT
           id, project_id, route_id, task_id, title, purpose, hypothesis, research_question,
           condition_summary, method_summary, conclusion, summary_other, status, rating, tags,
           usable_for_paper, usable_for_report, usable_for_patent, schema_version, source,
           condition_items, method_steps, variables, materials, custom_fields, legacy,
           migrated_from_legacy, experiment_name, machine_object, fault_type, speed, load,
           sensor_config, data_path, sampling_rate, duration, result_summary, problem_notes,
           next_action, {experiment_date}, {experiment_time}, created_at, updated_at, deleted_at
         FROM experiments;

         INSERT INTO experiment_runs_created_local_time (
           id, experiment_id, project_id, route_id, task_id, title, run_label, status,
           started_at, completed_at, condition_summary, variable_parameter_summary,
           method_summary, result_summary, conclusion, summary_other, rating, tags,
           schema_version, source, condition_items, method_steps, variables, materials,
           custom_fields, legacy, created_local_date, created_local_time, created_at,
           updated_at, deleted_at
         )
         SELECT
           id, experiment_id, project_id, route_id, task_id, title, run_label, status,
           started_at, completed_at, condition_summary, variable_parameter_summary,
           method_summary, result_summary, conclusion, summary_other, rating, tags,
           schema_version, source, condition_items, method_steps, variables, materials,
           custom_fields, legacy, {run_date}, {run_time}, created_at, updated_at, deleted_at
         FROM experiment_runs;"
    ))?;

    connection.execute_batch(
        "DROP TABLE experiment_runs;
         DROP TABLE experiments;
         ALTER TABLE experiments_created_local_time RENAME TO experiments;
         ALTER TABLE experiment_runs_created_local_time RENAME TO experiment_runs;

         CREATE INDEX idx_experiments_project_id ON experiments(project_id);
         CREATE INDEX idx_experiments_task_id ON experiments(task_id);
         CREATE INDEX idx_experiments_deleted_at ON experiments(deleted_at);
         CREATE INDEX idx_experiment_runs_experiment_id ON experiment_runs(experiment_id);
         CREATE INDEX idx_experiment_runs_project_id ON experiment_runs(project_id);
         CREATE INDEX idx_experiment_runs_deleted_at ON experiment_runs(deleted_at);

         INSERT INTO schema_migrations (version, name)
         VALUES (23, 'experiment_run_created_local_time_freeze');",
    )?;
    Ok(())
}

fn apply_experiment_workspace_title_identity_schema_migration(
    connection: &Connection,
) -> Result<()> {
    add_column_if_missing(
        connection,
        "experiments",
        "workspace_title_identity",
        "TEXT NOT NULL DEFAULT 'experiment'",
    )?;
    add_column_if_missing(
        connection,
        "experiment_runs",
        "workspace_title_identity",
        "TEXT NOT NULL DEFAULT 'run'",
    )?;
    connection.execute_batch(
        "INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (24, 'experiment_run_workspace_title_identity');",
    )?;
    Ok(())
}

fn apply_experiment_provisioning_identity_schema_migration(
    connection: &Connection,
) -> Result<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_file_refs_experiment_default_folder_owner;
         CREATE UNIQUE INDEX idx_file_refs_experiment_default_folder_owner
           ON file_refs(owner_type, owner_id)
           WHERE owner_type = 'experiment'
             AND resource_kind = 'folder'
             AND file_role = 'defaultFolder'
             AND location_mode = 'managed';
         INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (25, 'experiment_provisioning_identity');"
    )?;
    Ok(())
}

fn apply_experiment_run_provisioning_identity_schema_migration(
    connection: &Connection,
) -> Result<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_file_refs_experiment_run_default_folder_owner;
         DROP INDEX IF EXISTS idx_file_refs_experiment_run_managed_manuscript_owner;
         CREATE UNIQUE INDEX idx_file_refs_experiment_run_default_folder_owner
           ON file_refs(owner_type, owner_id)
           WHERE owner_type = 'experimentRun'
             AND resource_kind = 'folder'
             AND file_role = 'defaultFolder'
             AND location_mode = 'managed';
         INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (26, 'experiment_run_provisioning_identity');"
    )?;
    Ok(())
}

fn apply_experiment_representative_run_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS experiment_representative_runs (
           id TEXT PRIMARY KEY,
           experiment_id TEXT NOT NULL,
           run_id TEXT NOT NULL,
           sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
           FOREIGN KEY (run_id) REFERENCES experiment_runs(id) ON DELETE CASCADE
         );
         CREATE UNIQUE INDEX IF NOT EXISTS uq_experiment_representative_runs_experiment_run
           ON experiment_representative_runs(experiment_id, run_id);
         CREATE UNIQUE INDEX IF NOT EXISTS uq_experiment_representative_runs_experiment_sort
           ON experiment_representative_runs(experiment_id, sort_order);
         CREATE INDEX IF NOT EXISTS idx_experiment_representative_runs_run
           ON experiment_representative_runs(run_id);
         CREATE TRIGGER IF NOT EXISTS trg_experiment_representative_runs_compact_after_delete
           AFTER DELETE ON experiment_representative_runs
           BEGIN
             UPDATE experiment_representative_runs
             SET sort_order = sort_order - 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE experiment_id = OLD.experiment_id
               AND sort_order > OLD.sort_order;
           END;
         INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (27, 'experiment_representative_run');"
    )?;
    Ok(())
}

fn apply_experiment_file_body_single_source_schema_migration(
    connection: &Connection,
) -> Result<()> {
    remove_formal_outline_custom_fields(connection, "experiments", &["generalNotes"])?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (?1, 'experiment_file_body_single_source')",
        [EXPERIMENT_FILE_BODY_SINGLE_SOURCE_SCHEMA_VERSION],
    )?;
    Ok(())
}

fn apply_experiment_workspace_identity_enforcement_schema_migration(
    connection: &Connection,
) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [EXPERIMENT_WORKSPACE_IDENTITY_ENFORCEMENT_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    if applied > 0 {
        return Ok(());
    }

    let valid_experiments: i64 = connection.query_row(
        "SELECT COUNT(*) FROM experiments
         WHERE workspace_title_identity IS NOT NULL
           AND trim(workspace_title_identity) <> ''
           AND workspace_title_identity <> 'experiment'",
        [],
        |row| row.get(0),
    )?;
    let valid_runs: i64 = connection.query_row(
        "SELECT COUNT(*) FROM experiment_runs
         WHERE workspace_title_identity IS NOT NULL
           AND trim(workspace_title_identity) <> ''
           AND workspace_title_identity <> 'run'",
        [],
        |row| row.get(0),
    )?;
    if valid_experiments > 0 || valid_runs > 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "v29 destructive development-data cleanup found non-default workspace identities"
                .to_string(),
        ));
    }

    connection.execute_batch(
        "PRAGMA defer_foreign_keys = ON;

         DELETE FROM manuscript_bindings
          WHERE owner_type IN ('experiment', 'experimentRun');
         DELETE FROM file_refs
          WHERE owner_type IN ('experiment', 'experimentRun');
         DELETE FROM experiment_representative_runs;
         DELETE FROM result_metrics
          WHERE experiment_id IN (SELECT id FROM experiments)
             OR run_id IN (SELECT id FROM experiment_runs);
         DELETE FROM result_items
          WHERE experiment_id IN (SELECT id FROM experiments)
             OR experiment_run_id IN (SELECT id FROM experiment_runs);
         DELETE FROM findings
          WHERE experiment_id IN (SELECT id FROM experiments);
         DELETE FROM outputs
          WHERE experiment_id IN (SELECT id FROM experiments);
         DELETE FROM literature_links
          WHERE target_type IN ('experiment', 'experimentRun');
         DELETE FROM output_source_links
          WHERE source_type IN ('experiment', 'experimentRun');
         DELETE FROM output_conversion_relations
          WHERE source_type IN ('experiment', 'experimentRun')
             OR target_type IN ('experiment', 'experimentRun');
         DELETE FROM research_trace_event_preferences
          WHERE target_type IN ('experiment', 'experimentRun');
         DELETE FROM recycle_entries
          WHERE entity_type IN ('experiment', 'experimentRun');
         DELETE FROM operation_logs
          WHERE module = 'experiment';
         DELETE FROM experiment_runs;
         DELETE FROM experiments;

         ALTER TABLE experiments DROP COLUMN workspace_title_identity;
         ALTER TABLE experiment_runs DROP COLUMN workspace_title_identity;
         ALTER TABLE experiments ADD COLUMN workspace_title_identity TEXT NOT NULL
           CHECK (length(trim(workspace_title_identity)) > 0);
         ALTER TABLE experiment_runs ADD COLUMN workspace_title_identity TEXT NOT NULL
           CHECK (length(trim(workspace_title_identity)) > 0);

         INSERT INTO schema_migrations (version, name)
         VALUES (29, 'experiment_workspace_identity_enforcement_and_dev_cleanup');",
    )?;
    Ok(())
}

fn apply_experiment_shared_open_file_ref_identity_schema_migration(
    connection: &Connection,
) -> Result<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_file_refs_experiment_managed_manuscript_owner;
         DROP INDEX IF EXISTS idx_file_refs_identity;
         CREATE UNIQUE INDEX idx_file_refs_identity
           ON file_refs(
             owner_type,
             owner_id,
             manuscript_channel,
             resource_kind,
             file_role,
             location_mode,
             path_identity_key
           );
         INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (30, 'experiment_shared_open_file_ref_identity');",
    )?;
    Ok(())
}

fn apply_experiment_run_switch_context_snapshot_schema_migration(
    connection: &Connection,
) -> Result<()> {
    add_column_if_missing(
        connection,
        "experiment_run_manuscript_switch_recoveries",
        "project_title_snapshot",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(
        connection,
        "experiment_run_manuscript_switch_recoveries",
        "rating_snapshot",
        "TEXT",
    )?;
    add_column_if_missing(
        connection,
        "experiment_run_manuscript_switch_recoveries",
        "tags_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?1, ?2)",
        (
            EXPERIMENT_RUN_SWITCH_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
            "experiment_run_switch_context_snapshot",
        ),
    )?;
    Ok(())
}

fn apply_experiment_run_switch_canonical_writeback_schema_migration(
    connection: &Connection,
) -> Result<()> {
    let applied: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [EXPERIMENT_RUN_SWITCH_CANONICAL_WRITEBACK_SCHEMA_VERSION],
        |row| row.get(0),
    )?;
    if applied == 1 {
        return Ok(());
    }

    // Development-only canonical rebuild: no compatibility columns or dual reader survive.
    remove_formal_outline_custom_fields(
        connection,
        "experiment_runs",
        &["generalNotes", "recordNotes"],
    )?;
    connection.execute_batch(
        "DROP TABLE IF EXISTS experiment_run_manuscript_switch_recoveries;",
    )?;
    connection.execute_batch(
        super::experiment_run_manuscript_switch_recovery::RECOVERY_SCHEMA_SQL,
    )?;
    connection.execute(
        "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
        (
            EXPERIMENT_RUN_SWITCH_CANONICAL_WRITEBACK_SCHEMA_VERSION,
            "experiment_run_switch_canonical_writeback",
        ),
    )?;
    Ok(())
}

fn apply_experiment_run_multi_manuscript_identity_schema_migration(
    connection: &Connection,
) -> Result<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_file_refs_experiment_run_managed_manuscript_owner;
         INSERT OR IGNORE INTO schema_migrations (version, name)
         VALUES (31, 'experiment_run_multi_manuscript_identity');",
    )?;
    Ok(())
}

fn apply_experiment_generated_field_reconciliation_schema_migration(
    connection: &Connection,
) -> Result<()> {
    // v37 and earlier could project the internal fault sentinel into condition_summary and
    // copy title into an empty purpose on the next form save. The exact generated condition
    // pair is the eligibility proof; same-looking user text without that pair is retained.
    connection.execute_batch(
        r#"
        INSERT OR IGNORE INTO operation_logs (
          id, operation_type, source, module, status, risk_level, target, summary,
          related_entities, impact_summary, confirmation, feedback, warnings, errors,
          skipped, is_recoverable, actor_id, actor_label, refresh_keys, schema_version,
          created_at, updated_at
        )
        SELECT
          'schema-v39-experiment-generated-fields-' || e.id,
          'migration', 'system', 'experiment', 'success', 'low',
          'experiment:' || e.id,
          'Removed generated legacy values from editable Experiment fields.',
          json_array(json_object('entityType', 'experiment', 'entityId', e.id)),
          'the generated condition item was cleared; the sentinel summary and equal title fallback were cleared when present; updated_at was preserved.',
          json_object('required', 0, 'reason', 'exact generated-sentinel reconciliation'),
          json_object('code', 'EXPERIMENT_GENERATED_FIELDS_RECONCILED', 'count', 1),
          '[]', '[]', '[]', 0, 'system', 'LabPod schema migration',
          json_array('experiments'), 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM experiments e
        WHERE e.fault_type = 'unknown'
          AND e.condition_items = '[{"id":"legacy-fault-type","name":"faultType","value":"unknown","role":"sample"}]';

        UPDATE experiments AS e
        SET purpose = CASE
              WHEN e.condition_summary = 'faultType: unknown' AND e.purpose = e.title
              THEN NULL ELSE e.purpose END,
            condition_summary = CASE
              WHEN e.condition_summary = 'faultType: unknown'
              THEN NULL ELSE e.condition_summary END,
            condition_items = '[]'
        WHERE e.fault_type = 'unknown'
          AND e.condition_items = '[{"id":"legacy-fault-type","name":"faultType","value":"unknown","role":"sample"}]';

        INSERT OR IGNORE INTO schema_migrations (version, name)
        VALUES (39, 'experiment_generated_field_reconciliation');
        "#,
    )?;
    Ok(())
}

fn remove_formal_outline_custom_fields(
    connection: &Connection,
    table_name: &str,
    field_names: &[&str],
) -> Result<()> {
    let rows = {
        let mut statement = connection.prepare(&format!(
            "SELECT id, custom_fields FROM {table_name} WHERE custom_fields IS NOT NULL"
        ))?;
        let collected = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>>>()?;
        collected
    };

    for (id, custom_fields) in rows {
        let Ok(serde_json::Value::Array(mut fields)) =
            serde_json::from_str::<serde_json::Value>(&custom_fields)
        else {
            continue;
        };
        let original_len = fields.len();
        fields.retain(|field| {
            field
                .get("name")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|name| !field_names.contains(&name))
        });
        if fields.len() != original_len {
            connection.execute(
                &format!("UPDATE {table_name} SET custom_fields = ?1 WHERE id = ?2"),
                rusqlite::params![serde_json::Value::Array(fields).to_string(), id],
            )?;
        }
    }
    Ok(())
}

fn migration_path_identity_key(path: &str) -> String {
    let mut value = path.trim().to_string();
    let lower = value.to_ascii_lowercase();
    let is_file_url = lower.starts_with("file:");
    if lower.starts_with("file:///") {
        value = value[8..].to_string();
    } else if lower.starts_with("file://") {
        value = format!("//{}", &value[7..]);
    }
    if is_file_url {
        if let Some(decoded) = decode_percent_encoded_path(&value) {
            value = decoded;
        }
    }
    value = value.replace('\\', "/");
    let is_unc = value.starts_with("//");
    let body = if is_unc { &value[2..] } else { value.as_str() };
    let mut collapsed = String::new();
    let mut previous_slash = false;
    for character in body.chars() {
        if character == '/' {
            if !previous_slash {
                collapsed.push(character);
            }
            previous_slash = true;
        } else {
            collapsed.push(character);
            previous_slash = false;
        }
    }
    value = if is_unc {
        format!("//{collapsed}")
    } else {
        collapsed
    };
    if value.len() > 1 && !value.ends_with(":/") {
        value = value.trim_end_matches('/').to_string();
    }
    if is_unc || (value.len() >= 3 && value.as_bytes()[1] == b':' && value.as_bytes()[2] == b'/') {
        value = value.to_lowercase();
    }
    value
}

fn decode_percent_encoded_path(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = (bytes[index + 1] as char).to_digit(16)? as u8;
            let low = (bytes[index + 2] as char).to_digit(16)? as u8;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}
