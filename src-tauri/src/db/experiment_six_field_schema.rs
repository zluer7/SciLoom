use rusqlite::{Connection, OptionalExtension, Result};

const TEMP_TABLE: &str = "experiments_lp12_4_a1_six_field";

pub(super) const SIX_FIELD_EXPERIMENT_TABLE_SQL: &str = r#"
CREATE TABLE experiments_lp12_4_a1_six_field (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  route_id TEXT,
  task_id TEXT,
  title TEXT,
  purpose_and_question TEXT,
  condition_summary TEXT,
  method_summary TEXT,
  conclusion_and_next_steps TEXT,
  other TEXT,
  status TEXT,
  rating TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  usable_for_paper INTEGER NOT NULL DEFAULT 0,
  usable_for_report INTEGER NOT NULL DEFAULT 0,
  usable_for_patent INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  condition_items TEXT NOT NULL DEFAULT '[]',
  method_steps TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]',
  materials TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '[]',
  legacy TEXT,
  migrated_from_legacy INTEGER,
  experiment_name TEXT NOT NULL,
  machine_object TEXT NOT NULL,
  fault_type TEXT NOT NULL,
  speed REAL,
  load REAL,
  sensor_config TEXT NOT NULL,
  data_path TEXT NOT NULL,
  sampling_rate REAL,
  duration REAL,
  result_summary TEXT NOT NULL,
  problem_notes TEXT,
  next_action TEXT,
  created_local_date TEXT NOT NULL CHECK (
    length(created_local_date) = 10
    AND created_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(created_local_date) = created_local_date
  ),
  created_local_time TEXT NOT NULL CHECK (
    length(created_local_time) = 4
    AND created_local_time GLOB '[0-9][0-9][0-9][0-9]'
    AND CAST(substr(created_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_local_time, 3, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  workspace_title_identity TEXT NOT NULL CHECK (length(trim(workspace_title_identity)) > 0),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
"#;

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for candidate in columns {
        if candidate? == column { return Ok(true); }
    }
    Ok(false)
}

fn fold_expression() -> &'static str {
    r#"CASE
      WHEN length(trim(COALESCE(purpose,''), char(9)||char(10)||char(13)||' ')) = 0
       AND length(trim(COALESCE(research_question,''), char(9)||char(10)||char(13)||' ')) = 0
       AND length(trim(COALESCE(hypothesis,''), char(9)||char(10)||char(13)||' ')) = 0 THEN NULL
      ELSE
        CASE WHEN length(trim(COALESCE(purpose,''), char(9)||char(10)||char(13)||' ')) > 0 THEN '实验目的：' || char(10) || purpose ELSE '' END ||
        CASE WHEN length(trim(COALESCE(research_question,''), char(9)||char(10)||char(13)||' ')) > 0 THEN
          CASE WHEN length(trim(COALESCE(purpose,''), char(9)||char(10)||char(13)||' ')) > 0 THEN char(10) || char(10) ELSE '' END ||
          '研究问题：' || char(10) || research_question ELSE '' END ||
        CASE WHEN length(trim(COALESCE(hypothesis,''), char(9)||char(10)||char(13)||' ')) > 0 THEN
          CASE WHEN length(trim(COALESCE(purpose,''), char(9)||char(10)||char(13)||' ')) > 0 OR length(trim(COALESCE(research_question,''), char(9)||char(10)||char(13)||' ')) > 0
            THEN char(10) || char(10) ELSE '' END ||
          '研究假设：' || char(10) || hypothesis ELSE '' END
    END"#
}

fn migrate_inner(connection: &Connection) -> Result<()> {
    if has_column(connection, "experiments", "purpose_and_question")? {
        return Ok(());
    }
    if !has_column(connection, "experiments", "purpose")? {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let dependent_sql: Vec<String> = {
        let mut statement = connection.prepare(
            "SELECT sql FROM sqlite_master WHERE tbl_name='experiments' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name"
        )?;
        let rows = statement.query_map([], |row| row.get(0))?.collect::<Result<Vec<_>>>()?;
        rows
    };

    connection.execute_batch("PRAGMA defer_foreign_keys=ON; PRAGMA legacy_alter_table=ON;")?;
    connection.execute_batch(&format!("DROP TABLE IF EXISTS {TEMP_TABLE};{SIX_FIELD_EXPERIMENT_TABLE_SQL}"))?;
    connection.execute_batch(&format!(r#"
      INSERT INTO {TEMP_TABLE} (
        id,project_id,route_id,task_id,title,purpose_and_question,condition_summary,method_summary,
        conclusion_and_next_steps,other,status,rating,tags,usable_for_paper,usable_for_report,
        usable_for_patent,schema_version,source,condition_items,method_steps,variables,materials,
        custom_fields,legacy,migrated_from_legacy,experiment_name,machine_object,fault_type,speed,
        load,sensor_config,data_path,sampling_rate,duration,result_summary,problem_notes,next_action,
        created_local_date,created_local_time,created_at,updated_at,deleted_at,workspace_title_identity
      ) SELECT
        id,project_id,route_id,task_id,title,{fold},condition_summary,method_summary,
        conclusion,summary_other,status,rating,tags,usable_for_paper,usable_for_report,
        usable_for_patent,schema_version,source,condition_items,method_steps,variables,materials,
        custom_fields,legacy,migrated_from_legacy,experiment_name,machine_object,fault_type,speed,
        load,sensor_config,data_path,sampling_rate,duration,result_summary,problem_notes,next_action,
        created_local_date,created_local_time,created_at,updated_at,deleted_at,workspace_title_identity
      FROM experiments;
      DROP TABLE experiments;
      ALTER TABLE {TEMP_TABLE} RENAME TO experiments;
    "#, fold = fold_expression()))?;
    for sql in dependent_sql { connection.execute_batch(&sql)?; }
    if has_column(connection, "experiment_manuscript_switch_recoveries", "before_purpose")? {
        let replacements = r#"[{"key":"purposeAndQuestion","action":"clear"},{"key":"conditionSummary","action":"clear"},{"key":"methodSummary","action":"clear"},{"key":"resultSummary","action":"clear"},{"key":"conclusionAndNextSteps","action":"clear"},{"key":"other","action":"clear"}]"#;
        connection.execute_batch(&format!(r#"
          ALTER TABLE experiment_manuscript_switch_recoveries ADD COLUMN before_purpose_and_question TEXT;
          UPDATE experiment_manuscript_switch_recoveries
          SET before_purpose_and_question = {fold};
          ALTER TABLE experiment_manuscript_switch_recoveries DROP COLUMN before_purpose;
          ALTER TABLE experiment_manuscript_switch_recoveries DROP COLUMN before_research_question;
          ALTER TABLE experiment_manuscript_switch_recoveries DROP COLUMN before_hypothesis;
          ALTER TABLE experiment_manuscript_switch_recoveries
            RENAME COLUMN before_conclusion TO before_conclusion_and_next_steps;
          ALTER TABLE experiment_manuscript_switch_recoveries
            RENAME COLUMN before_summary_other TO before_other;
          UPDATE experiment_manuscript_switch_recoveries
          SET outline_replacements_json='{replacements}',
              phase=CASE WHEN phase IN ('resolved','cancelled_safe') THEN phase ELSE 'blocked' END,
              last_error_code=CASE WHEN phase IN ('resolved','cancelled_safe') THEN last_error_code ELSE 'EXPERIMENT_SIX_FIELD_RECOVERY_REVIEW_REQUIRED' END,
              last_diagnostic_summary=CASE WHEN phase IN ('resolved','cancelled_safe') THEN last_diagnostic_summary ELSE 'Blocked during v52 six-field schema migration; no physical manuscript was read or rewritten.' END;
        "#, fold = fold_expression().replace("purpose", "before_purpose").replace("research_question", "before_research_question").replace("hypothesis", "before_hypothesis"), replacements = replacements))?;
    }
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,name) VALUES (52,'experiment_six_field_schema_foundation')",
        [],
    )?;
    connection.execute_batch("PRAGMA legacy_alter_table=OFF;")?;
    Ok(())
}

pub(crate) fn apply_schema_migration(connection: &Connection) -> Result<()> {
    connection.execute_batch("SAVEPOINT lp12_4_a1_experiment_six_field;")?;
    match migrate_inner(connection) {
        Ok(()) => connection.execute_batch("RELEASE lp12_4_a1_experiment_six_field;"),
        Err(error) => {
            let _ = connection.execute_batch(
                "ROLLBACK TO lp12_4_a1_experiment_six_field; RELEASE lp12_4_a1_experiment_six_field;"
            );
            let _ = connection.execute_batch("PRAGMA legacy_alter_table=OFF;");
            Err(error)
        }
    }
}

pub(crate) fn validate_current_schema(connection: &Connection) -> Result<()> {
    for required in ["purpose_and_question", "condition_summary", "method_summary", "result_summary", "conclusion_and_next_steps", "other"] {
        if !has_column(connection, "experiments", required)? { return Err(rusqlite::Error::InvalidQuery); }
    }
    for forbidden in ["purpose", "research_question", "hypothesis", "conclusion", "summary_other"] {
        if has_column(connection, "experiments", forbidden)? { return Err(rusqlite::Error::InvalidQuery); }
    }
    let residue: Option<String> = connection.query_row(
        "SELECT name FROM sqlite_master WHERE name=?1", [TEMP_TABLE], |row| row.get(0)
    ).optional()?;
    if residue.is_some() { return Err(rusqlite::Error::InvalidQuery); }
    if has_column(connection, "experiment_manuscript_switch_recoveries", "before_purpose")?
        || !has_column(connection, "experiment_manuscript_switch_recoveries", "before_purpose_and_question")? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn downgrade_experiments_to_v51(connection: &Connection, strict_dates: bool) {
        super::super::formal_switch_foundation::remove_v53_foundation_for_legacy_fixture(connection)
            .expect("remove v53 foundation from isolated v51 fixture");
        connection.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE experiments;").expect("drop v52 experiments");
        let date_checks = if strict_dates {
            "CHECK (length(created_local_date)=10 AND date(created_local_date)=created_local_date)"
        } else { "" };
        connection.execute_batch(&format!(r#"
          CREATE TABLE experiments (
            id TEXT PRIMARY KEY,project_id TEXT NOT NULL,route_id TEXT,task_id TEXT,title TEXT,
            purpose TEXT,hypothesis TEXT,research_question TEXT,condition_summary TEXT,method_summary TEXT,
            conclusion TEXT,summary_other TEXT,status TEXT,rating TEXT,tags TEXT NOT NULL DEFAULT '[]',
            usable_for_paper INTEGER NOT NULL DEFAULT 0,usable_for_report INTEGER NOT NULL DEFAULT 0,
            usable_for_patent INTEGER NOT NULL DEFAULT 0,schema_version INTEGER NOT NULL DEFAULT 2,
            source TEXT NOT NULL DEFAULT 'user',condition_items TEXT NOT NULL DEFAULT '[]',
            method_steps TEXT NOT NULL DEFAULT '[]',variables TEXT NOT NULL DEFAULT '[]',materials TEXT NOT NULL DEFAULT '[]',
            custom_fields TEXT NOT NULL DEFAULT '[]',legacy TEXT,migrated_from_legacy INTEGER,
            experiment_name TEXT NOT NULL,machine_object TEXT NOT NULL,fault_type TEXT NOT NULL,speed REAL,load REAL,
            sensor_config TEXT NOT NULL,data_path TEXT NOT NULL,sampling_rate REAL,duration REAL,
            result_summary TEXT NOT NULL,problem_notes TEXT,next_action TEXT,
            created_local_date TEXT NOT NULL {date_checks},created_local_time TEXT NOT NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,
            workspace_title_identity TEXT NOT NULL CHECK(length(trim(workspace_title_identity))>0),
            FOREIGN KEY(task_id) REFERENCES tasks(id)
          );
          CREATE INDEX idx_experiments_project_id ON experiments(project_id);
          CREATE INDEX idx_experiments_task_id ON experiments(task_id);
          CREATE INDEX idx_experiments_deleted_at ON experiments(deleted_at);
          PRAGMA user_version=51;
          PRAGMA foreign_keys=ON;
        "#)).expect("v51 experiments");
    }

    fn insert_v51_fixture(connection: &Connection, id: &str, purpose: Option<&str>, question: Option<&str>, hypothesis: Option<&str>, date: &str) {
        connection.execute(
            "INSERT INTO experiments(
              id,project_id,title,purpose,research_question,hypothesis,condition_summary,method_summary,
              conclusion,summary_other,status,tags,experiment_name,machine_object,fault_type,sensor_config,
              data_path,result_summary,created_local_date,created_local_time,created_at,updated_at,workspace_title_identity,
              problem_notes,next_action,legacy,speed,load,sampling_rate,duration
             ) VALUES(?1,'project-a','Unicode Ω',?2,?3,?4,'条件\n二行','方法','结论','其他','planned','[\"Ω\"]',
               '实验 Ω','machine','unknown','sensor','N:/ref-only','结果',?5,'0930','2026-08-08T01:00:00Z',
               '2026-08-08T02:00:00Z',?1,'problem','next','{\"keep\":true}',1.5,2.5,1000,3.5)",
            rusqlite::params![id,purpose,question,hypothesis,date],
        ).expect("fixture row");
    }

    #[test]
    fn v51_to_v52_folds_all_partial_blank_rows_preserves_relations_and_reopens() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let path = std::env::temp_dir().join(format!("labpod-lp12-4-a1-{stamp}.sqlite3"));
        {
            let connection = Connection::open(&path).expect("open fixture");
            super::super::schema::run_migrations(&connection).expect("fresh v53");
            downgrade_experiments_to_v51(&connection, true);
            insert_v51_fixture(&connection,"all",Some("目的 Ω\n原文"),Some("问题"),Some("假设"),"2026-08-08");
            insert_v51_fixture(&connection,"partial",None,Some("仅问题"),None,"2026-08-08");
            insert_v51_fixture(&connection,"blank",Some("  "),Some("\n"),None,"2026-08-08");
            connection.execute(
                "INSERT INTO experiment_runs(id,experiment_id,project_id,title,status,tags,schema_version,source,
                 condition_items,method_steps,variables,materials,custom_fields,created_local_date,created_local_time,
                 workspace_title_identity,created_at,updated_at)
                 VALUES('run-all','all','project-a','Run','planned','[]',2,'user','[]','[]','[]','[]','[]',
                 '2026-08-08','0940','run-all','2026-08-08T01:00:00Z','2026-08-08T01:00:00Z')",[]
            ).expect("related run");
            super::super::schema::run_migrations(&connection).expect("v51 to v52");
            let all:String=connection.query_row("SELECT purpose_and_question FROM experiments WHERE id='all'",[],|r|r.get(0)).expect("all fold");
            assert_eq!(all,"实验目的：\n目的 Ω\n原文\n\n研究问题：\n问题\n\n研究假设：\n假设");
            let partial:String=connection.query_row("SELECT purpose_and_question FROM experiments WHERE id='partial'",[],|r|r.get(0)).expect("partial fold");
            assert_eq!(partial,"研究问题：\n仅问题");
            let blank:Option<String>=connection.query_row("SELECT purpose_and_question FROM experiments WHERE id='blank'",[],|r|r.get(0)).expect("blank fold");
            assert_eq!(blank,None);
            let preserved:(String,String,String,f64)=connection.query_row(
                "SELECT problem_notes,next_action,legacy,speed FROM experiments WHERE id='all'",[],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
            ).expect("non-target data");
            assert_eq!(preserved,("problem".into(),"next".into(),"{\"keep\":true}".into(),1.5));
            let run_owner:String=connection.query_row("SELECT experiment_id FROM experiment_runs WHERE id='run-all'",[],|r|r.get(0)).expect("run relation");
            assert_eq!(run_owner,"all");
            assert_eq!(connection.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),super::super::schema::CURRENT_SCHEMA_VERSION);
            assert_eq!(connection.query_row("PRAGMA foreign_key_check",[],|_|Ok(1)).optional().unwrap(),None);
        }
        {
            let reopened=Connection::open(&path).expect("reopen");
            super::super::schema::run_migrations(&reopened).expect("reopen current");
            validate_current_schema(&reopened).expect("current six fields");
        }
        fs::remove_file(&path).expect("remove fixture");
    }

    #[test]
    fn failed_v52_copy_rolls_back_and_does_not_advance_or_leave_temp_table() {
        let connection=Connection::open_in_memory().expect("open");
        super::super::schema::run_migrations(&connection).expect("fresh v53");
        downgrade_experiments_to_v51(&connection,false);
        insert_v51_fixture(&connection,"bad",Some("purpose"),None,None,"invalid-date");
        let error=super::super::schema::run_migrations(&connection).expect_err("invalid row must fail");
        assert_eq!(error.version,52);
        assert_eq!(connection.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),51);
        assert!(has_column(&connection,"experiments","purpose").unwrap());
        assert!(!has_column(&connection,"experiments","purpose_and_question").unwrap());
        let residue:Option<String>=connection.query_row("SELECT name FROM sqlite_master WHERE name=?1",[TEMP_TABLE],|r|r.get(0)).optional().unwrap();
        assert_eq!(residue,None);
    }
}
