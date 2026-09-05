use super::chained_atomic_initialization::{
    initialize_chained_operation_atomically, initialize_chained_operation_with_fault,
    ChainedAtomicInitializationRequest, ChainedAtomicInitializationResult,
    ChainedInitializationFault, ChainedInitializationIntent,
};
use crate::manuscript_provisioning_contract::{
    CanonicalResourceIdentity, DescriptorKey, DurableManuscriptChannel, DurablePlanOwnerType,
    DurablePlanScopeKind, ProvisioningScopeIdentity,
};
use rusqlite::{params, Connection};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use uuid::Uuid;

const NOW: &str = "2026-07-26T12:00:00Z";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

struct TempDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TempDatabase {
    fn new(label: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("labpod-r1-r-{label}-{}", Uuid::new_v4()));
        fs::create_dir(&directory).expect("create isolated database directory");
        let path = directory.join("fixture.sqlite3");
        crate::db::initialize_database_at(&path).expect("initialize isolated exact-v41 SQLite");
        Self { directory, path }
    }

    fn open(&self) -> Connection {
        let connection = Connection::open(&self.path).expect("open isolated exact-v41 SQLite");
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;")
            .expect("configure isolated exact-v41 SQLite");
        connection
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).expect("remove only isolated test directory");
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

fn seed_review_authority(connection: &Connection, owner_id: &str) {
    connection
        .execute(
            "INSERT OR IGNORE INTO managed_root_settings (
               id,configured_root,created_at,updated_at
             ) VALUES ('managed-root','C:/LabPod/Managed',?1,?1)",
            [NOW],
        )
        .expect("seed managed root");
    let file_id = format!("review-file-{owner_id}");
    let binding_id = format!("review-binding-{owner_id}");
    connection
        .execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,created_at,updated_at
             ) VALUES (
               ?1,'review',?2,'primary','file','manuscript',
               'managed','markdown',?3,?3,'Review',?4,?4
             )",
            (
                &file_id,
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
             ) VALUES (?1,'review',?2,'primary',?3,?3,?4,?4)",
            (&binding_id, owner_id, &file_id, NOW),
        )
        .expect("seed Review Binding");
}

fn seed_terminal_predecessor(
    connection: &Connection,
    operation_id: &str,
    owner_id: &str,
    next_action: &str,
    revision: i64,
) {
    let (classification, phase) = match next_action {
        "retry" => ("retryable", "failed"),
        "repair" => ("repair-required", "failed"),
        _ => panic!("test predecessor must be retry or repair"),
    };
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               intent,trigger_kind,phase,operation_status,result_classification,next_action,
               revision,final_verification_outcome,started_at,updated_at,terminal_at
             ) VALUES (
               ?1,'channel','review',?2,'primary',
               'create-default','owner-create',?3,'terminal-failed',?4,?5,
               ?6,'not-passed',?7,?7,?7
             )",
            (
                operation_id,
                owner_id,
                phase,
                classification,
                next_action,
                revision,
                NOW,
            ),
        )
        .expect("seed terminal predecessor Attempt");
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
               'review',?5,'channel','primary','create-default',?6,?7,1,'planner-v1',?8
             )",
            (
                HASH_A,
                operation_id,
                HASH_B,
                HASH_C,
                owner_id,
                HASH_C,
                HASH_D,
                NOW,
            ),
        )
        .expect("seed predecessor Plan");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id,plan_id,operation_id,step_ordinal,step_kind,step_scope,
               step_version,is_required,boundary,effect_outcome,readback_outcome,
               effect_facts_schema_version,progress_revision,created_at,updated_at
             ) VALUES (
               ?1,?2,?3,0,'ensure-directory','primary',
               1,1,'intended','unobserved','not-run',1,0,?4,?4
             )",
            (HASH_B, HASH_A, operation_id, NOW),
        )
        .expect("seed predecessor Step");
}

fn seed_owner_row(connection: &Connection, owner_type: DurablePlanOwnerType, owner_id: &str) {
    match owner_type {
        DurablePlanOwnerType::Experiment => connection.execute(
            "INSERT INTO experiments (
                   id,project_id,experiment_name,machine_object,fault_type,sensor_config,
                   data_path,result_summary,created_local_date,created_local_time,
                   workspace_title_identity,created_at,updated_at
                 ) VALUES (?1,'project-1','Experiment','Machine','Fault','{}','path','Summary',
                           '2026-07-26','1200','experiment',?2,?2)",
            (owner_id, NOW),
        ),
        DurablePlanOwnerType::ExperimentRun => {
            let experiment_id = format!("experiment-for-{owner_id}");
            connection
                .execute(
                    "INSERT INTO experiments (
                       id,project_id,experiment_name,machine_object,fault_type,sensor_config,
                       data_path,result_summary,created_local_date,created_local_time,
                       workspace_title_identity,created_at,updated_at
                     ) VALUES (?1,'project-1','Experiment','Machine','Fault','{}','path','Summary',
                               '2026-07-26','1200','experiment',?2,?2)",
                    (&experiment_id, NOW),
                )
                .expect("seed ExperimentRun parent");
            connection.execute(
                "INSERT INTO experiment_runs (
                   id,experiment_id,project_id,title,status,created_local_date,created_local_time,
                   workspace_title_identity,created_at,updated_at
                 ) VALUES (?1,?2,'project-1','Run','planned','2026-07-26','1200','run',?3,?3)",
                (owner_id, &experiment_id, NOW),
            )
        }
        DurablePlanOwnerType::Literature => connection.execute(
            "INSERT INTO literatures (
               id,title,reading_status,primary_project_id,created_at,updated_at
             ) VALUES (?1,'Literature','unread','project-1',?2,?2)",
            (owner_id, NOW),
        ),
        DurablePlanOwnerType::Review => return,
        DurablePlanOwnerType::ResultItem => connection.execute(
            "INSERT INTO result_items (
               id,project_id,source_type,source_id,title,result_type,created_at,updated_at
             ) VALUES (?1,'project-1','user','source-1','Result','metric',?2,?2)",
            (owner_id, NOW),
        ),
        DurablePlanOwnerType::Finding => connection.execute(
            "INSERT INTO findings (
               id,project_id,title,summary,created_at,updated_at
             ) VALUES (?1,'project-1','Finding','Summary',?2,?2)",
            (owner_id, NOW),
        ),
        DurablePlanOwnerType::OutputCandidate => connection.execute(
            "INSERT INTO output_candidates (
               id,project_id,title,candidate_type,status,created_at,updated_at
             ) VALUES (?1,'project-1','Candidate','paper','draft',?2,?2)",
            (owner_id, NOW),
        ),
        DurablePlanOwnerType::OutputGap => connection.execute(
            "INSERT INTO output_gaps (
               id,project_id,title,gap_type,status,created_at,updated_at
             ) VALUES (?1,'project-1','Gap','evidence','open',?2,?2)",
            (owner_id, NOW),
        ),
        DurablePlanOwnerType::ResearchOutput => connection.execute(
            "INSERT INTO outputs (
               id,project_id,output_name,output_type,description,created_at,updated_at
             ) VALUES (?1,'project-1','Output','paper','Description',?2,?2)",
            (owner_id, NOW),
        ),
    }
    .expect("seed durable owner row");
}

fn seed_terminal_predecessor_for_scope(
    connection: &Connection,
    operation_id: &str,
    scope: &ProvisioningScopeIdentity,
) {
    let template = match scope.owner_type {
        DurablePlanOwnerType::Experiment => "experiment-primary",
        DurablePlanOwnerType::ExperimentRun => "experiment-run-primary",
        DurablePlanOwnerType::Literature => "literature-aggregate",
        _ => "managed-primary",
    };
    let step_scope = if scope.owner_type == DurablePlanOwnerType::Literature {
        "literature-aggregate"
    } else {
        "primary"
    };
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               intent,trigger_kind,phase,operation_status,result_classification,next_action,
               revision,final_verification_outcome,started_at,updated_at,terminal_at
             ) VALUES (
               ?1,?2,?3,?4,?5,'create-default','owner-create','failed','terminal-failed',
               'retryable','retry',0,'not-passed',?6,?6,?6
             )",
            params![
                operation_id,
                scope.scope_kind.as_str(),
                scope.owner_type.as_str(),
                scope.owner_id,
                scope.manuscript_channel.map(|value| value.as_str()),
                NOW
            ],
        )
        .expect("seed owner-neutral predecessor Attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id,operation_id,plan_version,plan_template_kind,
               plan_identity_fingerprint,precondition_snapshot_hash,fingerprint_profile,
               owner_type,owner_id,scope_kind,manuscript_channel,intent,
               canonical_resource_identity_hash,canonical_placement_identity_hash,
               step_count,planner_version,created_at
             ) VALUES (
               ?1,?2,1,?3,?4,?5,'restricted-jcs-sha256-v1',
               ?6,?7,?8,?9,'create-default',?10,?11,1,'planner-v1',?12
             )",
            params![
                HASH_A,
                operation_id,
                template,
                HASH_B,
                HASH_C,
                scope.owner_type.as_str(),
                scope.owner_id,
                scope.scope_kind.as_str(),
                scope.manuscript_channel.map(|value| value.as_str()),
                HASH_C,
                HASH_D,
                NOW
            ],
        )
        .expect("seed owner-neutral predecessor Plan");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id,plan_id,operation_id,step_ordinal,step_kind,step_scope,
               step_version,is_required,boundary,effect_outcome,readback_outcome,
               effect_facts_schema_version,progress_revision,created_at,updated_at
             ) VALUES (
               ?1,?2,?3,0,'ensure-directory',?4,
               1,1,'intended','unobserved','not-run',1,0,?5,?5
             )",
            (HASH_B, HASH_A, operation_id, step_scope, NOW),
        )
        .expect("seed owner-neutral predecessor Step");
    if scope.owner_type == DurablePlanOwnerType::Literature {
        for channel in ["literature_outline", "dedicated_notes"] {
            connection
                .execute(
                    "INSERT INTO manuscript_provisioning_literature_child_states (
                       aggregate_operation_id,owner_type,owner_id,manuscript_channel,
                       current_operation_id,current_operation_scope_kind,revision,
                       child_summary_status,result_classification,next_action,
                       default_readiness,final_verification_outcome,updated_at
                     ) VALUES (
                       ?1,'literature',?2,?3,?1,'literature-aggregate',0,
                       'terminal-unresolved','retryable','retry','not-ready','not-passed',?4
                     )",
                    (operation_id, &scope.owner_id, channel, NOW),
                )
                .expect("seed Literature predecessor Projection");
        }
    }
}

fn request(
    operation_id: &str,
    predecessor_operation_id: &str,
    owner_id: &str,
    intent: ChainedInitializationIntent,
    expected_predecessor_revision: i64,
) -> ChainedAtomicInitializationRequest {
    ChainedAtomicInitializationRequest {
        operation_id: operation_id.to_string(),
        scope: review_scope(owner_id),
        intent,
        predecessor_operation_id: predecessor_operation_id.to_string(),
        expected_predecessor_revision,
        authorization_id: format!("authorization-{operation_id}"),
        descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
        canonical_resource: CanonicalResourceIdentity {
            resource_identity_hash: HASH_C.to_string(),
            placement_identity_hash: HASH_D.to_string(),
            parent_shared_identity_hash: None,
        },
        occurred_at: NOW.to_string(),
    }
}

fn row_count(connection: &Connection, table: &str, operation_id: &str) -> i64 {
    connection
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE operation_id=?1"),
            [operation_id],
            |row| row.get(0),
        )
        .expect("count operation rows")
}

#[test]
fn r1_r_closed_entry_is_production_typed_and_retry_repair_only() {
    let _entry = initialize_chained_operation_atomically;
    let _request_type = std::mem::size_of::<ChainedAtomicInitializationRequest>();
    assert_ne!(
        ChainedInitializationIntent::ExplicitRetry,
        ChainedInitializationIntent::ExplicitRepair
    );
    let _result_type = std::mem::size_of::<ChainedAtomicInitializationResult>();
}

#[test]
fn r1_r_retry_initializes_complete_exact_v41_set_with_separate_hashes() {
    let database = TempDatabase::new("retry-complete");
    let connection = database.open();
    seed_review_authority(&connection, "review-1");
    seed_terminal_predecessor(&connection, "predecessor-1", "review-1", "retry", 3);
    drop(connection);

    let result = initialize_chained_operation_atomically(
        &database.path,
        &request(
            "retry-1",
            "predecessor-1",
            "review-1",
            ChainedInitializationIntent::ExplicitRetry,
            3,
        ),
    );
    let ChainedAtomicInitializationResult::Initialized(authority) = result else {
        panic!("expected Initialized, got {result:?}");
    };
    assert_eq!(authority.predecessor_operation_id, "predecessor-1");
    assert_eq!(authority.root_operation_id, "predecessor-1");
    assert_eq!(authority.step_count, 7);
    assert_ne!(
        authority.plan_identity_fingerprint,
        authority.precondition_snapshot_hash
    );

    let connection = database.open();
    assert_eq!(
        row_count(
            &connection,
            "manuscript_provisioning_operation_attempts",
            "retry-1"
        ),
        1
    );
    assert_eq!(
        row_count(
            &connection,
            "manuscript_provisioning_active_claims",
            "retry-1"
        ),
        1
    );
    assert_eq!(
        row_count(&connection, "manuscript_provisioning_step_plans", "retry-1"),
        1
    );
    assert_eq!(
        row_count(
            &connection,
            "manuscript_provisioning_step_progress",
            "retry-1"
        ),
        7
    );
    assert_eq!(
        row_count(
            &connection,
            "manuscript_provisioning_audit_outbox",
            "retry-1"
        ),
        0
    );
}

#[test]
fn r1_r_existing_first_is_zero_write_and_revision_stable() {
    let database = TempDatabase::new("existing-first");
    let connection = database.open();
    seed_review_authority(&connection, "review-2");
    seed_terminal_predecessor(&connection, "predecessor-2", "review-2", "repair", 4);
    drop(connection);
    let existing_request = request(
        "repair-2",
        "predecessor-2",
        "review-2",
        ChainedInitializationIntent::ExplicitRepair,
        4,
    );
    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::Initialized(_)
    ));
    let connection = database.open();
    let before: (i64, i64) = connection
        .query_row(
            "SELECT a.revision,c.claim_revision
             FROM manuscript_provisioning_operation_attempts a
             JOIN manuscript_provisioning_active_claims c ON c.operation_id=a.operation_id
             WHERE a.operation_id='repair-2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read initial revisions");
    drop(connection);

    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::AuthoritativeExisting(_)
    ));
    let connection = database.open();
    let after: (i64, i64) = connection
        .query_row(
            "SELECT a.revision,c.claim_revision
             FROM manuscript_provisioning_operation_attempts a
             JOIN manuscript_provisioning_active_claims c ON c.operation_id=a.operation_id
             WHERE a.operation_id='repair-2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read replay revisions");
    assert_eq!(before, after);
}

#[test]
fn r1_r_predecessor_revision_action_and_leaf_conflicts_write_nothing() {
    let database = TempDatabase::new("predecessor-conflicts");
    let connection = database.open();
    seed_review_authority(&connection, "review-3");
    seed_terminal_predecessor(&connection, "predecessor-3", "review-3", "retry", 5);
    drop(connection);

    let stale = request(
        "retry-stale",
        "predecessor-3",
        "review-3",
        ChainedInitializationIntent::ExplicitRetry,
        4,
    );
    assert_eq!(
        initialize_chained_operation_atomically(&database.path, &stale),
        ChainedAtomicInitializationResult::PredecessorRevisionMismatch
    );
    let wrong_action = request(
        "repair-wrong",
        "predecessor-3",
        "review-3",
        ChainedInitializationIntent::ExplicitRepair,
        5,
    );
    assert_eq!(
        initialize_chained_operation_atomically(&database.path, &wrong_action),
        ChainedAtomicInitializationResult::PredecessorActionMismatch
    );

    let winner = request(
        "retry-winner",
        "predecessor-3",
        "review-3",
        ChainedInitializationIntent::ExplicitRetry,
        5,
    );
    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &winner),
        ChainedAtomicInitializationResult::Initialized(_)
    ));
    let loser = request(
        "retry-loser",
        "predecessor-3",
        "review-3",
        ChainedInitializationIntent::ExplicitRetry,
        5,
    );
    assert_eq!(
        initialize_chained_operation_atomically(&database.path, &loser),
        ChainedAtomicInitializationResult::PredecessorNotCurrentLeaf
    );
    let connection = database.open();
    assert_eq!(
        row_count(
            &connection,
            "manuscript_provisioning_operation_attempts",
            "retry-loser"
        ),
        0
    );
}

#[test]
fn r1_r_replay_detects_durable_authority_change_before_completeness() {
    let database = TempDatabase::new("durable-stale");
    let connection = database.open();
    seed_review_authority(&connection, "review-4");
    seed_terminal_predecessor(&connection, "predecessor-4", "review-4", "retry", 1);
    drop(connection);
    let existing_request = request(
        "retry-4",
        "predecessor-4",
        "review-4",
        ChainedInitializationIntent::ExplicitRetry,
        1,
    );
    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::Initialized(_)
    ));
    let connection = database.open();
    connection
        .execute(
            "UPDATE managed_root_settings
             SET configured_root='D:/Changed',updated_at=?1 WHERE id='managed-root'",
            [NOW],
        )
        .expect("change durable authority");
    drop(connection);
    assert_eq!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::DurableAuthorityStale
    );
}

#[test]
fn r1_r_existing_terminal_recovery_partial_and_identity_matrix_is_fail_closed() {
    let database = TempDatabase::new("existing-matrix");
    let connection = database.open();
    seed_review_authority(&connection, "review-5");
    seed_terminal_predecessor(&connection, "predecessor-5", "review-5", "retry", 2);
    drop(connection);
    let existing_request = request(
        "retry-5",
        "predecessor-5",
        "review-5",
        ChainedInitializationIntent::ExplicitRetry,
        2,
    );
    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::Initialized(_)
    ));

    let connection = database.open();
    connection
        .execute_batch(
            "BEGIN IMMEDIATE;
             UPDATE manuscript_provisioning_step_progress
             SET boundary='converged',effect_outcome='reused',readback_outcome='verified',
                 observed_identity_hash='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                 progress_revision=4,started_at=updated_at,effect_observed_at=updated_at,
                 readback_verified_at=updated_at,converged_at=updated_at
             WHERE operation_id='retry-5' AND step_ordinal=0;
             DELETE FROM manuscript_provisioning_active_claims WHERE operation_id='retry-5';
             UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed',operation_status='terminal-failed',
                 result_classification='retryable',next_action='retry',
                 final_verification_outcome='not-passed',terminal_at=updated_at
             WHERE operation_id='retry-5';
             COMMIT;",
        )
        .expect("terminalize existing Attempt without retaining Claim");
    drop(connection);
    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::TerminalExisting(_)
    ));

    let connection = database.open();
    connection
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed',operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',next_action='recover',
                 partial_kind='physical-only',final_verification_outcome='not-verified'
             WHERE operation_id='retry-5'",
            [],
        )
        .expect("mark existing recovery-required");
    drop(connection);
    assert!(matches!(
        initialize_chained_operation_atomically(&database.path, &existing_request),
        ChainedAtomicInitializationResult::RecoveryRequiredExisting(_)
    ));

    let mut different = existing_request.clone();
    different.canonical_resource.resource_identity_hash = HASH_A.to_string();
    assert_eq!(
        initialize_chained_operation_atomically(&database.path, &different),
        ChainedAtomicInitializationResult::IdentityConflict
    );

    let partial = TempDatabase::new("existing-partial");
    let connection = partial.open();
    seed_review_authority(&connection, "review-partial");
    seed_terminal_predecessor(
        &connection,
        "predecessor-partial",
        "review-partial",
        "repair",
        0,
    );
    drop(connection);
    let partial_request = request(
        "repair-partial",
        "predecessor-partial",
        "review-partial",
        ChainedInitializationIntent::ExplicitRepair,
        0,
    );
    assert!(matches!(
        initialize_chained_operation_atomically(&partial.path, &partial_request),
        ChainedAtomicInitializationResult::Initialized(_)
    ));
    let connection = partial.open();
    connection
        .execute(
            "DELETE FROM manuscript_provisioning_active_claims
             WHERE operation_id='repair-partial'",
            [],
        )
        .expect("create invariant-broken active set");
    drop(connection);
    assert_eq!(
        initialize_chained_operation_atomically(&partial.path, &partial_request),
        ChainedAtomicInitializationResult::ProvisioningRecoveryRequired
    );
}

#[test]
fn r1_r_statement_commit_and_post_commit_fault_matrix_has_closed_disposition() {
    let mut precommit_faults = vec![
        ChainedInitializationFault::BeginImmediate,
        ChainedInitializationFault::PredecessorRead,
        ChainedInitializationFault::CurrentLeafRead,
        ChainedInitializationFault::DurableBuilder,
        ChainedInitializationFault::AttemptInsert,
        ChainedInitializationFault::ClaimInsert,
        ChainedInitializationFault::PlanInsert,
        ChainedInitializationFault::PreconditionHashWrite,
        ChainedInitializationFault::ProjectionSync,
        ChainedInitializationFault::AuthoritativeReadback,
    ];
    for index in 0..7 {
        precommit_faults.push(ChainedInitializationFault::StepInsert(index));
        precommit_faults.push(ChainedInitializationFault::InitialProgressInsert(index));
    }
    for (ordinal, fault) in precommit_faults.into_iter().enumerate() {
        let database = TempDatabase::new(&format!("fault-{ordinal}"));
        let connection = database.open();
        let owner = format!("review-fault-{ordinal}");
        let predecessor = format!("predecessor-fault-{ordinal}");
        let operation = format!("retry-fault-{ordinal}");
        seed_review_authority(&connection, &owner);
        seed_terminal_predecessor(&connection, &predecessor, &owner, "retry", 0);
        drop(connection);
        let input = request(
            &operation,
            &predecessor,
            &owner,
            ChainedInitializationIntent::ExplicitRetry,
            0,
        );
        let result = initialize_chained_operation_with_fault(&database.path, &input, fault);
        assert!(
            matches!(
                result,
                ChainedAtomicInitializationResult::RepositoryUnavailable
                    | ChainedAtomicInitializationResult::InternalInvariantFailure
            ),
            "unexpected pre-COMMIT fault result {result:?}"
        );
        let connection = database.open();
        assert_eq!(
            row_count(
                &connection,
                "manuscript_provisioning_operation_attempts",
                &operation
            ),
            0,
            "pre-COMMIT fault must roll back Attempt: {fault:?}"
        );
        assert_eq!(
            row_count(
                &connection,
                "manuscript_provisioning_active_claims",
                &operation
            ),
            0
        );
        assert_eq!(
            row_count(
                &connection,
                "manuscript_provisioning_step_plans",
                &operation
            ),
            0
        );
        assert_eq!(
            row_count(
                &connection,
                "manuscript_provisioning_step_progress",
                &operation
            ),
            0
        );
    }

    for (label, fault, expected_persisted) in [
        (
            "commit-known-not",
            ChainedInitializationFault::CommitKnownNotCommitted,
            false,
        ),
        (
            "commit-unknown",
            ChainedInitializationFault::CommitOutcomeUnknown,
            true,
        ),
        (
            "post-commit",
            ChainedInitializationFault::PostCommitReadback,
            true,
        ),
    ] {
        let database = TempDatabase::new(label);
        let connection = database.open();
        seed_review_authority(&connection, label);
        seed_terminal_predecessor(&connection, "predecessor-commit", label, "retry", 0);
        drop(connection);
        let input = request(
            "retry-commit",
            "predecessor-commit",
            label,
            ChainedInitializationIntent::ExplicitRetry,
            0,
        );
        let result = initialize_chained_operation_with_fault(&database.path, &input, fault);
        match fault {
            ChainedInitializationFault::CommitKnownNotCommitted => {
                assert_eq!(result, ChainedAtomicInitializationResult::KnownNotCommitted)
            }
            ChainedInitializationFault::CommitOutcomeUnknown
            | ChainedInitializationFault::PostCommitReadback => assert_eq!(
                result,
                ChainedAtomicInitializationResult::ProvisioningRecoveryRequired
            ),
            _ => unreachable!(),
        }
        let connection = database.open();
        assert_eq!(
            row_count(
                &connection,
                "manuscript_provisioning_operation_attempts",
                "retry-commit"
            ),
            i64::from(expected_persisted)
        );
    }
}

#[test]
fn r1_r_two_connection_competition_has_one_child_and_same_id_replays() {
    let database = TempDatabase::new("concurrency-child");
    let connection = database.open();
    seed_review_authority(&connection, "review-concurrency");
    seed_terminal_predecessor(
        &connection,
        "predecessor-concurrency",
        "review-concurrency",
        "retry",
        0,
    );
    drop(connection);
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for operation in ["concurrent-a", "concurrent-b"] {
        let path = database.path.clone();
        let barrier = Arc::clone(&barrier);
        let input = request(
            operation,
            "predecessor-concurrency",
            "review-concurrency",
            ChainedInitializationIntent::ExplicitRetry,
            0,
        );
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            initialize_chained_operation_atomically(&path, &input)
        }));
    }
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("join concurrency worker"))
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, ChainedAtomicInitializationResult::Initialized(_)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                **result == ChainedAtomicInitializationResult::PredecessorNotCurrentLeaf
            })
            .count(),
        1
    );
    let connection = database.open();
    let children: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id='predecessor-concurrency'",
            [],
            |row| row.get(0),
        )
        .expect("count competing children");
    assert_eq!(children, 1);

    let same = TempDatabase::new("concurrency-same-id");
    let connection = same.open();
    seed_review_authority(&connection, "review-same");
    seed_terminal_predecessor(&connection, "predecessor-same", "review-same", "repair", 0);
    drop(connection);
    let barrier = Arc::new(Barrier::new(3));
    let input = request(
        "same-operation",
        "predecessor-same",
        "review-same",
        ChainedInitializationIntent::ExplicitRepair,
        0,
    );
    let workers = (0..2)
        .map(|_| {
            let path = same.path.clone();
            let input = input.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                initialize_chained_operation_atomically(&path, &input)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("join same-id worker"))
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, ChainedAtomicInitializationResult::Initialized(_)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                matches!(
                    result,
                    ChainedAtomicInitializationResult::AuthoritativeExisting(_)
                )
            })
            .count(),
        1
    );
}

#[test]
fn r1_r_all_nine_owners_are_isolated_and_literature_projection_is_atomic() {
    let owners = [
        DurablePlanOwnerType::Experiment,
        DurablePlanOwnerType::ExperimentRun,
        DurablePlanOwnerType::Literature,
        DurablePlanOwnerType::Review,
        DurablePlanOwnerType::ResultItem,
        DurablePlanOwnerType::Finding,
        DurablePlanOwnerType::OutputCandidate,
        DurablePlanOwnerType::OutputGap,
        DurablePlanOwnerType::ResearchOutput,
    ];
    let mut plan_fingerprints = BTreeSet::new();
    let mut durable_hashes = BTreeSet::new();
    for owner_type in owners {
        let label = owner_type.as_str();
        let database = TempDatabase::new(&format!("owner-{label}"));
        let connection = database.open();
        let owner_id = format!("owner-{label}");
        seed_owner_row(&connection, owner_type, &owner_id);
        let scope = if owner_type == DurablePlanOwnerType::Literature {
            ProvisioningScopeIdentity {
                owner_type,
                owner_id: owner_id.clone(),
                scope_kind: DurablePlanScopeKind::LiteratureAggregate,
                manuscript_channel: None,
            }
        } else {
            ProvisioningScopeIdentity {
                owner_type,
                owner_id: owner_id.clone(),
                scope_kind: DurablePlanScopeKind::Channel,
                manuscript_channel: Some(DurableManuscriptChannel::Primary),
            }
        };
        let predecessor_id = format!("predecessor-{label}");
        seed_terminal_predecessor_for_scope(&connection, &predecessor_id, &scope);
        drop(connection);
        let operation_id = format!("retry-{label}");
        let input = ChainedAtomicInitializationRequest {
            operation_id: operation_id.clone(),
            scope: scope.clone(),
            intent: ChainedInitializationIntent::ExplicitRetry,
            predecessor_operation_id: predecessor_id,
            expected_predecessor_revision: 0,
            authorization_id: format!("authorization-{label}"),
            descriptor_key: DescriptorKey(
                if owner_type == DurablePlanOwnerType::Literature {
                    "literature-aggregate-v1"
                } else {
                    "managed-primary-v1"
                }
                .to_string(),
            ),
            canonical_resource: CanonicalResourceIdentity {
                resource_identity_hash: HASH_C.to_string(),
                placement_identity_hash: HASH_D.to_string(),
                parent_shared_identity_hash: None,
            },
            occurred_at: NOW.to_string(),
        };
        let result = initialize_chained_operation_atomically(&database.path, &input);
        let ChainedAtomicInitializationResult::Initialized(authority) = result else {
            panic!("owner {label} must initialize, got {result:?}");
        };
        assert_eq!(
            authority.step_count,
            if owner_type == DurablePlanOwnerType::Literature {
                11
            } else {
                7
            }
        );
        assert!(plan_fingerprints.insert(authority.plan_identity_fingerprint));
        assert!(durable_hashes.insert(authority.precondition_snapshot_hash));
        let connection = database.open();
        let projection_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
                 WHERE aggregate_operation_id=?1",
                [&operation_id],
                |row| row.get(0),
            )
            .expect("count conditional Projection rows");
        assert_eq!(
            projection_count,
            if owner_type == DurablePlanOwnerType::Literature {
                2
            } else {
                0
            }
        );
    }
    assert_eq!(plan_fingerprints.len(), 9);
    assert_eq!(durable_hashes.len(), 9);
}

#[test]
fn r1_r_literature_projection_fault_rolls_back_the_entire_new_aggregate() {
    let database = TempDatabase::new("projection-fault");
    let connection = database.open();
    let scope = ProvisioningScopeIdentity {
        owner_type: DurablePlanOwnerType::Literature,
        owner_id: "literature-projection-fault".to_string(),
        scope_kind: DurablePlanScopeKind::LiteratureAggregate,
        manuscript_channel: None,
    };
    seed_owner_row(&connection, scope.owner_type, &scope.owner_id);
    seed_terminal_predecessor_for_scope(&connection, "literature-predecessor", &scope);
    drop(connection);
    let input = ChainedAtomicInitializationRequest {
        operation_id: "literature-retry".to_string(),
        scope,
        intent: ChainedInitializationIntent::ExplicitRetry,
        predecessor_operation_id: "literature-predecessor".to_string(),
        expected_predecessor_revision: 0,
        authorization_id: "authorization-literature-retry".to_string(),
        descriptor_key: DescriptorKey("literature-aggregate-v1".to_string()),
        canonical_resource: CanonicalResourceIdentity {
            resource_identity_hash: HASH_C.to_string(),
            placement_identity_hash: HASH_D.to_string(),
            parent_shared_identity_hash: None,
        },
        occurred_at: NOW.to_string(),
    };
    assert_eq!(
        initialize_chained_operation_with_fault(
            &database.path,
            &input,
            ChainedInitializationFault::ProjectionSync,
        ),
        ChainedAtomicInitializationResult::InternalInvariantFailure
    );
    let connection = database.open();
    assert_eq!(
        row_count(
            &connection,
            "manuscript_provisioning_operation_attempts",
            "literature-retry"
        ),
        0
    );
    let projections: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id='literature-retry'",
            [],
            |row| row.get(0),
        )
        .expect("count rolled-back Projection rows");
    assert_eq!(projections, 0);
}

#[test]
fn r1_r_architecture_gate_has_one_entry_and_no_caller_authority_bypass() {
    let source = include_str!("chained_atomic_initialization.rs").replace("\r\n", "\n");
    assert_eq!(
        source
            .matches("#[cfg(not(test))]\npub(crate) fn initialize_chained_operation_atomically",)
            .count(),
        1
    );
    assert_eq!(
        source
            .matches("#[cfg(test)]\npub(crate) fn initialize_chained_operation_atomically")
            .count(),
        1
    );
    let request_contract = source
        .split("pub(crate) struct ChainedAtomicInitializationRequest")
        .nth(1)
        .and_then(|tail| tail.split('}').next())
        .expect("request contract source");
    for forbidden in [
        "root_operation_id",
        "current_leaf",
        "precondition_snapshot_hash",
        "plan_identity_fingerprint",
        "steps:",
        "ordinal",
        "DurablePreconditionToken",
    ] {
        assert!(
            !request_contract.contains(forbidden),
            "caller authority bypass remained in request: {forbidden}"
        );
    }
    assert!(source.contains("token: &DurablePreconditionToken"));
    assert!(!source.contains("std::fs"));
    assert!(!source.contains("Adapter"));
    assert!(!source.contains("Planning"));

    let legacy = include_str!("step_progress_repository.rs");
    assert!(legacy.contains("ordinary Retry/Repair must use the sealed-token chained initializer"));
    let contract = include_str!("../../manuscript_provisioning_contract.rs");
    let operation_reference = contract
        .split("pub(crate) struct OperationReference")
        .nth(1)
        .and_then(|tail| tail.split('}').next())
        .expect("OperationReference source");
    assert!(!operation_reference.contains("root_operation_id"));
    assert!(!operation_reference.contains("terminal"));
}
