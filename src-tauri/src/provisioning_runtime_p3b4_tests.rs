use crate::db::schema;
use crate::provisioning_runtime::activation::{
    ActivationStatus, AuditActivationStatus, CapabilityStatus, ProductionActivationState,
    ShutdownStatus,
};
use crate::provisioning_runtime::cancellation::CancellationToken;
use crate::provisioning_runtime::core::{ProvisioningRuntime, RuntimeResource, SlotRequest};
use crate::provisioning_runtime::database_provider::{
    RuntimeDatabaseProvider, RuntimeDatabaseProviderError, SqliteRuntimeDatabaseProvider,
};
use crate::provisioning_runtime::feedback::{RuntimeFeedback, RuntimeSafeErrorCode};
use crate::provisioning_runtime::heartbeat_scheduler::{
    FixedMonotonicClock, HeartbeatOutcome, HeartbeatRegistration, HeartbeatScheduler,
    RecordingTicker, SchedulerTicker, SchedulerTickerStart,
};
use crate::provisioning_runtime::lifecycle::{
    InlineRuntimeTaskSpawner, RecordingRuntimeEventSink, RuntimeTask, RuntimeTaskSpawner,
    TauriAsyncHeartbeatTicker,
};
use crate::provisioning_runtime::schema_capability::SchemaCapability;
use crate::provisioning_runtime::slot::ResourceKey;
use crate::provisioning_runtime::startup_scanner::{
    StartupScanPayload, StartupScanResult, StartupScannerState,
};
use crate::provisioning_runtime::tauri_state::install_isolated_provisioning_runtime_for_test;
use crate::provisioning_runtime_foundation::ProcessGeneration;
use rusqlite::{Connection, OpenFlags};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;
use tauri::Manager;
use uuid::Uuid;

fn isolated_database_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("labpod-p3b4-{label}-{}.sqlite3", Uuid::new_v4()))
}

fn create_database(label: &str, version: i64, exact_current: bool) -> PathBuf {
    let path = isolated_database_path(label);
    let connection = Connection::open(&path).expect("isolated P-3B-4 SQLite");
    if exact_current {
        assert_eq!(version, schema::CURRENT_SCHEMA_VERSION);
        schema::run_migrations(&connection).expect("isolated current schema");
    } else {
        connection
            .pragma_update(None, "user_version", version)
            .expect("isolated user_version");
    }
    path
}

fn insert_terminal_with_failed_audit(path: &Path, operation_id: &str) {
    let connection = Connection::open(path).expect("isolated audit fixture");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id, scope_kind, owner_type, owner_id, manuscript_channel,
               intent, trigger_kind, phase, operation_status, result_classification,
               next_action, started_at, updated_at, terminal_at
             ) VALUES (?1, 'channel', 'experiment', 'owner-p3b4', 'primary',
               'retry', 'explicit-retry', 'failed', 'terminal-failed', 'retryable',
               'retry', '2026-07-23T00:00:00.000Z', '2026-07-23T00:01:00.000Z',
               '2026-07-23T00:01:00.000Z')",
            [operation_id],
        )
        .expect("insert isolated terminal attempt");
    connection
        .execute(
            "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id, delivery_status, revision, delivery_attempt_count,
               error_code, created_at, updated_at
             ) VALUES (?1, 'failed', 0, 1, 'PROVISIONING_AUDIT_BATCH_FAILED',
               '2026-07-23T00:01:00.000Z', '2026-07-23T00:01:00.000Z')",
            [operation_id],
        )
        .expect("insert isolated failed outbox");
}

fn isolated_provider(path: &Path) -> Arc<SqliteRuntimeDatabaseProvider> {
    Arc::new(
        SqliteRuntimeDatabaseProvider::new_isolated(path.to_path_buf(), "local.labpod.p3b4.test")
            .expect("isolated provider"),
    )
}

fn production_runtime(
    provider: Arc<dyn RuntimeDatabaseProvider>,
) -> (
    Arc<ProvisioningRuntime>,
    Arc<RecordingTicker>,
    Arc<RecordingRuntimeEventSink>,
) {
    let ticker = Arc::new(RecordingTicker::default());
    let events = Arc::new(RecordingRuntimeEventSink::default());
    let runtime = Arc::new(ProvisioningRuntime::new_production(
        provider,
        Arc::new(ProcessGeneration::new("fixed-production-token")),
        Arc::new(FixedMonotonicClock::new(1_000)),
        ticker.clone(),
        Arc::new(InlineRuntimeTaskSpawner),
        events.clone(),
    ));
    (runtime, ticker, events)
}

struct BlockingStopTicker {
    running: AtomicBool,
    block_next_stop: AtomicBool,
    stop_entered: Barrier,
    release_stop: Barrier,
}

impl BlockingStopTicker {
    fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            block_next_stop: AtomicBool::new(false),
            stop_entered: Barrier::new(2),
            release_stop: Barrier::new(2),
        }
    }
}

impl SchedulerTicker for BlockingStopTicker {
    fn start(&self) -> Result<SchedulerTickerStart, RuntimeSafeErrorCode> {
        if self.running.swap(true, Ordering::AcqRel) {
            Ok(SchedulerTickerStart::AlreadyRunning)
        } else {
            Ok(SchedulerTickerStart::Started)
        }
    }

    fn stop(&self) {
        if self.block_next_stop.swap(false, Ordering::AcqRel) {
            self.stop_entered.wait();
            self.release_stop.wait();
        }
        self.running.store(false, Ordering::Release);
    }
}

#[derive(Debug, Default)]
struct FailingStartTicker;

impl SchedulerTicker for FailingStartTicker {
    fn start(&self) -> Result<SchedulerTickerStart, RuntimeSafeErrorCode> {
        Err(RuntimeSafeErrorCode::RuntimeHeartbeatFailed)
    }

    fn stop(&self) {}
}

#[derive(Debug, Default)]
struct PanickingStartTicker;

impl SchedulerTicker for PanickingStartTicker {
    fn start(&self) -> Result<SchedulerTickerStart, RuntimeSafeErrorCode> {
        panic!("isolated synchronous ticker start panic");
    }

    fn stop(&self) {}
}

fn heartbeat_registration(operation_id: &str, generation: u64) -> HeartbeatRegistration {
    HeartbeatRegistration {
        operation_id: operation_id.to_string(),
        claim_id: format!("claim-{operation_id}"),
        expected_claim_revision: 0,
        resource: ResourceKey::new("experiment", operation_id, "primary"),
        generation,
        callback: Arc::new(|_| HeartbeatOutcome::Advanced {
            new_claim_revision: 1,
        }),
    }
}

#[test]
fn p3b4_first_registration_start_failure_rolls_back_without_ghost_entry() {
    let scheduler = HeartbeatScheduler::new(
        Arc::new(FixedMonotonicClock::new(0)),
        Arc::new(FailingStartTicker),
    );

    let error = scheduler
        .register(heartbeat_registration("operation-start-failed", 1))
        .expect_err("failed ticker start must reject registration");

    assert!(matches!(
        error,
        RuntimeFeedback::InternalFailure {
            safe_error_code: RuntimeSafeErrorCode::RuntimeHeartbeatFailed,
            ..
        }
    ));
    assert_eq!(scheduler.entry_count(), 0);
}

#[test]
fn p3b4_first_registration_start_panic_is_bounded_and_rolls_back() {
    let scheduler = HeartbeatScheduler::new(
        Arc::new(FixedMonotonicClock::new(0)),
        Arc::new(PanickingStartTicker),
    );

    let result = catch_unwind(AssertUnwindSafe(|| {
        scheduler.register(heartbeat_registration("operation-start-panicked", 1))
    }));
    let error = result
        .expect("ticker start panic must be contained")
        .expect_err("panicked ticker start must reject registration");

    assert!(matches!(
        error,
        RuntimeFeedback::InternalFailure {
            safe_error_code: RuntimeSafeErrorCode::RuntimeHeartbeatFailed,
            ..
        }
    ));
    assert_eq!(scheduler.entry_count(), 0);
}

#[test]
fn p3b4_registration_after_scheduler_shutdown_is_explicit_and_has_no_ghost_entry() {
    let scheduler = HeartbeatScheduler::new(
        Arc::new(FixedMonotonicClock::new(0)),
        Arc::new(RecordingTicker::default()),
    );
    scheduler.shutdown();

    let error = scheduler
        .register(heartbeat_registration("operation-after-shutdown", 1))
        .expect_err("shutdown scheduler must reject registration");

    assert!(matches!(
        error,
        RuntimeFeedback::InternalFailure {
            safe_error_code: RuntimeSafeErrorCode::RuntimeShuttingDown,
            ..
        }
    ));
    assert_eq!(scheduler.entry_count(), 0);
}

#[test]
fn p3b4_registry_last_unregister_and_new_first_register_keep_ticker_running() {
    let ticker = Arc::new(BlockingStopTicker::new());
    let scheduler = Arc::new(HeartbeatScheduler::new(
        Arc::new(FixedMonotonicClock::new(1_000)),
        ticker.clone(),
    ));
    scheduler
        .register(heartbeat_registration("operation-a", 1))
        .expect("register initial heartbeat");
    ticker.block_next_stop.store(true, Ordering::Release);

    let unregister_scheduler = scheduler.clone();
    let unregister = thread::spawn(move || {
        assert!(unregister_scheduler.unregister("operation-a", 1));
    });
    ticker.stop_entered.wait();
    let register_scheduler = scheduler.clone();
    let register = thread::spawn(move || {
        register_scheduler
            .register(heartbeat_registration("operation-b", 2))
            .expect("register replacement heartbeat");
    });
    ticker.release_stop.wait();
    unregister.join().expect("unregister thread");
    register.join().expect("register thread");

    assert_eq!(scheduler.entry_count(), 1);
    assert!(ticker.running.load(Ordering::Acquire));
}

#[test]
fn p3b4_shutdown_invalidates_in_flight_heartbeat_without_waiting_forever() {
    let ticker = Arc::new(RecordingTicker::default());
    let clock = Arc::new(FixedMonotonicClock::new(0));
    let scheduler = Arc::new(HeartbeatScheduler::new(clock.clone(), ticker.clone()));
    let callback_entered = Arc::new(Barrier::new(2));
    let release_callback = Arc::new(Barrier::new(2));
    let entered = callback_entered.clone();
    let release = release_callback.clone();
    scheduler
        .register(HeartbeatRegistration {
            operation_id: "operation-in-flight".to_string(),
            claim_id: "claim-in-flight".to_string(),
            expected_claim_revision: 0,
            resource: ResourceKey::new("experiment", "owner-in-flight", "primary"),
            generation: 1,
            callback: Arc::new(move |_| {
                entered.wait();
                release.wait();
                HeartbeatOutcome::Advanced {
                    new_claim_revision: 9,
                }
            }),
        })
        .expect("register in-flight heartbeat");
    clock.advance_ms(30_000);
    let tick_scheduler = scheduler.clone();
    let tick = thread::spawn(move || tick_scheduler.tick());
    callback_entered.wait();

    let (shutdown_complete, shutdown_returned) = mpsc::channel();
    let shutdown_scheduler = scheduler.clone();
    let shutdown = thread::spawn(move || {
        shutdown_scheduler.shutdown();
        shutdown_complete
            .send(())
            .expect("report heartbeat shutdown completion");
    });
    shutdown_returned
        .recv_timeout(Duration::from_secs(1))
        .expect("shutdown must return before the callback is released");

    release_callback.wait();
    tick.join().expect("heartbeat tick thread");
    shutdown.join().expect("heartbeat shutdown thread");
    assert_eq!(scheduler.expected_revision("operation-in-flight"), Some(0));
    assert_eq!(ticker.stop_count(), 1);
}

#[test]
fn p3b4_isolated_provider_rejects_formal_identity_and_opens_fresh_connections() {
    let path = create_database("provider", schema::CURRENT_SCHEMA_VERSION, true);
    assert_eq!(
        SqliteRuntimeDatabaseProvider::new_isolated(
            path.clone(),
            SqliteRuntimeDatabaseProvider::formal_app_identifier()
        )
        .expect_err("formal identifier must be rejected")
        .safe_error_code,
        RuntimeSafeErrorCode::RuntimeIsolationRequired
    );
    assert_eq!(
        SqliteRuntimeDatabaseProvider::new_isolated(path.clone(), "local.labpod.p3b4")
            .expect_err("missing isolated identifier must fail")
            .safe_error_code,
        RuntimeSafeErrorCode::RuntimeIsolationRequired
    );
    let provider = isolated_provider(&path);
    let first = provider
        .open_read_only()
        .expect("first isolated read connection");
    let second = provider
        .open_read_only()
        .expect("second isolated read connection");
    first
        .pragma_update(None, "cache_size", 17)
        .expect("connection-local pragma");
    let second_cache: i64 = second
        .pragma_query_value(None, "cache_size", |row| row.get(0))
        .expect("second connection pragma");
    assert_ne!(second_cache, 17);
    assert_eq!(provider.connection_open_count(), 2);
}

#[test]
fn p3b4_available_runtime_waits_for_real_main_ready_and_runs_startup_once() {
    let path = create_database("ready", schema::CURRENT_SCHEMA_VERSION, true);
    let provider = isolated_provider(&path);
    let (runtime, _ticker, events) = production_runtime(provider.clone());
    let before = runtime.production_snapshot().expect("initial snapshot");
    assert_eq!(
        before.activation_status,
        ActivationStatus::WaitingForMainWindow
    );
    assert_eq!(before.capability_status, CapabilityStatus::Available);
    assert!(!before.main_window_ready);

    assert_eq!(
        runtime
            .mark_main_window_ready("secondary")
            .expect_err("non-main ready must be rejected"),
        RuntimeSafeErrorCode::RuntimeInvalidReadyWindow
    );
    let completed = runtime
        .mark_main_window_ready("main")
        .expect("main ready snapshot");
    assert_eq!(completed.activation_status, ActivationStatus::Active);
    assert_eq!(
        completed.startup_scan_status,
        StartupScannerState::Completed
    );
    assert_eq!(completed.audit_status, AuditActivationStatus::Completed);
    assert_eq!(completed.startup_task_generation, 1);
    assert_eq!(completed.markdown_bytes_read, 0);

    let repeated = runtime
        .mark_main_window_ready("main")
        .expect("repeated main ready");
    assert_eq!(repeated.startup_task_generation, 1);
    assert_eq!(events.startup_completed_count(), 1);
    assert!(provider.connection_open_count() >= 4);
}

#[test]
fn p3b4_production_slot_rejects_work_before_main_ready_without_another_db_read() {
    let path = create_database(
        "slot-before-ready",
        schema::CURRENT_SCHEMA_VERSION,
        true,
    );
    let provider = isolated_provider(&path);
    let (runtime, _ticker, _events) = production_runtime(provider.clone());
    let error = runtime
        .try_acquire_operation_slot(
            SlotRequest {
                resource: RuntimeResource::Ordinary(ResourceKey::new(
                    "experiment",
                    "owner-before-ready",
                    "primary",
                )),
                intent: "create".to_string(),
            },
            CancellationToken::new(),
        )
        .expect_err("production work must wait for main ready");
    assert!(matches!(
        error,
        RuntimeFeedback::InternalFailure {
            safe_error_code: RuntimeSafeErrorCode::RuntimeMainWindowNotReady,
            ..
        }
    ));
    assert_eq!(provider.connection_open_count(), 1);
}

#[test]
fn p3b4_audit_retry_owner_is_atomic_and_shutdown_invalidates_late_finish() {
    let activation = ProductionActivationState::new(SchemaCapability::Available);
    let startup_generation = activation
        .mark_main_window_ready("main")
        .expect("main ready")
        .expect("startup generation");
    assert!(activation.complete_startup_task(
        startup_generation,
        StartupScanResult {
            state: StartupScannerState::Completed,
            generation: 1,
            payload: Some(StartupScanPayload::empty()),
            safe_error_code: None,
        },
    ));

    let audit_generation = activation
        .begin_audit_retry()
        .expect("first audit retry owner");
    assert_eq!(
        activation
            .begin_audit_retry()
            .expect_err("second audit retry must be rejected"),
        RuntimeSafeErrorCode::AuditRetryFailed
    );
    assert!(activation.begin_shutdown());
    assert_eq!(
        activation
            .complete_audit_retry(
                audit_generation,
                crate::provisioning_runtime::audit_scheduler::AuditBatchItemResult {
                    operation_id: "operation-late".to_string(),
                    selected_status: "failed".to_string(),
                    final_status: crate::provisioning_runtime::audit_scheduler::AuditBatchItemFinalStatus::Delivered,
                    safe_error_code: None,
                    operation_log_produced: true,
                    explicit_retry_required: false,
                },
                0,
                Default::default(),
            )
            .expect_err("shutdown invalidates late audit completion"),
        RuntimeSafeErrorCode::RuntimeShutdownInProgress
    );
}

#[test]
fn p3b4_v39_and_invalid_v40_stay_inactive_without_operation_table_access() {
    for (label, version, expected) in [
        ("v39", 39, CapabilityStatus::UnavailableNotMigrated),
        ("invalid-v40", 40, CapabilityStatus::UnavailableNotMigrated),
    ] {
        let path = create_database(label, version, false);
        let provider = isolated_provider(&path);
        let (runtime, ticker, _events) = production_runtime(provider.clone());
        assert_eq!(provider.connection_open_count(), 1);
        let ready = runtime
            .mark_main_window_ready("main")
            .expect("inactive ready snapshot");
        assert_eq!(ready.activation_status, ActivationStatus::Inactive);
        assert_eq!(ready.capability_status, expected);
        assert_eq!(ready.startup_scan_status, StartupScannerState::NotStarted);
        assert_eq!(provider.connection_open_count(), 1);
        assert_eq!(ticker.start_count(), 0);
    }
}

#[derive(Debug)]
struct ReadFailingProvider;

impl RuntimeDatabaseProvider for ReadFailingProvider {
    fn open_read_only(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        Err(RuntimeDatabaseProviderError::failed())
    }

    fn open_audit(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        panic!("read-failed capability must stop before audit")
    }

    fn safe_source_id(&self) -> &'static str {
        "read-failed-test"
    }
}

#[test]
fn p3b4_read_failed_is_inactive_and_does_not_block_safe_queries() {
    let (runtime, ticker, _events) = production_runtime(Arc::new(ReadFailingProvider));
    let snapshot = runtime.production_snapshot().expect("safe failed snapshot");
    assert_eq!(snapshot.capability_status, CapabilityStatus::ReadFailed);
    assert_eq!(snapshot.activation_status, ActivationStatus::Inactive);
    assert_eq!(
        snapshot.safe_error_code,
        Some(RuntimeSafeErrorCode::RuntimeDatabaseProviderFailed)
    );
    assert_eq!(ticker.start_count(), 0);
}

#[derive(Debug)]
struct FailAfterCapabilityProvider {
    path: PathBuf,
    reads: AtomicUsize,
}

#[derive(Debug)]
struct PanicAfterCapabilityProvider {
    path: PathBuf,
    reads: AtomicUsize,
}

impl RuntimeDatabaseProvider for PanicAfterCapabilityProvider {
    fn open_read_only(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        if self.reads.fetch_add(1, Ordering::SeqCst) == 0 {
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| RuntimeDatabaseProviderError::failed())
        } else {
            panic!("isolated startup scan panic")
        }
    }

    fn open_audit(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        panic!("panic scan must stop before audit")
    }

    fn safe_source_id(&self) -> &'static str {
        "panic-scan-test"
    }
}

#[derive(Debug)]
struct DroppingRuntimeTaskSpawner;

impl RuntimeTaskSpawner for DroppingRuntimeTaskSpawner {
    fn spawn(&self, _task: RuntimeTask, on_abort: RuntimeTask) {
        on_abort();
    }
}

impl RuntimeDatabaseProvider for FailAfterCapabilityProvider {
    fn open_read_only(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst);
        if read == 0 {
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| RuntimeDatabaseProviderError::failed())
        } else {
            Err(RuntimeDatabaseProviderError::failed())
        }
    }

    fn open_audit(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        panic!("failed business scan must stop before audit")
    }

    fn safe_source_id(&self) -> &'static str {
        "scan-failure-test"
    }
}

#[test]
fn p3b4_scan_failure_keeps_runtime_active_and_consumes_only_one_explicit_retry() {
    let path = create_database("scan-failure", schema::CURRENT_SCHEMA_VERSION, true);
    let (runtime, _ticker, _events) = production_runtime(Arc::new(FailAfterCapabilityProvider {
        path,
        reads: AtomicUsize::new(0),
    }));
    let failed = runtime
        .mark_main_window_ready("main")
        .expect("failed scan snapshot");
    assert_eq!(failed.activation_status, ActivationStatus::Active);
    assert_eq!(
        failed.startup_scan_status,
        StartupScannerState::FailedRetryAvailable
    );
    assert_eq!(failed.audit_status, AuditActivationStatus::NotStarted);

    let exhausted = runtime
        .retry_production_startup_scan()
        .expect("single explicit retry");
    assert_eq!(
        exhausted.startup_scan_status,
        StartupScannerState::FailedRetryExhausted
    );
    assert!(exhausted.startup_retry_consumed);
    assert_eq!(
        runtime
            .retry_production_startup_scan()
            .expect_err("third scan must be rejected"),
        RuntimeSafeErrorCode::StartupScanRetryExhausted
    );
}

#[test]
fn p3b4_startup_task_panic_and_drop_become_safe_failures() {
    let panic_path = create_database("scan-panic", schema::CURRENT_SCHEMA_VERSION, true);
    let (panic_runtime, _ticker, panic_events) =
        production_runtime(Arc::new(PanicAfterCapabilityProvider {
            path: panic_path,
            reads: AtomicUsize::new(0),
        }));
    let panic_snapshot = panic_runtime
        .mark_main_window_ready("main")
        .expect("panic converted to safe snapshot");
    assert_eq!(
        panic_snapshot.startup_scan_status,
        StartupScannerState::FailedRetryAvailable
    );
    assert_eq!(
        panic_snapshot.safe_error_code,
        Some(RuntimeSafeErrorCode::RuntimeStartupTaskFailed)
    );
    assert_eq!(panic_events.startup_completed_count(), 0);
    assert_eq!(panic_events.startup_failed_count(), 1);

    let drop_path = create_database("scan-drop", schema::CURRENT_SCHEMA_VERSION, true);
    let drop_events = Arc::new(RecordingRuntimeEventSink::default());
    let drop_runtime = Arc::new(ProvisioningRuntime::new_production(
        isolated_provider(&drop_path),
        Arc::new(ProcessGeneration::new("drop-test-token")),
        Arc::new(FixedMonotonicClock::new(1_000)),
        Arc::new(RecordingTicker::default()),
        Arc::new(DroppingRuntimeTaskSpawner),
        drop_events.clone(),
    ));
    let drop_snapshot = drop_runtime
        .mark_main_window_ready("main")
        .expect("dropped task converted to safe snapshot");
    assert_eq!(drop_snapshot.activation_status, ActivationStatus::Active);
    assert_eq!(
        drop_snapshot.startup_scan_status,
        StartupScannerState::FailedRetryAvailable
    );
    assert_eq!(
        drop_snapshot.safe_error_code,
        Some(RuntimeSafeErrorCode::RuntimeStartupTaskFailed)
    );
    assert_eq!(drop_events.startup_completed_count(), 0);
    assert_eq!(drop_events.startup_failed_count(), 1);
}

#[test]
fn p3b4_shutdown_is_idempotent_stops_ticker_and_rejects_new_work() {
    let path = create_database("shutdown", schema::CURRENT_SCHEMA_VERSION, true);
    let (runtime, ticker, events) = production_runtime(isolated_provider(&path));
    runtime
        .mark_main_window_ready("main")
        .expect("active runtime");
    runtime.shutdown_production();
    runtime.shutdown_production();
    let snapshot = runtime.production_snapshot().expect("stopped snapshot");
    assert_eq!(snapshot.shutdown_status, ShutdownStatus::Stopped);
    assert_eq!(ticker.stop_count(), 0);
    assert_eq!(events.shutdown_count(), 1);
    assert_eq!(
        runtime
            .retry_production_startup_scan()
            .expect_err("shutdown rejects scan retry"),
        RuntimeSafeErrorCode::RuntimeShutdownInProgress
    );
    assert_eq!(
        runtime
            .retry_production_audit_one("operation-after-shutdown")
            .expect_err("shutdown rejects audit retry"),
        RuntimeSafeErrorCode::RuntimeShutdownInProgress
    );
}

#[test]
fn p3b4_explicit_audit_retry_refreshes_authoritative_issues() {
    let path = create_database("audit-retry", schema::CURRENT_SCHEMA_VERSION, true);
    let (runtime, _ticker, _events) = production_runtime(isolated_provider(&path));
    runtime
        .mark_main_window_ready("main")
        .expect("empty startup activation");
    insert_terminal_with_failed_audit(&path, "operation-audit-retry");

    let refreshed = runtime
        .retry_production_audit_one("operation-audit-retry")
        .expect("explicit isolated audit retry");
    assert_eq!(refreshed.audit_status, AuditActivationStatus::Completed);
    let audit = refreshed.audit_summary.expect("audit retry summary");
    assert_eq!(audit.selected, 1);
    assert_eq!(audit.delivered, 1);
    assert_eq!(audit.remaining, 0);
    assert_eq!(refreshed.issue_summary.audit_issue_count, 0);
    assert_eq!(refreshed.issue_summary.business_issue_count, 1);
    assert_eq!(refreshed.markdown_bytes_read, 0);

    let connection = Connection::open(&path).expect("isolated audit verification");
    let status: String = connection
        .query_row(
            "SELECT delivery_status
             FROM manuscript_provisioning_audit_outbox
             WHERE operation_id='operation-audit-retry'",
            [],
            |row| row.get(0),
        )
        .expect("isolated audit status");
    let operation_logs: i64 = connection
        .query_row("SELECT COUNT(*) FROM operation_logs", [], |row| row.get(0))
        .expect("isolated operation log count");
    assert_eq!(status, "delivered");
    assert_eq!(operation_logs, 1);
}

#[test]
fn p3b4_async_heartbeat_ticker_is_single_and_stops_deterministically() {
    let ticks = Arc::new(AtomicUsize::new(0));
    let ticker = Arc::new(TauriAsyncHeartbeatTicker::new(Duration::from_millis(5)));
    let tick_counter = ticks.clone();
    ticker
        .bind_tick(Arc::new(move || {
            tick_counter.fetch_add(1, Ordering::SeqCst);
        }))
        .expect("bind ticker once");
    assert_eq!(
        ticker.start().expect("start ticker"),
        SchedulerTickerStart::Started
    );
    assert_eq!(
        ticker.start().expect("duplicate start is idempotent"),
        SchedulerTickerStart::AlreadyRunning
    );
    for _ in 0..40 {
        if ticks.load(Ordering::SeqCst) > 0 {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert!(ticks.load(Ordering::SeqCst) > 0);
    assert_eq!(ticker.start_count(), 1);
    ticker.stop();
    let stopped_at = ticks.load(Ordering::SeqCst);
    thread::sleep(Duration::from_millis(20));
    assert_eq!(ticks.load(Ordering::SeqCst), stopped_at);
    assert_eq!(ticker.stop_count(), 1);
}

#[test]
fn p3b4_heartbeat_ticker_panic_stops_without_creating_a_second_task() {
    let ticker = Arc::new(TauriAsyncHeartbeatTicker::new(Duration::from_millis(5)));
    ticker
        .bind_tick(Arc::new(|| panic!("isolated ticker panic")))
        .expect("bind panic ticker");
    ticker.start().expect("start panic ticker");
    for _ in 0..40 {
        if ticker.panic_count() == 1 {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(ticker.panic_count(), 1);
    assert_eq!(ticker.start_count(), 1);
    assert_eq!(
        ticker.start().expect_err("failed ticker must stay latched"),
        RuntimeSafeErrorCode::RuntimeHeartbeatFailed
    );
    assert_eq!(ticker.start_count(), 1);
    assert_eq!(ticker.panic_count(), 1);

    let scheduler = HeartbeatScheduler::new(Arc::new(FixedMonotonicClock::new(0)), ticker.clone());
    let registration_error = scheduler
        .register(heartbeat_registration("operation-after-ticker-panic", 2))
        .expect_err("registration must not succeed without a live ticker");
    assert!(matches!(
        registration_error,
        RuntimeFeedback::InternalFailure {
            safe_error_code: RuntimeSafeErrorCode::RuntimeHeartbeatFailed,
            ..
        }
    ));
    assert_eq!(scheduler.entry_count(), 0);
}

#[test]
fn p3b4_mock_tauri_app_manages_exactly_one_runtime_and_one_token() {
    let path = create_database("mock-app", schema::CURRENT_SCHEMA_VERSION, true);
    let app = tauri::test::mock_app();
    let runtime = install_isolated_provisioning_runtime_for_test(
        app.handle(),
        path.clone(),
        "local.labpod.p3b4.mock.test",
    )
    .expect("install isolated managed runtime");
    let managed = app.state::<Arc<ProvisioningRuntime>>();
    assert!(Arc::ptr_eq(&runtime, &managed));
    assert_eq!(
        runtime.test_app_instance_token(),
        runtime.test_app_instance_token()
    );

    let duplicate = install_isolated_provisioning_runtime_for_test(
        app.handle(),
        path,
        "local.labpod.p3b4.mock.test",
    );
    assert!(matches!(
        duplicate,
        Err(RuntimeSafeErrorCode::RuntimeAlreadyInitialized)
    ));
}
