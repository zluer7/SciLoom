use super::audit_scheduler::{map_repository_error, AuditStore, AuditStoreError, AuditStoreOutbox};
use super::feedback::RuntimeSafeErrorCode;
use super::runtime_issue::RuntimeIssueCandidate;
use super::schema_capability::{
    check_sqlite_schema_capability, SchemaCapability, SchemaCapabilityProvider,
};
use super::startup_scanner::{
    scan_sqlite_audit_candidates, scan_sqlite_runtime_candidates, StartupOrchestrationSource,
};
use crate::db::manuscript_provisioning_operation_state::{
    count_audit_delivery_candidates, deliver_audit_outbox_once, list_audit_delivery_candidates,
    read_audit_state, retry_audit_outbox_once, AuditDeliveryInput,
};
use rusqlite::{Connection, OpenFlags};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const FORMAL_APP_IDENTIFIER: &str = "local.labpod.desktop";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeDatabaseProviderError {
    pub safe_error_code: RuntimeSafeErrorCode,
}

impl RuntimeDatabaseProviderError {
    pub(crate) fn failed() -> Self {
        Self {
            safe_error_code: RuntimeSafeErrorCode::RuntimeDatabaseProviderFailed,
        }
    }

    fn isolation_required() -> Self {
        Self {
            safe_error_code: RuntimeSafeErrorCode::RuntimeIsolationRequired,
        }
    }
}

pub(crate) trait RuntimeDatabaseProvider: Send + Sync {
    fn open_read_only(&self) -> Result<Connection, RuntimeDatabaseProviderError>;
    fn open_audit(&self) -> Result<Connection, RuntimeDatabaseProviderError>;
    fn open_ownership(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        self.open_audit()
    }
    fn safe_source_id(&self) -> &str;
}

#[derive(Debug)]
pub(crate) struct SqliteRuntimeDatabaseProvider {
    database_path: PathBuf,
    safe_source_id: String,
    connection_open_count: AtomicUsize,
}

impl SqliteRuntimeDatabaseProvider {
    pub(crate) fn new_production_initialized(
        database_path: PathBuf,
    ) -> Result<Self, RuntimeDatabaseProviderError> {
        if !database_path.is_file() {
            return Err(RuntimeDatabaseProviderError::failed());
        }
        Ok(Self {
            database_path,
            safe_source_id: "production-initialized".to_string(),
            connection_open_count: AtomicUsize::new(0),
        })
    }

    pub(crate) fn new_isolated(
        database_path: PathBuf,
        identifier: &str,
    ) -> Result<Self, RuntimeDatabaseProviderError> {
        if identifier == FORMAL_APP_IDENTIFIER
            || !identifier.contains(".test")
            || !database_path.is_file()
        {
            return Err(RuntimeDatabaseProviderError::isolation_required());
        }
        let app_data = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(RuntimeDatabaseProviderError::isolation_required)?;
        let formal_directory = app_data.join(FORMAL_APP_IDENTIFIER);
        let candidate = database_path
            .canonicalize()
            .map_err(|_| RuntimeDatabaseProviderError::isolation_required())?;
        let formal = formal_directory.canonicalize().unwrap_or(formal_directory);
        if candidate.starts_with(&formal) {
            return Err(RuntimeDatabaseProviderError::isolation_required());
        }
        Ok(Self {
            database_path: candidate,
            safe_source_id: "isolated-test".to_string(),
            connection_open_count: AtomicUsize::new(0),
        })
    }

    pub(crate) fn formal_app_identifier() -> &'static str {
        FORMAL_APP_IDENTIFIER
    }

    #[cfg(test)]
    pub(crate) fn connection_open_count(&self) -> usize {
        self.connection_open_count.load(Ordering::Acquire)
    }

    fn open_with_flags(
        &self,
        flags: OpenFlags,
    ) -> Result<Connection, RuntimeDatabaseProviderError> {
        self.connection_open_count.fetch_add(1, Ordering::AcqRel);
        let connection = Connection::open_with_flags(&self.database_path, flags)
            .map_err(|_| RuntimeDatabaseProviderError::failed())?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|_| RuntimeDatabaseProviderError::failed())?;
        Ok(connection)
    }
}

impl RuntimeDatabaseProvider for SqliteRuntimeDatabaseProvider {
    fn open_read_only(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        self.open_with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY)
    }

    fn open_audit(&self) -> Result<Connection, RuntimeDatabaseProviderError> {
        self.open_with_flags(OpenFlags::SQLITE_OPEN_READ_WRITE)
    }

    fn safe_source_id(&self) -> &str {
        &self.safe_source_id
    }
}

pub(crate) struct ProviderSchemaCapability {
    provider: Arc<dyn RuntimeDatabaseProvider>,
}

impl ProviderSchemaCapability {
    pub(crate) fn new(provider: Arc<dyn RuntimeDatabaseProvider>) -> Self {
        Self { provider }
    }
}

impl SchemaCapabilityProvider for ProviderSchemaCapability {
    fn schema_capability(&self) -> SchemaCapability {
        match self.provider.open_read_only() {
            Ok(connection) => check_sqlite_schema_capability(&connection),
            Err(_) => SchemaCapability::ReadFailed,
        }
    }
}

pub(crate) struct ProviderStartupOrchestrationSource {
    provider: Arc<dyn RuntimeDatabaseProvider>,
}

impl ProviderStartupOrchestrationSource {
    pub(crate) fn new(provider: Arc<dyn RuntimeDatabaseProvider>) -> Self {
        Self { provider }
    }

    fn audit_error(error: RuntimeDatabaseProviderError) -> AuditStoreError {
        AuditStoreError {
            kind: super::audit_scheduler::AuditStoreErrorKind::Failure,
            safe_error_code: error.safe_error_code,
        }
    }
}

impl AuditStore for ProviderStartupOrchestrationSource {
    fn list_candidates(&self, limit: usize) -> Result<Vec<AuditStoreOutbox>, AuditStoreError> {
        let connection = self.provider.open_read_only().map_err(Self::audit_error)?;
        list_audit_delivery_candidates(&connection, limit)
            .map(|items| items.iter().map(AuditStoreOutbox::from).collect())
            .map_err(map_repository_error)
    }

    fn count_candidates(&self) -> Result<usize, AuditStoreError> {
        let connection = self.provider.open_read_only().map_err(Self::audit_error)?;
        count_audit_delivery_candidates(&connection).map_err(map_repository_error)
    }

    fn read_outbox(&self, operation_id: &str) -> Result<Option<AuditStoreOutbox>, AuditStoreError> {
        let connection = self.provider.open_read_only().map_err(Self::audit_error)?;
        read_audit_state(&connection, operation_id)
            .map(|item| item.as_ref().map(AuditStoreOutbox::from))
            .map_err(map_repository_error)
    }

    fn deliver_pending(
        &self,
        selected: &AuditStoreOutbox,
        occurred_at: &str,
    ) -> Result<(), AuditStoreError> {
        let mut connection = self.provider.open_audit().map_err(Self::audit_error)?;
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
        let mut connection = self.provider.open_audit().map_err(Self::audit_error)?;
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

impl StartupOrchestrationSource for ProviderStartupOrchestrationSource {
    fn scan_business_candidates(
        &self,
        current_app_instance_token: &str,
        observed_at: &str,
    ) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode> {
        let connection = self
            .provider
            .open_read_only()
            .map_err(|_| RuntimeSafeErrorCode::RuntimeDatabaseProviderFailed)?;
        scan_sqlite_runtime_candidates(&connection, current_app_instance_token, observed_at)
    }

    fn scan_final_audit_candidates(
        &self,
    ) -> Result<Vec<RuntimeIssueCandidate>, RuntimeSafeErrorCode> {
        let connection = self
            .provider
            .open_read_only()
            .map_err(|_| RuntimeSafeErrorCode::RuntimeDatabaseProviderFailed)?;
        scan_sqlite_audit_candidates(&connection)
    }
}

pub(crate) fn is_safe_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
