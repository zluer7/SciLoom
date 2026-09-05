use crate::db::manuscript_provisioning_operation_state::step_progress_schema::
    validate_provisioning_contract;
use crate::db::schema::{validate_global_schema_current, CURRENT_SCHEMA_VERSION};
use rusqlite::Connection;
use std::sync::{Arc, Mutex, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SchemaCapability {
    Available,
    UnavailableNotMigrated,
    UnavailableInvalidSchema,
    ReadFailed,
}

pub(crate) trait SchemaCapabilityProvider: Send + Sync {
    fn schema_capability(&self) -> SchemaCapability;
}

pub(crate) trait SchemaCapabilityAccess {
    fn read_user_version(&self) -> Result<i64, ()>;
    fn validate_composed_contracts(&self) -> Result<bool, ()>;
}

impl SchemaCapabilityAccess for Connection {
    fn read_user_version(&self) -> Result<i64, ()> {
        self.pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| ())
    }

    fn validate_composed_contracts(&self) -> Result<bool, ()> {
        Ok(
            validate_global_schema_current(self).is_ok()
                && validate_provisioning_contract(self).map_err(|_| ())?,
        )
    }
}

pub(crate) fn check_schema_capability(access: &dyn SchemaCapabilityAccess) -> SchemaCapability {
    let user_version = match access.read_user_version() {
        Ok(version) => version,
        Err(()) => return SchemaCapability::ReadFailed,
    };
    if user_version < CURRENT_SCHEMA_VERSION {
        return SchemaCapability::UnavailableNotMigrated;
    }
    if user_version != CURRENT_SCHEMA_VERSION {
        return SchemaCapability::UnavailableInvalidSchema;
    }
    match access.validate_composed_contracts() {
        Ok(true) => SchemaCapability::Available,
        Ok(false) => SchemaCapability::UnavailableInvalidSchema,
        Err(()) => SchemaCapability::ReadFailed,
    }
}

pub(crate) fn check_sqlite_schema_capability(connection: &Connection) -> SchemaCapability {
    check_schema_capability(connection)
}

#[derive(Debug, Clone)]
pub(crate) struct SqliteSchemaCapabilityProvider {
    connection: Arc<Mutex<Connection>>,
}

impl SqliteSchemaCapabilityProvider {
    pub(crate) fn new(connection: Arc<Mutex<Connection>>) -> Self {
        Self { connection }
    }
}

impl SchemaCapabilityProvider for SqliteSchemaCapabilityProvider {
    fn schema_capability(&self) -> SchemaCapability {
        let connection = self
            .connection
            .lock()
            .expect("SQLite schema capability lock");
        check_sqlite_schema_capability(&connection)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FixedSchemaCapabilityProvider {
    capability: Arc<RwLock<SchemaCapability>>,
}

impl FixedSchemaCapabilityProvider {
    pub(crate) fn new(capability: SchemaCapability) -> Self {
        Self {
            capability: Arc::new(RwLock::new(capability)),
        }
    }

    #[cfg(test)]
    pub(crate) fn set(&self, capability: SchemaCapability) {
        *self.capability.write().expect("capability write lock") = capability;
    }
}

impl SchemaCapabilityProvider for FixedSchemaCapabilityProvider {
    fn schema_capability(&self) -> SchemaCapability {
        *self.capability.read().expect("capability read lock")
    }
}
