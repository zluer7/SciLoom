use super::manuscript_provisioning_operation_state::apply_schema_migration;
use rusqlite::Connection;

pub(crate) fn open_v40_source_database() -> Connection {
    let connection = Connection::open_in_memory().expect("open isolated v40 SQLite");
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );",
        )
        .expect("create isolated migration ledger");
    apply_schema_migration(&connection).expect("install exact v40 operation-state schema");
    connection
        .pragma_update(None, "user_version", 40)
        .expect("set isolated v40 version");
    connection
}

pub(crate) fn open_v39_source_database() -> Connection {
    let connection = open_v40_source_database();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP TABLE manuscript_provisioning_audit_outbox;
             DROP TABLE manuscript_provisioning_literature_child_states;
             DROP TABLE manuscript_provisioning_active_claims;
             DROP TABLE manuscript_provisioning_operation_attempts;
             DELETE FROM schema_migrations WHERE version=40;
             PRAGMA user_version=39;
             PRAGMA foreign_keys=ON;",
        )
        .expect("derive exact isolated v39 migration source");
    connection
}
