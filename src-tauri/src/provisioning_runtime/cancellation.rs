use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub(crate) struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
