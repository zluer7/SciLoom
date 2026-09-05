use crate::provisioning_runtime::cancellation::CancellationToken;
use crate::provisioning_runtime::core::{
    ClaimCallbackError, ClaimedOperation, ProvisioningRuntime, RuntimeResource, SlotRequest,
    TerminalOperationSummary,
};
use crate::provisioning_runtime::feedback::{
    ActiveOperationSummary, FeedbackAuthority, RuntimeFeedback, RuntimeSafeErrorCode,
};
use crate::provisioning_runtime::heartbeat_scheduler::{
    FixedMonotonicClock, HeartbeatInput, HeartbeatOutcome, RecordingTicker,
};
use crate::provisioning_runtime::literature_gate::LiteratureScope;
use crate::provisioning_runtime::schema_capability::{
    FixedSchemaCapabilityProvider, SchemaCapability,
};
use crate::provisioning_runtime::slot::ResourceKey;
use crate::provisioning_runtime_foundation::ProcessGeneration;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier, Mutex};
use std::thread;
use uuid::Uuid;

fn ordinary_request(owner_id: &str, channel: &str, intent: &str) -> SlotRequest {
    SlotRequest {
        resource: RuntimeResource::Ordinary(ResourceKey::new("experiment", owner_id, channel)),
        intent: intent.to_string(),
    }
}

fn literature_request(owner_id: &str, scope: LiteratureScope, intent: &str) -> SlotRequest {
    SlotRequest {
        resource: RuntimeResource::Literature {
            owner_id: owner_id.to_string(),
            scope,
        },
        intent: intent.to_string(),
    }
}

fn runtime_with(
    capability: SchemaCapability,
) -> (
    ProvisioningRuntime,
    Arc<FixedMonotonicClock>,
    Arc<RecordingTicker>,
) {
    let clock = Arc::new(FixedMonotonicClock::new(0));
    let ticker = Arc::new(RecordingTicker::default());
    let runtime = ProvisioningRuntime::new(
        Arc::new(FixedSchemaCapabilityProvider::new(capability)),
        Arc::new(ProcessGeneration::new(
            "00000000-0000-4000-8000-000000000001",
        )),
        clock.clone(),
        ticker.clone(),
    );
    (runtime, clock, ticker)
}

fn claimed_operation(
    operation_id: &str,
    revision: i64,
    calls: Arc<Mutex<Vec<HeartbeatInput>>>,
) -> ClaimedOperation {
    ClaimedOperation::new(
        operation_id,
        &format!("claim-{operation_id}"),
        revision,
        "claim-acquired",
        "active",
        Arc::new(move |input: HeartbeatInput| {
            calls.lock().expect("heartbeat calls").push(input.clone());
            HeartbeatOutcome::Advanced {
                new_claim_revision: input.expected_claim_revision + 1,
            }
        }),
    )
}

#[test]
fn capability_unavailable_stops_before_slot_or_durable_callback() {
    let (runtime, _, _) = runtime_with(SchemaCapability::UnavailableNotMigrated);
    let cancellation = CancellationToken::new();

    let result = runtime
        .try_acquire_operation_slot(ordinary_request("exp-1", "main", "retry"), cancellation);

    assert!(matches!(
        result,
        Err(RuntimeFeedback::OperationStateUnavailable {
            authority: FeedbackAuthority::None,
            ..
        })
    ));
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn ordinary_same_key_is_immediately_busy_and_intent_cannot_bypass() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let first = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "create-default"),
            CancellationToken::new(),
        )
        .expect("first slot");

    let duplicate = runtime.try_acquire_operation_slot(
        ordinary_request("exp-1", "main", "repair"),
        CancellationToken::new(),
    );

    match duplicate {
        Err(RuntimeFeedback::Busy {
            operation_summary:
                ActiveOperationSummary::LocalPending {
                    operation_id,
                    intent,
                    ..
                },
            ..
        }) => {
            assert!(operation_id.is_none());
            assert_eq!(intent, "create-default");
        }
        other => panic!("expected local pending busy, got {other:?}"),
    }
    drop(first);
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn ordinary_different_keys_can_be_held_concurrently() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let first = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("first slot");
    let second = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-2", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("different key");

    assert_eq!(runtime.snapshot().active_slot_count, 2);
    drop((first, second));
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn pre_claim_cancel_skips_callback_and_releases_guard() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let cancellation = CancellationToken::new();
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            cancellation.clone(),
        )
        .expect("slot");
    cancellation.cancel();
    let callback_calls = AtomicUsize::new(0);

    let result = guard.claim(|_| {
        callback_calls.fetch_add(1, Ordering::SeqCst);
        Err(ClaimCallbackError::internal(
            RuntimeSafeErrorCode::InternalFailure,
        ))
    });

    assert!(matches!(
        result,
        Err(RuntimeFeedback::CallerCancelled { .. })
    ));
    assert_eq!(callback_calls.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn durable_claim_conflict_releases_local_slot_without_heartbeat() {
    let (runtime, _, ticker) = runtime_with(SchemaCapability::Available);
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");

    let result = guard.claim(|_| Err(ClaimCallbackError::active_claim_conflict(None)));

    assert!(matches!(
        result,
        Err(RuntimeFeedback::ActiveClaimConflict { .. })
    ));
    assert_eq!(runtime.snapshot().active_slot_count, 0);
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 0);
    assert_eq!(ticker.start_count(), 0);
}

#[test]
fn callback_panic_drops_pre_claim_guard() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");

    let panic_result = catch_unwind(AssertUnwindSafe(|| {
        let _ = guard.claim(|_| -> Result<ClaimedOperation, ClaimCallbackError> {
            panic!("durable callback panic");
        });
    }));

    assert!(panic_result.is_err());
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn claimed_summary_has_authoritative_operation_and_detach_keeps_execution() {
    let (runtime, _, ticker) = runtime_with(SchemaCapability::Available);
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let heartbeat_calls = Arc::new(Mutex::new(Vec::new()));
    let mut handle = guard
        .claim(|token| {
            assert_eq!(token, "00000000-0000-4000-8000-000000000001");
            Ok(claimed_operation("op-1", 0, heartbeat_calls.clone()))
        })
        .expect("claim");

    let duplicate = runtime.try_acquire_operation_slot(
        ordinary_request("exp-1", "main", "repair"),
        CancellationToken::new(),
    );
    match duplicate {
        Err(RuntimeFeedback::Busy {
            operation_summary:
                ActiveOperationSummary::ClaimedActive {
                    operation_id,
                    authority,
                    ..
                },
            ..
        }) => {
            assert_eq!(operation_id, "op-1");
            assert_eq!(authority, FeedbackAuthority::DurableOperationState);
        }
        other => panic!("expected claimed busy, got {other:?}"),
    }

    assert!(matches!(
        handle.detach_caller(),
        Ok(RuntimeFeedback::CallerDetached { .. })
    ));
    assert_eq!(runtime.snapshot().active_slot_count, 1);
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 1);
    assert!(ticker.is_running());

    let completed = handle
        .complete(TerminalOperationSummary::completed("op-1", "completed"))
        .expect("complete");
    assert!(matches!(completed, RuntimeFeedback::Completed { .. }));
    assert_eq!(runtime.snapshot().active_slot_count, 0);
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 0);
    assert!(!ticker.is_running());
    assert!(handle
        .complete(TerminalOperationSummary::completed("op-1", "completed"))
        .is_err());
}

#[test]
fn literature_gate_enforces_conflict_graph_without_ordinary_slot() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let outline = runtime
        .try_acquire_operation_slot(
            literature_request("lit-1", LiteratureScope::Outline, "retry"),
            CancellationToken::new(),
        )
        .expect("outline");
    let notes = runtime
        .try_acquire_operation_slot(
            literature_request("lit-1", LiteratureScope::Notes, "repair"),
            CancellationToken::new(),
        )
        .expect("notes parallel");
    let aggregate = runtime.try_acquire_operation_slot(
        literature_request("lit-1", LiteratureScope::Aggregate, "retry"),
        CancellationToken::new(),
    );
    let same_outline = runtime.try_acquire_operation_slot(
        literature_request("lit-1", LiteratureScope::Outline, "create-default"),
        CancellationToken::new(),
    );

    assert!(matches!(aggregate, Err(RuntimeFeedback::Busy { .. })));
    assert!(matches!(same_outline, Err(RuntimeFeedback::Busy { .. })));
    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.ordinary_slot_count, 0);
    assert_eq!(snapshot.literature_slot_count, 2);

    drop(outline);
    assert_eq!(runtime.snapshot().literature_slot_count, 1);
    assert!(runtime
        .try_acquire_operation_slot(
            literature_request("lit-1", LiteratureScope::Outline, "retry"),
            CancellationToken::new(),
        )
        .is_ok());
    drop(notes);
    assert_eq!(runtime.snapshot().literature_slot_count, 0);
}

#[test]
fn literature_aggregate_channel_race_has_only_one_legal_winner() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let runtime = Arc::new(runtime);
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for scope in [LiteratureScope::Aggregate, LiteratureScope::Outline] {
        let runtime = runtime.clone();
        let barrier = barrier.clone();
        joins.push(thread::spawn(move || {
            barrier.wait();
            runtime.try_acquire_operation_slot(
                literature_request("lit-race", scope, "retry"),
                CancellationToken::new(),
            )
        }));
    }
    barrier.wait();
    let results: Vec<_> = joins
        .into_iter()
        .map(|join| join.join().expect("race thread"))
        .collect();

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(RuntimeFeedback::Busy { .. })))
            .count(),
        1
    );
}

#[test]
fn literature_different_owners_are_independent_and_panic_releases_gate() {
    let (runtime, _, _) = runtime_with(SchemaCapability::Available);
    let first = runtime
        .try_acquire_operation_slot(
            literature_request("lit-1", LiteratureScope::Aggregate, "retry"),
            CancellationToken::new(),
        )
        .expect("first owner");
    let second = runtime
        .try_acquire_operation_slot(
            literature_request("lit-2", LiteratureScope::Outline, "retry"),
            CancellationToken::new(),
        )
        .expect("different owner");
    drop((first, second));

    let guard = runtime
        .try_acquire_operation_slot(
            literature_request("lit-panic", LiteratureScope::Notes, "retry"),
            CancellationToken::new(),
        )
        .expect("panic slot");
    let panic_result = catch_unwind(AssertUnwindSafe(|| {
        let _ = guard.claim(|_| -> Result<ClaimedOperation, ClaimCallbackError> {
            panic!("literature callback panic");
        });
    }));

    assert!(panic_result.is_err());
    assert_eq!(runtime.snapshot().literature_slot_count, 0);
}

#[test]
fn dropping_claimed_handle_detaches_execution_lifetime_from_caller_lifetime() {
    let (runtime, _, ticker) = runtime_with(SchemaCapability::Available);
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-drop", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let handle = guard
        .claim(|_| {
            Ok(claimed_operation(
                "op-drop",
                0,
                Arc::new(Mutex::new(Vec::new())),
            ))
        })
        .expect("claim");

    drop(handle);

    assert_eq!(runtime.snapshot().active_slot_count, 1);
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 1);
    assert!(ticker.is_running());
    assert!(matches!(
        runtime.try_acquire_operation_slot(
            ordinary_request("exp-drop", "main", "repair"),
            CancellationToken::new()
        ),
        Err(RuntimeFeedback::Busy { .. })
    ));
}

#[test]
fn process_generation_is_stable_strong_random_and_test_injectable() {
    let first = ProcessGeneration::default();
    let first_value = first.canonical().to_string();
    assert_eq!(first.canonical(), first_value);
    assert_eq!(
        Uuid::parse_str(&first_value)
            .expect("UUID")
            .get_version_num(),
        4
    );

    let second = ProcessGeneration::default();
    assert_ne!(first.canonical(), second.canonical());

    let fixed = ProcessGeneration::new("fixed-token");
    assert_eq!(fixed.canonical(), "fixed-token");
}

#[test]
fn shutdown_rejects_new_acquire_and_abandons_without_completion() {
    let (runtime, _, ticker) = runtime_with(SchemaCapability::Available);
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let mut handle = guard
        .claim(|_| {
            Ok(claimed_operation(
                "op-1",
                0,
                Arc::new(Mutex::new(Vec::new())),
            ))
        })
        .expect("claim");

    runtime.shutdown();

    assert!(!ticker.is_running());
    assert_eq!(runtime.snapshot().abandoned_execution_count, 1);
    assert!(matches!(
        runtime.try_acquire_operation_slot(
            ordinary_request("exp-2", "main", "retry"),
            CancellationToken::new()
        ),
        Err(RuntimeFeedback::ShuttingDown { .. })
    ));
    assert!(handle
        .complete(TerminalOperationSummary::completed("op-1", "completed"))
        .is_err());
}

#[test]
fn shutdown_during_durable_claim_retains_an_abandoned_slot_without_heartbeat() {
    let (runtime, _, ticker) = runtime_with(SchemaCapability::Available);
    let runtime = Arc::new(runtime);
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-race", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let claim_thread = thread::spawn(move || {
        guard.claim(|_| {
            started_tx.send(()).expect("claim started");
            release_rx.recv().expect("release claim");
            Ok(claimed_operation(
                "op-shutdown-race",
                0,
                Arc::new(Mutex::new(Vec::new())),
            ))
        })
    });
    started_rx.recv().expect("durable callback started");

    runtime.shutdown();
    release_tx.send(()).expect("release durable callback");
    let result = claim_thread.join().expect("claim thread");

    assert!(matches!(
        result,
        Err(RuntimeFeedback::ShuttingDown {
            authority: FeedbackAuthority::DurableOperationState,
            ..
        })
    ));
    assert_eq!(runtime.snapshot().active_slot_count, 1);
    assert_eq!(runtime.snapshot().abandoned_execution_count, 1);
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 0);
    assert!(!ticker.is_running());
}

#[test]
fn heartbeat_waits_for_cadence_and_uses_authoritative_revision_on_next_tick() {
    let (runtime, clock, ticker) = runtime_with(SchemaCapability::Available);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let _handle = guard
        .claim(|_| Ok(claimed_operation("op-heartbeat", 7, calls.clone())))
        .expect("claim");

    assert_eq!(runtime.tick_heartbeats().feedback.len(), 0);
    assert!(calls.lock().expect("calls").is_empty());
    clock.advance_ms(29_999);
    runtime.tick_heartbeats();
    assert!(calls.lock().expect("calls").is_empty());

    clock.advance_ms(1);
    runtime.tick_heartbeats();
    assert_eq!(calls.lock().expect("calls")[0].expected_claim_revision, 7);
    assert_eq!(
        runtime
            .heartbeat_scheduler()
            .expected_revision("op-heartbeat"),
        Some(8)
    );

    clock.advance_ms(30_000);
    runtime.tick_heartbeats();
    assert_eq!(calls.lock().expect("calls")[1].expected_claim_revision, 8);
    assert_eq!(ticker.start_count(), 1);
    assert_eq!(runtime.heartbeat_scheduler().cadence_ms(), 30_000);
    assert_eq!(
        runtime.heartbeat_scheduler().stale_candidate_threshold_ms(),
        300_000
    );
}

#[test]
fn heartbeat_callback_runs_without_registry_lock() {
    let (runtime, clock, _) = runtime_with(SchemaCapability::Available);
    let scheduler = runtime.heartbeat_scheduler();
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let callback_scheduler = scheduler.clone();
    let _handle = guard
        .claim(|_| {
            Ok(ClaimedOperation::new(
                "op-unlocked",
                "claim-op-unlocked",
                0,
                "claim-acquired",
                "active",
                Arc::new(move |input| {
                    assert_eq!(
                        callback_scheduler.expected_revision("op-unlocked"),
                        Some(input.expected_claim_revision)
                    );
                    HeartbeatOutcome::Advanced {
                        new_claim_revision: input.expected_claim_revision + 1,
                    }
                }),
            ))
        })
        .expect("claim");

    clock.advance_ms(30_000);
    runtime.tick_heartbeats();
    assert_eq!(scheduler.expected_revision("op-unlocked"), Some(1));
}

#[test]
fn transient_heartbeat_error_is_once_per_cadence_and_feedback_is_deduplicated() {
    let (runtime, clock, _) = runtime_with(SchemaCapability::Available);
    let calls = Arc::new(AtomicUsize::new(0));
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let callback_calls = calls.clone();
    let _handle = guard
        .claim(|_| {
            Ok(ClaimedOperation::new(
                "op-transient",
                "claim-op-transient",
                0,
                "claim-acquired",
                "active",
                Arc::new(move |_| {
                    callback_calls.fetch_add(1, Ordering::SeqCst);
                    HeartbeatOutcome::TransientError {
                        safe_error_code: "TRANSIENT_IO".to_string(),
                    }
                }),
            ))
        })
        .expect("claim");

    clock.advance_ms(300_000);
    let first = runtime.tick_heartbeats();
    let same_tick = runtime.tick_heartbeats();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(first.feedback.len(), 1);
    assert!(same_tick.feedback.is_empty());
    assert_eq!(runtime.snapshot().active_slot_count, 1);
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 1);

    clock.advance_ms(30_000);
    let next = runtime.tick_heartbeats();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(next.feedback.is_empty());
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 1);
}

#[test]
fn cas_conflict_and_authoritative_terminal_unregister_heartbeat_and_slot() {
    for (operation_id, outcome) in [
        ("op-cas", HeartbeatOutcome::CasConflict),
        ("op-terminal", HeartbeatOutcome::AuthoritativeTerminal),
    ] {
        let (runtime, clock, ticker) = runtime_with(SchemaCapability::Available);
        let guard = runtime
            .try_acquire_operation_slot(
                ordinary_request(operation_id, "main", "retry"),
                CancellationToken::new(),
            )
            .expect("slot");
        let expected_outcome = outcome.clone();
        let _handle = guard
            .claim(|_| {
                Ok(ClaimedOperation::new(
                    operation_id,
                    &format!("claim-{operation_id}"),
                    0,
                    "claim-acquired",
                    "active",
                    Arc::new(move |_| expected_outcome.clone()),
                ))
            })
            .expect("claim");

        clock.advance_ms(30_000);
        let report = runtime.tick_heartbeats();

        assert_eq!(report.removed.len(), 1);
        assert_eq!(runtime.snapshot().heartbeat_entry_count, 0);
        assert_eq!(runtime.snapshot().active_slot_count, 0);
        assert!(!ticker.is_running());
    }
}

#[test]
fn completed_entry_ignores_an_old_heartbeat_callback_result() {
    let (runtime, clock, _) = runtime_with(SchemaCapability::Available);
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let guard = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-race", "main", "retry"),
            CancellationToken::new(),
        )
        .expect("slot");
    let callback_release = release_rx.clone();
    let mut handle = guard
        .claim(|_| {
            Ok(ClaimedOperation::new(
                "op-race",
                "claim-op-race",
                4,
                "claim-acquired",
                "active",
                Arc::new(move |_| {
                    started_tx.send(()).expect("signal heartbeat start");
                    callback_release
                        .lock()
                        .expect("release receiver")
                        .recv()
                        .expect("release heartbeat");
                    HeartbeatOutcome::Advanced {
                        new_claim_revision: 99,
                    }
                }),
            ))
        })
        .expect("claim");
    clock.advance_ms(30_000);
    let tick_runtime = runtime.clone();
    let tick_thread = thread::spawn(move || tick_runtime.tick_heartbeats());
    started_rx.recv().expect("heartbeat started");

    handle
        .complete(TerminalOperationSummary::completed("op-race", "completed"))
        .expect("complete during callback");
    release_tx.send(()).expect("release callback");
    let report = tick_thread.join().expect("tick thread");

    assert!(report.removed.is_empty());
    assert_eq!(runtime.snapshot().heartbeat_entry_count, 0);
    assert_eq!(runtime.snapshot().active_slot_count, 0);
}

#[test]
fn all_unavailable_capability_states_have_safe_feedback_and_no_slot() {
    for capability in [
        SchemaCapability::UnavailableNotMigrated,
        SchemaCapability::UnavailableInvalidSchema,
        SchemaCapability::ReadFailed,
    ] {
        let (runtime, _, _) = runtime_with(capability);
        let feedback = runtime
            .try_acquire_operation_slot(
                ordinary_request("exp-1", "main", "retry"),
                CancellationToken::new(),
            )
            .expect_err("capability must stop acquire");
        let encoded = serde_json::to_string(&feedback).expect("serialize feedback");
        assert!(encoded.contains("operation-state-unavailable"));
        assert!(!encoded.contains("operationSummary"));
        assert!(!encoded.contains("sqlite"));
        assert_eq!(runtime.snapshot().active_slot_count, 0);
    }
}

#[test]
fn feedback_serialization_is_camel_case_bounded_and_redacted() {
    let (runtime, _, _) = runtime_with(SchemaCapability::UnavailableInvalidSchema);
    let feedback = runtime
        .try_acquire_operation_slot(
            ordinary_request("exp-1", "main", "retry"),
            CancellationToken::new(),
        )
        .expect_err("unavailable");
    let encoded = serde_json::to_string(&feedback).expect("feedback JSON");

    assert!(encoded.contains("\"nextAction\""));
    assert!(encoded.contains("\"safeErrorCode\""));
    assert!(encoded.contains("PROVISIONING_OPERATION_STATE_UNAVAILABLE"));
    for forbidden in [
        "appInstanceToken",
        "claimToken",
        "sqlite",
        "SELECT ",
        "C:\\\\",
        "markdownBody",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "leaked {forbidden}: {encoded}"
        );
    }
}
