use super::feedback::RuntimeSafeErrorCode;
use super::heartbeat_scheduler::{MonotonicClock, SchedulerTicker, SchedulerTickerStart};
use serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub(crate) type RuntimeTask = Box<dyn FnOnce() + Send + 'static>;

struct RuntimeTaskAbortGuard {
    on_abort: Option<RuntimeTask>,
}

impl RuntimeTaskAbortGuard {
    fn new(on_abort: RuntimeTask) -> Self {
        Self {
            on_abort: Some(on_abort),
        }
    }

    fn complete(&mut self) {
        self.on_abort.take();
    }

    fn abort(&mut self) {
        if let Some(on_abort) = self.on_abort.take() {
            let _ = catch_unwind(AssertUnwindSafe(on_abort));
        }
    }
}

impl Drop for RuntimeTaskAbortGuard {
    fn drop(&mut self) {
        self.abort();
    }
}

pub(crate) trait RuntimeTaskSpawner: Send + Sync {
    fn spawn(&self, task: RuntimeTask, on_abort: RuntimeTask);
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct InlineRuntimeTaskSpawner;

impl RuntimeTaskSpawner for InlineRuntimeTaskSpawner {
    fn spawn(&self, task: RuntimeTask, on_abort: RuntimeTask) {
        if catch_unwind(AssertUnwindSafe(task)).is_err() {
            on_abort();
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TauriRuntimeTaskSpawner;

impl RuntimeTaskSpawner for TauriRuntimeTaskSpawner {
    fn spawn(&self, task: RuntimeTask, on_abort: RuntimeTask) {
        tauri::async_runtime::spawn(async move {
            let mut abort_guard = RuntimeTaskAbortGuard::new(on_abort);
            let result =
                tauri::async_runtime::spawn_blocking(move || catch_unwind(AssertUnwindSafe(task)))
                    .await;
            if matches!(result, Ok(Ok(()))) {
                abort_guard.complete();
            } else {
                abort_guard.abort();
            }
        });
    }
}

#[derive(Debug)]
pub(crate) struct SystemMonotonicClock {
    started: Instant,
}

impl Default for SystemMonotonicClock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl MonotonicClock for SystemMonotonicClock {
    fn now_ms(&self) -> i64 {
        self.started.elapsed().as_millis().min(i64::MAX as u128) as i64
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStateNotification {
    pub revision: u64,
    pub generation: u64,
    pub kind: String,
}

pub(crate) trait RuntimeEventSink: Send + Sync {
    fn notify(&self, notification: RuntimeStateNotification);
}

#[derive(Debug, Default)]
pub(crate) struct NoopRuntimeEventSink;

impl RuntimeEventSink for NoopRuntimeEventSink {
    fn notify(&self, _notification: RuntimeStateNotification) {}
}

#[derive(Debug, Default)]
pub(crate) struct RecordingRuntimeEventSink {
    notifications: Mutex<Vec<RuntimeStateNotification>>,
}

impl RecordingRuntimeEventSink {
    #[cfg(test)]
    pub(crate) fn startup_completed_count(&self) -> usize {
        self.notifications
            .lock()
            .expect("runtime event lock")
            .iter()
            .filter(|notification| notification.kind == "startup-completed")
            .count()
    }

    #[cfg(test)]
    pub(crate) fn startup_failed_count(&self) -> usize {
        self.notifications
            .lock()
            .expect("runtime event lock")
            .iter()
            .filter(|notification| notification.kind == "startup-failed")
            .count()
    }

    #[cfg(test)]
    pub(crate) fn shutdown_count(&self) -> usize {
        self.notifications
            .lock()
            .expect("runtime event lock")
            .iter()
            .filter(|notification| notification.kind == "shutdown-stopped")
            .count()
    }
}

impl RuntimeEventSink for RecordingRuntimeEventSink {
    fn notify(&self, notification: RuntimeStateNotification) {
        self.notifications
            .lock()
            .expect("runtime event lock")
            .push(notification);
    }
}

type TickCallback = Arc<dyn Fn() + Send + Sync + 'static>;

struct AsyncTickerState {
    callback: Mutex<Option<TickCallback>>,
    interval: Duration,
    running: AtomicBool,
    failed: AtomicBool,
    generation: AtomicU64,
    starts: AtomicUsize,
    stops: AtomicUsize,
    panics: AtomicUsize,
    stop_notify: Notify,
}

pub(crate) struct TauriAsyncHeartbeatTicker {
    state: Arc<AsyncTickerState>,
}

impl TauriAsyncHeartbeatTicker {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            state: Arc::new(AsyncTickerState {
                callback: Mutex::new(None),
                interval,
                running: AtomicBool::new(false),
                failed: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                starts: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
                panics: AtomicUsize::new(0),
                stop_notify: Notify::new(),
            }),
        }
    }

    pub(crate) fn bind_tick(&self, callback: TickCallback) -> Result<(), RuntimeSafeErrorCode> {
        let mut current = self.state.callback.lock().expect("ticker callback lock");
        if current.is_some() {
            return Err(RuntimeSafeErrorCode::RuntimeAlreadyInitialized);
        }
        *current = Some(callback);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn start_count(&self) -> usize {
        self.state.starts.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn stop_count(&self) -> usize {
        self.state.stops.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn panic_count(&self) -> usize {
        self.state.panics.load(Ordering::Acquire)
    }
}

impl SchedulerTicker for TauriAsyncHeartbeatTicker {
    fn start(&self) -> Result<SchedulerTickerStart, RuntimeSafeErrorCode> {
        if self.state.failed.load(Ordering::Acquire) {
            return Err(RuntimeSafeErrorCode::RuntimeHeartbeatFailed);
        }
        if self.state.running.swap(true, Ordering::AcqRel) {
            return Ok(SchedulerTickerStart::AlreadyRunning);
        }
        let Some(callback) = self
            .state
            .callback
            .lock()
            .expect("ticker callback lock")
            .clone()
        else {
            self.state.running.store(false, Ordering::Release);
            return Err(RuntimeSafeErrorCode::RuntimeActivationFailed);
        };
        self.state.starts.fetch_add(1, Ordering::AcqRel);
        let generation = self.state.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let state = self.state.clone();
        tauri::async_runtime::spawn(async move {
            while state.running.load(Ordering::Acquire)
                && state.generation.load(Ordering::Acquire) == generation
            {
                if tokio::time::timeout(state.interval, state.stop_notify.notified())
                    .await
                    .is_ok()
                {
                    break;
                }
                if !state.running.load(Ordering::Acquire)
                    || state.generation.load(Ordering::Acquire) != generation
                {
                    break;
                }
                if catch_unwind(AssertUnwindSafe(|| callback())).is_err() {
                    state.panics.fetch_add(1, Ordering::AcqRel);
                    state.failed.store(true, Ordering::Release);
                    state.running.store(false, Ordering::Release);
                    break;
                }
            }
        });
        Ok(SchedulerTickerStart::Started)
    }

    fn stop(&self) {
        if self.state.running.swap(false, Ordering::AcqRel) {
            self.state.stops.fetch_add(1, Ordering::AcqRel);
            self.state.generation.fetch_add(1, Ordering::AcqRel);
            self.state.stop_notify.notify_waiters();
        }
    }
}
