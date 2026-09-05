use crate::db::manuscript_provisioning_operation_state::{
    initialize_chained_operation_atomically, ChainedAtomicInitializationRequest,
    ChainedAtomicInitializationResult, ChainedInitializationIntent,
};
use crate::manuscript_provisioning_contract::{
    CanonicalResourceIdentity, DescriptorKey, DurableManuscriptChannel, DurablePlanOwnerType,
    DurablePlanScopeKind, ProvisioningScopeIdentity,
};
use crate::provisioning_runtime::core::ProvisioningRuntime;
use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
use crate::provisioning_runtime::non_completed_exit::{
    seal_not_invoked_for_test, EffectRisk, ExitFault, HeartbeatFoundationFault,
    HeartbeatFoundationResult, NonCompletedExitReason, NonCompletedExitResult,
    PermitBoundaryResult, PermitFault, RuntimeHandleRegistrationResult, RuntimeRegistryLifecycle,
};
use crate::provisioning_runtime::schema_capability::{
    FixedSchemaCapabilityProvider, SchemaCapability,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use rusqlite::{params, Connection};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::thread;
use uuid::Uuid;

const NOW: &str = "2026-07-26T13:00:00Z";
const LATER: &str = "2026-07-26T13:01:00Z";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

pub(crate) struct TempDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TempDatabase {
    pub(crate) fn new(label: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("labpod-p1-02-{label}-{}", Uuid::new_v4()));
        fs::create_dir(&directory).expect("create isolated P1-02 directory");
        let path = directory.join("fixture.sqlite3");
        crate::db::initialize_test_database_at(&path)
            .expect("initialize isolated exact-v41 SQLite");
        Self { directory, path }
    }

    pub(crate) fn open(&self) -> Connection {
        let connection = Connection::open(&self.path).expect("open isolated exact-v41 SQLite");
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;")
            .expect("configure isolated exact-v41 SQLite");
        connection
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).expect("remove isolated P1-02 directory");
    }
}

fn runtime() -> ProvisioningRuntime {
    ProvisioningRuntime::new(
        Arc::new(FixedSchemaCapabilityProvider::new(
            SchemaCapability::Available,
        )),
        Arc::new(ProcessGeneration::new(
            "00000000-0000-4000-8000-00000000p102",
        )),
        Arc::new(FixedMonotonicClock::new(100)),
        Arc::new(RecordingTicker::default()),
    )
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
    let path = format!("C:/LabPod/Managed/{owner_id}/review.md");
    connection
        .execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,created_at,updated_at
             ) VALUES (
               ?1,'review',?2,'primary','file','manuscript',
               'managed','markdown',?3,?3,'Review',?4,?4
             )",
            (&file_id, owner_id, &path, NOW),
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

fn seed_terminal_predecessor(connection: &Connection, operation_id: &str, owner_id: &str) {
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               intent,trigger_kind,phase,operation_status,result_classification,next_action,
               revision,final_verification_outcome,started_at,updated_at,terminal_at
             ) VALUES (
               ?1,'channel','review',?2,'primary','create-default','owner-create',
               'failed','terminal-failed','retryable','retry',0,'not-passed',?3,?3,?3
             )",
            (operation_id, owner_id, NOW),
        )
        .expect("seed predecessor Attempt");
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

pub(crate) fn initialized_review(
    database: &TempDatabase,
    suffix: &str,
) -> ChainedAtomicInitializationResult {
    let owner_id = format!("review-{suffix}");
    let predecessor = format!("predecessor-{suffix}");
    let operation = format!("operation-{suffix}");
    let connection = database.open();
    seed_review_authority(&connection, &owner_id);
    seed_terminal_predecessor(&connection, &predecessor, &owner_id);
    drop(connection);
    initialize_chained_operation_atomically(
        &database.path,
        &ChainedAtomicInitializationRequest {
            operation_id: operation,
            scope: review_scope(&owner_id),
            intent: ChainedInitializationIntent::ExplicitRetry,
            predecessor_operation_id: predecessor,
            expected_predecessor_revision: 0,
            authorization_id: format!("authorization-{suffix}"),
            descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
            canonical_resource: CanonicalResourceIdentity {
                resource_identity_hash: HASH_C.to_string(),
                placement_identity_hash: HASH_D.to_string(),
                parent_shared_identity_hash: None,
            },
            occurred_at: NOW.to_string(),
        },
    )
}

fn seed_owner_row(connection: &Connection, owner_type: DurablePlanOwnerType, owner_id: &str) {
    match owner_type {
        DurablePlanOwnerType::Experiment => connection.execute(
            "INSERT INTO experiments (
               id,project_id,experiment_name,machine_object,fault_type,sensor_config,
               data_path,result_summary,created_local_date,created_local_time,
               workspace_title_identity,created_at,updated_at
             ) VALUES (?1,'project-1','Experiment','Machine','Fault','{}','path','Summary',
                       '2026-07-26','1300','experiment',?2,?2)",
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
                               '2026-07-26','1300','experiment',?2,?2)",
                    (&experiment_id, NOW),
                )
                .expect("seed ExperimentRun parent");
            connection.execute(
                "INSERT INTO experiment_runs (
                   id,experiment_id,project_id,title,status,created_local_date,created_local_time,
                   workspace_title_identity,created_at,updated_at
                 ) VALUES (?1,?2,'project-1','Run','planned','2026-07-26','1300','run',?3,?3)",
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
    .expect("seed owner row");
}

fn seed_terminal_predecessor_for_scope(
    connection: &Connection,
    operation_id: &str,
    scope: &ProvisioningScopeIdentity,
) {
    let template = if scope.owner_type == DurablePlanOwnerType::Literature {
        "literature-aggregate"
    } else {
        "managed-primary"
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
        .expect("seed owner predecessor Attempt");
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
        .expect("seed owner predecessor Plan");
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
        .expect("seed owner predecessor Step");
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
                .expect("seed predecessor Literature projection");
        }
    }
}

pub(crate) fn initialized_owner(
    database: &TempDatabase,
    owner_type: DurablePlanOwnerType,
) -> ChainedAtomicInitializationResult {
    let label = owner_type.as_str();
    let owner_id = format!("owner-{label}");
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
    let predecessor = format!("predecessor-{label}");
    let connection = database.open();
    seed_owner_row(&connection, owner_type, &owner_id);
    seed_terminal_predecessor_for_scope(&connection, &predecessor, &scope);
    drop(connection);
    initialize_chained_operation_atomically(
        &database.path,
        &ChainedAtomicInitializationRequest {
            operation_id: format!("operation-{label}"),
            scope,
            intent: ChainedInitializationIntent::ExplicitRetry,
            predecessor_operation_id: predecessor,
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
        },
    )
}

fn registered_review(
    runtime: &ProvisioningRuntime,
    database: &TempDatabase,
    suffix: &str,
) -> crate::provisioning_runtime::non_completed_exit::ProvisioningRuntimeHandle {
    match runtime
        .register_initialized_runtime_handle(&database.path, initialized_review(database, suffix))
    {
        RuntimeHandleRegistrationResult::Registered(handle) => handle,
        other => panic!("expected registered Runtime Handle, got {other:?}"),
    }
}

#[test]
fn p1_03_pre_heartbeat_replaces_registry_proof_and_permit_reads_latest_revision() {
    let database = TempDatabase::new("pre-heartbeat-proof");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "pre-heartbeat-proof");

    assert_eq!(handle.registry_snapshot_for_test().claim_revision, Some(0));
    assert_eq!(
        handle.record_claim_heartbeat_foundation(),
        HeartbeatFoundationResult::HeartbeatFoundationUpdated
    );
    assert_eq!(handle.registry_snapshot_for_test().claim_revision, Some(1));

    let connection = database.open();
    let durable: (i64, String, String) = connection
        .query_row(
            "SELECT claim_revision,last_heartbeat_at,claim_owner_token
             FROM manuscript_provisioning_active_claims
             WHERE operation_id=?1",
            [handle.operation_id_for_test()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("durable heartbeat readback");
    assert_eq!(durable.0, 1);
    assert!(durable.1.parse::<i64>().is_ok());
    assert_eq!(durable.2, runtime.test_app_instance_token());
    assert!(matches!(
        handle.issue_execution_permit(LATER),
        PermitBoundaryResult::Issued(_)
    ));
}

#[test]
fn p1_03_pre_handle_factory_rejects_claim_from_another_process_generation() {
    let database = TempDatabase::new("pre-generation-mismatch");
    let initialization = initialized_review(&database, "pre-generation-mismatch");
    let other_runtime = ProvisioningRuntime::new(
        Arc::new(FixedSchemaCapabilityProvider::new(
            SchemaCapability::Available,
        )),
        Arc::new(ProcessGeneration::new(
            "00000000-0000-4000-8000-00000000other",
        )),
        Arc::new(FixedMonotonicClock::new(100)),
        Arc::new(RecordingTicker::default()),
    );

    assert!(matches!(
        other_runtime.register_initialized_runtime_handle(&database.path, initialization),
        RuntimeHandleRegistrationResult::HandleOwnershipConflict
    ));
    assert_eq!(other_runtime.snapshot().active_slot_count, 0);
}

#[test]
fn p1_03_pre_known_commit_plus_registry_replacement_failure_quarantines_every_path() {
    let database = TempDatabase::new("pre-registry-replacement-conflict");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "pre-registry-replacement-conflict");

    assert_eq!(
        handle.record_claim_heartbeat_with_fault_for_test(
            HeartbeatFoundationFault::RegistryReplacementConflict,
        ),
        HeartbeatFoundationResult::RegistryReplacementConflict
    );
    assert_eq!(
        handle.registry_snapshot_for_test().lifecycle,
        RuntimeRegistryLifecycle::Quarantined
    );
    assert_eq!(handle.registry_snapshot_for_test().claim_revision, None);
    assert!(matches!(
        handle.issue_execution_permit(LATER),
        PermitBoundaryResult::HandleStale
    ));
    assert_eq!(
        handle.record_claim_heartbeat_foundation(),
        HeartbeatFoundationResult::RegistryProofStale
    );
}

#[test]
fn p1_03_pre_heartbeat_commit_unknown_invalidates_old_proof_without_retry() {
    let database = TempDatabase::new("pre-heartbeat-commit-unknown");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "pre-heartbeat-commit-unknown");

    assert_eq!(
        handle.record_claim_heartbeat_with_fault_for_test(
            HeartbeatFoundationFault::PostCommitOutcomeUnknown,
        ),
        HeartbeatFoundationResult::CommitOutcomeUnknown
    );
    assert_eq!(
        handle.registry_snapshot_for_test().lifecycle,
        RuntimeRegistryLifecycle::Quarantined
    );
    assert_eq!(handle.registry_snapshot_for_test().claim_revision, None);
    assert_eq!(
        handle.record_claim_heartbeat_foundation(),
        HeartbeatFoundationResult::RegistryProofStale
    );
}

fn operation_facts(connection: &Connection, operation_id: &str) -> (String, i64, i64) {
    let status = connection
        .query_row(
            "SELECT operation_status FROM manuscript_provisioning_operation_attempts
             WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .expect("read Attempt status");
    let claims = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_active_claims WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .expect("count Claims");
    let outboxes = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_audit_outbox WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .expect("count Outboxes");
    (status, claims, outboxes)
}

#[test]
fn p1_02_effect_risk_join_never_downgrades_indeterminate() {
    assert_eq!(
        EffectRisk::NoEffectPossible.join(EffectRisk::EffectIndeterminate),
        EffectRisk::EffectIndeterminate
    );
    assert_eq!(
        EffectRisk::EffectIndeterminate.join(EffectRisk::NoEffectProven),
        EffectRisk::EffectIndeterminate
    );
}

#[test]
fn p1_02_receipt_registers_one_handle_and_window_detach_is_non_authoritative() {
    let database = TempDatabase::new("registry");
    let runtime = runtime();
    let handle = registered_review(&runtime, &database, "registry");
    let operation_id = handle.operation_id_for_test().to_string();
    let claim_id = handle.claim_id_for_test().to_string();

    assert!(matches!(
        runtime.register_initialized_runtime_handle(
            &database.path,
            ChainedAtomicInitializationResult::AuthoritativeExisting(
                handle.initialization_authority_for_test()
            )
        ),
        RuntimeHandleRegistrationResult::NotFreshInitialization
    ));
    let first = handle.attach_window("window-a").expect("attach window A");
    let second = handle.attach_window("window-b").expect("attach window B");
    assert_eq!(handle.registry_snapshot_for_test().subscription_count, 2);
    assert!(first.request_cancellation());
    drop(first);
    assert_eq!(handle.registry_snapshot_for_test().subscription_count, 1);
    assert!(handle.registry_snapshot_for_test().cancellation_requested);
    assert_eq!(handle.operation_id_for_test(), operation_id);
    assert_eq!(handle.claim_id_for_test(), claim_id);
    drop(second);
    drop(handle);

    let retained = runtime.runtime_registry_snapshot_for_test(&operation_id);
    assert_eq!(
        retained.lifecycle,
        RuntimeRegistryLifecycle::DroppedUnclosed
    );
    assert_eq!(operation_facts(&database.open(), &operation_id).1, 1);
}

#[test]
fn p1_02_permit_is_issued_only_after_started_boundary_is_durable() {
    let database = TempDatabase::new("permit");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "permit");
    let operation_id = handle.operation_id_for_test().to_string();

    let permit = match handle.issue_execution_permit(LATER) {
        PermitBoundaryResult::Issued(permit) => permit,
        other => panic!("expected Permit, got {other:?}"),
    };
    let connection = database.open();
    let (boundary, effect, revision): (String, String, i64) = connection
        .query_row(
            "SELECT boundary,effect_outcome,progress_revision
             FROM manuscript_provisioning_step_progress
             WHERE operation_id=?1 AND step_ordinal=0",
            [&operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read committed permit boundary");
    assert_eq!(
        (boundary.as_str(), effect.as_str(), revision),
        ("started", "unobserved", 1)
    );
    assert_eq!(permit.operation_id_for_test(), operation_id);
    assert_eq!(permit.progress_revision_for_test(), 1);
    drop(permit);
}

#[test]
fn p1_02_cancel_before_permit_atomically_terminalizes_and_releases_claim() {
    let database = TempDatabase::new("safe-close");
    let runtime = runtime();
    let handle = registered_review(&runtime, &database, "safe-close");
    let operation_id = handle.operation_id_for_test().to_string();

    assert_eq!(
        handle.close_non_completed(NonCompletedExitReason::ExplicitCancel, LATER),
        NonCompletedExitResult::SafelyTerminalizedAndReleased
    );
    assert_eq!(
        operation_facts(&database.open(), &operation_id),
        ("terminal-failed".to_string(), 0, 1)
    );
    assert!(runtime
        .runtime_registry_snapshot_optional_for_test(&operation_id)
        .is_none());
}

#[test]
fn p1_02_issued_permit_without_sealed_receipt_recovers_and_retains_claim() {
    let database = TempDatabase::new("issued-close");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "issued-close");
    let operation_id = handle.operation_id_for_test().to_string();
    let permit = match handle.issue_execution_permit(LATER) {
        PermitBoundaryResult::Issued(permit) => permit,
        other => panic!("expected Permit, got {other:?}"),
    };
    drop(permit);

    assert_eq!(
        handle.close_non_completed(NonCompletedExitReason::RuntimeShutdown, LATER),
        NonCompletedExitResult::RecoveryRequiredAndRetained
    );
    assert_eq!(
        operation_facts(&database.open(), &operation_id),
        ("terminal-recovery-required".to_string(), 1, 1)
    );
    assert_eq!(
        runtime
            .runtime_registry_snapshot_for_test(&operation_id)
            .lifecycle,
        RuntimeRegistryLifecycle::Retained
    );
}

#[test]
fn p1_02_sealed_not_invoked_plus_durable_no_effect_safely_releases() {
    let database = TempDatabase::new("sealed-safe");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "sealed-safe");
    let operation_id = handle.operation_id_for_test().to_string();
    let permit = match handle.issue_execution_permit(LATER) {
        PermitBoundaryResult::Issued(permit) => permit,
        other => panic!("expected Permit, got {other:?}"),
    };
    let receipt =
        seal_not_invoked_for_test(permit, &mut handle, LATER).expect("sealed no-effect receipt");
    assert_eq!(receipt.operation_id_for_test(), operation_id);

    assert_eq!(
        handle.close_non_completed(NonCompletedExitReason::AdapterUnavailable, LATER),
        NonCompletedExitResult::SafelyTerminalizedAndReleased
    );
    assert_eq!(
        operation_facts(&database.open(), &operation_id),
        ("terminal-failed".to_string(), 0, 1)
    );
}

#[test]
fn p1_02_same_claim_second_fresh_handle_is_rejected() {
    let database = TempDatabase::new("double-handle");
    let runtime = runtime();
    let initialized = initialized_review(&database, "double-handle");
    let ChainedAtomicInitializationResult::Initialized(authority) = &initialized else {
        panic!("fixture must initialize");
    };
    let duplicate = ChainedAtomicInitializationResult::Initialized(authority.clone());
    let first = runtime.register_initialized_runtime_handle(&database.path, initialized);
    let second = runtime.register_initialized_runtime_handle(&database.path, duplicate);
    assert!(matches!(
        first,
        RuntimeHandleRegistrationResult::Registered(_)
    ));
    assert!(matches!(
        second,
        RuntimeHandleRegistrationResult::HandleOwnershipConflict
    ));
}

#[test]
fn p1_02_external_terminalization_race_fails_closed_without_overwrite() {
    let database = TempDatabase::new("terminal-race");
    let runtime = runtime();
    let handle = registered_review(&runtime, &database, "terminal-race");
    let operation_id = handle.operation_id_for_test().to_string();
    let connection = database.open();
    connection
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET phase='blocked',operation_status='terminal-blocked',
                 result_classification='blocked',next_action='stop',
                 original_cause_code='EXTERNAL_TERMINAL',
                 revision=revision+1,updated_at=?1,terminal_at=?1
             WHERE operation_id=?2 AND operation_status='active'",
            (LATER, &operation_id),
        )
        .expect("external terminalization");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
             ) VALUES (?1,'pending',0,0,?2,?2)",
            (&operation_id, LATER),
        )
        .expect("external terminal outbox");
    connection
        .execute(
            "DELETE FROM manuscript_provisioning_active_claims WHERE operation_id=?1",
            [&operation_id],
        )
        .expect("external Claim release");
    drop(connection);

    assert_eq!(
        handle.close_non_completed(NonCompletedExitReason::ExplicitCancel, LATER),
        NonCompletedExitResult::AuthoritativeExistingTerminal
    );
    assert_eq!(
        operation_facts(&database.open(), &operation_id),
        ("terminal-blocked".to_string(), 0, 1)
    );
}

#[test]
fn p1_02_architecture_gate_keeps_runtime_protocol_sealed_and_unwired() {
    let source =
        include_str!("provisioning_runtime/non_completed_exit.rs").replace("\r\n", "\n");
    let crate_root = include_str!("lib.rs");
    assert_eq!(
        source
            .matches("fn close_runtime_handle_non_completed_atomically")
            .count(),
        1
    );
    assert!(!source.contains("Serialize"));
    assert!(!source.contains("Deserialize"));
    assert!(!source.contains("std::fs"));
    assert!(!source.contains("crate::planning"));
    assert!(!source.contains("AdapterOutcome"));
    assert!(!source.contains("#[tauri::command]"));
    assert!(!source.contains("impl Clone for ProvisioningRuntimeHandle"));
    assert!(!source.contains("impl Clone for RuntimeExecutionPermit"));
    assert!(source.contains("pub(crate) fn close_non_completed(\n        mut self,"));
    assert!(!crate_root.contains("register_initialized_runtime_handle("));
    assert_eq!(crate::db::schema::CURRENT_SCHEMA_VERSION, 58);
}

#[test]
fn p1_02_permit_boundary_faults_rollback_or_quarantine_without_permit() {
    for (index, fault) in [
        PermitFault::Begin,
        PermitFault::DurableValidation,
        PermitFault::StepUpdate,
        PermitFault::PreCommitReadback,
        PermitFault::CommitKnownNotCommitted,
    ]
    .into_iter()
    .enumerate()
    {
        let database = TempDatabase::new(&format!("permit-rollback-{index}"));
        let runtime = runtime();
        let mut handle =
            registered_review(&runtime, &database, &format!("permit-rollback-{index}"));
        let operation_id = handle.operation_id_for_test().to_string();
        assert!(!matches!(
            handle.issue_execution_permit_with_fault_for_test(LATER, fault),
            PermitBoundaryResult::Issued(_)
        ));
        let step: (String, i64) = database
            .open()
            .query_row(
                "SELECT boundary,progress_revision
                 FROM manuscript_provisioning_step_progress
                 WHERE operation_id=?1 AND step_ordinal=0",
                [&operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read rolled-back Step");
        assert_eq!(step, ("intended".to_string(), 0));
        assert_eq!(
            operation_facts(&database.open(), &operation_id),
            ("active".to_string(), 1, 0)
        );
    }

    for (index, fault) in [
        PermitFault::CommitOutcomeUnknown,
        PermitFault::PostCommitReadback,
    ]
    .into_iter()
    .enumerate()
    {
        let database = TempDatabase::new(&format!("permit-unknown-{index}"));
        let runtime = runtime();
        let mut handle = registered_review(&runtime, &database, &format!("permit-unknown-{index}"));
        let operation_id = handle.operation_id_for_test().to_string();
        assert!(matches!(
            handle.issue_execution_permit_with_fault_for_test(LATER, fault),
            PermitBoundaryResult::CommitOutcomeUnknownQuarantined
        ));
        assert_eq!(
            handle.registry_snapshot_for_test().lifecycle,
            RuntimeRegistryLifecycle::Quarantined
        );
        let step: (String, i64) = database
            .open()
            .query_row(
                "SELECT boundary,progress_revision
                 FROM manuscript_provisioning_step_progress
                 WHERE operation_id=?1 AND step_ordinal=0",
                [&operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read unknown Step");
        assert_eq!(step, ("started".to_string(), 1));
    }
}

#[test]
fn p1_02_exit_statement_fault_matrix_rolls_back_before_commit() {
    let faults = [
        ExitFault::BeginExit,
        ExitFault::AttemptRead,
        ExitFault::ClaimRead,
        ExitFault::StepRead,
        ExitFault::ProjectionRead,
        ExitFault::RiskJoin,
        ExitFault::AttemptUpdate,
        ExitFault::StepUpdate,
        ExitFault::ProjectionSync,
        ExitFault::OutboxInsert,
        ExitFault::ClaimRelease,
        ExitFault::PreCommitReadback,
        ExitFault::CommitKnownNotCommitted,
    ];
    for (index, fault) in faults.into_iter().enumerate() {
        let database = TempDatabase::new(&format!("exit-fault-{index}"));
        let runtime = runtime();
        let handle = registered_review(&runtime, &database, &format!("exit-fault-{index}"));
        let operation_id = handle.operation_id_for_test().to_string();
        let result = handle.close_non_completed_with_fault_for_test(
            NonCompletedExitReason::ExplicitCancel,
            LATER,
            fault,
        );
        assert!(
            !matches!(
                result,
                NonCompletedExitResult::SafelyTerminalizedAndReleased
                    | NonCompletedExitResult::RecoveryRequiredAndRetained
            ),
            "fault {fault:?} must not report a committed exit"
        );
        assert_eq!(
            operation_facts(&database.open(), &operation_id),
            ("active".to_string(), 1, 0),
            "fault {fault:?} must roll back the entire exit"
        );
        assert_eq!(
            runtime
                .runtime_registry_snapshot_for_test(&operation_id)
                .lifecycle,
            RuntimeRegistryLifecycle::DroppedUnclosed
        );
    }
}

#[test]
fn p1_02_exit_commit_unknown_never_replays_and_keeps_quarantine() {
    for (index, fault) in [
        ExitFault::CommitOutcomeUnknown,
        ExitFault::PostCommitReadback,
    ]
    .into_iter()
    .enumerate()
    {
        let database = TempDatabase::new(&format!("exit-unknown-{index}"));
        let runtime = runtime();
        let handle = registered_review(&runtime, &database, &format!("exit-unknown-{index}"));
        let operation_id = handle.operation_id_for_test().to_string();
        assert_eq!(
            handle.close_non_completed_with_fault_for_test(
                NonCompletedExitReason::ExplicitCancel,
                LATER,
                fault,
            ),
            NonCompletedExitResult::CommitOutcomeUnknownQuarantined
        );
        assert_eq!(
            runtime
                .runtime_registry_snapshot_for_test(&operation_id)
                .lifecycle,
            RuntimeRegistryLifecycle::Quarantined
        );
        assert!(operation_facts(&database.open(), &operation_id).2 <= 1);
    }
}

#[test]
fn p1_02_permit_issue_failure_after_boundary_requires_recovery() {
    let database = TempDatabase::new("permit-issue");
    let runtime = runtime();
    let mut handle = registered_review(&runtime, &database, "permit-issue");
    let operation_id = handle.operation_id_for_test().to_string();
    assert!(matches!(
        handle.issue_execution_permit_with_fault_for_test(LATER, PermitFault::PermitIssue),
        PermitBoundaryResult::ProvisioningRecoveryRequired
    ));
    let step: (String, String, i64) = database
        .open()
        .query_row(
            "SELECT boundary,effect_outcome,progress_revision
             FROM manuscript_provisioning_step_progress
             WHERE operation_id=?1 AND step_ordinal=0",
            [&operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read committed boundary");
    assert_eq!(step, ("started".to_string(), "unobserved".to_string(), 1));
    assert_eq!(
        handle.close_non_completed(NonCompletedExitReason::RuntimeShutdown, LATER),
        NonCompletedExitResult::RecoveryRequiredAndRetained
    );
    assert_eq!(
        operation_facts(&database.open(), &operation_id),
        ("terminal-recovery-required".to_string(), 1, 1)
    );
}

#[test]
fn p1_02_recovery_exit_faults_never_release_claim() {
    for (index, fault) in [
        ExitFault::RecoveryUpdate,
        ExitFault::ProjectionSync,
        ExitFault::OutboxInsert,
        ExitFault::PreCommitReadback,
        ExitFault::CommitKnownNotCommitted,
    ]
    .into_iter()
    .enumerate()
    {
        let database = TempDatabase::new(&format!("recovery-fault-{index}"));
        let runtime = runtime();
        let mut handle = registered_review(&runtime, &database, &format!("recovery-fault-{index}"));
        let operation_id = handle.operation_id_for_test().to_string();
        let permit = match handle.issue_execution_permit(LATER) {
            PermitBoundaryResult::Issued(permit) => permit,
            other => panic!("expected Permit, got {other:?}"),
        };
        drop(permit);
        let result = handle.close_non_completed_with_fault_for_test(
            NonCompletedExitReason::RuntimeShutdown,
            LATER,
            fault,
        );
        assert!(!matches!(
            result,
            NonCompletedExitResult::SafelyTerminalizedAndReleased
                | NonCompletedExitResult::RecoveryRequiredAndRetained
        ));
        assert_eq!(
            operation_facts(&database.open(), &operation_id),
            ("active".to_string(), 1, 0),
            "fault {fault:?} must retain the Claim and roll back exit"
        );
    }
}

#[test]
fn p1_02_drop_and_panic_leave_non_executable_registry_and_durable_claim() {
    let database = TempDatabase::new("panic");
    let runtime = runtime();
    let operation_id = "operation-panic".to_string();
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _handle = registered_review(&runtime, &database, "panic");
        panic!("simulated Runtime task panic");
    }));
    assert!(panic.is_err());
    assert_eq!(
        runtime
            .runtime_registry_snapshot_for_test(&operation_id)
            .lifecycle,
        RuntimeRegistryLifecycle::DroppedUnclosed
    );
    assert_eq!(
        operation_facts(&database.open(), &operation_id),
        ("active".to_string(), 1, 0)
    );
}

#[test]
fn p1_02_all_nine_owners_share_one_runtime_protocol_and_isolated_authority() {
    for owner_type in [
        DurablePlanOwnerType::Experiment,
        DurablePlanOwnerType::ExperimentRun,
        DurablePlanOwnerType::Literature,
        DurablePlanOwnerType::Review,
        DurablePlanOwnerType::ResultItem,
        DurablePlanOwnerType::Finding,
        DurablePlanOwnerType::OutputCandidate,
        DurablePlanOwnerType::OutputGap,
        DurablePlanOwnerType::ResearchOutput,
    ] {
        let label = owner_type.as_str();
        let database = TempDatabase::new(&format!("owner-{label}"));
        let runtime = runtime();
        let initialized = initialized_owner(&database, owner_type);
        let mut handle =
            match runtime.register_initialized_runtime_handle(&database.path, initialized) {
                RuntimeHandleRegistrationResult::Registered(handle) => handle,
                other => panic!("owner {label} registration failed: {other:?}"),
            };
        let operation_id = handle.operation_id_for_test().to_string();
        let permit = match handle.issue_execution_permit(LATER) {
            PermitBoundaryResult::Issued(permit) => permit,
            other => panic!("owner {label} Permit failed: {other:?}"),
        };
        drop(permit);
        assert_eq!(
            handle.close_non_completed(NonCompletedExitReason::RuntimeShutdown, LATER),
            NonCompletedExitResult::RecoveryRequiredAndRetained,
            "owner {label}"
        );
        assert_eq!(
            operation_facts(&database.open(), &operation_id),
            ("terminal-recovery-required".to_string(), 1, 1),
            "owner {label}"
        );
        if owner_type == DurablePlanOwnerType::Literature {
            let projections: i64 = database
                .open()
                .query_row(
                    "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
                     WHERE aggregate_operation_id=?1
                       AND child_summary_status='terminal-unresolved'
                       AND result_classification='provisioning-recovery-required'
                       AND next_action='recover'",
                    [&operation_id],
                    |row| row.get(0),
                )
                .expect("read Literature projections");
            assert_eq!(projections, 2);
        }
    }
}

#[test]
fn p1_02_parallel_same_claim_registration_has_exactly_one_live_handle() {
    let database = TempDatabase::new("parallel-register");
    let runtime = Arc::new(runtime());
    let initialized = initialized_review(&database, "parallel-register");
    let ChainedAtomicInitializationResult::Initialized(authority) = initialized else {
        panic!("fixture must initialize");
    };
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let runtime = runtime.clone();
        let barrier = barrier.clone();
        let path = database.path.clone();
        let receipt = ChainedAtomicInitializationResult::Initialized(authority.clone());
        joins.push(thread::spawn(move || {
            barrier.wait();
            runtime.register_initialized_runtime_handle(&path, receipt)
        }));
    }
    barrier.wait();
    let results = joins
        .into_iter()
        .map(|join| join.join().expect("registration thread"))
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, RuntimeHandleRegistrationResult::Registered(_)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                matches!(
                    result,
                    RuntimeHandleRegistrationResult::HandleOwnershipConflict
                )
            })
            .count(),
        1
    );
}
