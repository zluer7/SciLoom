use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
    derive_claim_expiry_epoch_ms, ClaimOwnershipError, ClaimOwnershipRepositoryContext,
    FixedRepositoryUtcClock, LEASE_DURATION_MS,
};
use crate::db::manuscript_provisioning_operation_state::{
    read_active_claim_for_operation, record_claim_heartbeat_with_repository_clock,
    PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE, PROVISIONING_OPERATION_CAS_CONFLICT,
};
use crate::owner_authority_lease::OwnerAuthorityLeaseRegistry;
use crate::provisioning_runtime::core::ProvisioningRuntime;
use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
use crate::provisioning_runtime::schema_capability::{
    FixedSchemaCapabilityProvider, SchemaCapability,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use rusqlite::{params, Connection};
use std::sync::Arc;

fn exact_v41_claim_fixture(owner_token: &str, last_heartbeat_at: &str) -> Connection {
    let connection = Connection::open_in_memory().expect("isolated SQLite");
    crate::db::schema::run_migrations(&connection).expect("exact-v41 schema");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               intent,trigger_kind,phase,operation_status,revision,
               final_verification_outcome,facts_schema_version,started_at,updated_at
             ) VALUES (
               'operation-pre','channel','review','review-pre','primary',
               'retry','explicit-retry','preflight','active',0,
               'not-run',1,'2026-07-26T00:00:00Z','2026-07-26T00:00:00Z'
             )",
            [],
        )
        .expect("active Attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_active_claims (
               claim_id,scope_kind,owner_type,owner_id,manuscript_channel,
               operation_id,claim_owner_token,claim_revision,claimed_at,
               last_heartbeat_at,last_progress_at
             ) VALUES (
               'claim-pre','channel','review','review-pre','primary',
               'operation-pre',?1,0,'2026-07-26T00:00:00Z',?2,
               '2026-07-26T00:00:00Z'
             )",
            params![owner_token, last_heartbeat_at],
        )
        .expect("active Claim");
    connection
}

#[test]
fn auth_registry_and_runtime_share_one_injected_process_generation() {
    let generation = Arc::new(ProcessGeneration::fixed_for_test("process-generation-a"));
    let authority_registry =
        OwnerAuthorityLeaseRegistry::from_process_generation(generation.clone());
    let runtime = ProvisioningRuntime::new(
        Arc::new(FixedSchemaCapabilityProvider::new(
            SchemaCapability::Available,
        )),
        generation.clone(),
        Arc::new(FixedMonotonicClock::new(0)),
        Arc::new(RecordingTicker::default()),
    );

    assert_eq!(
        authority_registry.process_generation_for_test(),
        generation.canonical()
    );
    assert_eq!(
        runtime.process_generation_for_test(),
        generation.canonical()
    );
}

#[test]
fn sealed_epoch_clock_and_expiry_fail_closed_on_rollback_and_overflow() {
    let generation = Arc::new(ProcessGeneration::fixed_for_test("process-generation-a"));
    let clock = Arc::new(FixedRepositoryUtcClock::new(1_700_000_000_000));
    let context = ClaimOwnershipRepositoryContext::new(generation, clock.clone());

    assert_eq!(
        context
            .sample_sealed_epoch_ms()
            .expect("sealed clock sample"),
        1_700_000_000_000
    );
    assert_eq!(
        derive_claim_expiry_epoch_ms(1_700_000_000_000).expect("deterministic expiry"),
        1_700_000_000_000 + LEASE_DURATION_MS
    );

    clock.set_epoch_ms(1_699_999_999_999);
    assert_eq!(
        context
            .validate_heartbeat_advance(1_700_000_000_000)
            .expect_err("clock rollback must fail closed"),
        ClaimOwnershipError::ClockAuthorityUnavailable
    );
    assert_eq!(
        derive_claim_expiry_epoch_ms(i64::MAX).expect_err("expiry overflow must fail closed"),
        ClaimOwnershipError::HeartbeatTimestampInvariantFailure
    );
}

#[test]
fn process_restart_produces_a_distinct_generation() {
    let first = ProcessGeneration::new_process();
    let restarted = ProcessGeneration::new_process();

    assert_ne!(first.canonical(), restarted.canonical());
}

#[test]
fn heartbeat_revision_cas_allows_only_one_of_two_old_snapshots() {
    let generation = Arc::new(ProcessGeneration::fixed_for_test("process-generation-a"));
    let clock = Arc::new(FixedRepositoryUtcClock::new(2_000));
    let context = ClaimOwnershipRepositoryContext::new(generation, clock);
    let mut connection = exact_v41_claim_fixture("process-generation-a", "1000");
    let claim = read_active_claim_for_operation(&connection, "operation-pre")
        .expect("Claim read")
        .expect("active Claim");
    let proof = context
        .create_proof_from_fresh_claim(claim, 7)
        .expect("repository proof");
    let first = proof.sealed_snapshot();
    let second = proof.sealed_snapshot();

    let advanced = record_claim_heartbeat_with_repository_clock(&mut connection, &context, &first)
        .expect("first heartbeat");
    assert_eq!(advanced.claim_revision, 1);
    let stale = record_claim_heartbeat_with_repository_clock(&mut connection, &context, &second)
        .expect_err("second old proof must lose CAS");
    assert_eq!(stale.code, PROVISIONING_OPERATION_CAS_CONFLICT);
}

#[test]
fn heartbeat_clock_rollback_leaves_durable_claim_unchanged() {
    let generation = Arc::new(ProcessGeneration::fixed_for_test("process-generation-a"));
    let clock = Arc::new(FixedRepositoryUtcClock::new(999));
    let context = ClaimOwnershipRepositoryContext::new(generation, clock);
    let mut connection = exact_v41_claim_fixture("process-generation-a", "1000");
    let claim = read_active_claim_for_operation(&connection, "operation-pre")
        .expect("Claim read")
        .expect("active Claim");
    let proof = context
        .create_proof_from_fresh_claim(claim, 7)
        .expect("repository proof");
    let snapshot = proof.sealed_snapshot();

    let error = record_claim_heartbeat_with_repository_clock(&mut connection, &context, &snapshot)
        .expect_err("rollback must fail closed");
    assert_eq!(error.code, PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE);
    let unchanged = read_active_claim_for_operation(&connection, "operation-pre")
        .expect("Claim readback")
        .expect("active Claim");
    assert_eq!(unchanged.claim_revision, 0);
    assert_eq!(unchanged.last_heartbeat_at, "1000");
}

#[test]
fn exact_v41_uses_existing_non_null_heartbeat_without_expiry_column() {
    let connection = exact_v41_claim_fixture("process-generation-a", "1000");
    let columns: Vec<(String, i64)> = {
        let mut statement = connection
            .prepare("PRAGMA table_info(manuscript_provisioning_active_claims)")
            .expect("table info");
        statement
            .query_map([], |row| Ok((row.get(1)?, row.get(3)?)))
            .expect("column query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("columns")
    };

    assert!(columns
        .iter()
        .any(|(name, not_null)| name == "last_heartbeat_at" && *not_null == 1));
    assert!(!columns.iter().any(|(name, _)| name == "expires_at"));
    assert_eq!(crate::db::schema::CURRENT_SCHEMA_VERSION, 58);
    assert!(connection
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET last_heartbeat_at=NULL WHERE operation_id='operation-pre'",
            [],
        )
        .is_err());
}

#[test]
fn ownership_architecture_gate_has_one_producer_and_no_automatic_heartbeat_caller() {
    let foundation = include_str!("provisioning_runtime_foundation.rs");
    let startup = include_str!("lib.rs");
    let authority_registry = include_str!("owner_authority_lease.rs");
    let operation_state = include_str!("db/manuscript_provisioning_operation_state.rs");
    let chained =
        include_str!("db/manuscript_provisioning_operation_state/chained_atomic_initialization.rs");
    let step_repository =
        include_str!("db/manuscript_provisioning_operation_state/step_progress_repository.rs");
    let ownership = include_str!("db/manuscript_provisioning_operation_state/claim_ownership.rs");
    let runtime_core = include_str!("provisioning_runtime/core.rs");
    let tauri_state = include_str!("provisioning_runtime/tauri_state.rs");

    assert_eq!(foundation.matches("Uuid::new_v4()").count(), 1);
    assert_eq!(
        startup.matches("ProcessGeneration::new_process()").count(),
        1
    );
    assert!(!authority_registry.contains("impl Default for RegistryState"));
    assert!(!authority_registry.contains("generation: Uuid::new_v4()"));
    assert!(!chained.contains("claim-owner-{}"));
    assert!(operation_state.contains("sealed_heartbeat.persisted_value()"));
    assert!(chained.contains("sealed_heartbeat.persisted_value()"));
    assert!(step_repository.contains("ownership_context.claim_owner_token()"));
    assert!(ownership.contains("pub(crate) struct ClaimOwnershipProof"));
    assert!(!ownership.contains("derive(Debug, Clone)]\npub(crate) struct ClaimOwnershipProof"));
    assert!(!runtime_core.contains("record_claim_heartbeat_foundation("));
    assert!(!tauri_state.contains("record_claim_heartbeat_foundation("));
    assert_eq!(crate::db::schema::CURRENT_SCHEMA_VERSION, 58);
}
