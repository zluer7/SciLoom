//! v59 removes only Experiment's legacy Task FK. Planning remains the sole owner.
use rusqlite::{Connection, Result};

pub(crate) const VERSION: i64 = 59;
const TEMP: &str = "experiments_lp15_d4_relation";
const LEGACY_FK: &str = ",\n  FOREIGN KEY (task_id) REFERENCES tasks(id)";

fn table_sql(target: bool) -> String {
    let sql = super::experiment_six_field_schema::SIX_FIELD_EXPERIMENT_TABLE_SQL
        .replace("experiments_lp12_4_a1_six_field", "experiments");
    if target { sql.replace(LEGACY_FK, "") } else { sql }
}

fn normalized(sql: &str) -> String {
    let mut result=String::new();
    let mut literal=false;
    for c in sql.chars() {
        if c=='\'' { literal=!literal; result.push(c); }
        else if literal { result.push(c); }
        else if !c.is_whitespace() && c!='"' && c!=';' { result.push(c.to_ascii_lowercase()); }
    }
    result
}

fn validate_shape(connection: &Connection, target: bool) -> Result<()> {
    let actual: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='experiments'", [], |r| r.get(0))?;
    if normalized(&actual) != normalized(&table_sql(target)) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    for table in ["experiments", "experiment_runs"] {
        let count: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name IN ('route_id','task_id') AND upper(type)='TEXT' AND [notnull]=0 AND dflt_value IS NULL"),
            [], |r| r.get(0))?;
        if count != 2 { return Err(rusqlite::Error::InvalidQuery); }
    }
    Ok(())
}

pub(crate) fn integrity(connection: &Connection) -> Result<()> {
    let quick: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if quick != "ok" || connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

pub(crate) fn preflight(connection: &Connection) -> Result<()> {
    validate_shape(connection, false)?;
    integrity(connection)?;
    // SQL NULL only: even an empty or apparently current ID is unapproved here.
    for table in ["experiments", "experiment_runs"] {
        if connection.prepare(&format!("SELECT 1 FROM {table} WHERE route_id IS NOT NULL OR task_id IS NOT NULL LIMIT 1"))?.exists([])? {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    Ok(())
}

pub(crate) fn validate_target(connection: &Connection) -> Result<()> {
    validate_shape(connection, true)?;
    let marker: i64 = connection.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version=59", [], |r| r.get(0))?;
    if marker != 1 { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

// Caller owns the existing migration transaction and controlled FK suspension.
// No provisioning, FileRef/Binding writes, recovery execution, or filesystem IO.
pub(crate) fn apply(connection: &Connection) -> Result<()> {
    let dependent: Vec<String> = connection.prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name='experiments' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name"
    )?.query_map([], |r| r.get(0))?.collect::<Result<_>>()?;
    connection.execute_batch(&table_sql(true).replacen("CREATE TABLE experiments", &format!("CREATE TABLE {TEMP}"), 1))?;
    // Shape was admitted exactly; column order and every value remain identical.
    connection.execute_batch(&format!(
        "INSERT INTO {TEMP} SELECT * FROM experiments; DROP TABLE experiments; ALTER TABLE {TEMP} RENAME TO experiments;"
    ))?;
    for sql in dependent { connection.execute_batch(&sql)?; }
    connection.execute("INSERT INTO schema_migrations(version,name) VALUES (59,'experiment_current_planning_relations')", [])?;
    validate_target(connection)?;
    integrity(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::schema;
    use rusqlite::types::Value;
    use std::collections::BTreeMap;

    fn rows(c: &Connection, sql: &str) -> Vec<Vec<Value>> {
        let mut statement = c.prepare(sql).unwrap();
        let count = statement.column_count();
        statement.query_map([], |r| (0..count).map(|i| r.get(i)).collect()).unwrap()
            .collect::<Result<_>>().unwrap()
    }
    fn contents(c: &Connection) -> BTreeMap<String, Vec<Vec<Value>>> {
        let names: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_>>().unwrap();
        names.into_iter().map(|name| {
            let data = rows(c, &format!("SELECT * FROM \"{name}\" ORDER BY 1"));
            (name, data)
        }).collect()
    }
    fn objects(c: &Connection) -> Vec<Vec<Value>> {
        rows(c, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE NOT (type='table' AND name='experiments') ORDER BY type,name")
    }
    fn version(c: &Connection) -> i64 { c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap() }
    fn fk(c: &Connection) -> i64 { c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap() }

    fn predecessor() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        schema::run_migrations(&c).unwrap();
        // Isolated approved-family fixture only; never reverse an actual database.
        let indexes: Vec<String> = c.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='experiments' AND type IN ('index','trigger') AND sql IS NOT NULL").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_>>().unwrap();
        c.execute_batch("PRAGMA foreign_keys=OFF; BEGIN; DROP TABLE experiments;").unwrap();
        c.execute_batch(&table_sql(false)).unwrap();
        for sql in indexes { c.execute_batch(&sql).unwrap(); }
        c.execute_batch("DELETE FROM schema_migrations WHERE version=59; PRAGMA user_version=58; COMMIT; PRAGMA foreign_keys=ON;").unwrap();
        c.execute_batch(r#"
          INSERT INTO experiments(id,project_id,experiment_name,machine_object,fault_type,sensor_config,data_path,result_summary,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at)
            VALUES ('exp','project','Experiment','','unknown','','','preserve body α','2026-09-05','0900','exp','created','updated');
          INSERT INTO experiment_runs(id,experiment_id,project_id,title,run_label,status,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at)
            VALUES ('run1','exp','project','Run 1','R1','draft','2026-09-05','0901','run1','created','updated'),
                   ('run2','exp','project','Run 2','R2','draft','2026-09-05','0902','run2','created','updated');
          INSERT INTO experiment_representative_runs VALUES ('rep1','exp','run1',0,'created','unchanged1'),('rep2','exp','run2',1,'created','unchanged2');
          INSERT INTO result_metrics(id,run_id,experiment_id,name,value,order_index,created_at,updated_at) VALUES ('metric','run1','exp','M','0.73',4,'created','updated');
          INSERT INTO result_items(id,project_id,experiment_id,experiment_run_id,source_type,source_id,title,result_type,created_at,updated_at) VALUES ('result','project','exp','run1','experiment','exp','Result','other','created','updated');
          INSERT INTO findings(id,project_id,experiment_id,title,summary,created_at,updated_at) VALUES ('finding','project','exp','Finding','preserve finding','created','updated');
          INSERT INTO outputs(id,project_id,experiment_id,output_name,output_type,description,created_at,updated_at) VALUES ('output','project','exp','Output','other','preserve output','created','updated');
          INSERT INTO file_refs(id,owner_type,owner_id,file_type,path,title,created_at,updated_at) VALUES ('file','experiment','exp','markdown','fixture.md','File','created','updated');
          INSERT INTO manuscript_bindings(id,owner_type,owner_id,current_file_ref_id,default_manuscript_file_ref_id,created_at,updated_at) VALUES ('binding','experiment','exp','file','file','created','updated');
          INSERT INTO tasks(id,project_id,title,description,task_type,priority,status,acceptance_criteria,created_at,updated_at) VALUES ('current-looking-task','project','Legacy fixture','','research','medium','todo','','created','updated');
          CREATE TRIGGER lp15_fixture_experiment_trigger AFTER UPDATE OF title ON experiments BEGIN SELECT 1; END;
        "#).unwrap();
        preflight(&c).unwrap();
        c
    }

    #[test]
    fn preserves_all_rows_reverse_refs_sorting_bindings_and_non_target_schema() {
        let c=predecessor(); let data=contents(&c); let schema_before=objects(&c);
        schema::run_migrations(&c).unwrap();
        assert_eq!(data,contents(&c)); assert_eq!(schema_before,objects(&c));
        assert_eq!(version(&c),VERSION); assert_eq!(fk(&c),1);
        integrity(&c).unwrap(); validate_target(&c).unwrap();
        assert!(!c.prepare("PRAGMA foreign_key_list(experiments)").unwrap().exists([]).unwrap());
        assert_eq!(rows(&c,"SELECT sort_order,updated_at FROM experiment_representative_runs ORDER BY sort_order"),vec![vec![Value::Integer(0),Value::Text("unchanged1".into())],vec![Value::Integer(1),Value::Text("unchanged2".into())]]);
        let fresh=Connection::open_in_memory().unwrap(); schema::run_migrations(&fresh).unwrap();
        assert_eq!(rows(&c,"PRAGMA table_info(experiments)"),rows(&fresh,"PRAGMA table_info(experiments)"));
        assert_eq!(rows(&c,"SELECT sql FROM sqlite_master WHERE name='experiments'"),rows(&fresh,"SELECT sql FROM sqlite_master WHERE name='experiments'"));
        // Once at target, non-null current IDs survive start and no rebuild occurs.
        c.execute_batch("UPDATE experiments SET route_id='current-route',task_id='current-task'; UPDATE experiment_runs SET task_id='current-task';").unwrap();
        let target=contents(&c); let schema_version=rows(&c,"PRAGMA schema_version");
        schema::run_migrations(&c).unwrap();
        assert_eq!(target,contents(&c)); assert_eq!(schema_version,rows(&c,"PRAGMA schema_version"));
    }

    #[test]
    fn rejects_each_non_null_predecessor_field_before_migration() {
        for (table,column,value) in [("experiments","route_id","current-route"),("experiments","task_id","current-looking-task"),("experiment_runs","route_id",""),("experiment_runs","task_id","current-task")] {
            let c=predecessor(); c.execute(&format!("UPDATE {table} SET {column}=?1 WHERE rowid=(SELECT MIN(rowid) FROM {table})"),[value]).unwrap();
            integrity(&c).unwrap(); // Rejection must not be caused by an invalid legacy FK.
            let data=contents(&c); let before=rows(&c,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
            let error=schema::run_migrations(&c).unwrap_err();
            assert_eq!(error.stage,"v59-predecessor-admission-all-four-relations-null");
            assert_eq!(data,contents(&c)); assert_eq!(before,rows(&c,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name"));
            assert_eq!(version(&c),58); assert_eq!(fk(&c),1); integrity(&c).unwrap();
        }
    }

    #[test]
    fn migration_execution_failure_rolls_back_data_schema_version_and_restores_fk() {
        let c=predecessor();
        c.execute_batch("CREATE TRIGGER lp15_fail_marker BEFORE INSERT ON schema_migrations WHEN NEW.version=59 BEGIN SELECT RAISE(ABORT,'deterministic after-rebuild failure'); END;").unwrap();
        let data=contents(&c); let before=rows(&c,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
        let error=schema::run_migrations(&c).unwrap_err();
        assert_eq!(error.stage,"v59-relation-migration"); assert!(error.message.contains("deterministic after-rebuild failure"));
        assert_eq!(data,contents(&c)); assert_eq!(before,rows(&c,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name"));
        assert_eq!(version(&c),58); assert_eq!(fk(&c),1); integrity(&c).unwrap(); preflight(&c).unwrap();
    }

    #[test]
    fn rejects_unknown_version_and_tampered_predecessor_shape() {
        let c=predecessor(); c.execute_batch("PRAGMA user_version=57;").unwrap();
        let before=contents(&c); assert!(schema::run_migrations(&c).is_err()); assert_eq!(version(&c),57); assert_eq!(before,contents(&c));
        c.execute_batch("PRAGMA user_version=58; ALTER TABLE experiments ADD COLUMN unexpected TEXT;").unwrap();
        let before=contents(&c); assert!(schema::run_migrations(&c).is_err()); assert_eq!(version(&c),58); assert_eq!(before,contents(&c));
        let unversioned=Connection::open_in_memory().unwrap();
        unversioned.execute_batch("CREATE TABLE existing(id TEXT PRIMARY KEY);").unwrap();
        assert!(schema::run_migrations(&unversioned).is_err()); assert_eq!(version(&unversioned),0);
    }
}
