use super::manuscript_provisioning_operation_state::step_progress::{
    durable_step_plan_from_row, durable_step_progress_from_row, is_lowercase_sha256,
    is_utc_timestamp, literature_child_projection_from_row, DurableStepBoundary, DurableStepKind,
    DurableStepScope, LiteratureChildSummaryStatus, PlanFingerprintProfile, PlanTemplateKind,
};
use super::manuscript_provisioning_operation_state::step_progress_schema::{
    apply_v41_in_transaction_with_fault, migrate_v40_to_v41, validate_provisioning_contract,
    V41MigrationFault, V41MigrationOutcome, DURABLE_STEP_PROGRESS_MIGRATION_NAME,
    SOURCE_OPERATION_STATE_NONEMPTY, SOURCE_SCHEMA_INVALID, STEP_PROGRESS_TABLE_SQL,
};
use super::manuscript_provisioning_operation_state::PROVISIONING_OPERATION_STATE_SCHEMA_SQL;
use super::manuscript_provisioning_v40_migration_fixture::open_v40_source_database;
use super::schema;
use rusqlite::Connection;
use std::str::FromStr;
use std::sync::{Arc, Barrier};

const NOW: &str = "2026-07-24T00:00:00.000Z";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const STEP_PROGRESS_INDEXES_SQL: &str = "
CREATE UNIQUE INDEX uq_manuscript_provisioning_step_plan_ordinal
  ON manuscript_provisioning_step_progress(plan_id, step_ordinal);
CREATE UNIQUE INDEX uq_manuscript_provisioning_step_plan_scope_kind
  ON manuscript_provisioning_step_progress(plan_id, step_scope, step_kind);
CREATE INDEX idx_manuscript_provisioning_step_operation_boundary
  ON manuscript_provisioning_step_progress(operation_id, boundary, step_ordinal);
CREATE INDEX idx_manuscript_provisioning_step_plan_scope
  ON manuscript_provisioning_step_progress(plan_id, step_scope, step_ordinal);
CREATE INDEX idx_manuscript_provisioning_step_updated
  ON manuscript_provisioning_step_progress(updated_at, operation_id);
";

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get::<_, bool>(0),
        )
        .expect("table introspection")
}

fn insert_attempt(connection: &Connection, operation_id: &str, scope: &str, channel: Option<&str>) {
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               aggregate_operation_id, intent, trigger_kind, phase, operation_status,
               revision, folder_effect, manuscript_effect, file_ref_effect, binding_effect,
               final_verification_outcome, facts_schema_version, started_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, 'owner-1', ?4, NULL, 'create-default', 'owner-create',
               'preflight', 'active', 0, 'none', 'none', 'none', 'none',
               'not-run', 1, ?5, ?5
             )",
            (
                operation_id,
                scope,
                if scope == "literature-aggregate" {
                    "literature"
                } else {
                    "review"
                },
                channel,
                NOW,
            ),
        )
        .expect("insert isolated attempt");
}

fn insert_plan(connection: &Connection, operation_id: &str, plan_id: &str) {
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id, operation_id, plan_version, plan_template_kind,
               plan_identity_fingerprint, precondition_snapshot_hash,
               fingerprint_profile, owner_type, owner_id, scope_kind,
               manuscript_channel, intent, canonical_resource_identity_hash,
               canonical_placement_identity_hash, parent_shared_identity_hash,
               step_count, planner_version, created_at
             ) VALUES (
               ?1, ?2, 1, 'managed-primary', ?3, ?4,
               'restricted-jcs-sha256-v1', 'review', 'owner-1', 'channel',
               'primary', 'create-default', ?5, ?3, NULL, 1, 'planner-v1', ?6
             )",
            (plan_id, operation_id, HASH_A, HASH_B, HASH_C, NOW),
        )
        .expect("insert isolated plan");
}

fn replace_step_table(connection: &Connection, tampered_sql: &str) {
    assert_ne!(
        tampered_sql, STEP_PROGRESS_TABLE_SQL,
        "tamper must alter the frozen DDL"
    );
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP TABLE manuscript_provisioning_step_progress;",
        )
        .expect("drop isolated step table");
    connection
        .execute_batch(tampered_sql)
        .expect("create isolated tampered step table");
    connection
        .execute_batch(STEP_PROGRESS_INDEXES_SQL)
        .expect("restore exact indexes around the tampered table");
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .expect("restore foreign-key enforcement");
}

#[test]
fn p4_2b_fresh_database_reaches_current_schema_with_embedded_v41_contract() {
    let connection = Connection::open_in_memory().expect("open isolated SQLite");
    schema::run_migrations(&connection).expect("migrate fresh isolated SQLite");

    assert_eq!(schema::CURRENT_SCHEMA_VERSION, 58);
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .expect("read user_version"),
        schema::CURRENT_SCHEMA_VERSION
    );
    for table in [
        "manuscript_provisioning_step_plans",
        "manuscript_provisioning_step_progress",
        "manuscript_provisioning_literature_child_states",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .expect("inspect target table");
        assert_eq!(exists, 1, "{table}");
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM schema_migrations WHERE version=41",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("v41 ledger"),
        DURABLE_STEP_PROGRESS_MIGRATION_NAME
    );
    assert!(validate_provisioning_contract(&connection).expect("provisioning contract validator"));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("foreign key check"),
        0
    );
}

#[test]
fn p4_2b_empty_v40_and_v39_chain_upgrade_atomically_and_repeat_is_idempotent() {
    let mut v40 = open_v40_source_database();
    assert_eq!(
        migrate_v40_to_v41(&mut v40).expect("v40 to v41"),
        V41MigrationOutcome::Migrated
    );
    assert_eq!(
        migrate_v40_to_v41(&mut v40).expect("repeat current v41"),
        V41MigrationOutcome::AlreadyCurrent
    );
    assert_eq!(
        v40.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version=41",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        1
    );

    let v39 = Connection::open_in_memory().expect("open isolated v39 chain");
    schema::run_migrations(&v39).expect("fresh through v39/v40/v41 chain");
    v39.execute_batch(
        "PRAGMA foreign_keys=OFF;
         DROP TABLE manuscript_provisioning_step_progress;
         DROP TABLE manuscript_provisioning_step_plans;
         DROP TABLE manuscript_provisioning_literature_child_states;
         DROP TABLE manuscript_provisioning_audit_outbox;
         DROP TABLE manuscript_provisioning_active_claims;
         DROP TABLE manuscript_provisioning_operation_attempts;
         DELETE FROM schema_migrations WHERE version IN (40, 41);
         PRAGMA user_version=39;
         PRAGMA foreign_keys=ON;",
    )
    .expect("derive isolated exact pre-v40 fixture");
    schema::run_migrations(&v39).expect("v39 to v40 to v41");
    assert!(validate_provisioning_contract(&v39).unwrap());
}

#[test]
fn p4_2b_nonempty_v40_gate_rejects_each_authority_without_partial_schema() {
    for table in [
        "manuscript_provisioning_operation_attempts",
        "manuscript_provisioning_active_claims",
        "manuscript_provisioning_literature_child_states",
        "manuscript_provisioning_audit_outbox",
    ] {
        let mut connection = open_v40_source_database();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable fixture foreign keys");
        match table {
            "manuscript_provisioning_operation_attempts" => {
                insert_attempt(
                    &connection,
                    "operation-nonempty",
                    "channel",
                    Some("primary"),
                );
            }
            "manuscript_provisioning_active_claims" => {
                connection
                    .execute(
                        "INSERT INTO manuscript_provisioning_active_claims (
                       claim_id, scope_kind, owner_type, owner_id, manuscript_channel,
                       operation_id, claim_owner_token, claimed_at, last_heartbeat_at,
                       last_progress_at
                     ) VALUES (
                       'claim-1', 'channel', 'review', 'owner-1', 'primary',
                       'missing-operation', 'test-token', ?1, ?1, ?1
                     )",
                        [NOW],
                    )
                    .unwrap();
            }
            "manuscript_provisioning_literature_child_states" => {
                connection
                    .execute(
                        "INSERT INTO manuscript_provisioning_literature_child_states (
                       aggregate_operation_id, owner_id, manuscript_channel, updated_at
                     ) VALUES ('missing-aggregate', 'owner-1', 'literature_outline', ?1)",
                        [NOW],
                    )
                    .unwrap();
            }
            "manuscript_provisioning_audit_outbox" => {
                connection
                    .execute(
                        "INSERT INTO manuscript_provisioning_audit_outbox (
                       operation_id, created_at, updated_at
                     ) VALUES ('missing-operation', ?1, ?1)",
                        [NOW],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("restore fixture foreign keys");
        let error = migrate_v40_to_v41(&mut connection).expect_err("nonempty gate");
        assert_eq!(error.code, SOURCE_OPERATION_STATE_NONEMPTY, "{table}");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            40,
            "{table}"
        );
        assert!(!table_exists(
            &connection,
            "manuscript_provisioning_step_plans"
        ));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version=41",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "{table}"
        );
        assert_eq!(
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
            "{table}"
        );
    }
}

#[test]
fn p4_2b_missing_v40_authority_is_source_schema_invalid_not_empty() {
    let mut connection = open_v40_source_database();
    connection
        .execute_batch("DROP TABLE manuscript_provisioning_audit_outbox;")
        .expect("tamper isolated v40 source");
    let error = migrate_v40_to_v41(&mut connection).expect_err("missing source table");
    assert_eq!(error.code, SOURCE_SCHEMA_INVALID);
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        40
    );
    assert!(!table_exists(
        &connection,
        "manuscript_provisioning_step_plans"
    ));
}

#[test]
fn p4_2b_every_in_transaction_fault_rolls_back_tables_child_ledger_and_version() {
    for fault in [
        V41MigrationFault::PlanTable,
        V41MigrationFault::StepTable,
        V41MigrationFault::ChildTempTable,
        V41MigrationFault::ChildCopy,
        V41MigrationFault::ChildReplace,
        V41MigrationFault::Indexes,
        V41MigrationFault::TransactionValidator,
        V41MigrationFault::Ledger,
        V41MigrationFault::UserVersion,
    ] {
        let connection = open_v40_source_database();
        connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let error = apply_v41_in_transaction_with_fault(&connection, Some(fault))
            .expect_err("fault must fail");
        assert!(
            [super::manuscript_provisioning_operation_state::step_progress_schema::MIGRATION_FAILED,
             super::manuscript_provisioning_operation_state::step_progress_schema::TARGET_SCHEMA_INVALID]
                .contains(&error.code)
        );
        connection.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            40,
            "{fault:?}"
        );
        assert!(!table_exists(
            &connection,
            "manuscript_provisioning_step_plans"
        ));
        assert!(!table_exists(
            &connection,
            "manuscript_provisioning_literature_child_states_v41"
        ));
        assert!(table_exists(
            &connection,
            "manuscript_provisioning_literature_child_states"
        ));
        let child_columns = {
            let mut statement = connection
                .prepare("PRAGMA table_info(manuscript_provisioning_literature_child_states)")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert!(child_columns.contains(&"phase".to_string()), "{fault:?}");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version=41",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "{fault:?}"
        );
    }
}

#[test]
fn p4_2b_exact_validator_rejects_index_column_and_check_tampering() {
    let mut connection = open_v40_source_database();
    migrate_v40_to_v41(&mut connection).unwrap();
    connection
        .execute_batch(
            "DROP INDEX idx_manuscript_provisioning_step_updated;
             CREATE INDEX idx_manuscript_provisioning_step_updated
             ON manuscript_provisioning_step_progress(operation_id, updated_at);",
        )
        .unwrap();
    assert!(!validate_provisioning_contract(&connection).unwrap());

    let mut extra_authority = open_v40_source_database();
    migrate_v40_to_v41(&mut extra_authority).unwrap();
    extra_authority
        .execute_batch(
            "ALTER TABLE manuscript_provisioning_literature_child_states
             ADD COLUMN phase TEXT;",
        )
        .unwrap();
    assert!(!validate_provisioning_contract(&extra_authority).unwrap());

    let mut check_tamper = open_v40_source_database();
    migrate_v40_to_v41(&mut check_tamper).unwrap();
    check_tamper
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             ALTER TABLE manuscript_provisioning_step_progress
             RENAME TO manuscript_provisioning_step_progress_exact;
             CREATE TABLE manuscript_provisioning_step_progress (
               step_id TEXT PRIMARY KEY,
               plan_id TEXT NOT NULL,
               operation_id TEXT NOT NULL,
               step_ordinal INTEGER NOT NULL,
               step_kind TEXT NOT NULL,
               step_scope TEXT NOT NULL,
               step_version INTEGER NOT NULL,
               is_required INTEGER NOT NULL DEFAULT 1,
               boundary TEXT NOT NULL DEFAULT 'intended'
                 CHECK (boundary IN ('intended','started','effect-observed','readback-verified','converged','skipped')),
               effect_outcome TEXT NOT NULL DEFAULT 'unobserved',
               readback_outcome TEXT NOT NULL DEFAULT 'not-run',
               observed_identity_hash TEXT,
               resource_record_id TEXT,
               effect_facts_schema_version INTEGER NOT NULL DEFAULT 1,
               progress_revision INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               started_at TEXT,
               effect_observed_at TEXT,
               readback_verified_at TEXT,
               converged_at TEXT,
               FOREIGN KEY(plan_id, operation_id)
                 REFERENCES manuscript_provisioning_step_plans(plan_id, operation_id)
                 ON DELETE RESTRICT
             );
             DROP TABLE manuscript_provisioning_step_progress_exact;
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();
    assert!(!validate_provisioning_contract(&check_tamper).unwrap());
}

#[test]
fn p4_2b_exact_validator_rejects_each_structural_contract_class() {
    let tamper_cases = [
        (
            "missing-column",
            "  effect_facts_schema_version INTEGER NOT NULL DEFAULT 1\n    CHECK (effect_facts_schema_version = 1),\n",
            "",
        ),
        (
            "wrong-type",
            "  step_ordinal INTEGER NOT NULL",
            "  step_ordinal TEXT NOT NULL",
        ),
        (
            "wrong-nullability",
            "  operation_id TEXT NOT NULL,\n",
            "  operation_id TEXT,\n",
        ),
        (
            "wrong-default",
            "  progress_revision INTEGER NOT NULL DEFAULT 0",
            "  progress_revision INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "step-vocabulary-widened",
            "      'ensure-directory',\n",
            "      'ensure-directory',\n      'free-form-step',\n",
        ),
        (
            "hash-check-relaxed",
            "      AND step_id NOT GLOB '*[^0-9a-f]*'\n",
            "",
        ),
        (
            "wrong-composite-fk-order",
            "REFERENCES manuscript_provisioning_step_plans(plan_id, operation_id)",
            "REFERENCES manuscript_provisioning_step_plans(operation_id, plan_id)",
        ),
        (
            "cascade-instead-of-restrict",
            "    ON DELETE RESTRICT\n",
            "    ON DELETE CASCADE\n",
        ),
    ];

    for (label, from, to) in tamper_cases {
        let mut connection = open_v40_source_database();
        migrate_v40_to_v41(&mut connection).unwrap();
        let tampered = STEP_PROGRESS_TABLE_SQL.replacen(from, to, 1);
        replace_step_table(&connection, &tampered);
        assert!(
            !matches!(validate_provisioning_contract(&connection), Ok(true)),
            "{label} must fail the provisioning contract validator"
        );
    }

    for table in [
        "manuscript_provisioning_step_plans",
        "manuscript_provisioning_step_progress",
        "manuscript_provisioning_literature_child_states",
    ] {
        let mut missing_table = open_v40_source_database();
        migrate_v40_to_v41(&mut missing_table).unwrap();
        missing_table
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        missing_table
            .execute(&format!("DROP TABLE {table}"), [])
            .unwrap();
        missing_table
            .execute_batch("PRAGMA foreign_keys=ON;")
            .unwrap();
        assert!(
            !matches!(validate_provisioning_contract(&missing_table), Ok(true)),
            "missing {table} must fail the provisioning contract validator"
        );
    }

    let mut missing_unique = open_v40_source_database();
    migrate_v40_to_v41(&mut missing_unique).unwrap();
    missing_unique
        .execute_batch("DROP INDEX uq_manuscript_provisioning_step_plan_ordinal;")
        .unwrap();
    assert!(!validate_provisioning_contract(&missing_unique).unwrap());

    let mut wrong_version = open_v40_source_database();
    migrate_v40_to_v41(&mut wrong_version).unwrap();
    wrong_version
        .execute_batch("PRAGMA user_version=40;")
        .unwrap();
    assert!(validate_provisioning_contract(&wrong_version).unwrap());

    let mut wrong_ledger = open_v40_source_database();
    migrate_v40_to_v41(&mut wrong_ledger).unwrap();
    wrong_ledger
        .execute(
            "UPDATE schema_migrations SET name='wrong-v41-ledger' WHERE version=41",
            [],
        )
        .unwrap();
    assert!(!validate_provisioning_contract(&wrong_ledger).unwrap());

    let mut temp_residue = open_v40_source_database();
    migrate_v40_to_v41(&mut temp_residue).unwrap();
    temp_residue
        .execute_batch(
            "CREATE TABLE manuscript_provisioning_literature_child_states_v41 (
               residue INTEGER
             );",
        )
        .unwrap();
    assert!(!validate_provisioning_contract(&temp_residue).unwrap());
}

#[test]
fn p4_2b_composite_plan_identity_and_restrict_are_database_enforced() {
    let mut connection = open_v40_source_database();
    migrate_v40_to_v41(&mut connection).unwrap();
    insert_attempt(&connection, "operation-a", "channel", Some("primary"));
    insert_attempt(&connection, "operation-b", "channel", Some("primary"));
    insert_plan(&connection, "operation-a", HASH_A);
    let mismatch = connection.execute(
        "INSERT INTO manuscript_provisioning_step_progress (
           step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
           step_version, created_at, updated_at
         ) VALUES (?1, ?2, 'operation-b', 0, 'ensure-directory', 'primary', 1, ?3, ?3)",
        (HASH_B, HASH_A, NOW),
    );
    assert!(mismatch.is_err(), "composite identity mismatch must fail");
    assert!(
        connection
            .execute(
                "DELETE FROM manuscript_provisioning_operation_attempts
                 WHERE operation_id='operation-a'",
                [],
            )
            .is_err(),
        "Plan FK must RESTRICT attempt deletion"
    );
}

#[test]
fn p4_2b_rust_dto_decodes_only_bounded_valid_values() {
    assert!(is_lowercase_sha256(HASH_A));
    assert!(!is_lowercase_sha256(&HASH_A.to_ascii_uppercase()));
    assert!(is_utc_timestamp(NOW));
    assert!(!is_utc_timestamp("2026-07-24 00:00:00"));
    assert_eq!(
        DurableStepBoundary::from_str("converged").unwrap(),
        DurableStepBoundary::Converged
    );
    assert!(DurableStepBoundary::from_str("skipped").is_err());
    assert!(DurableStepKind::from_str("verify").is_err());
    assert!(DurableStepScope::from_str("free-text").is_err());
    assert!(PlanTemplateKind::from_str("free-text").is_err());
    assert!(PlanFingerprintProfile::from_str("sha256").is_err());
    assert!(LiteratureChildSummaryStatus::from_str("active").is_err());

    let mut connection = open_v40_source_database();
    migrate_v40_to_v41(&mut connection).unwrap();
    insert_attempt(&connection, "operation-dto", "channel", Some("primary"));
    insert_plan(&connection, "operation-dto", HASH_A);
    let plan = connection
        .query_row(
            "SELECT
               plan_id, operation_id, plan_version, plan_template_kind,
               plan_identity_fingerprint, precondition_snapshot_hash,
               fingerprint_profile, owner_type, owner_id, scope_kind,
               manuscript_channel, intent, canonical_resource_identity_hash,
               canonical_placement_identity_hash, parent_shared_identity_hash,
               step_count, planner_version, created_at
             FROM manuscript_provisioning_step_plans WHERE plan_id=?1",
            [HASH_A],
            durable_step_plan_from_row,
        )
        .expect("decode valid plan");
    assert_eq!(plan.plan_template_kind, PlanTemplateKind::ManagedPrimary);

    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
               step_version, created_at, updated_at
             ) VALUES (?1, ?2, 'operation-dto', 0, 'ensure-directory', 'primary', 1, ?3, ?3)",
            (HASH_B, HASH_A, NOW),
        )
        .unwrap();
    let step = connection
        .query_row(
            "SELECT
               step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
               step_version, is_required, boundary, effect_outcome, readback_outcome,
               observed_identity_hash, resource_record_id, effect_facts_schema_version,
               progress_revision, created_at, updated_at, started_at,
               effect_observed_at, readback_verified_at, converged_at
             FROM manuscript_provisioning_step_progress WHERE step_id=?1",
            [HASH_B],
            durable_step_progress_from_row,
        )
        .expect("decode valid intended step");
    assert_eq!(step.boundary, DurableStepBoundary::Intended);

    let invalid = connection.query_row(
        "SELECT
           ?1, ?2, 'operation-dto', 0, 'ensure-directory', 'primary',
           1, 1, 'skipped', 'unobserved', 'not-run', NULL, NULL, 1, 0,
           ?3, ?3, NULL, NULL, NULL, NULL",
        (HASH_C, HASH_A, NOW),
        durable_step_progress_from_row,
    );
    assert!(invalid.is_err(), "unknown boundary must not decode");

    let invalid_plan_version = connection.query_row(
        "SELECT
           plan_id, operation_id, 2, plan_template_kind,
           plan_identity_fingerprint, precondition_snapshot_hash,
           fingerprint_profile, owner_type, owner_id, scope_kind,
           manuscript_channel, intent, canonical_resource_identity_hash,
           canonical_placement_identity_hash, parent_shared_identity_hash,
           step_count, planner_version, created_at
         FROM manuscript_provisioning_step_plans WHERE plan_id=?1",
        [HASH_A],
        durable_step_plan_from_row,
    );
    assert!(
        invalid_plan_version.is_err(),
        "unknown Plan version must not decode"
    );

    let decode_step_fixture = |step_id: &str,
                               ordinal: i64,
                               step_version: i64,
                               required: i64,
                               boundary: &str,
                               facts_version: i64,
                               progress_revision: i64,
                               timestamp: &str,
                               started_at: Option<&str>| {
        connection.query_row(
            "SELECT
                   ?1, ?2, 'operation-dto', ?3, 'ensure-directory', 'primary',
                   ?4, ?5, ?6, 'unobserved', 'not-run', NULL, NULL, ?7, ?8,
                   ?9, ?9, ?10, NULL, NULL, NULL",
            rusqlite::params![
                step_id,
                HASH_A,
                ordinal,
                step_version,
                required,
                boundary,
                facts_version,
                progress_revision,
                timestamp,
                started_at,
            ],
            durable_step_progress_from_row,
        )
    };
    let invalid_step_cases = [
        decode_step_fixture(HASH_C, 32, 1, 1, "intended", 1, 0, NOW, None),
        decode_step_fixture(HASH_C, 0, 2, 1, "intended", 1, 0, NOW, None),
        decode_step_fixture(HASH_C, 0, 1, 0, "intended", 1, 0, NOW, None),
        decode_step_fixture(HASH_C, 0, 1, 1, "intended", 2, 0, NOW, None),
        decode_step_fixture(HASH_C, 0, 1, 1, "intended", 1, -1, NOW, None),
        decode_step_fixture(
            &HASH_C.to_ascii_uppercase(),
            0,
            1,
            1,
            "intended",
            1,
            0,
            NOW,
            None,
        ),
        decode_step_fixture(
            HASH_C,
            0,
            1,
            1,
            "intended",
            1,
            0,
            "2026-07-24 00:00:00",
            None,
        ),
        decode_step_fixture(HASH_C, 0, 1, 1, "started", 1, 0, NOW, None),
    ];
    for invalid_step in invalid_step_cases {
        assert!(invalid_step.is_err(), "invalid Step row must not decode");
    }
    let safe_error = decode_step_fixture(HASH_C, 32, 1, 1, "intended", 1, 0, NOW, None)
        .expect_err("invalid ordinal")
        .to_string();
    assert!(safe_error.contains("step-progress-facts-invalid"));
    assert!(!safe_error.contains("SELECT"));
    assert!(!safe_error.contains("N:\\"));

    insert_attempt(
        &connection,
        "operation-literature",
        "literature-aggregate",
        None,
    );
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_literature_child_states (
               aggregate_operation_id, owner_id, manuscript_channel,
               current_operation_id, current_operation_scope_kind, updated_at
             ) VALUES (
               'operation-literature', 'owner-1', 'literature_outline',
               'operation-literature', 'literature-aggregate', ?1
             )",
            [NOW],
        )
        .unwrap();
    let projection = connection
        .query_row(
            "SELECT
               aggregate_operation_id, owner_type, owner_id, manuscript_channel,
               current_operation_id, current_operation_scope_kind, revision,
               child_summary_status, result_classification, next_action,
               default_readiness, final_verification_outcome, original_cause_code,
               updated_at
             FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id='operation-literature'
               AND manuscript_channel='literature_outline'",
            [],
            literature_child_projection_from_row,
        )
        .expect("decode valid Literature projection");
    assert_eq!(
        projection.child_summary_status,
        LiteratureChildSummaryStatus::Assigned
    );

    let invalid_projection = connection.query_row(
        "SELECT
           aggregate_operation_id, owner_type, owner_id, manuscript_channel,
           current_operation_id, current_operation_scope_kind, revision,
           child_summary_status, 'unknown-classification', next_action,
           default_readiness, final_verification_outcome, original_cause_code,
           updated_at
         FROM manuscript_provisioning_literature_child_states
         WHERE aggregate_operation_id='operation-literature'
           AND manuscript_channel='literature_outline'",
        [],
        literature_child_projection_from_row,
    );
    assert!(
        invalid_projection.is_err(),
        "unknown projection vocabulary must not decode"
    );
}

#[test]
fn p4_2b_concurrent_v40_migration_has_one_schema_and_one_ledger() {
    let path = std::env::temp_dir().join(format!(
        "labpod-p4-2b-concurrent-{}-{}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    {
        let connection = Connection::open(&path).expect("create isolated temp SQLite");
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   name TEXT NOT NULL,
                   applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .unwrap();
        connection
            .execute_batch(PROVISIONING_OPERATION_STATE_SCHEMA_SQL)
            .unwrap();
        connection.pragma_update(None, "user_version", 40).unwrap();
    }
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let path = path.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let mut connection = Connection::open(path).unwrap();
            connection
                .busy_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
            barrier.wait();
            migrate_v40_to_v41(&mut connection)
        }));
    }
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().expect("migration thread"))
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Ok(V41MigrationOutcome::Migrated)))
            .count(),
        1
    );
    assert!(outcomes.iter().all(|result| {
        matches!(
            result,
            Ok(V41MigrationOutcome::Migrated | V41MigrationOutcome::AlreadyCurrent)
        )
    }));
    let final_connection = Connection::open(&path).unwrap();
    assert!(validate_provisioning_contract(&final_connection).unwrap());
    assert_eq!(
        final_connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=41",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    drop(final_connection);
    std::fs::remove_file(&path).expect("remove exact isolated temp SQLite");
}

#[test]
fn p4_2b_architecture_surface_contains_no_progress_cas_executor_or_claim_revision() {
    let schema_source =
        include_str!("manuscript_provisioning_operation_state/step_progress_schema.rs");
    let dto_source = include_str!("manuscript_provisioning_operation_state/step_progress.rs");
    for forbidden in [
        "mark_step_started",
        "record_step_effect_observed",
        "record_step_readback_verified",
        "converge_step",
        "create_attempt_claim_plan_and_steps",
        "SharedProvisioningExecutor",
        "ResourceMutationAdapter",
        "claim_revision",
        "OperationLog",
    ] {
        assert!(
            !schema_source.contains(forbidden) && !dto_source.contains(forbidden),
            "{forbidden} must remain outside P-4-2B modules"
        );
    }
}
