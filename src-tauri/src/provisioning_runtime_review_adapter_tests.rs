use crate::db::manuscript_provisioning_operation_state::{
    initialize_chained_operation_atomically, read_active_claim_for_operation,
    ChainedAtomicInitializationRequest, ChainedAtomicInitializationResult,
    ChainedInitializationIntent, ProvisioningActiveClaim,
};
use crate::manuscript_provisioning_contract::{
    CanonicalResourceIdentity, DescriptorKey, DurableManuscriptChannel, DurablePlanOwnerType,
    DurablePlanScopeKind, ProvisioningScopeIdentity,
};
use crate::provisioning_runtime::review_adapter::{
    CanonicalReviewAdapter, ReviewAdapterFault, ReviewAdapterResult, ReviewLifecycleState,
    ReviewPlanningAuthority, ReviewPlanningAuthorityVerifier,
};
use crate::provisioning_runtime::shared_executor::{
    SharedExecutionResult, SharedExecutorFoundation,
};
use crate::provisioning_runtime_non_completed_exit_tests::TempDatabase;
use crate::provisioning_runtime_shared_executor_tests::{
    acquire_recovery, prepared_executor_for_owner, recovery_harness,
};
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

const NOW: &str = "2026-07-26T14:00:00Z";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone)]
struct TestReviewAuthority {
    state: Arc<Mutex<ReviewPlanningAuthority>>,
}

impl TestReviewAuthority {
    fn new(review_id: &str) -> Self {
        Self {
            state: Arc::new(Mutex::new(ReviewPlanningAuthority {
                review_id: review_id.to_string(),
                project_id: "project-cra-1".to_string(),
                lifecycle: ReviewLifecycleState::Active,
                authority_revision: "review-authority-r1".to_string(),
            })),
        }
    }

    fn set_lifecycle(&self, lifecycle: ReviewLifecycleState) {
        self.state.lock().expect("authority lock").lifecycle = lifecycle;
    }
}

impl ReviewPlanningAuthorityVerifier for TestReviewAuthority {
    fn read_fresh(&self, review_id: &str) -> Result<ReviewPlanningAuthority, ReviewAdapterResult> {
        let state = self.state.lock().expect("authority lock").clone();
        if state.review_id == review_id {
            Ok(state)
        } else {
            Err(ReviewAdapterResult::ReviewLifecycleDenied)
        }
    }
}

struct ReviewFixture {
    database: TempDatabase,
    review_id: String,
    managed_root: PathBuf,
    workspace: PathBuf,
    manuscript: PathBuf,
    authority: TestReviewAuthority,
}

impl ReviewFixture {
    fn new(label: &str) -> Self {
        let database = TempDatabase::new(label);
        let review_id = format!("review-cra-{label}");
        let managed_root = database
            .path()
            .parent()
            .expect("fixture directory")
            .join("managed");
        fs::create_dir(&managed_root).expect("create managed root");
        let workspace = managed_root.join(format!("workspace-{label}"));
        let manuscript = workspace.join("review.md");
        let authority = TestReviewAuthority::new(&review_id);
        seed_review_metadata(
            &database.open(),
            &review_id,
            &managed_root,
            &workspace,
            &manuscript,
        );
        Self {
            database,
            review_id,
            managed_root,
            workspace,
            manuscript,
            authority,
        }
    }

    fn adapter(&self) -> Result<CanonicalReviewAdapter, ReviewAdapterResult> {
        CanonicalReviewAdapter::inspect(
            self.database.path().to_path_buf(),
            &self.review_id,
            Arc::new(self.authority.clone()),
        )
    }

    fn metadata_digest(&self) -> (i64, i64, String, String, String) {
        self.database
            .open()
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM file_refs WHERE owner_type='review' AND owner_id=?1),
                   (SELECT COUNT(*) FROM manuscript_bindings
                      WHERE owner_type='review' AND owner_id=?1),
                   b.default_folder_file_ref_id,b.default_manuscript_file_ref_id,b.current_file_ref_id
                 FROM manuscript_bindings b
                 WHERE b.owner_type='review' AND b.owner_id=?1 AND b.manuscript_channel='primary'",
                [&self.review_id],
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
            .expect("metadata digest")
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn seed_review_metadata(
    connection: &Connection,
    review_id: &str,
    managed_root: &Path,
    workspace: &Path,
    manuscript: &Path,
) {
    let folder_id = format!("folder-{review_id}");
    let manuscript_id = format!("manuscript-{review_id}");
    let binding_id = format!("binding-{review_id}");
    let managed_root = path_string(managed_root);
    let workspace = path_string(workspace);
    let manuscript = path_string(manuscript);
    connection
        .execute(
            "INSERT INTO managed_root_settings (
               id,configured_root,created_at,updated_at
             ) VALUES ('managed-root',?1,?2,?2)",
            params![managed_root, NOW],
        )
        .expect("seed managed root");
    connection
        .execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,created_at,updated_at
             ) VALUES (
               ?1,'review',?2,'primary','folder','defaultFolder',
               'managed','folder',?3,?3,'Review workspace',?4,?4
             )",
            params![folder_id, review_id, workspace, NOW],
        )
        .expect("seed workspace FileRef");
    connection
        .execute(
            "INSERT INTO file_refs (
               id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
               location_mode,file_type,path,path_identity_key,title,created_at,updated_at
             ) VALUES (
               ?1,'review',?2,'primary','file','manuscript',
               'managed','markdown',?3,?3,'Review',?4,?4
             )",
            params![manuscript_id, review_id, manuscript, NOW],
        )
        .expect("seed manuscript FileRef");
    connection
        .execute(
            "INSERT INTO manuscript_bindings (
               id,owner_type,owner_id,manuscript_channel,default_folder_file_ref_id,
               default_manuscript_file_ref_id,current_file_ref_id,created_at,updated_at
             ) VALUES (?1,'review',?2,'primary',?3,?4,?4,?5,?5)",
            params![binding_id, review_id, folder_id, manuscript_id, NOW],
        )
        .expect("seed Review Binding");
}

fn review_scope(review_id: &str) -> ProvisioningScopeIdentity {
    ProvisioningScopeIdentity {
        owner_type: DurablePlanOwnerType::Review,
        owner_id: review_id.to_string(),
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
    }
}

fn seed_terminal_predecessor(
    connection: &Connection,
    operation_id: &str,
    review_id: &str,
    resource_hash: &str,
    placement_hash: &str,
    parent_hash: &str,
) {
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
            params![operation_id, review_id, NOW],
        )
        .expect("seed terminal predecessor Attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id,operation_id,plan_version,plan_template_kind,
               plan_identity_fingerprint,precondition_snapshot_hash,fingerprint_profile,
               owner_type,owner_id,scope_kind,manuscript_channel,intent,
               canonical_resource_identity_hash,canonical_placement_identity_hash,
               parent_shared_identity_hash,step_count,planner_version,created_at
             ) VALUES (
               ?1,?2,1,'managed-primary',?3,?4,'restricted-jcs-sha256-v1',
               'review',?5,'channel','primary','create-default',?6,?7,?8,1,'planner-v1',?9
             )",
            params![
                HASH_A,
                operation_id,
                HASH_B,
                resource_hash,
                review_id,
                resource_hash,
                placement_hash,
                parent_hash,
                NOW
            ],
        )
        .expect("seed terminal predecessor Plan");
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
            params![HASH_B, HASH_A, operation_id, NOW],
        )
        .expect("seed terminal predecessor Step");
}

fn initialize_claim(
    fixture: &ReviewFixture,
    adapter: &CanonicalReviewAdapter,
) -> ProvisioningActiveClaim {
    let predecessor = format!("predecessor-{}", fixture.review_id);
    let operation = format!("operation-{}", fixture.review_id);
    seed_terminal_predecessor(
        &fixture.database.open(),
        &predecessor,
        &fixture.review_id,
        adapter.canonical_resource_identity_hash(),
        adapter.canonical_placement_identity_hash(),
        adapter.parent_identity_hash(),
    );
    let result = initialize_chained_operation_atomically(
        fixture.database.path(),
        &ChainedAtomicInitializationRequest {
            operation_id: operation,
            scope: review_scope(&fixture.review_id),
            intent: ChainedInitializationIntent::ExplicitRetry,
            predecessor_operation_id: predecessor,
            expected_predecessor_revision: 0,
            authorization_id: format!("authorization-{}", fixture.review_id),
            descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
            canonical_resource: CanonicalResourceIdentity {
                resource_identity_hash: adapter.canonical_resource_identity_hash().to_string(),
                placement_identity_hash: adapter.canonical_placement_identity_hash().to_string(),
                parent_shared_identity_hash: Some(adapter.parent_identity_hash().to_string()),
            },
            occurred_at: NOW.to_string(),
        },
    );
    let operation_id = match result {
        ChainedAtomicInitializationResult::Initialized(authority)
        | ChainedAtomicInitializationResult::AuthoritativeExisting(authority) => {
            authority.operation_id
        }
        other => panic!("CRA fixture initialization failed: {other:?}"),
    };
    read_active_claim_for_operation(&fixture.database.open(), &operation_id)
        .expect("read initialized Claim")
        .expect("initialized Claim")
}

fn prepared_executor(
    fixture: &ReviewFixture,
    adapter: &CanonicalReviewAdapter,
) -> (SharedExecutorFoundation, String) {
    let claim = initialize_claim(fixture, adapter);
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (runtime, monotonic, authority_registry) = recovery_harness(
        &fixture.database,
        heartbeat,
        &format!("cra-process-generation-{}", fixture.review_id),
    );
    let recovery_claim = acquire_recovery(&fixture.database, &runtime, &monotonic, &claim);
    let executor = SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry)
        .expect("production-compiled CRA Shared Executor");
    (executor, recovery_claim)
}

#[test]
fn cra1_descriptor_is_stable_closed_and_review_primary_only() {
    let fixture = ReviewFixture::new("descriptor");
    let adapter = fixture.adapter().expect("inspect CRA");
    assert_eq!(
        CanonicalReviewAdapter::adapter_id(),
        "labpod.review.primary.recovery"
    );
    assert_eq!(
        CanonicalReviewAdapter::contract_version(),
        "review-primary-recovery@1"
    );
    assert_eq!(CanonicalReviewAdapter::descriptor_hash().len(), 64);
    assert_eq!(CanonicalReviewAdapter::capability_fingerprint().len(), 64);
    let manifest =
        crate::provisioning_runtime::shared_executor::SharedExecutionAdapter::manifest(&adapter);
    assert_eq!(manifest.step_count_for_test(), 2);
}

#[test]
fn cra1_missing_managed_targets_are_created_zero_byte_without_metadata_writes() {
    let fixture = ReviewFixture::new("create");
    let before = fixture.metadata_digest();
    let adapter = fixture.adapter().expect("inspect missing targets");
    let (executor, recovery_claim) = prepared_executor(&fixture, &adapter);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-create",
            &adapter,
        )
        .expect("materialize CRA execution");
    let mut adapter = adapter;
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    assert!(fixture.workspace.is_dir());
    assert!(!fixture.manuscript.exists());
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::Completed
    );
    assert!(fixture.manuscript.is_file());
    assert_eq!(
        fs::metadata(&fixture.manuscript).expect("manuscript").len(),
        0
    );
    assert_eq!(fixture.metadata_digest(), before);
}

#[test]
fn cra1_exact_existing_targets_are_reused_without_content_or_metadata_change() {
    let fixture = ReviewFixture::new("reuse");
    fs::create_dir(&fixture.workspace).expect("create existing workspace");
    fs::File::create(&fixture.manuscript).expect("create existing empty manuscript");
    let before = fixture.metadata_digest();
    let adapter = fixture.adapter().expect("inspect matching targets");
    let (executor, recovery_claim) = prepared_executor(&fixture, &adapter);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-reuse",
            &adapter,
        )
        .expect("materialize CRA reuse");
    let mut adapter = adapter;
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::Completed
    );
    assert_eq!(fs::read(&fixture.manuscript).expect("read manuscript"), b"");
    assert_eq!(fixture.metadata_digest(), before);
    assert_eq!(
        adapter.last_result(),
        ReviewAdapterResult::ReviewTargetReused
    );
}

#[test]
fn cra1_nonempty_manuscript_is_a_zero_mutation_conflict() {
    let fixture = ReviewFixture::new("nonempty");
    fs::create_dir(&fixture.workspace).expect("create workspace");
    fs::write(&fixture.manuscript, b"user-authored-content").expect("seed content");
    assert!(matches!(
        fixture.adapter(),
        Err(ReviewAdapterResult::ReviewPhysicalConflict)
    ));
    assert_eq!(
        fs::read(&fixture.manuscript).expect("content preserved"),
        b"user-authored-content"
    );
}

#[test]
fn cra1_external_default_manuscript_is_denied_without_filesystem_effect() {
    let fixture = ReviewFixture::new("external");
    fixture
        .database
        .open()
        .execute(
            "UPDATE file_refs SET location_mode='external'
             WHERE owner_type='review' AND owner_id=?1 AND file_role='manuscript'",
            [&fixture.review_id],
        )
        .expect("mark external");
    assert!(matches!(
        fixture.adapter(),
        Err(ReviewAdapterResult::ReviewExternalMutationDenied)
    ));
    assert!(!fixture.workspace.exists());
    assert!(!fixture.manuscript.exists());
}

#[test]
fn cra1_missing_binding_or_fileref_and_denied_lifecycle_fail_closed() {
    let fixture = ReviewFixture::new("authority");
    fixture
        .database
        .open()
        .execute(
            "UPDATE manuscript_bindings SET deleted_at=?2
             WHERE owner_type='review' AND owner_id=?1",
            params![fixture.review_id, NOW],
        )
        .expect("soft-delete Binding");
    assert!(matches!(
        fixture.adapter(),
        Err(ReviewAdapterResult::MetadataAuthorityIncomplete)
    ));
    let lifecycle_fixture = ReviewFixture::new("lifecycle");
    lifecycle_fixture
        .authority
        .set_lifecycle(ReviewLifecycleState::SoftDeleted);
    assert!(matches!(
        lifecycle_fixture.adapter(),
        Err(ReviewAdapterResult::ReviewLifecycleDenied)
    ));
    assert!(!fixture.workspace.exists());
    assert!(!lifecycle_fixture.workspace.exists());

    let file_ref_fixture = ReviewFixture::new("missing-fileref");
    file_ref_fixture
        .database
        .open()
        .execute(
            "UPDATE file_refs SET deleted_at=?2
             WHERE owner_type='review' AND owner_id=?1 AND resource_kind='folder'",
            params![file_ref_fixture.review_id, NOW],
        )
        .expect("soft-delete FileRef");
    assert!(matches!(
        file_ref_fixture.adapter(),
        Err(ReviewAdapterResult::MetadataAuthorityIncomplete)
    ));
    assert!(!file_ref_fixture.workspace.exists());

    let current_conflict_fixture = ReviewFixture::new("current-conflict");
    current_conflict_fixture
        .database
        .open()
        .execute(
            "UPDATE manuscript_bindings
             SET current_file_ref_id=default_folder_file_ref_id
             WHERE owner_type='review' AND owner_id=?1",
            [&current_conflict_fixture.review_id],
        )
        .expect("seed invalid current reference");
    assert!(matches!(
        current_conflict_fixture.adapter(),
        Err(ReviewAdapterResult::MetadataAuthorityIncomplete)
    ));
    assert!(!current_conflict_fixture.workspace.exists());
}

#[test]
fn cra1_multi_component_missing_workspace_is_rejected() {
    let fixture = ReviewFixture::new("multilevel");
    let nested_workspace = fixture
        .managed_root
        .join("missing-parent")
        .join("workspace");
    let nested_manuscript = nested_workspace.join("review.md");
    let connection = fixture.database.open();
    connection
        .execute(
            "UPDATE file_refs SET path=?2,path_identity_key=?2
             WHERE owner_type='review' AND owner_id=?1 AND resource_kind='folder'",
            params![fixture.review_id, path_string(&nested_workspace)],
        )
        .expect("move planned workspace metadata");
    connection
        .execute(
            "UPDATE file_refs SET path=?2,path_identity_key=?2
             WHERE owner_type='review' AND owner_id=?1 AND file_role='manuscript'",
            params![fixture.review_id, path_string(&nested_manuscript)],
        )
        .expect("move planned manuscript metadata");
    drop(connection);
    assert!(matches!(
        fixture.adapter(),
        Err(ReviewAdapterResult::ReviewContainmentFailed)
    ));
    assert!(!nested_workspace.exists());
}

#[test]
fn cra1_identity_change_between_plan_and_invoke_is_not_mutated() {
    let fixture = ReviewFixture::new("identity-race");
    let adapter = fixture.adapter().expect("inspect");
    let (executor, recovery_claim) = prepared_executor(&fixture, &adapter);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-identity-race",
            &adapter,
        )
        .expect("materialize");
    fixture
        .database
        .open()
        .execute(
            "UPDATE file_refs SET updated_at='2026-07-26T14:01:00Z'
             WHERE owner_type='review' AND owner_id=?1 AND resource_kind='folder'",
            [&fixture.review_id],
        )
        .expect("change authority after plan");
    let mut adapter = adapter;
    assert!(matches!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::AdapterPreMutationRejected | SharedExecutionResult::RecoveryRequired
    ));
    assert!(!fixture.workspace.exists());
    assert!(!fixture.manuscript.exists());
}

#[test]
fn cra1_concurrent_exact_creation_is_no_clobber_and_reused() {
    let fixture = ReviewFixture::new("concurrent");
    let adapter = fixture.adapter().expect("inspect");
    let (executor, recovery_claim) = prepared_executor(&fixture, &adapter);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-concurrent",
            &adapter,
        )
        .expect("materialize");
    fs::create_dir(&fixture.workspace).expect("concurrent directory create");
    let mut adapter = adapter;
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    fs::File::create(&fixture.manuscript).expect("concurrent file create");
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::Completed
    );
    assert_eq!(fs::metadata(&fixture.manuscript).expect("file").len(), 0);
}

#[test]
fn cra1_restored_review_is_freshly_admitted() {
    let fixture = ReviewFixture::new("restored");
    fixture
        .authority
        .set_lifecycle(ReviewLifecycleState::Restored);
    assert!(fixture.adapter().is_ok());
    assert!(!fixture.workspace.exists());
}

#[test]
fn cra1_interrupted_unknown_partial_and_unavailable_are_conservative() {
    for (label, fault) in [
        ("interrupted", ReviewAdapterFault::InvocationInterrupted),
        (
            "unknown-after-effect",
            ReviewAdapterFault::InvocationOutcomeUnknownAfterEffect,
        ),
        (
            "readback-unavailable",
            ReviewAdapterFault::ReadbackUnavailable,
        ),
        ("readback-partial", ReviewAdapterFault::ReadbackPartial),
        (
            "permission-unavailable",
            ReviewAdapterFault::PreMutationUnavailable,
        ),
    ] {
        let fixture = ReviewFixture::new(label);
        let mut adapter = fixture.adapter().expect("inspect fault fixture");
        let (executor, recovery_claim) = prepared_executor(&fixture, &adapter);
        let mut handle = executor
            .materialize_recovery_execution(
                &recovery_claim,
                "project-cra-1",
                "test-only-cra-window",
                label,
                &adapter,
            )
            .expect("materialize fault fixture");
        adapter.set_fault_for_test(fault);
        assert!(matches!(
            handle.execute_next_step(&mut adapter),
            SharedExecutionResult::RecoveryRequired
                | SharedExecutionResult::AdapterPreMutationRejected
        ));
        assert!(!fixture.manuscript.exists());
        if matches!(
            fault,
            ReviewAdapterFault::InvocationInterrupted | ReviewAdapterFault::PreMutationUnavailable
        ) {
            assert!(!fixture.workspace.exists());
        }
    }
}

#[test]
fn cra1_commit_response_loss_reconciles_without_second_effect() {
    let fixture = ReviewFixture::new("commit-loss");
    let adapter = fixture.adapter().expect("inspect");
    let (executor, recovery_claim) = prepared_executor(&fixture, &adapter);
    let mut handle = executor
        .materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-commit-loss",
            &adapter,
        )
        .expect("materialize");
    handle.force_result_response_loss_once_for_test();
    let mut adapter = adapter;
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::StepConverged
    );
    assert!(fixture.workspace.is_dir());
    assert!(!fixture.manuscript.exists());
    assert_eq!(
        handle.execute_next_step(&mut adapter),
        SharedExecutionResult::Completed
    );
    assert_eq!(fs::metadata(&fixture.manuscript).expect("file").len(), 0);
}

#[test]
fn cra1_restart_after_unknown_does_not_replay_the_effect() {
    let fixture = ReviewFixture::new("restart-no-replay");
    let mut first_adapter = fixture.adapter().expect("inspect");
    let (executor, recovery_claim) = prepared_executor(&fixture, &first_adapter);
    let mut first_handle = executor
        .materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-restart-first",
            &first_adapter,
        )
        .expect("materialize first execution");
    first_adapter.set_fault_for_test(ReviewAdapterFault::ReadbackPartial);
    assert_eq!(
        first_handle.execute_next_step(&mut first_adapter),
        SharedExecutionResult::RecoveryRequired
    );
    assert!(fixture.workspace.is_dir());
    let execution_id = first_handle.operation_id_for_test().to_string();
    let retained_claim = read_active_claim_for_operation(&fixture.database.open(), &execution_id)
        .expect("read retained Claim")
        .expect("retained Claim");
    let heartbeat = retained_claim
        .last_heartbeat_at
        .parse::<i64>()
        .expect("heartbeat");
    drop(first_handle);

    let (runtime, monotonic, authority_registry) = recovery_harness(
        &fixture.database,
        heartbeat,
        "cra-restart-second-process-generation",
    );
    let second_recovery =
        acquire_recovery(&fixture.database, &runtime, &monotonic, &retained_claim);
    let second_executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry)
            .expect("second executor");
    let second_adapter = fixture.adapter().expect("fresh second adapter");
    assert!(matches!(
        second_executor.materialize_recovery_execution(
            &second_recovery,
            "project-cra-1",
            "test-only-cra-window",
            "cra-restart-second",
            &second_adapter,
        ),
        Err(SharedExecutionResult::RecoveryAuthorityUnavailable)
    ));
    assert!(fixture.workspace.is_dir());
    assert!(!fixture.manuscript.exists());
}

#[test]
fn cra1_dual_materializer_has_one_durable_winner() {
    let fixture = ReviewFixture::new("dual-materializer");
    let seed_adapter = fixture.adapter().expect("inspect");
    let (executor, recovery_claim) = prepared_executor(&fixture, &seed_adapter);
    let first = fixture.adapter().expect("first adapter");
    let second = fixture.adapter().expect("second adapter");
    let executor = Arc::new(executor);
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for (index, adapter) in [first, second].into_iter().enumerate() {
        let executor = executor.clone();
        let barrier = barrier.clone();
        let recovery_claim = recovery_claim.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            executor
                .materialize_recovery_execution(
                    &recovery_claim,
                    "project-cra-1",
                    &format!("cra-dual-window-{index}"),
                    &format!("cra-dual-materializer-{index}"),
                    &adapter,
                )
                .is_ok()
        }));
    }
    barrier.wait();
    let winners = workers
        .into_iter()
        .map(|worker| worker.join().expect("materializer thread"))
        .filter(|won| *won)
        .count();
    assert_eq!(winners, 1);
    assert!(!fixture.workspace.exists());
}

#[test]
fn cra1_dual_executor_has_one_durable_winner() {
    let fixture = ReviewFixture::new("dual-executor");
    let seed_adapter = fixture.adapter().expect("inspect");
    let claim = initialize_claim(&fixture, &seed_adapter);
    let heartbeat = claim.last_heartbeat_at.parse::<i64>().expect("heartbeat");
    let (runtime, monotonic, authority_registry) = recovery_harness(
        &fixture.database,
        heartbeat,
        "cra-dual-executor-process-generation",
    );
    let recovery_claim =
        acquire_recovery(&fixture.database, &runtime, &monotonic, &claim);
    let first_executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry.clone())
            .expect("first executor");
    let second_executor =
        SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry)
            .expect("second executor");
    let first = fixture.adapter().expect("first adapter");
    let second = fixture.adapter().expect("second adapter");
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for (index, (executor, adapter)) in
        [(first_executor, first), (second_executor, second)]
            .into_iter()
            .enumerate()
    {
        let barrier = barrier.clone();
        let recovery_claim = recovery_claim.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            executor
                .materialize_recovery_execution(
                    &recovery_claim,
                    "project-cra-1",
                    &format!("cra-dual-executor-window-{index}"),
                    &format!("cra-dual-executor-{index}"),
                    &adapter,
                )
                .is_ok()
        }));
    }
    barrier.wait();
    let winners = workers
        .into_iter()
        .map(|worker| worker.join().expect("executor thread"))
        .filter(|won| *won)
        .count();
    assert_eq!(winners, 1);
    assert!(!fixture.workspace.exists());
}

#[test]
fn cra1_non_review_recovery_authority_is_rejected_before_effect() {
    let fixture = ReviewFixture::new("non-review");
    let adapter = fixture.adapter().expect("inspect");
    let (_database, executor, _leases, recovery_claim) =
        prepared_executor_for_owner("cra-non-review", DurablePlanOwnerType::Experiment);
    assert!(matches!(
        executor.materialize_recovery_execution(
            &recovery_claim,
            "project-cra-1",
            "test-only-cra-window",
            "cra-non-review",
            &adapter,
        ),
        Err(SharedExecutionResult::AdapterPlanningRejected)
    ));
    assert!(!fixture.workspace.exists());
}

#[cfg(target_os = "windows")]
#[test]
fn cra1_windows_reparse_workspace_is_rejected_without_escape() {
    use std::os::windows::fs::symlink_dir;

    let fixture = ReviewFixture::new("reparse");
    let outside = fixture
        .database
        .path()
        .parent()
        .expect("fixture directory")
        .join("outside");
    fs::create_dir(&outside).expect("create outside directory");
    if let Err(error) = symlink_dir(&outside, &fixture.workspace) {
        assert!(
            error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314),
            "only unavailable Windows symlink privilege may gate this fixture: {error}"
        );
        return;
    }
    assert!(matches!(
        fixture.adapter(),
        Err(ReviewAdapterResult::ReviewContainmentFailed)
    ));
    assert!(!outside.join("review.md").exists());
}

#[test]
fn cra1_architecture_gate_has_no_business_writer_or_production_caller() {
    let adapter_source = include_str!("provisioning_runtime/review_adapter.rs");
    for forbidden in [
        "INSERT INTO file_refs",
        "UPDATE file_refs",
        "DELETE FROM file_refs",
        "INSERT INTO manuscript_bindings",
        "UPDATE manuscript_bindings",
        "DELETE FROM manuscript_bindings",
        "create_dir_all",
        "tauri::command",
        "invoke_handler",
    ] {
        assert!(
            !adapter_source.contains(forbidden),
            "forbidden CRA production capability remained: {forbidden}"
        );
    }
    assert!(adapter_source.contains("apply_creation_only"));
    assert!(adapter_source.contains("invocation.permit()"));
    assert!(adapter_source.contains("PhysicalFreshVerifier"));
    assert!(adapter_source.contains("bounded_authoritative_readback"));

    let module_source = include_str!("provisioning_runtime/mod.rs").replace("\r\n", "\n");
    assert!(module_source.contains("#[cfg(not(test))]\nmod review_adapter;"));
    let lib_source = include_str!("lib.rs");
    let main_source = include_str!("main.rs");
    assert!(!lib_source.contains("CanonicalReviewAdapter"));
    assert!(!main_source.contains("CanonicalReviewAdapter"));
}
