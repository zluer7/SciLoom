use super::durable_precondition::{
    validate_closed_payload_json_for_test, DurablePreconditionBuilder, DurablePreconditionRequest,
    DurableReplayClassification, DurableReplayExistingState, DurableRevalidationResult,
};
use crate::manuscript_provisioning_contract::{
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
    ProvisioningScopeIdentity, StableErrorCode,
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const NOW: &str = "2026-07-26T12:00:00Z";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct TempDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TempDatabase {
    fn new(label: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("labpod-r1-a-{label}-{}", Uuid::new_v4()));
        fs::create_dir(&directory).expect("create isolated database directory");
        let path = directory.join("fixture.sqlite3");
        crate::db::initialize_database_at(&path).expect("initialize exact-v41 fixture");
        Self { directory, path }
    }

    fn open(&self) -> Connection {
        let connection = Connection::open(&self.path).expect("open isolated database");
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;")
            .expect("configure isolated database");
        connection
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).expect("remove only isolated database directory");
    }
}

fn candidate_scope(owner_id: &str) -> ProvisioningScopeIdentity {
    ProvisioningScopeIdentity {
        owner_type: DurablePlanOwnerType::OutputCandidate,
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
    }
}

fn review_scope(owner_id: &str) -> ProvisioningScopeIdentity {
    ProvisioningScopeIdentity {
        owner_type: DurablePlanOwnerType::Review,
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
    }
}

fn request(
    operation_id: &str,
    scope: ProvisioningScopeIdentity,
    intent: DurablePlanIntent,
    predecessor_operation_id: Option<&str>,
) -> DurablePreconditionRequest {
    DurablePreconditionRequest {
        operation_id: operation_id.to_string(),
        scope,
        intent,
        predecessor_operation_id: predecessor_operation_id.map(str::to_string),
    }
}

fn seed_candidate_authority(connection: &Connection, owner_id: &str, reverse_file_ref_order: bool) {
    connection
        .execute(
            "INSERT INTO output_candidates (
               id,project_id,title,candidate_type,status,created_at,updated_at
             ) VALUES (?1,'project-1','Candidate','paper','draft',?2,?2)",
            (owner_id, NOW),
        )
        .expect("seed candidate owner");
    connection
        .execute(
            "INSERT OR IGNORE INTO managed_root_settings (
               id,configured_root,created_at,updated_at
             ) VALUES ('managed-root','C:/LabPod/Managed',?1,?1)",
            [NOW],
        )
        .expect("seed managed root");
    let rows = if reverse_file_ref_order {
        [
            ("manuscript-ref", "manuscript"),
            ("folder-ref", "defaultFolder"),
        ]
    } else {
        [
            ("folder-ref", "defaultFolder"),
            ("manuscript-ref", "manuscript"),
        ]
    };
    for (id, role) in rows {
        let resource_kind = if role == "defaultFolder" {
            "folder"
        } else {
            "file"
        };
        let file_type = if role == "defaultFolder" {
            "folder"
        } else {
            "markdown"
        };
        connection
            .execute(
                "INSERT INTO file_refs (
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES (
                   ?1,'outputCandidate',?2,'primary',?3,?4,
                   'managed',?5,?6,?6,?1,?7,?7
                 )",
                (
                    id,
                    owner_id,
                    resource_kind,
                    role,
                    file_type,
                    format!("C:/LabPod/Managed/{owner_id}/{id}"),
                    NOW,
                ),
            )
            .expect("seed FileRef");
    }
    connection
        .execute(
            "INSERT INTO manuscript_bindings (
               id,owner_type,owner_id,manuscript_channel,
               default_folder_file_ref_id,default_manuscript_file_ref_id,current_file_ref_id,
               created_at,updated_at
             ) VALUES (
               ?1,'outputCandidate',?2,'primary',
               'folder-ref','manuscript-ref','manuscript-ref',?3,?3
             )",
            (format!("binding-{owner_id}"), owner_id, NOW),
        )
        .expect("seed Binding");
}

fn seed_review_authority(connection: &Connection, owner_id: &str) {
    connection
        .execute(
            "INSERT OR IGNORE INTO managed_root_settings (
               id,configured_root,created_at,updated_at
             ) VALUES ('managed-root','C:/LabPod/Managed',?1,?1)",
            [NOW],
        )
        .expect("seed managed root");
    connection
        .execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,created_at,updated_at
             ) VALUES (
               'review-file','review',?1,'primary','file','manuscript',
               'managed','markdown',?2,?2,'Review',?3,?3
             )",
            (
                owner_id,
                format!("C:/LabPod/Managed/{owner_id}/review.md"),
                NOW,
            ),
        )
        .expect("seed Review FileRef");
    connection
        .execute(
            "INSERT INTO manuscript_bindings (
               id,owner_type,owner_id,manuscript_channel,
               default_manuscript_file_ref_id,current_file_ref_id,created_at,updated_at
             ) VALUES ('review-binding','review',?1,'primary','review-file','review-file',?2,?2)",
            (owner_id, NOW),
        )
        .expect("seed Review Binding");
}

fn seed_attempt(
    connection: &Connection,
    operation_id: &str,
    owner_id: &str,
    intent: &str,
    status: &str,
    next_action: Option<&str>,
    previous_operation_id: Option<&str>,
    root_operation_id: Option<&str>,
) {
    let (trigger, phase, classification, terminal_at, partial_kind, verification) = match status {
        "active" => (
            match intent {
                "retry" => "explicit-retry",
                "repair" => "explicit-repair",
                _ => "owner-create",
            },
            "preflight",
            None,
            None,
            None,
            "not-run",
        ),
        "terminal-failed" => (
            match intent {
                "retry" => "explicit-retry",
                "repair" => "explicit-repair",
                _ => "owner-create",
            },
            "failed",
            Some(if next_action == Some("repair") {
                "repair-required"
            } else {
                "retryable"
            }),
            Some(NOW),
            None,
            "not-run",
        ),
        "terminal-completed" => (
            "owner-create",
            "completed",
            Some("completed"),
            Some(NOW),
            None,
            "passed",
        ),
        "terminal-recovery-required" => (
            "owner-create",
            "partial",
            Some("provisioning-recovery-required"),
            Some(NOW),
            Some("physical-only"),
            "not-verified",
        ),
        _ => panic!("unsupported test status"),
    };
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               intent,trigger_kind,phase,operation_status,result_classification,next_action,
               partial_kind,revision,previous_operation_id,root_operation_id,
               final_verification_outcome,started_at,updated_at,terminal_at
             ) VALUES (
               ?1,'channel','outputCandidate',?2,'primary',
               ?3,?4,?5,?6,?7,?8,?9,0,?10,?11,?12,?13,?13,?14
             )",
            rusqlite::params![
                operation_id,
                owner_id,
                intent,
                trigger,
                phase,
                status,
                classification,
                next_action,
                partial_kind,
                previous_operation_id,
                root_operation_id,
                verification,
                NOW,
                terminal_at,
            ],
        )
        .expect("seed operation Attempt");
}

fn seed_plan(connection: &Connection, operation_id: &str, owner_id: &str, hash: &str) {
    let plan_id = format!(
        "{:x}",
        Sha256::digest(format!("plan:{operation_id}").as_bytes())
    );
    let step_id = format!(
        "{:x}",
        Sha256::digest(format!("step:{operation_id}").as_bytes())
    );
    let intent: String = connection
        .query_row(
            "SELECT intent FROM manuscript_provisioning_operation_attempts WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .expect("read fixture Attempt intent");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id,operation_id,plan_version,plan_template_kind,
               plan_identity_fingerprint,precondition_snapshot_hash,fingerprint_profile,
               owner_type,owner_id,scope_kind,manuscript_channel,intent,
               canonical_resource_identity_hash,canonical_placement_identity_hash,
               step_count,planner_version,created_at
             ) VALUES (
               ?1,?2,1,'managed-primary',?3,?4,'restricted-jcs-sha256-v1',
               'outputCandidate',?5,'channel','primary',?6,
               ?7,?7,1,'r1-a-test',?8
             )",
            (
                &plan_id,
                operation_id,
                HASH_A,
                hash,
                owner_id,
                intent,
                HASH_B,
                NOW,
            ),
        )
        .expect("seed isolated fixture Plan");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id,plan_id,operation_id,step_ordinal,step_kind,step_scope,
               step_version,is_required,effect_facts_schema_version,created_at,updated_at
             ) VALUES (?1,?2,?3,0,'ensure-directory','primary',1,1,1,?4,?4)",
            (&step_id, &plan_id, operation_id, NOW),
        )
        .expect("seed isolated fixture Step");
}

fn seed_terminal_predecessor(
    connection: &Connection,
    owner_id: &str,
    operation_id: &str,
    next_action: &str,
) {
    seed_attempt(
        connection,
        operation_id,
        owner_id,
        "create-default",
        "terminal-failed",
        Some(next_action),
        None,
        None,
    );
    seed_plan(connection, operation_id, owner_id, HASH_A);
}

fn build_token(
    connection: &mut Connection,
    request: &DurablePreconditionRequest,
) -> super::durable_precondition::DurablePreconditionToken {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin immediate");
    let token = DurablePreconditionBuilder::build_in_transaction(&transaction, request)
        .expect("build durable token");
    transaction.commit().expect("commit read-only transaction");
    token
}

#[test]
fn canonical_hash_is_stable_across_query_order_and_drop_reopen() {
    let first = TempDatabase::new("canonical-a");
    let second = TempDatabase::new("canonical-b");
    let mut first_connection = first.open();
    let mut second_connection = second.open();
    seed_candidate_authority(&first_connection, "candidate-1", false);
    seed_candidate_authority(&second_connection, "candidate-1", true);
    let request = request(
        "operation-new",
        candidate_scope("candidate-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );

    let first_token = build_token(&mut first_connection, &request);
    let second_token = build_token(&mut second_connection, &request);
    assert_eq!(
        first_token.canonical_hash_for_test(),
        second_token.canonical_hash_for_test(),
    );
    drop(first_connection);
    let mut reopened = first.open();
    let reopened_token = build_token(&mut reopened, &request);
    assert_eq!(
        first_token.canonical_hash_for_test(),
        reopened_token.canonical_hash_for_test(),
    );
}

#[test]
fn canonical_payload_is_closed_restricted_jcs_with_null_and_empty_fields() {
    let database = TempDatabase::new("closed-payload");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    let token = build_token(
        &mut connection,
        &request(
            "operation-new",
            candidate_scope("candidate-1"),
            DurablePlanIntent::CreateDefault,
            None,
        ),
    );
    let canonical = token.canonical_payload_for_test();
    assert!(validate_closed_payload_json_for_test(canonical));
    let value: Value = serde_json::from_str(canonical).expect("valid canonical JSON");
    let object = value.as_object().expect("closed payload object");
    assert_eq!(object.len(), 11);
    assert!(object["predecessor"].is_null());
    assert!(object["currentLeaf"].is_null());
    assert_eq!(object["priorSteps"], Value::Array(Vec::new()));
    assert!(!canonical.contains("created_at"));
    assert!(!canonical.contains("checked_at"));
    assert!(!canonical.contains("rowid"));
    assert!(!canonical.contains("plan_identity_fingerprint"));

    let mut omitted = object.clone();
    omitted.remove("managedRoot");
    assert!(!validate_closed_payload_json_for_test(
        &serde_json::to_string(&omitted).expect("serialize malformed fixture")
    ));
}

#[test]
fn review_has_null_durable_owner_but_keeps_file_binding_and_root_facts() {
    let database = TempDatabase::new("review");
    let mut connection = database.open();
    seed_review_authority(&connection, "review-1");
    let request = request(
        "review-operation",
        review_scope("review-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );
    let first = build_token(&mut connection, &request);
    let second = build_token(&mut connection, &request);
    let payload: Value =
        serde_json::from_str(first.canonical_payload_for_test()).expect("Review payload JSON");
    assert!(payload["durableOwner"].is_null());
    assert_eq!(payload["fileRefs"].as_array().expect("FileRefs").len(), 1);
    assert!(payload["binding"].is_object());
    assert!(payload["managedRoot"].is_object());
    assert_eq!(
        first.canonical_hash_for_test(),
        second.canonical_hash_for_test()
    );
}

#[test]
fn short_revalidation_matches_without_writes_then_detects_durable_stale() {
    let database = TempDatabase::new("revalidate");
    let mut setup = database.open();
    seed_candidate_authority(&setup, "candidate-1", false);
    let request = request(
        "operation-1",
        candidate_scope("candidate-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );
    let token = build_token(&mut setup, &request);
    seed_attempt(
        &setup,
        "operation-1",
        "candidate-1",
        "create-default",
        "active",
        None,
        None,
        None,
    );
    seed_plan(
        &setup,
        "operation-1",
        "candidate-1",
        token.canonical_hash_for_test(),
    );
    let changes_before = setup.total_changes();
    let transaction = setup
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin short revalidation");
    let matched =
        DurablePreconditionBuilder::short_revalidate_in_transaction(&transaction, "operation-1");
    assert!(matches!(matched, DurableRevalidationResult::Matched(_)));
    transaction.commit().expect("commit read-only revalidation");
    assert_eq!(setup.total_changes(), changes_before);

    let mut concurrent = database.open();
    let mutation = concurrent
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin concurrent durable mutation");
    mutation
        .execute(
            "UPDATE file_refs SET deleted_at=?1 WHERE id='manuscript-ref'",
            [NOW],
        )
        .expect("mutate durable FileRef facts");
    mutation.commit().expect("commit durable mutation");

    let transaction = setup
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin post-mutation revalidation");
    assert!(matches!(
        DurablePreconditionBuilder::short_revalidate_in_transaction(&transaction, "operation-1"),
        DurableRevalidationResult::DurableAuthorityStale
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");
}

#[test]
fn owner_binding_root_and_file_ref_changes_each_make_expected_hash_stale() {
    for (label, mutation) in [
        (
            "owner",
            "UPDATE output_candidates SET deleted_at='2026-07-26T12:00:00Z' WHERE id='candidate-1'",
        ),
        (
            "file-ref",
            "UPDATE file_refs SET path_identity_key='changed-key' WHERE id='manuscript-ref'",
        ),
        (
            "binding",
            "UPDATE manuscript_bindings SET current_file_ref_id='folder-ref' WHERE id='binding-candidate-1'",
        ),
        (
            "root",
            "UPDATE managed_root_settings SET configured_root='D:/Changed' WHERE id='managed-root'",
        ),
    ] {
        let database = TempDatabase::new(label);
        let mut connection = database.open();
        seed_candidate_authority(&connection, "candidate-1", false);
        let request = request(
            "operation-1",
            candidate_scope("candidate-1"),
            DurablePlanIntent::CreateDefault,
            None,
        );
        let token = build_token(&mut connection, &request);
        seed_attempt(
            &connection,
            "operation-1",
            "candidate-1",
            "create-default",
            "active",
            None,
            None,
            None,
        );
        seed_plan(
            &connection,
            "operation-1",
            "candidate-1",
            token.canonical_hash_for_test(),
        );
        connection.execute_batch(mutation).expect("mutate one durable fact");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin stale revalidation");
        assert!(matches!(
            DurablePreconditionBuilder::short_revalidate_in_transaction(
                &transaction,
                "operation-1"
            ),
            DurableRevalidationResult::DurableAuthorityStale
        ));
        transaction.rollback().expect("rollback read-only transaction");
    }
}

#[test]
fn retry_and_repair_facts_are_repository_derived_sealed_and_purpose_specific() {
    let retry_database = TempDatabase::new("retry-facts");
    let mut retry_connection = retry_database.open();
    seed_candidate_authority(&retry_connection, "candidate-1", false);
    seed_terminal_predecessor(
        &retry_connection,
        "candidate-1",
        "predecessor-retry",
        "retry",
    );
    let retry_request = request(
        "retry-operation",
        candidate_scope("candidate-1"),
        DurablePlanIntent::Retry,
        Some("predecessor-retry"),
    );
    let transaction = retry_connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin retry facts read");
    let retry =
        DurablePreconditionBuilder::read_retry_facts_in_transaction(&transaction, &retry_request)
            .expect("derive retry facts");
    assert_eq!(retry.root_operation_id_for_test(), "predecessor-retry");
    assert_eq!(retry.predecessor_revision_for_test(), 0);
    assert_eq!(retry.prior_step_count_for_test(), 1);
    transaction
        .rollback()
        .expect("rollback read-only transaction");

    let repair_database = TempDatabase::new("repair-facts");
    let mut repair_connection = repair_database.open();
    seed_candidate_authority(&repair_connection, "candidate-1", false);
    seed_terminal_predecessor(
        &repair_connection,
        "candidate-1",
        "predecessor-repair",
        "repair",
    );
    let repair_request = request(
        "repair-operation",
        candidate_scope("candidate-1"),
        DurablePlanIntent::Repair,
        Some("predecessor-repair"),
    );
    let transaction = repair_connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin repair facts read");
    let repair =
        DurablePreconditionBuilder::read_repair_facts_in_transaction(&transaction, &repair_request)
            .expect("derive repair facts");
    assert_eq!(repair.root_operation_id_for_test(), "predecessor-repair");
    assert_eq!(repair.prior_step_count_for_test(), 1);
    transaction
        .rollback()
        .expect("rollback read-only transaction");
}

#[test]
fn retry_rejects_started_unobserved_and_non_current_predecessor() {
    let database = TempDatabase::new("retry-invalid");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    seed_terminal_predecessor(&connection, "candidate-1", "predecessor", "retry");
    connection
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='started',started_at=?1 WHERE operation_id='predecessor'",
            [NOW],
        )
        .expect("seed started/unobserved state");
    let request = request(
        "retry-operation",
        candidate_scope("candidate-1"),
        DurablePlanIntent::Retry,
        Some("predecessor"),
    );
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin invalid retry read");
    assert_eq!(
        DurablePreconditionBuilder::read_retry_facts_in_transaction(&transaction, &request)
            .expect_err("started/unobserved cannot enter ordinary retry"),
        StableErrorCode::DurableInvalidOperationState
    );
    transaction
        .rollback()
        .expect("rollback read-only transaction");

    connection
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='intended',started_at=NULL WHERE operation_id='predecessor'",
            [],
        )
        .expect("restore intended state");
    seed_attempt(
        &connection,
        "child",
        "candidate-1",
        "retry",
        "terminal-failed",
        Some("retry"),
        Some("predecessor"),
        Some("predecessor"),
    );
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin current-leaf validation");
    assert_eq!(
        DurablePreconditionBuilder::read_retry_facts_in_transaction(&transaction, &request)
            .expect_err("predecessor is no longer current leaf"),
        StableErrorCode::DurableIdentityConflict
    );
    transaction
        .rollback()
        .expect("rollback read-only transaction");
}

#[test]
fn predecessor_revision_and_step_progress_changes_make_revalidation_stale() {
    for (label, mutation) in [
        (
            "predecessor-revision",
            "UPDATE manuscript_provisioning_operation_attempts
             SET revision=revision+1 WHERE operation_id='predecessor'",
        ),
        (
            "step-progress",
            "UPDATE manuscript_provisioning_step_progress
             SET progress_revision=progress_revision+1 WHERE operation_id='predecessor'",
        ),
        (
            "step-effect",
            "UPDATE manuscript_provisioning_step_progress
             SET boundary='started',effect_outcome='no-effect-proven',
                 readback_outcome='verified-absent',started_at='2026-07-26T12:00:00Z'
             WHERE operation_id='predecessor'",
        ),
    ] {
        let database = TempDatabase::new(label);
        let mut connection = database.open();
        seed_candidate_authority(&connection, "candidate-1", false);
        seed_terminal_predecessor(&connection, "candidate-1", "predecessor", "retry");
        let request = request(
            "retry-operation",
            candidate_scope("candidate-1"),
            DurablePlanIntent::Retry,
            Some("predecessor"),
        );
        let token = build_token(&mut connection, &request);
        seed_attempt(
            &connection,
            "retry-operation",
            "candidate-1",
            "retry",
            "active",
            None,
            Some("predecessor"),
            Some("predecessor"),
        );
        seed_plan(
            &connection,
            "retry-operation",
            "candidate-1",
            token.canonical_hash_for_test(),
        );
        connection
            .execute_batch(mutation)
            .expect("mutate predecessor facts");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin retry stale check");
        assert!(matches!(
            DurablePreconditionBuilder::short_revalidate_in_transaction(
                &transaction,
                "retry-operation"
            ),
            DurableRevalidationResult::DurableAuthorityStale
        ));
        transaction
            .rollback()
            .expect("rollback read-only transaction");
    }
}

#[test]
fn replay_is_read_only_and_never_bypasses_identity_or_stale_checks() {
    let database = TempDatabase::new("replay");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    let request = request(
        "operation-1",
        candidate_scope("candidate-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );
    let token = build_token(&mut connection, &request);
    seed_attempt(
        &connection,
        "operation-1",
        "candidate-1",
        "create-default",
        "active",
        None,
        None,
        None,
    );
    seed_plan(
        &connection,
        "operation-1",
        "candidate-1",
        token.canonical_hash_for_test(),
    );
    let changes = connection.total_changes();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin replay classification");
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(
            &transaction,
            "operation-1",
            &token
        ),
        DurableReplayClassification::ExactImmutablePayloadMatch(
            DurableReplayExistingState::ActiveExisting
        )
    ));
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(
            &transaction,
            "different-operation",
            &token
        ),
        DurableReplayClassification::IdentityConflict
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");
    assert_eq!(connection.total_changes(), changes);

    connection
        .execute(
            "UPDATE file_refs SET path_identity_key='stale' WHERE id='folder-ref'",
            [],
        )
        .expect("mutate durable authority");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin stale replay classification");
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(
            &transaction,
            "operation-1",
            &token
        ),
        DurableReplayClassification::DurableAuthorityStale
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");
}

#[test]
fn replay_distinguishes_terminal_recovery_and_no_existing() {
    let database = TempDatabase::new("replay-status");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    let request = request(
        "operation-1",
        candidate_scope("candidate-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );
    let token = build_token(&mut connection, &request);
    seed_attempt(
        &connection,
        "operation-1",
        "candidate-1",
        "create-default",
        "terminal-completed",
        Some("none"),
        None,
        None,
    );
    seed_plan(
        &connection,
        "operation-1",
        "candidate-1",
        token.canonical_hash_for_test(),
    );
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin terminal replay classification");
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(
            &transaction,
            "operation-1",
            &token
        ),
        DurableReplayClassification::ExactImmutablePayloadMatch(
            DurableReplayExistingState::TerminalExisting
        )
    ));
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(&transaction, "missing", &token),
        DurableReplayClassification::NoExisting | DurableReplayClassification::IdentityConflict
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");

    connection
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='partial',operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',
                 next_action='recover',partial_kind='physical-only',
                 final_verification_outcome='not-verified'
             WHERE operation_id='operation-1'",
            [],
        )
        .expect("seed recovery-required status");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin recovery replay classification");
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(
            &transaction,
            "operation-1",
            &token
        ),
        DurableReplayClassification::ExactImmutablePayloadMatch(
            DurableReplayExistingState::RecoveryRequiredExisting
        )
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");
}

#[test]
fn token_generation_and_scope_identity_are_isolated_without_affecting_hash() {
    let database = TempDatabase::new("token-isolation");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    let request_one = request(
        "operation-1",
        candidate_scope("candidate-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );
    let mut token = build_token(&mut connection, &request_one);
    let stable_hash = token.canonical_hash_for_test().to_string();
    token.invalidate_generation_for_test();
    assert_eq!(token.canonical_hash_for_test(), stable_hash);
    assert!(!token.generation_is_current_for_test());

    seed_attempt(
        &connection,
        "operation-1",
        "candidate-1",
        "create-default",
        "active",
        None,
        None,
        None,
    );
    seed_plan(&connection, "operation-1", "candidate-1", &stable_hash);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin stale-generation replay");
    assert!(matches!(
        DurablePreconditionBuilder::classify_replay_in_transaction(
            &transaction,
            "operation-1",
            &token
        ),
        DurableReplayClassification::IdentityConflict
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");
}

#[test]
fn repository_read_and_canonical_faults_fail_closed_without_builder_writes() {
    let database = TempDatabase::new("faults");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    let request = request(
        "operation-new",
        candidate_scope("candidate-1"),
        DurablePlanIntent::CreateDefault,
        None,
    );
    let changes = connection.total_changes();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin canonical fault");
    assert_eq!(
        DurablePreconditionBuilder::build_with_canonical_fault_for_test(&transaction, &request)
            .expect_err("canonical fault must fail closed"),
        StableErrorCode::DurableInternalFailure
    );
    transaction.rollback().expect("rollback canonical fault");
    assert_eq!(connection.total_changes(), changes);

    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .expect("disable fixture FK");
    connection
        .execute_batch("DROP TABLE file_refs;")
        .expect("remove only isolated fixture table");
    let changes = connection.total_changes();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin read fault");
    assert_eq!(
        DurablePreconditionBuilder::build_in_transaction(&transaction, &request)
            .expect_err("read fault must fail closed"),
        StableErrorCode::DurableRepositoryUnavailable
    );
    transaction.rollback().expect("rollback read fault");
    assert_eq!(connection.total_changes(), changes);
}

#[test]
fn each_initial_durable_source_statement_failure_is_fail_closed_and_zero_write() {
    let cases = [
        ("owner", "DROP TABLE output_candidates;"),
        ("file-ref", "DROP TABLE file_refs;"),
        ("binding", "DROP TABLE manuscript_bindings;"),
        ("managed-root", "DROP TABLE managed_root_settings;"),
        (
            "current-leaf",
            "DROP TABLE manuscript_provisioning_operation_attempts;",
        ),
    ];

    for (label, destructive_fixture_sql) in cases {
        let database = TempDatabase::new(label);
        let mut connection = database.open();
        seed_candidate_authority(&connection, "candidate-1", false);
        let request = request(
            "operation-new",
            candidate_scope("candidate-1"),
            DurablePlanIntent::CreateDefault,
            None,
        );
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable only isolated fixture FK");
        connection
            .execute_batch(destructive_fixture_sql)
            .expect("remove only isolated durable source table");
        let changes = connection.total_changes();

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin source read fault");
        assert_eq!(
            DurablePreconditionBuilder::build_in_transaction(&transaction, &request)
                .expect_err("source read fault must fail closed"),
            StableErrorCode::DurableRepositoryUnavailable,
            "{label} read failure must remain distinguishable"
        );
        transaction
            .rollback()
            .expect("rollback read-only transaction");
        assert_eq!(
            connection.total_changes(),
            changes,
            "{label} read failure must have zero builder writes"
        );
    }
}

#[test]
fn predecessor_and_prior_step_statement_failures_are_fail_closed_and_zero_write() {
    let cases = [
        (
            "predecessor",
            "DROP TABLE manuscript_provisioning_operation_attempts;",
        ),
        (
            "prior-step",
            "DROP TABLE manuscript_provisioning_step_progress;",
        ),
    ];

    for (label, destructive_fixture_sql) in cases {
        let database = TempDatabase::new(label);
        let mut connection = database.open();
        seed_candidate_authority(&connection, "candidate-1", false);
        seed_terminal_predecessor(&connection, "candidate-1", "predecessor-1", "retry");
        let request = request(
            "operation-retry",
            candidate_scope("candidate-1"),
            DurablePlanIntent::Retry,
            Some("predecessor-1"),
        );
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable only isolated fixture FK");
        connection
            .execute_batch(destructive_fixture_sql)
            .expect("remove only isolated operation source table");
        let changes = connection.total_changes();

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin operation source read fault");
        assert_eq!(
            DurablePreconditionBuilder::build_in_transaction(&transaction, &request)
                .expect_err("operation source read fault must fail closed"),
            StableErrorCode::DurableRepositoryUnavailable,
            "{label} read failure must remain distinguishable"
        );
        transaction
            .rollback()
            .expect("rollback read-only transaction");
        assert_eq!(
            connection.total_changes(),
            changes,
            "{label} read failure must have zero builder writes"
        );
    }
}

#[test]
fn short_revalidation_distinguishes_repository_failure_from_not_found() {
    let database = TempDatabase::new("revalidation-read-fault");
    let mut connection = database.open();
    seed_candidate_authority(&connection, "candidate-1", false);
    seed_attempt(
        &connection,
        "operation-1",
        "candidate-1",
        "create-default",
        "active",
        None,
        None,
        None,
    );
    seed_plan(&connection, "operation-1", "candidate-1", HASH_A);
    connection
        .execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE manuscript_provisioning_step_plans;")
        .expect("remove only isolated fixture Plan table");
    let changes = connection.total_changes();

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin revalidation read fault");
    assert!(matches!(
        DurablePreconditionBuilder::short_revalidate_in_transaction(&transaction, "operation-1"),
        DurableRevalidationResult::RepositoryUnavailable
    ));
    transaction
        .rollback()
        .expect("rollback read-only transaction");
    assert_eq!(connection.total_changes(), changes);
}

#[test]
fn begin_immediate_busy_failure_occurs_before_builder_and_changes_nothing() {
    let database = TempDatabase::new("busy");
    let mut first = database.open();
    let mut second = database.open();
    seed_candidate_authority(&first, "candidate-1", false);
    let first_transaction = first
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("hold immediate transaction");
    let second_changes = second.total_changes();
    let error = second
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect_err("second immediate transaction must be busy");
    assert!(matches!(error, rusqlite::Error::SqliteFailure(_, _)));
    assert_eq!(second.total_changes(), second_changes);
    first_transaction.rollback().expect("release isolated lock");
}
