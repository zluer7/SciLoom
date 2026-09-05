use super::feedback::RuntimeSafeErrorCode;
use crate::db::manuscript_provisioning_operation_state::{
    count_audit_delivery_candidates, deliver_audit_outbox_once, list_audit_delivery_candidates,
    read_audit_state, retry_audit_outbox_once, AuditDeliveryInput, ProvisioningAuditOutbox,
    ProvisioningOperationRepositoryError, PROVISIONING_OUTBOX_DELIVERY_CONFLICT,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

pub(crate) const STARTUP_AUDIT_BATCH_LIMIT: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuditStoreErrorKind {
    Conflict,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuditStoreError {
    pub kind: AuditStoreErrorKind,
    pub safe_error_code: RuntimeSafeErrorCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuditStoreOutbox {
    pub operation_id: String,
    pub delivery_status: String,
    pub revision: i64,
    pub operation_log_id: Option<String>,
    pub safe_error_code: Option<String>,
}

impl AuditStoreOutbox {
    #[cfg(test)]
    pub(crate) fn pending(operation_id: &str) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            delivery_status: "pending".to_string(),
            revision: 0,
            operation_log_id: None,
            safe_error_code: None,
        }
    }
}

pub(crate) trait AuditStore: Send + Sync {
    fn list_candidates(&self, limit: usize) -> Result<Vec<AuditStoreOutbox>, AuditStoreError>;
    fn count_candidates(&self) -> Result<usize, AuditStoreError>;
    fn read_outbox(&self, operation_id: &str) -> Result<Option<AuditStoreOutbox>, AuditStoreError>;
    fn deliver_pending(
        &self,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), AuditStoreError>;
    fn retry_failed(
        &self,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), AuditStoreError>;
}

#[derive(Debug, Clone)]
pub(crate) struct SqliteAuditStore {
    connection: Arc<Mutex<Connection>>,
}

impl SqliteAuditStore {
    pub(crate) fn new(connection: Arc<Mutex<Connection>>) -> Self {
        Self { connection }
    }

    #[cfg(test)]
    pub(crate) fn connection(&self) -> Arc<Mutex<Connection>> {
        self.connection.clone()
    }
}

impl AuditStore for SqliteAuditStore {
    fn list_candidates(&self, limit: usize) -> Result<Vec<AuditStoreOutbox>, AuditStoreError> {
        let connection = self.connection.lock().expect("SQLite audit store lock");
        list_audit_delivery_candidates(&connection, limit)
            .map(|items| items.iter().map(AuditStoreOutbox::from).collect())
            .map_err(map_repository_error)
    }

    fn count_candidates(&self) -> Result<usize, AuditStoreError> {
        let connection = self.connection.lock().expect("SQLite audit store lock");
        count_audit_delivery_candidates(&connection).map_err(map_repository_error)
    }

    fn read_outbox(&self, operation_id: &str) -> Result<Option<AuditStoreOutbox>, AuditStoreError> {
        let connection = self.connection.lock().expect("SQLite audit store lock");
        read_audit_state(&connection, operation_id)
            .map(|item| item.as_ref().map(AuditStoreOutbox::from))
            .map_err(map_repository_error)
    }

    fn deliver_pending(
        &self,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), AuditStoreError> {
        let mut connection = self.connection.lock().expect("SQLite audit store lock");
        deliver_audit_outbox_once(
            &mut connection,
            &AuditDeliveryInput {
                operation_id: selected.operation_id.clone(),
                expected_revision: selected.revision,
                expected_status: selected.delivery_status.clone(),
                occurred_at: occurred_at.to_string(),
            },
        )
        .map(|_| ())
        .map_err(map_repository_error)
    }

    fn retry_failed(
        &self,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), AuditStoreError> {
        let mut connection = self.connection.lock().expect("SQLite audit store lock");
        retry_audit_outbox_once(
            &mut connection,
            &AuditDeliveryInput {
                operation_id: selected.operation_id.clone(),
                expected_revision: selected.revision,
                expected_status: selected.delivery_status.clone(),
                occurred_at: occurred_at.to_string(),
            },
        )
        .map(|_| ())
        .map_err(map_repository_error)
    }
}

impl From<&ProvisioningAuditOutbox> for AuditStoreOutbox {
    fn from(outbox: &ProvisioningAuditOutbox) -> Self {
        Self {
            operation_id: outbox.operation_id.clone(),
            delivery_status: outbox.delivery_status.clone(),
            revision: outbox.revision,
            operation_log_id: outbox.operation_log_id.clone(),
            safe_error_code: outbox.error_code.clone(),
        }
    }
}

pub(crate) fn map_repository_error(error: ProvisioningOperationRepositoryError) -> AuditStoreError {
    AuditStoreError {
        kind: if error.code == PROVISIONING_OUTBOX_DELIVERY_CONFLICT {
            AuditStoreErrorKind::Conflict
        } else {
            AuditStoreErrorKind::Failure
        },
        safe_error_code: if error.code == PROVISIONING_OUTBOX_DELIVERY_CONFLICT {
            RuntimeSafeErrorCode::AuditRetryFailed
        } else {
            RuntimeSafeErrorCode::AuditBatchFailed
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AuditBatchItemFinalStatus {
    Delivered,
    AlreadyDelivered,
    Conflicted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditBatchItemResult {
    pub operation_id: String,
    pub selected_status: String,
    pub final_status: AuditBatchItemFinalStatus,
    pub safe_error_code: Option<RuntimeSafeErrorCode>,
    pub operation_log_produced: bool,
    pub explicit_retry_required: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditBatchSummary {
    pub selected: usize,
    pub delivered: usize,
    pub already_delivered: usize,
    pub conflicted: usize,
    pub failed: usize,
    pub remaining: usize,
    pub items: Vec<AuditBatchItemResult>,
    pub safe_error_code: Option<RuntimeSafeErrorCode>,
}

#[derive(Debug, Default)]
struct AuditSchedulerState {
    startup_batch_started: bool,
    shutting_down: bool,
}

#[derive(Debug, Default)]
pub(crate) struct AuditScheduler {
    state: Mutex<AuditSchedulerState>,
}

impl AuditScheduler {
    pub(crate) fn run_startup_batch(
        &self,
        store: &dyn AuditStore,
        occurred_at: &str,
    ) -> AuditBatchSummary {
        {
            let mut state = self.state.lock().expect("audit scheduler lock");
            if state.shutting_down || state.startup_batch_started {
                return AuditBatchSummary {
                    safe_error_code: Some(if state.shutting_down {
                        RuntimeSafeErrorCode::RuntimeShuttingDown
                    } else {
                        RuntimeSafeErrorCode::AuditBatchFailed
                    }),
                    ..AuditBatchSummary::default()
                };
            }
            state.startup_batch_started = true;
        }
        let total = match store.count_candidates() {
            Ok(total) => total,
            Err(error) => {
                return AuditBatchSummary {
                    safe_error_code: Some(error.safe_error_code),
                    ..AuditBatchSummary::default()
                }
            }
        };
        let selected = match store.list_candidates(STARTUP_AUDIT_BATCH_LIMIT) {
            Ok(selected) => selected,
            Err(error) => {
                return AuditBatchSummary {
                    remaining: total,
                    safe_error_code: Some(error.safe_error_code),
                    ..AuditBatchSummary::default()
                }
            }
        };
        self.run_selected(store, selected, total, occurred_at)
    }

    pub(crate) fn deliver_one(
        &self,
        store: &dyn AuditStore,
        operation_id: &str,
        occurred_at: &str,
    ) -> AuditBatchItemResult {
        self.run_one(store, operation_id, "pending", occurred_at)
    }

    pub(crate) fn retry_one(
        &self,
        store: &dyn AuditStore,
        operation_id: &str,
        occurred_at: &str,
    ) -> AuditBatchItemResult {
        self.run_one(store, operation_id, "failed", occurred_at)
    }

    fn run_one(
        &self,
        store: &dyn AuditStore,
        operation_id: &str,
        required_status: &str,
        occurred_at: &str,
    ) -> AuditBatchItemResult {
        if self
            .state
            .lock()
            .expect("audit scheduler lock")
            .shutting_down
        {
            return failed_item(
                operation_id,
                required_status,
                AuditStoreErrorKind::Failure,
                RuntimeSafeErrorCode::RuntimeShuttingDown,
            );
        }
        match store.read_outbox(operation_id) {
            Ok(Some(outbox)) if outbox.delivery_status == "delivered" => {
                item_from_final(&outbox, AuditBatchItemFinalStatus::AlreadyDelivered, None)
            }
            Ok(Some(outbox)) if outbox.delivery_status == required_status => {
                self.deliver_selected(store, &outbox, occurred_at)
            }
            Ok(Some(_)) | Ok(None) => failed_item(
                operation_id,
                required_status,
                AuditStoreErrorKind::Conflict,
                RuntimeSafeErrorCode::AuditRetryFailed,
            ),
            Err(error) => failed_item(
                operation_id,
                required_status,
                error.kind,
                error.safe_error_code,
            ),
        }
    }

    fn run_selected(
        &self,
        store: &dyn AuditStore,
        selected: Vec<AuditStoreOutbox>,
        total: usize,
        occurred_at: &str,
    ) -> AuditBatchSummary {
        let mut summary = AuditBatchSummary {
            selected: selected.len(),
            remaining: total.saturating_sub(selected.len()),
            ..AuditBatchSummary::default()
        };
        for outbox in selected {
            let item = if outbox.delivery_status == "delivered" {
                item_from_final(&outbox, AuditBatchItemFinalStatus::AlreadyDelivered, None)
            } else if matches!(outbox.delivery_status.as_str(), "pending" | "failed") {
                self.deliver_selected(store, &outbox, occurred_at)
            } else {
                failed_item(
                    &outbox.operation_id,
                    &outbox.delivery_status,
                    AuditStoreErrorKind::Conflict,
                    RuntimeSafeErrorCode::AuditBatchFailed,
                )
            };
            match item.final_status {
                AuditBatchItemFinalStatus::Delivered => summary.delivered += 1,
                AuditBatchItemFinalStatus::AlreadyDelivered => summary.already_delivered += 1,
                AuditBatchItemFinalStatus::Conflicted => summary.conflicted += 1,
                AuditBatchItemFinalStatus::Failed => summary.failed += 1,
            }
            summary.items.push(item);
        }
        if summary.failed > 0 || summary.conflicted > 0 {
            summary.safe_error_code = Some(RuntimeSafeErrorCode::AuditBatchFailed);
        }
        summary
    }

    fn deliver_selected(
        &self,
        store: &dyn AuditStore,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> AuditBatchItemResult {
        let selected_status = selected.delivery_status.clone();
        let delivery = if selected.delivery_status == "pending" {
            store.deliver_pending(selected, occurred_at)
        } else {
            store.retry_failed(selected, occurred_at)
        };
        if let Err(error) = delivery {
            return failed_item(
                &selected.operation_id,
                &selected.delivery_status,
                error.kind,
                error.safe_error_code,
            );
        }
        match store.read_outbox(&selected.operation_id) {
            Ok(Some(final_outbox)) if final_outbox.delivery_status == "delivered" => {
                let mut item =
                    item_from_final(&final_outbox, AuditBatchItemFinalStatus::Delivered, None);
                item.selected_status = selected_status;
                item
            }
            Ok(Some(final_outbox)) if final_outbox.delivery_status == "failed" => {
                let mut item = item_from_final(
                    &final_outbox,
                    AuditBatchItemFinalStatus::Failed,
                    Some(RuntimeSafeErrorCode::AuditBatchFailed),
                );
                item.selected_status = selected_status;
                item
            }
            Ok(Some(final_outbox)) => {
                let mut item = item_from_final(
                    &final_outbox,
                    AuditBatchItemFinalStatus::Conflicted,
                    Some(RuntimeSafeErrorCode::AuditBatchFailed),
                );
                item.selected_status = selected_status;
                item
            }
            Ok(None) => failed_item(
                &selected.operation_id,
                &selected.delivery_status,
                AuditStoreErrorKind::Conflict,
                RuntimeSafeErrorCode::AuditBatchFailed,
            ),
            Err(error) => failed_item(
                &selected.operation_id,
                &selected.delivery_status,
                error.kind,
                error.safe_error_code,
            ),
        }
    }

    pub(crate) fn shutdown(&self) {
        self.state
            .lock()
            .expect("audit scheduler lock")
            .shutting_down = true;
    }
}

fn item_from_final(
    outbox: &AuditStoreOutbox,
    final_status: AuditBatchItemFinalStatus,
    safe_error_code: Option<RuntimeSafeErrorCode>,
) -> AuditBatchItemResult {
    AuditBatchItemResult {
        operation_id: outbox.operation_id.clone(),
        selected_status: outbox.delivery_status.clone(),
        final_status,
        safe_error_code,
        operation_log_produced: outbox.operation_log_id.is_some(),
        explicit_retry_required: matches!(
            final_status,
            AuditBatchItemFinalStatus::Failed | AuditBatchItemFinalStatus::Conflicted
        ),
    }
}

fn failed_item(
    operation_id: &str,
    selected_status: &str,
    kind: AuditStoreErrorKind,
    safe_error_code: RuntimeSafeErrorCode,
) -> AuditBatchItemResult {
    AuditBatchItemResult {
        operation_id: operation_id.to_string(),
        selected_status: selected_status.to_string(),
        final_status: if kind == AuditStoreErrorKind::Conflict {
            AuditBatchItemFinalStatus::Conflicted
        } else {
            AuditBatchItemFinalStatus::Failed
        },
        safe_error_code: Some(safe_error_code),
        operation_log_produced: false,
        explicit_retry_required: true,
    }
}
