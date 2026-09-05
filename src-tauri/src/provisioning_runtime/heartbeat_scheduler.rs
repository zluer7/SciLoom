use super::feedback::{
    FeedbackAuthority, RuntimeFeedback, RuntimeNextAction, RuntimeSafeErrorCode,
};
use super::slot::ResourceKey;
use crate::db::manuscript_provisioning_operation_state::{
    HEARTBEAT_CADENCE_MS, STALE_CANDIDATE_THRESHOLD_MS,
};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeartbeatInput {
    pub operation_id: String,
    pub claim_id: String,
    pub expected_claim_revision: i64,
    pub generation: u64,
    pub scheduled_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HeartbeatOutcome {
    Advanced { new_claim_revision: i64 },
    CasConflict,
    ClaimMismatch,
    AuthoritativeTerminal,
    TransientError { safe_error_code: String },
}

pub(crate) type HeartbeatCallback =
    Arc<dyn Fn(HeartbeatInput) -> HeartbeatOutcome + Send + Sync + 'static>;

pub(crate) trait MonotonicClock: Send + Sync {
    fn now_ms(&self) -> i64;
}

#[derive(Debug, Default)]
pub(crate) struct FixedMonotonicClock {
    now_ms: AtomicI64,
}

impl FixedMonotonicClock {
    pub(crate) fn new(now_ms: i64) -> Self {
        Self {
            now_ms: AtomicI64::new(now_ms),
        }
    }

    pub(crate) fn advance_ms(&self, delta_ms: i64) {
        self.now_ms.fetch_add(delta_ms, Ordering::AcqRel);
    }

    #[cfg(test)]
    pub(crate) fn set_ms(&self, now_ms: i64) {
        self.now_ms.store(now_ms, Ordering::Release);
    }
}

impl MonotonicClock for FixedMonotonicClock {
    fn now_ms(&self) -> i64 {
        self.now_ms.load(Ordering::Acquire)
    }
}

pub(crate) trait SchedulerTicker: Send + Sync {
    fn start(&self) -> Result<SchedulerTickerStart, RuntimeSafeErrorCode>;
    fn stop(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SchedulerTickerStart {
    Started,
    AlreadyRunning,
}

#[derive(Debug, Default)]
pub(crate) struct RecordingTicker {
    running: AtomicBool,
    starts: AtomicUsize,
    stops: AtomicUsize,
}

impl RecordingTicker {
    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub(crate) fn start_count(&self) -> usize {
        self.starts.load(Ordering::Acquire)
    }

    pub(crate) fn stop_count(&self) -> usize {
        self.stops.load(Ordering::Acquire)
    }
}

impl SchedulerTicker for RecordingTicker {
    fn start(&self) -> Result<SchedulerTickerStart, RuntimeSafeErrorCode> {
        if self.running.swap(true, Ordering::AcqRel) {
            Ok(SchedulerTickerStart::AlreadyRunning)
        } else {
            self.starts.fetch_add(1, Ordering::AcqRel);
            Ok(SchedulerTickerStart::Started)
        }
    }

    fn stop(&self) {
        if self.running.swap(false, Ordering::AcqRel) {
            self.stops.fetch_add(1, Ordering::AcqRel);
        }
    }
}

#[derive(Clone)]
pub(crate) struct HeartbeatRegistration {
    pub operation_id: String,
    pub claim_id: String,
    pub expected_claim_revision: i64,
    pub resource: ResourceKey,
    pub generation: u64,
    pub callback: HeartbeatCallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeartbeatExecutionState {
    Active,
    Abandoned,
}

#[derive(Clone)]
struct HeartbeatEntry {
    operation_id: String,
    claim_id: String,
    expected_claim_revision: i64,
    resource: ResourceKey,
    generation: u64,
    callback: HeartbeatCallback,
    last_scheduled_at_ms: i64,
    state: HeartbeatExecutionState,
    consecutive_failures: u8,
    last_error_code: Option<String>,
}

#[derive(Default)]
struct SchedulerState {
    shutting_down: bool,
    entries: HashMap<String, HeartbeatEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeartbeatRemovalReason {
    CasConflict,
    ClaimMismatch,
    AuthoritativeTerminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeartbeatRemoval {
    pub operation_id: String,
    pub generation: u64,
    pub reason: HeartbeatRemovalReason,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct HeartbeatTickReport {
    pub feedback: Vec<RuntimeFeedback>,
    pub removed: Vec<HeartbeatRemoval>,
}

pub(crate) struct HeartbeatScheduler {
    state: Mutex<SchedulerState>,
    clock: Arc<dyn MonotonicClock>,
    ticker: Arc<dyn SchedulerTicker>,
}

impl HeartbeatScheduler {
    pub(crate) fn new(clock: Arc<dyn MonotonicClock>, ticker: Arc<dyn SchedulerTicker>) -> Self {
        Self {
            state: Mutex::new(SchedulerState::default()),
            clock,
            ticker,
        }
    }

    pub(crate) fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    pub(crate) fn register(
        &self,
        registration: HeartbeatRegistration,
    ) -> Result<(), RuntimeFeedback> {
        let mut state = self.state.lock().expect("heartbeat registry lock");
        if state.shutting_down {
            return Err(RuntimeFeedback::InternalFailure {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::RuntimeShuttingDown,
            });
        }
        if state.entries.contains_key(&registration.operation_id) {
            return Err(RuntimeFeedback::InternalFailure {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::RuntimeEntryGenerationConflict,
            });
        }
        let start_ticker = state.entries.is_empty();
        let now_ms = self.clock.now_ms();
        let operation_id = registration.operation_id.clone();
        state.entries.insert(
            operation_id.clone(),
            HeartbeatEntry {
                operation_id: registration.operation_id,
                claim_id: registration.claim_id,
                expected_claim_revision: registration.expected_claim_revision,
                resource: registration.resource,
                generation: registration.generation,
                callback: registration.callback,
                last_scheduled_at_ms: now_ms,
                state: HeartbeatExecutionState::Active,
                consecutive_failures: 0,
                last_error_code: None,
            },
        );
        if start_ticker {
            let start_result = catch_unwind(AssertUnwindSafe(|| self.ticker.start()))
                .unwrap_or(Err(RuntimeSafeErrorCode::RuntimeHeartbeatFailed));
            if let Err(safe_error_code) = start_result {
                state.entries.remove(&operation_id);
                return Err(RuntimeFeedback::InternalFailure {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::Stop,
                    safe_error_code,
                });
            }
        }
        drop(state);
        Ok(())
    }

    pub(crate) fn unregister(&self, operation_id: &str, generation: u64) -> bool {
        let mut state = self.state.lock().expect("heartbeat registry lock");
        let removed = if state
            .entries
            .get(operation_id)
            .is_some_and(|entry| entry.generation == generation)
        {
            state.entries.remove(operation_id);
            true
        } else {
            false
        };
        let stop_ticker = removed && state.entries.is_empty();
        if stop_ticker {
            self.ticker.stop();
        }
        drop(state);
        removed
    }

    pub(crate) fn tick(&self) -> HeartbeatTickReport {
        let now_ms = self.clock.now_ms();
        let snapshot: Vec<HeartbeatEntry> = {
            let state = self.state.lock().expect("heartbeat registry lock");
            if state.shutting_down {
                return HeartbeatTickReport::default();
            }
            state
                .entries
                .values()
                .filter(|entry| {
                    entry.state == HeartbeatExecutionState::Active
                        && now_ms - entry.last_scheduled_at_ms >= HEARTBEAT_CADENCE_MS
                })
                .cloned()
                .collect()
        };

        let mut report = HeartbeatTickReport::default();
        for snapshot_entry in snapshot {
            let still_active = {
                let state = self.state.lock().expect("heartbeat registry lock");
                !state.shutting_down
                    && state
                        .entries
                        .get(&snapshot_entry.operation_id)
                        .is_some_and(|entry| {
                            entry.generation == snapshot_entry.generation
                                && entry.state == HeartbeatExecutionState::Active
                        })
            };
            if !still_active {
                continue;
            }
            let input = HeartbeatInput {
                operation_id: snapshot_entry.operation_id.clone(),
                claim_id: snapshot_entry.claim_id.clone(),
                expected_claim_revision: snapshot_entry.expected_claim_revision,
                generation: snapshot_entry.generation,
                scheduled_at_ms: now_ms,
            };
            let outcome = (snapshot_entry.callback)(input);
            let mut state = self.state.lock().expect("heartbeat registry lock");
            if state.shutting_down {
                continue;
            }
            let Some(current) = state.entries.get_mut(&snapshot_entry.operation_id) else {
                continue;
            };
            if current.generation != snapshot_entry.generation {
                report.feedback.push(RuntimeFeedback::CasConflict {
                    authority: FeedbackAuthority::RuntimeLocal,
                    next_action: RuntimeNextAction::InspectActiveOperation,
                    safe_error_code: RuntimeSafeErrorCode::RuntimeEntryGenerationConflict,
                    operation_id: snapshot_entry.operation_id,
                });
                continue;
            }
            match outcome {
                HeartbeatOutcome::Advanced { new_claim_revision } => {
                    current.expected_claim_revision = new_claim_revision;
                    current.last_scheduled_at_ms = now_ms;
                    current.consecutive_failures = 0;
                    current.last_error_code = None;
                }
                HeartbeatOutcome::TransientError { safe_error_code } => {
                    current.last_scheduled_at_ms = now_ms;
                    current.consecutive_failures = current.consecutive_failures.saturating_add(1);
                    if current.last_error_code.as_deref() != Some(&safe_error_code) {
                        current.last_error_code = Some(safe_error_code);
                        report.feedback.push(RuntimeFeedback::HeartbeatFailed {
                            authority: FeedbackAuthority::DurableOperationState,
                            next_action: RuntimeNextAction::ContinueExecution,
                            safe_error_code: RuntimeSafeErrorCode::RuntimeHeartbeatFailed,
                            operation_id: current.operation_id.clone(),
                        });
                    }
                }
                HeartbeatOutcome::CasConflict
                | HeartbeatOutcome::ClaimMismatch
                | HeartbeatOutcome::AuthoritativeTerminal => {
                    let reason = match outcome {
                        HeartbeatOutcome::CasConflict => HeartbeatRemovalReason::CasConflict,
                        HeartbeatOutcome::ClaimMismatch => HeartbeatRemovalReason::ClaimMismatch,
                        HeartbeatOutcome::AuthoritativeTerminal => {
                            HeartbeatRemovalReason::AuthoritativeTerminal
                        }
                        _ => unreachable!(),
                    };
                    let operation_id = current.operation_id.clone();
                    let generation = current.generation;
                    state.entries.remove(&operation_id);
                    report.removed.push(HeartbeatRemoval {
                        operation_id: operation_id.clone(),
                        generation,
                        reason,
                    });
                    if !matches!(reason, HeartbeatRemovalReason::AuthoritativeTerminal) {
                        report.feedback.push(RuntimeFeedback::CasConflict {
                            authority: FeedbackAuthority::DurableOperationState,
                            next_action: RuntimeNextAction::InspectActiveOperation,
                            safe_error_code: RuntimeSafeErrorCode::RuntimeEntryGenerationConflict,
                            operation_id,
                        });
                    }
                }
            }
        }
        let state = self.state.lock().expect("heartbeat registry lock");
        if state.entries.is_empty() {
            self.ticker.stop();
        }
        drop(state);
        report
    }

    pub(crate) fn shutdown(&self) {
        let mut state = self.state.lock().expect("heartbeat registry lock");
        state.shutting_down = true;
        for entry in state.entries.values_mut() {
            entry.state = HeartbeatExecutionState::Abandoned;
        }
        drop(state);
        self.ticker.stop();
    }

    pub(crate) fn entry_count(&self) -> usize {
        self.state
            .lock()
            .expect("heartbeat registry lock")
            .entries
            .len()
    }

    #[cfg(test)]
    pub(crate) fn expected_revision(&self, operation_id: &str) -> Option<i64> {
        self.state
            .lock()
            .expect("heartbeat registry lock")
            .entries
            .get(operation_id)
            .map(|entry| entry.expected_claim_revision)
    }

    #[cfg(test)]
    pub(crate) fn safe_resource(&self, operation_id: &str) -> Option<ResourceKey> {
        self.state
            .lock()
            .expect("heartbeat registry lock")
            .entries
            .get(operation_id)
            .map(|entry| entry.resource.clone())
    }

    pub(crate) fn cadence_ms(&self) -> i64 {
        HEARTBEAT_CADENCE_MS
    }

    pub(crate) fn stale_candidate_threshold_ms(&self) -> i64 {
        STALE_CANDIDATE_THRESHOLD_MS
    }
}
