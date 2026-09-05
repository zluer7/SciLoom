use crate::db::manuscript_provisioning_operation_state::apply_schema_migration;
use crate::db::schema;
use crate::provisioning_runtime::audit_scheduler::{
    AuditBatchItemFinalStatus, AuditScheduler, AuditStore, AuditStoreError, AuditStoreErrorKind,
    AuditStoreOutbox, SqliteAuditStore, STARTUP_AUDIT_BATCH_LIMIT,
};
use crate::provisioning_runtime::core::{ProvisioningRuntime, RuntimeResource, SlotRequest};
use crate::provisioning_runtime::feedback::RuntimeFeedback;
use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
use crate::provisioning_runtime::recovery_decision::{
    read_authoritative_recovery_state, AuthoritativeRecoveryState, RecoveryDecisionInput,
    RecoveryDecisionKind,
};
use crate::provisioning_runtime::recovery_snapshot::{
    RecoveryInspectionSnapshot, RecoveryReadinessState, RECOVERY_SNAPSHOT_SCHEMA_VERSION,
};
use crate::provisioning_runtime::runtime_issue::{
    normalize_runtime_issues, LiteratureChildIssueSummary, RuntimeIssueCandidate, RuntimeIssueKind,
};
use crate::provisioning_runtime::schema_capability::{
    check_schema_capability, check_sqlite_schema_capability, FixedSchemaCapabilityProvider,
    SchemaCapability, SchemaCapabilityAccess, SchemaCapabilityProvider,
    SqliteSchemaCapabilityProvider,
};
use crate::provisioning_runtime::slot::ResourceKey;
use crate::provisioning_runtime::startup_scanner::{
    scan_sqlite_runtime_candidates, SqliteStartupOrchestrationStore, StartupScanPayload,
    StartupScanner, StartupScannerState,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use rusqlite::Connection;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

fn runtime() -> ProvisioningRuntime {
    ProvisioningRuntime::new(
        Arc::new(FixedSchemaCapabilityProvider::new(
            SchemaCapability::Available,
        )),
        Arc::new(ProcessGeneration::new("fixed-runtime-token")),
        Arc::new(FixedMonotonicClock::new(1_000)),
        Arc::new(RecordingTicker::default()),
    )
}

fn runtime_with_capability(capability: SchemaCapability) -> ProvisioningRuntime {
    ProvisioningRuntime::new(
        Arc::new(FixedSchemaCapabilityProvider::new(capability)),
        Arc::new(ProcessGeneration::new("fixed-runtime-token")),
        Arc::new(FixedMonotonicClock::new(1_000)),
        Arc::new(RecordingTicker::default()),
    )
}

fn candidate(
    operation_id: &str,
    classification: Option<&str>,
    stale_kind: Option<RuntimeIssueKind>,
) -> RuntimeIssueCandidate {
    RuntimeIssueCandidate {
        business_issue: true,
        operation_id: operation_id.to_string(),
        scope_kind: "channel".to_string(),
        owner_type: "experiment".to_string(),
        owner_id: "owner-1".to_string(),
        manuscript_channel: Some("primary".to_string()),
        phase: "failed".to_string(),
        operation_status: if classification.is_some() {
            "terminal-failed".to_string()
        } else {
            "active".to_string()
        },
        result_classification: classification.map(str::to_string),
        next_action: None,
        updated_at: "2026-07-23T01:02:03.000Z".to_string(),
        stale_kind,
        literature_children: Vec::new(),
        audit_status: None,
        safe_error_code: None,
    }
}

fn isolated_operation_state_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("isolated operation-state fixture");
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE operation_logs (
               id TEXT PRIMARY KEY,
               operation_type TEXT NOT NULL,
               source TEXT NOT NULL,
               module TEXT NOT NULL,
               status TEXT NOT NULL,
               risk_level TEXT NOT NULL,
               target TEXT NOT NULL,
               summary TEXT NOT NULL,
               related_entities TEXT NOT NULL,
               feedback TEXT NOT NULL,
               warnings TEXT NOT NULL,
               errors TEXT NOT NULL,
               skipped TEXT NOT NULL,
               is_recoverable INTEGER NOT NULL,
               actor_id TEXT NOT NULL,
               actor_label TEXT NOT NULL,
               refresh_keys TEXT NOT NULL,
               schema_version INTEGER NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               deleted_at TEXT
             );",
        )
        .expect("base isolated schema");
    apply_schema_migration(&connection).expect("operation-state fixture migration");
    connection
        .pragma_update(None, "user_version", 40)
        .expect("set fixture v40");
    connection
}

fn isolated_current_schema_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("isolated current-schema fixture");
    schema::run_migrations(&connection).expect("install exact current schema");
    connection
}

fn insert_terminal_with_pending_audit(connection: &Connection, operation_id: &str) {
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               intent, trigger_kind, phase, operation_status, result_classification,
               next_action, started_at, updated_at, terminal_at
             ) VALUES (?1, 'channel', 'experiment', 'owner-1', 'primary',
               'retry', 'explicit-retry', 'failed', 'terminal-failed', 'retryable',
               'retry', '2026-07-23T00:00:00.000Z', '2026-07-23T00:01:00.000Z',
               '2026-07-23T00:01:00.000Z')",
            [operation_id],
        )
        .expect("insert terminal attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id, delivery_status, revision, delivery_attempt_count,
               created_at, updated_at
             ) VALUES (?1, 'pending', 0, 0,
               '2026-07-23T00:01:00.000Z', '2026-07-23T00:01:00.000Z')",
            [operation_id],
        )
        .expect("insert pending outbox");
}

fn insert_terminal_progress_contract(connection: &Connection, operation_id: &str) {
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id, operation_id, plan_version, plan_template_kind,
               plan_identity_fingerprint, precondition_snapshot_hash, fingerprint_profile,
               owner_type, owner_id, scope_kind, manuscript_channel, intent,
               canonical_resource_identity_hash, canonical_placement_identity_hash,
               step_count, planner_version, created_at
             ) VALUES (
               ?1, ?2, 1, 'managed-primary', ?3, ?4, 'restricted-jcs-sha256-v1',
               'experiment', 'owner-1', 'channel', 'primary', 'retry',
               ?5, ?6, 1, 'planner-v1', '2026-07-23T00:00:00.000Z'
             )",
            (HASH_A, operation_id, HASH_B, HASH_C, HASH_C, HASH_D),
        )
        .expect("insert terminal Plan contract");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
               step_version, is_required, boundary, effect_outcome, readback_outcome,
               effect_facts_schema_version, progress_revision, created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, 0, 'ensure-directory', 'primary',
               1, 1, 'intended', 'unobserved', 'not-run',
               1, 0, '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
             )",
            (HASH_B, HASH_A, operation_id),
        )
        .expect("insert terminal Step contract");
}

fn insert_active_attempt_and_claim(
    connection: &Connection,
    operation_id: &str,
    claim_id: &str,
    holder: &str,
) {
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               intent, trigger_kind, phase, operation_status, started_at, updated_at
             ) VALUES (?1, 'channel', 'experiment', 'owner-1', 'primary',
               'repair', 'explicit-repair', 'inspection', 'active',
               '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')",
            [operation_id],
        )
        .expect("insert active attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_active_claims (
               claim_id, scope_kind, owner_type, owner_id, manuscript_channel,
               operation_id, claim_owner_token, claim_revision, claimed_at,
               last_heartbeat_at, last_progress_at
             ) VALUES (?1, 'channel', 'experiment', 'owner-1', 'primary',
               ?2, ?3, 4, '2026-07-23T00:00:00.000Z',
               '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')",
            (claim_id, operation_id, holder),
        )
        .expect("insert active claim");
}

#[test]
fn p3b3_capability_uses_current_global_version_and_composed_contracts() {
    let v39 = Connection::open_in_memory().expect("v39 fixture");
    v39.pragma_update(None, "user_version", 39)
        .expect("set v39");
    assert_eq!(
        check_sqlite_schema_capability(&v39),
        SchemaCapability::UnavailableNotMigrated
    );

    let missing_v40 = Connection::open_in_memory().expect("missing v40");
    missing_v40
        .pragma_update(None, "user_version", 40)
        .expect("set v40");
    assert_eq!(
        check_sqlite_schema_capability(&missing_v40),
        SchemaCapability::UnavailableNotMigrated
    );

    let missing_v41 = Connection::open_in_memory().expect("missing v41");
    missing_v41
        .pragma_update(None, "user_version", 41)
        .expect("set v41");
    assert_eq!(
        check_sqlite_schema_capability(&missing_v41),
        SchemaCapability::UnavailableNotMigrated
    );

    let valid_current = isolated_current_schema_connection();
    assert_eq!(
        check_sqlite_schema_capability(&valid_current),
        SchemaCapability::Available
    );

    valid_current
        .pragma_update(None, "user_version", schema::CURRENT_SCHEMA_VERSION + 1)
        .expect("set future version");
    assert_eq!(
        check_sqlite_schema_capability(&valid_current),
        SchemaCapability::UnavailableInvalidSchema
    );
}

struct FailingSchemaAccess;

impl SchemaCapabilityAccess for FailingSchemaAccess {
    fn read_user_version(&self) -> Result<i64, ()> {
        Err(())
    }

    fn validate_composed_contracts(&self) -> Result<bool, ()> {
        panic!("validator must not run after version read failure")
    }
}

#[test]
fn p3b3_capability_read_failure_is_bounded_and_does_not_validate() {
    assert_eq!(
        check_schema_capability(&FailingSchemaAccess),
        SchemaCapability::ReadFailed
    );
}

#[test]
fn p3b3_capability_rejects_v40_with_tampered_check_contract() {
    let connection = isolated_current_schema_connection();
    assert_eq!(
        check_sqlite_schema_capability(&connection),
        SchemaCapability::Available
    );
    connection
        .execute_batch(
            "PRAGMA writable_schema=ON;
             UPDATE sqlite_master
             SET sql=replace(sql, 'revision >= 0', 'revision >= -1')
             WHERE type='table'
               AND name='manuscript_provisioning_audit_outbox';
             PRAGMA writable_schema=OFF;",
        )
        .expect("tamper isolated CHECK metadata");
    assert_eq!(
        check_sqlite_schema_capability(&connection),
        SchemaCapability::UnavailableInvalidSchema
    );
}

#[test]
fn p3b3_capability_rejects_v40_with_tampered_foreign_key_contract() {
    let connection = isolated_current_schema_connection();
    connection
        .execute_batch(
            "PRAGMA writable_schema=ON;
             UPDATE sqlite_master
             SET sql=replace(
               sql,
               'FOREIGN KEY (operation_id)',
               'FOREIGN KEY (operation_log_id)'
             )
             WHERE type='table'
               AND name='manuscript_provisioning_audit_outbox';
             PRAGMA writable_schema=OFF;",
        )
        .expect("tamper isolated FK metadata");
    assert_eq!(
        check_sqlite_schema_capability(&connection),
        SchemaCapability::UnavailableInvalidSchema
    );
}

#[test]
fn p3b3_sqlite_capability_provider_is_a_real_runtime_provider() {
    let provider = SqliteSchemaCapabilityProvider::new(Arc::new(Mutex::new(
        isolated_current_schema_connection(),
    )));
    assert_eq!(provider.schema_capability(), SchemaCapability::Available);
}

#[test]
fn p3b3_issue_normalization_selects_one_main_issue_and_keeps_audit_separate() {
    let mut active = candidate("operation-1", None, Some(RuntimeIssueKind::StaleCandidate));
    active.audit_status = Some("failed".to_string());
    let recovery = candidate(
        "operation-1",
        Some("provisioning-recovery-required"),
        Some(RuntimeIssueKind::CrashCandidate),
    );

    let summary = normalize_runtime_issues(vec![active, recovery]);
    assert_eq!(summary.issues.len(), 2);
    assert_eq!(summary.issues[0].kind, RuntimeIssueKind::RecoveryRequired);
    assert_eq!(summary.issues[1].kind, RuntimeIssueKind::AuditFailed);
    assert!(summary
        .issues
        .iter()
        .all(|issue| !issue.key.contains('\\') && !issue.key.contains("token")));
}

#[test]
fn p3b3_issue_sort_is_deterministic_and_literature_child_is_not_top_level() {
    let mut later = candidate("operation-b", Some("retryable"), None);
    later.updated_at = "2026-07-23T02:00:00.000Z".to_string();
    let earlier = candidate("operation-a", Some("retryable"), None);
    let mut child = candidate("child-1", Some("repair-required"), None);
    child.scope_kind = "literature-child".to_string();
    child.owner_type = "literature".to_string();

    let first = normalize_runtime_issues(vec![earlier.clone(), later.clone(), child.clone()]);
    let second = normalize_runtime_issues(vec![child, later, earlier]);
    assert_eq!(first, second);
    assert_eq!(
        first
            .issues
            .iter()
            .map(|issue| issue.operation_id.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("operation-b"), Some("operation-a")]
    );
}

#[test]
fn p3b3_literature_aggregate_keeps_child_provenance_without_duplicate_top_level_issue() {
    let mut aggregate = candidate("literature-aggregate-1", Some("repair-required"), None);
    aggregate.scope_kind = "literature-aggregate".to_string();
    aggregate.owner_type = "literature".to_string();
    aggregate.manuscript_channel = None;
    aggregate.literature_children = vec![
        LiteratureChildIssueSummary {
            manuscript_channel: "dedicated_notes".to_string(),
            operation_id: Some("child-notes".to_string()),
            revision: 4,
            phase: Some("failed".to_string()),
            operation_status: Some("terminal-failed".to_string()),
            result_classification: Some("repair-required".to_string()),
            updated_at: "2026-07-23T01:01:00.000Z".to_string(),
        },
        LiteratureChildIssueSummary {
            manuscript_channel: "literature_outline".to_string(),
            operation_id: Some("child-outline".to_string()),
            revision: 5,
            phase: Some("failed".to_string()),
            operation_status: Some("terminal-failed".to_string()),
            result_classification: Some("retryable".to_string()),
            updated_at: "2026-07-23T01:02:00.000Z".to_string(),
        },
    ];
    let mut child = candidate("child-notes", Some("repair-required"), None);
    child.scope_kind = "literature-child".to_string();
    child.owner_type = "literature".to_string();

    let summary = normalize_runtime_issues(vec![child, aggregate]);
    assert_eq!(summary.business_issue_count, 1);
    assert_eq!(summary.issues.len(), 1);
    assert_eq!(
        summary.issues[0].operation_id.as_deref(),
        Some("literature-aggregate-1")
    );
    assert_eq!(summary.issues[0].literature_children.len(), 2);
}

#[test]
fn p3b3_startup_scanner_is_once_per_process_with_one_explicit_retry() {
    let scanner = StartupScanner::default();
    let attempts = AtomicUsize::new(0);

    let failed = scanner.run_initial(|| {
        attempts.fetch_add(1, Ordering::SeqCst);
        Err(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::StartupScanFailed)
    });
    assert_eq!(failed.state, StartupScannerState::FailedRetryAvailable);

    let completed = scanner.run_retry(|| {
        attempts.fetch_add(1, Ordering::SeqCst);
        Ok(StartupScanPayload::empty())
    });
    assert_eq!(completed.state, StartupScannerState::Completed);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);

    let repeated = scanner.run_retry(|| panic!("completed scanner must not run again"));
    assert_eq!(repeated.state, StartupScannerState::Completed);
}

#[test]
fn p3b3_startup_scanner_exhausts_after_second_failure_and_rejects_third_run() {
    let scanner = StartupScanner::default();
    let calls = AtomicUsize::new(0);
    scanner.run_initial(|| {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::StartupScanFailed)
    });
    let exhausted = scanner.run_retry(|| {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::StartupScanFailed)
    });
    assert_eq!(exhausted.state, StartupScannerState::FailedRetryExhausted);
    let third = scanner.run_retry(|| panic!("third scan must never execute"));
    assert_eq!(third.state, StartupScannerState::FailedRetryExhausted);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn p3b3_startup_scanner_allows_only_one_actual_concurrent_scan() {
    let scanner = Arc::new(StartupScanner::default());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let calls = Arc::new(AtomicUsize::new(0));

    let worker = {
        let scanner = scanner.clone();
        let entered = entered.clone();
        let release = release.clone();
        let calls = calls.clone();
        thread::spawn(move || {
            scanner.run_initial(|| {
                calls.fetch_add(1, Ordering::SeqCst);
                entered.wait();
                release.wait();
                Ok(StartupScanPayload::empty())
            })
        })
    };
    entered.wait();
    let duplicate = scanner.run_initial(|| panic!("duplicate scan must not execute"));
    assert_eq!(duplicate.state, StartupScannerState::Running);
    release.wait();
    assert_eq!(
        worker.join().expect("scanner worker").state,
        StartupScannerState::Completed
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn p3b3_startup_shutdown_race_never_publishes_completed_and_rejects_retry() {
    let scanner = Arc::new(StartupScanner::default());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let worker = {
        let scanner = scanner.clone();
        let entered = entered.clone();
        let release = release.clone();
        thread::spawn(move || {
            scanner.run_initial(|| {
                entered.wait();
                release.wait();
                Ok(StartupScanPayload::empty())
            })
        })
    };
    entered.wait();
    scanner.shutdown();
    release.wait();
    let result = worker.join().expect("shutdown scan worker");
    assert_ne!(result.state, StartupScannerState::Completed);
    assert_eq!(
        result.safe_error_code,
        Some(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::RuntimeShuttingDown)
    );
    let retry = scanner.run_retry(|| panic!("shutdown scanner must reject retry"));
    assert_ne!(retry.state, StartupScannerState::Completed);
}

#[derive(Default)]
struct RecordingAuditStore {
    outboxes: Mutex<Vec<AuditStoreOutbox>>,
    selected: AtomicUsize,
    fail_operation: Mutex<Option<String>>,
}

impl AuditStore for RecordingAuditStore {
    fn list_candidates(&self, limit: usize) -> Result<Vec<AuditStoreOutbox>, AuditStoreError> {
        let outboxes = self.outboxes.lock().expect("outbox lock");
        Ok(outboxes.iter().take(limit).cloned().collect())
    }

    fn count_candidates(&self) -> Result<usize, AuditStoreError> {
        Ok(self.outboxes.lock().expect("outbox lock").len())
    }

    fn read_outbox(&self, operation_id: &str) -> Result<Option<AuditStoreOutbox>, AuditStoreError> {
        Ok(self
            .outboxes
            .lock()
            .expect("outbox lock")
            .iter()
            .find(|outbox| outbox.operation_id == operation_id)
            .cloned())
    }

    fn deliver_pending(
        &self,
        selected: &AuditStoreOutbox,
        _occurred_at: &str,
    ) -> Result<(), AuditStoreError> {
        self.selected.fetch_add(1, Ordering::SeqCst);
        let mut outboxes = self.outboxes.lock().expect("outbox lock");
        let current = outboxes
            .iter_mut()
            .find(|outbox| outbox.operation_id == selected.operation_id)
            .expect("selected outbox");
        if self
            .fail_operation
            .lock()
            .expect("audit failure lock")
            .as_deref()
            == Some(selected.operation_id.as_str())
        {
            current.delivery_status = "failed".to_string();
            current.revision += 1;
            current.safe_error_code = Some("PROVISIONING_AUDIT_BATCH_FAILED".to_string());
            return Err(AuditStoreError {
                kind: AuditStoreErrorKind::Failure,
                safe_error_code:
                    crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::AuditBatchFailed,
            });
        }
        current.delivery_status = "delivered".to_string();
        current.revision += 1;
        current.operation_log_id = Some(current.operation_id.clone());
        Ok(())
    }

    fn retry_failed(
        &self,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), AuditStoreError> {
        self.deliver_pending(selected, occurred_at)
    }
}

#[test]
fn p3b3_audit_batch_selects_initial_32_only_and_returns_per_item_results() {
    let store = RecordingAuditStore {
        outboxes: Mutex::new(
            (0..33)
                .map(|index| AuditStoreOutbox::pending(&format!("operation-{index:02}")))
                .collect(),
        ),
        ..Default::default()
    };
    let scheduler = AuditScheduler::default();
    let result = scheduler.run_startup_batch(&store, "2026-07-23T03:00:00.000Z");

    assert_eq!(STARTUP_AUDIT_BATCH_LIMIT, 32);
    assert_eq!(result.selected, 32);
    assert_eq!(result.delivered, 32);
    assert_eq!(result.remaining, 1);
    assert_eq!(result.items.len(), 32);
    assert!(result.items.iter().all(|item| {
        item.selected_status == "pending"
            && item.final_status == AuditBatchItemFinalStatus::Delivered
    }));
    assert_eq!(store.selected.load(Ordering::SeqCst), 32);
}

#[test]
fn p3b3_audit_failure_is_isolated_and_deliver_retry_are_idempotent_and_explicit() {
    let store = RecordingAuditStore {
        outboxes: Mutex::new(
            ["operation-a", "operation-b", "operation-c"]
                .into_iter()
                .map(AuditStoreOutbox::pending)
                .collect(),
        ),
        fail_operation: Mutex::new(Some("operation-b".to_string())),
        ..Default::default()
    };
    let scheduler = AuditScheduler::default();
    let summary = scheduler.run_startup_batch(&store, "2026-07-23T03:00:00.000Z");
    assert_eq!(summary.selected, 3);
    assert_eq!(summary.delivered, 2);
    assert_eq!(summary.failed, 1);
    assert_eq!(summary.remaining, 0);
    assert!(summary.items.iter().any(|item| {
        item.operation_id == "operation-b"
            && item.final_status == AuditBatchItemFinalStatus::Failed
            && item.explicit_retry_required
    }));

    *store.fail_operation.lock().expect("audit failure lock") = None;
    let retried = scheduler.retry_one(&store, "operation-b", "2026-07-23T03:01:00.000Z");
    assert_eq!(retried.final_status, AuditBatchItemFinalStatus::Delivered);
    assert_eq!(retried.selected_status, "failed");

    let already = scheduler.deliver_one(&store, "operation-a", "2026-07-23T03:02:00.000Z");
    assert_eq!(
        already.final_status,
        AuditBatchItemFinalStatus::AlreadyDelivered
    );
    let conflict = scheduler.deliver_one(&store, "operation-missing", "2026-07-23T03:03:00.000Z");
    assert_eq!(conflict.final_status, AuditBatchItemFinalStatus::Conflicted);
}

#[test]
fn p3b3_audit_shutdown_rejects_batch_deliver_and_retry() {
    let store = RecordingAuditStore {
        outboxes: Mutex::new(vec![AuditStoreOutbox::pending("operation-a")]),
        ..Default::default()
    };
    let scheduler = AuditScheduler::default();
    scheduler.shutdown();
    let summary = scheduler.run_startup_batch(&store, "2026-07-23T03:00:00.000Z");
    assert_eq!(
        summary.safe_error_code,
        Some(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::RuntimeShuttingDown)
    );
    for item in [
        scheduler.deliver_one(&store, "operation-a", "2026-07-23T03:01:00.000Z"),
        scheduler.retry_one(&store, "operation-a", "2026-07-23T03:02:00.000Z"),
    ] {
        assert_eq!(item.final_status, AuditBatchItemFinalStatus::Failed);
        assert_eq!(
            item.safe_error_code,
            Some(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::RuntimeShuttingDown)
        );
    }
}

#[test]
fn p3b3_sqlite_audit_store_reuses_p3a_primitive_and_only_writes_audit_metadata() {
    let connection = isolated_operation_state_connection();
    insert_terminal_with_pending_audit(&connection, "operation-audit-1");
    let store = SqliteAuditStore::new(Arc::new(Mutex::new(connection)));
    let summary = AuditScheduler::default().run_startup_batch(&store, "2026-07-23T00:02:00.000Z");
    assert_eq!(summary.delivered, 1);
    let connection = store.connection();
    let connection = connection.lock().expect("audit fixture lock");
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_logs", [], |row| row
                .get::<_, i64>(0))
            .expect("operation log count"),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT delivery_status FROM manuscript_provisioning_audit_outbox
                 WHERE operation_id='operation-audit-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .expect("outbox readback"),
        "delivered"
    );
}

#[test]
fn p3b3_sqlite_scan_is_read_only_and_startup_refresh_removes_delivered_audit_issue() {
    let connection = isolated_current_schema_connection();
    insert_terminal_with_pending_audit(&connection, "operation-scan-1");
    insert_terminal_progress_contract(&connection, "operation-scan-1");
    let before_changes = connection.total_changes();
    let candidates = scan_sqlite_runtime_candidates(
        &connection,
        "fixed-runtime-token",
        "2026-07-23T00:02:00.000Z",
    )
    .expect("read-only candidate scan");
    assert_eq!(connection.total_changes(), before_changes);
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].result_classification.as_deref(),
        Some("retryable")
    );

    let store = SqliteStartupOrchestrationStore::new(Arc::new(Mutex::new(connection)));
    let result = StartupScanner::default().run_initial_orchestrated(
        &store,
        &AuditScheduler::default(),
        "fixed-runtime-token",
        "2026-07-23T00:02:00.000Z",
        "2026-07-23T00:03:00.000Z",
    );
    assert_eq!(result.state, StartupScannerState::Completed);
    let payload = result.payload.expect("startup payload");
    assert_eq!(payload.markdown_bytes_read, 0);
    assert_eq!(payload.audit.expect("audit summary").delivered, 1);
    assert!(payload
        .issues
        .issues
        .iter()
        .all(|issue| issue.kind != RuntimeIssueKind::AuditPending));
}

#[test]
fn p3b3_runtime_owns_startup_once_and_capability_blocks_source_access() {
    let connection = isolated_current_schema_connection();
    insert_terminal_with_pending_audit(&connection, "operation-runtime-scan");
    insert_terminal_progress_contract(&connection, "operation-runtime-scan");
    let store = SqliteStartupOrchestrationStore::new(Arc::new(Mutex::new(connection)));
    let runtime = runtime();
    let first = runtime.run_startup_scan(
        &store,
        "2026-07-23T00:02:00.000Z",
        "2026-07-23T00:03:00.000Z",
    );
    assert_eq!(first.state, StartupScannerState::Completed);
    let repeated = runtime.run_startup_scan(
        &store,
        "2026-07-23T00:04:00.000Z",
        "2026-07-23T00:05:00.000Z",
    );
    assert_eq!(repeated.generation, first.generation);

    let unavailable = runtime_with_capability(SchemaCapability::UnavailableNotMigrated);
    let blocked = unavailable.run_startup_scan(
        &store,
        "2026-07-23T00:06:00.000Z",
        "2026-07-23T00:07:00.000Z",
    );
    assert_eq!(blocked.state, StartupScannerState::NotStarted);
    assert_eq!(
        blocked.safe_error_code,
        Some(
            crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::OperationStateUnavailable
        )
    );
}

fn snapshot(operation_revision: i64) -> RecoveryInspectionSnapshot {
    RecoveryInspectionSnapshot::new_for_test(
        RECOVERY_SNAPSHOT_SCHEMA_VERSION,
        "2026-07-23T04:05:06.000Z",
        "p2-v1",
        "experiment",
        "owner-1",
        "primary",
        "channel",
        "binding-identity-1",
        "file-ref-identity-1",
        "path-key-1",
        "file",
        "metadata-identity-1",
        RecoveryReadinessState::Ready,
        RecoveryReadinessState::Ready,
        RecoveryReadinessState::Ready,
        RecoveryReadinessState::Ready,
        RecoveryReadinessState::Ready,
        "eligible",
        Vec::new(),
        vec![
            "binding-metadata".to_string(),
            "file-ref-metadata".to_string(),
        ],
        "operation-1",
        operation_revision,
        Some("claim-1"),
        Some(3),
        "other-instance",
        None,
    )
    .expect("valid recovery snapshot")
}

#[test]
fn p3b3_snapshot_hash_is_stable_and_excludes_inspection_time() {
    let first = snapshot(7);
    assert_eq!(
        first.snapshot_hash,
        "0a0d31f047e30b8fb2193abad5118b810540482129a9044bce8a0d1b8f8f63e1"
    );
    let mut second = first.clone();
    second.inspected_at = "2026-07-23T04:06:07.000Z".to_string();
    second.reseal().expect("reseal snapshot");
    assert_eq!(first.snapshot_hash, second.snapshot_hash);
    assert_eq!(first.markdown_bytes_read, 0);
    assert!(!first.canonical_identity().contains("inspectedAt"));

    second.observed_operation_revision = 8;
    second.reseal().expect("reseal changed snapshot");
    assert_ne!(first.snapshot_hash, second.snapshot_hash);
}

#[test]
fn p3b3_recovery_decision_requires_fresh_snapshot_and_authoritative_match() {
    let runtime = runtime();
    let confirmed = snapshot(7);
    let fresh = snapshot(7);
    let authority = AuthoritativeRecoveryState {
        operation_id: "operation-1".to_string(),
        operation_revision: 7,
        claim_id: Some("claim-1".to_string()),
        claim_revision: Some(3),
        claim_holder: "other-instance".to_string(),
        owner_type: "experiment".to_string(),
        owner_id: "owner-1".to_string(),
        manuscript_channel: "primary".to_string(),
        scope_kind: "channel".to_string(),
        recovery_candidate: true,
        other_active_authority: false,
    };
    let result = runtime.decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed,
            fresh,
        },
        || Ok(authority),
    );
    assert_eq!(result.kind, RecoveryDecisionKind::RecoveryReady);
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn p3b3_recovery_snapshot_change_matrix_is_precondition_changed() {
    type SnapshotMutation = Box<dyn Fn(&mut RecoveryInspectionSnapshot)>;
    let mutations: Vec<(&str, SnapshotMutation)> = vec![
        (
            "operation revision",
            Box::new(|value| value.observed_operation_revision += 1),
        ),
        (
            "claim revision",
            Box::new(|value| value.observed_claim_revision = Some(4)),
        ),
        (
            "holder",
            Box::new(|value| value.observed_claim_holder = "current-instance".to_string()),
        ),
        (
            "binding",
            Box::new(|value| value.binding_identity = "binding-identity-2".to_string()),
        ),
        (
            "file ref",
            Box::new(|value| value.file_ref_identity = "file-ref-identity-2".to_string()),
        ),
        (
            "path identity",
            Box::new(|value| value.path_identity_key = "path-key-2".to_string()),
        ),
        (
            "resource type",
            Box::new(|value| value.resource_type = "directory".to_string()),
        ),
        (
            "containment",
            Box::new(|value| value.containment_safety = RecoveryReadinessState::NotVerified),
        ),
        (
            "readiness",
            Box::new(|value| value.current_resource_ready = RecoveryReadinessState::NotReady),
        ),
        (
            "lifecycle",
            Box::new(|value| value.lifecycle_eligibility = "not-verified".to_string()),
        ),
        (
            "blocker",
            Box::new(|value| value.blocker_codes = vec!["wrong-type".to_string()]),
        ),
        (
            "literature child",
            Box::new(|value| {
                value.literature_child_state_identity = Some("literature-child-2".to_string())
            }),
        ),
    ];
    for (label, mutate) in mutations {
        let confirmed = snapshot(7);
        let mut fresh = confirmed.clone();
        mutate(&mut fresh);
        fresh.reseal().expect("changed snapshot reseal");
        let result = runtime().decide_recovery(
            RecoveryDecisionInput {
                user_confirmed: true,
                confirmed,
                fresh,
            },
            || {
                Ok(AuthoritativeRecoveryState {
                    operation_id: "operation-1".to_string(),
                    operation_revision: 7,
                    claim_id: Some("claim-1".to_string()),
                    claim_revision: Some(3),
                    claim_holder: "other-instance".to_string(),
                    owner_type: "experiment".to_string(),
                    owner_id: "owner-1".to_string(),
                    manuscript_channel: "primary".to_string(),
                    scope_kind: "channel".to_string(),
                    recovery_candidate: true,
                    other_active_authority: false,
                })
            },
        );
        assert_eq!(
            result.kind,
            RecoveryDecisionKind::PreconditionChanged,
            "{label}"
        );
    }
}

#[test]
fn p3b3_recovery_blocks_unconfirmed_not_ready_and_other_authority() {
    let matching_authority = || AuthoritativeRecoveryState {
        operation_id: "operation-1".to_string(),
        operation_revision: 7,
        claim_id: Some("claim-1".to_string()),
        claim_revision: Some(3),
        claim_holder: "other-instance".to_string(),
        owner_type: "experiment".to_string(),
        owner_id: "owner-1".to_string(),
        manuscript_channel: "primary".to_string(),
        scope_kind: "channel".to_string(),
        recovery_candidate: true,
        other_active_authority: false,
    };
    let unconfirmed = runtime().decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: false,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || panic!("unconfirmed decision must stop before authority read"),
    );
    assert_eq!(unconfirmed.kind, RecoveryDecisionKind::Blocked);

    let mut not_ready = snapshot(7);
    not_ready.blocker_codes = vec!["wrong-type".to_string()];
    not_ready.reseal().expect("blocked snapshot reseal");
    let blocked = runtime().decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: not_ready.clone(),
            fresh: not_ready,
        },
        || Ok(matching_authority()),
    );
    assert_eq!(blocked.kind, RecoveryDecisionKind::Blocked);

    let mut other_authority = matching_authority();
    other_authority.other_active_authority = true;
    let blocked = runtime().decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || Ok(other_authority),
    );
    assert_eq!(blocked.kind, RecoveryDecisionKind::Blocked);

    let mut changed_authority = matching_authority();
    changed_authority.claim_revision = Some(4);
    let changed = runtime().decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || Ok(changed_authority),
    );
    assert_eq!(changed.kind, RecoveryDecisionKind::PreconditionChanged);
}

#[test]
fn p3b3_recovery_decision_capability_unavailable_never_reads_authority() {
    let runtime = runtime_with_capability(SchemaCapability::UnavailableInvalidSchema);
    let reads = AtomicUsize::new(0);
    let result = runtime.decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || {
            reads.fetch_add(1, Ordering::SeqCst);
            panic!("unavailable capability must stop before authoritative read")
        },
    );
    assert_eq!(result.kind, RecoveryDecisionKind::Blocked);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[test]
fn p3b3_authoritative_recovery_read_is_metadata_only_and_detects_crash_holder() {
    let connection = isolated_operation_state_connection();
    insert_active_attempt_and_claim(
        &connection,
        "operation-crash-1",
        "claim-crash-1",
        "previous-process-token",
    );
    let before_changes = connection.total_changes();
    let state = read_authoritative_recovery_state(
        &connection,
        "operation-crash-1",
        "fixed-runtime-token",
        "2026-07-23T00:10:00.000Z",
    )
    .expect("authoritative recovery state");
    assert_eq!(connection.total_changes(), before_changes);
    assert!(state.recovery_candidate);
    assert_eq!(state.claim_holder, "other-instance");
    assert_eq!(state.claim_revision, Some(4));
    assert!(!state.other_active_authority);
}

#[test]
fn p3b3_feedback_mapper_keeps_startup_audit_and_recovery_as_typed_unions() {
    let scanner = StartupScanner::default();
    let failed = scanner.run_initial(|| {
        Err(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::StartupScanFailed)
    });
    assert!(matches!(
        RuntimeFeedback::from_startup_scan(&failed),
        RuntimeFeedback::StartupScanFailed { .. }
    ));

    let audit = crate::provisioning_runtime::audit_scheduler::AuditBatchSummary {
        selected: 1,
        failed: 1,
        safe_error_code: Some(
            crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::AuditBatchFailed,
        ),
        ..Default::default()
    };
    assert!(matches!(
        RuntimeFeedback::from_audit_summary(audit),
        RuntimeFeedback::AuditBatchPartial { .. }
    ));

    let ready = crate::provisioning_runtime::recovery_decision::RecoveryDecisionResult {
        kind: RecoveryDecisionKind::RecoveryReady,
        operation_id: Some("operation-1".to_string()),
        safe_error_code: None,
    };
    let json = serde_json::to_string(&RuntimeFeedback::from_recovery_decision(ready))
        .expect("safe feedback JSON");
    assert!(json.contains("\"kind\":\"recovery-ready\""));
    assert!(!json.contains("token"));
    assert!(!json.contains("path"));
}

#[test]
fn p3b3_recovery_decision_guard_conflicts_with_mutation_and_releases_on_error() {
    let runtime = Arc::new(runtime());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let worker = {
        let runtime = runtime.clone();
        let entered = entered.clone();
        let release = release.clone();
        thread::spawn(move || {
            runtime.decide_recovery(
                RecoveryDecisionInput {
                    user_confirmed: true,
                    confirmed: snapshot(7),
                    fresh: snapshot(7),
                },
                || {
                    entered.wait();
                    release.wait();
                    Err(crate::provisioning_runtime::feedback::RuntimeSafeErrorCode::InternalFailure)
                },
            )
        })
    };
    entered.wait();
    let decision_reads = AtomicUsize::new(0);
    let decision_busy = runtime.decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || {
            decision_reads.fetch_add(1, Ordering::SeqCst);
            panic!("concurrent decision must not read authority")
        },
    );
    assert_eq!(decision_busy.kind, RecoveryDecisionKind::Busy);
    assert_eq!(decision_reads.load(Ordering::SeqCst), 0);
    let busy = runtime.try_acquire_operation_slot(
        SlotRequest {
            resource: RuntimeResource::Ordinary(ResourceKey::new(
                "experiment",
                "owner-1",
                "primary",
            )),
            intent: "repair".to_string(),
        },
        Default::default(),
    );
    assert!(busy.is_err());
    release.wait();
    assert_eq!(
        worker.join().expect("decision worker").kind,
        RecoveryDecisionKind::Blocked
    );
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn p3b3_active_mutation_and_shutdown_reject_new_recovery_decision() {
    let runtime = runtime();
    let mutation = runtime
        .try_acquire_operation_slot(
            SlotRequest {
                resource: RuntimeResource::Ordinary(ResourceKey::new(
                    "experiment",
                    "owner-1",
                    "primary",
                )),
                intent: "repair".to_string(),
            },
            Default::default(),
        )
        .expect("mutation slot");
    let reads = AtomicUsize::new(0);
    let busy = runtime.decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || {
            reads.fetch_add(1, Ordering::SeqCst);
            panic!("busy decision must not read authority")
        },
    );
    assert_eq!(busy.kind, RecoveryDecisionKind::Busy);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    drop(mutation);

    runtime.shutdown();
    let shutdown = runtime.decide_recovery(
        RecoveryDecisionInput {
            user_confirmed: true,
            confirmed: snapshot(7),
            fresh: snapshot(7),
        },
        || panic!("shutdown decision must not read authority"),
    );
    assert_eq!(shutdown.kind, RecoveryDecisionKind::Busy);
}
