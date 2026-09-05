use super::experiment_manuscript_switch_recovery::{
    ensure_recovery_schema_in_connection, migrate_legacy_experiment_switch_recoveries_in_connection,
    post_verify_experiment_switch_recovery_in_connection,
    prepare_experiment_switch_recovery_in_connection,
    safe_cancel_experiment_switch_recovery_in_connection,
    update_experiment_switch_recovery_phase_in_connection,
    ExperimentSwitchRecoveryPhaseInput, ExperimentSwitchRecoveryPrepareInput,
};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::process::Command;

fn schema(connection: &Connection) {
    connection.execute_batch(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);
         CREATE TABLE experiments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,
           rating TEXT,tags TEXT,purpose_and_question TEXT,condition_summary TEXT,
           method_summary TEXT,result_summary TEXT NOT NULL,conclusion_and_next_steps TEXT,other TEXT,updated_at TEXT NOT NULL,deleted_at TEXT);
         CREATE TABLE manuscript_bindings(id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,
           manuscript_channel TEXT NOT NULL,current_file_ref_id TEXT,default_manuscript_file_ref_id TEXT,updated_at TEXT NOT NULL,deleted_at TEXT);
         CREATE TABLE file_refs(id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,manuscript_channel TEXT NOT NULL,
           resource_kind TEXT NOT NULL,file_role TEXT NOT NULL,location_mode TEXT NOT NULL,path TEXT NOT NULL,
           path_identity_key TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
         CREATE TABLE operation_logs(id TEXT PRIMARY KEY,operation_type TEXT NOT NULL,source TEXT NOT NULL,module TEXT NOT NULL,status TEXT NOT NULL,
           risk_level TEXT NOT NULL,target TEXT NOT NULL,summary TEXT NOT NULL,related_entities TEXT NOT NULL DEFAULT '[]',impact_summary TEXT,
           confirmation TEXT NOT NULL DEFAULT '{}',feedback TEXT NOT NULL DEFAULT '{}',warnings TEXT NOT NULL DEFAULT '[]',errors TEXT NOT NULL DEFAULT '[]',
           skipped TEXT NOT NULL DEFAULT '[]',is_recoverable INTEGER NOT NULL DEFAULT 0,actor_id TEXT NOT NULL,actor_label TEXT NOT NULL,
           refresh_keys TEXT NOT NULL DEFAULT '[]',schema_version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);",
    ).expect("base schema");
    ensure_recovery_schema_in_connection(connection).expect("recovery schema");
}

fn seed(connection: &Connection) {
    connection.execute_batch(
        "INSERT INTO experiments VALUES('experiment-1','project-1','实验 A','usable','[\"tag\"]','old-pq','old-c','old-m','old-r','old-k','old-o','owner-r1',NULL);
         INSERT INTO manuscript_bindings VALUES('binding-1','experiment','experiment-1','primary','old','default','binding-r1',NULL);"
    ).expect("owners");
    for (id, mode) in [("old","managed"),("default","managed"),("target","external")] {
        connection.execute("INSERT INTO file_refs VALUES(?1,'experiment','experiment-1','primary','file','manuscript',?2,?3,?3,?4,NULL)",
            params![id,mode,format!("{id}-identity"),format!("{id}-r1")]).expect("file ref");
    }
}

fn prepared(operation_id: &str) -> ExperimentSwitchRecoveryPrepareInput {
    ExperimentSwitchRecoveryPrepareInput {
        operation_id:operation_id.into(),experiment_id:"experiment-1".into(),project_id:"project-1".into(),binding_id:"binding-1".into(),
        expected_owner_updated_at:"owner-r1".into(),expected_binding_updated_at:"binding-r1".into(),old_current_file_ref_id:"old".into(),
        old_current_file_ref_updated_at:"old-r1".into(),old_current_path_identity:"old-identity".into(),old_current_location_mode:"managed".into(),
        default_file_ref_id:"default".into(),default_file_ref_updated_at:"default-r1".into(),default_path_identity:"default-identity".into(),default_location_mode:"managed".into(),
        target_file_ref_id:"target".into(),target_file_ref_updated_at:"target-r1".into(),target_path_identity:"target-identity".into(),target_location_mode:"external".into(),
        before_purpose_and_question:Some("old-pq".into()),before_condition_summary:Some("old-c".into()),
        before_method_summary:Some("old-m".into()),before_result_summary:Some("old-r".into()),before_conclusion_and_next_steps:Some("old-k".into()),before_other:Some("old-o".into()),
        outline_replacements_json:r#"[{"key":"purposeAndQuestion","action":"set","value":"p"},{"key":"conditionSummary","action":"clear"},{"key":"methodSummary","action":"clear"},{"key":"resultSummary","action":"set","value":"r"},{"key":"conclusionAndNextSteps","action":"clear"},{"key":"other","action":"clear"}]"#.into(),
        experiment_title_snapshot:"实验 A".into(),project_title_snapshot:"项目 A".into(),rating_snapshot:Some("usable".into()),tags_json:r#"["tag"]"#.into(),
        deterministic_writeback_version:1,recorded_at:"2026-07-21T01:00:00Z".into(),writeback_digest:"writeback".into(),writeback_byte_length:10,
        old_current_pre_revision:"physical-old-r1".into(),old_current_pre_digest:"old-digest".into(),old_current_expected_post_digest:"post-digest".into(),
        target_physical_revision:"physical-target-r1".into(),target_digest:"target-digest".into(),target_byte_length:20,
        old_current_file_name:"旧稿.md".into(),target_file_name:"目标稿.md".into(),default_file_name:"默认稿.md".into(),
        correlation_id:"correlation-1".into(),created_at:"2026-07-21T01:00:00Z".into(),
    }
}

#[test]
fn operation_id_is_primary_and_unresolved_is_unique_per_experiment_channel() {
    let connection=Connection::open_in_memory().expect("db"); schema(&connection); seed(&connection);
    let first=prepare_experiment_switch_recovery_in_connection(&connection,&prepared("op-1")).expect("first");
    assert_eq!(first.operation_id,"op-1"); assert_eq!(first.phase,"prepared");
    assert!(prepare_experiment_switch_recovery_in_connection(&connection,&prepared("op-2")).unwrap_err().contains("ALREADY_ACTIVE"));
    let table_sql:String=connection.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='experiment_manuscript_switch_recoveries'",[],|r|r.get(0)).expect("sql");
    assert!(table_sql.contains("operation_id TEXT PRIMARY KEY")); assert!(!table_sql.to_ascii_lowercase().contains("append"));
}

#[test]
fn canonical_transitions_reject_skips_and_safe_cancel_requires_pre_evidence() {
    let connection=Connection::open_in_memory().expect("db"); schema(&connection); seed(&connection);
    prepare_experiment_switch_recovery_in_connection(&connection,&prepared("op-state")).expect("prepared");
    let invalid=update_experiment_switch_recovery_phase_in_connection(&connection,&ExperimentSwitchRecoveryPhaseInput {
        operation_id:"op-state".into(),expected_phase:"prepared".into(),next_phase:"db_committed".into(),occurred_at:"now".into(),
        old_current_post_revision:None,writeback_verification_result:None,last_error_code:None,last_diagnostic_summary:None,
    }).unwrap_err();
    assert!(invalid.contains("TRANSITION_INVALID"));
    let canceled=safe_cancel_experiment_switch_recovery_in_connection(&connection,"op-state","physical-old-r1","now").expect("safe cancel");
    assert_eq!(canceled.phase,"cancelled_safe");
}

#[test]
fn prepared_id_mismatch_legacy_row_is_evidence_classified_cancelled_safe_and_audited() {
    let connection=Connection::open_in_memory().expect("db"); schema(&connection); seed(&connection);
    let old_path=std::env::temp_dir().join(format!("labpod-legacy-experiment-old-{}-{}.md",std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let old_text="# unchanged legacy manuscript\n";
    std::fs::write(&old_path,old_text).expect("old physical file");
    connection.execute("UPDATE file_refs SET path=?1,path_identity_key=?1 WHERE id='old'",[old_path.to_string_lossy().to_string()]).expect("physical identity");
    let old_digest={let mut hash=0xcbf29ce484222325u64;for byte in old_text.as_bytes(){hash^=u64::from(*byte);hash=hash.wrapping_mul(0x100000001b3);}format!("fnv1a64:{hash:016x}")};
    let payload=serde_json::json!({"details":{"manuscriptSwitchRecovery":{
        "operationId":"payload-operation","experimentId":"experiment-1","projectId":"project-1","bindingId":"binding-1","phase":"prepared",
        "oldCurrentFileRefId":"old","targetFileRefId":"target","defaultFileRefId":"default","correlationId":"corr",
        "oldCurrentPreHash":old_digest,"oldCurrentPreRevision":old_digest
    }}}).to_string();
    connection.execute("INSERT INTO operation_logs(id,operation_type,source,module,status,risk_level,target,summary,related_entities,confirmation,feedback,warnings,errors,skipped,is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at)
      VALUES('different-log-id','custom','user','experiment','partial','medium','{}','legacy','[]','{}',?1,'[]','[]','[]',1,'local','Local','[]',1,'2026-07-21','2026-07-21')",[payload]).expect("legacy");
    migrate_legacy_experiment_switch_recoveries_in_connection(&connection).expect("migrate");
    let phase:String=connection.query_row("SELECT phase FROM experiment_manuscript_switch_recoveries WHERE operation_id='payload-operation'",[],|r|r.get(0)).expect("phase");
    assert_eq!(phase,"cancelled_safe");
    let original:i64=connection.query_row("SELECT COUNT(*) FROM operation_logs WHERE id='different-log-id'",[],|r|r.get(0)).expect("original");
    let audit:i64=connection.query_row("SELECT COUNT(*) FROM operation_logs WHERE feedback LIKE '%LEGACY_EXPERIMENT_SWITCH_MIGRATED%'",[],|r|r.get(0)).expect("audit");
    assert_eq!(original,1); assert_eq!(audit,1);
    migrate_legacy_experiment_switch_recoveries_in_connection(&connection).expect("second startup no-op");
    std::fs::remove_file(old_path).expect("cleanup old physical file");
}

#[test]
fn deleted_owner_uncertain_legacy_row_is_blocked_but_never_discovered_as_active() {
    let connection=Connection::open_in_memory().expect("db"); schema(&connection); seed(&connection);
    connection.execute("UPDATE experiments SET deleted_at='2026-07-21T02:00:00Z' WHERE id='experiment-1'",[]).expect("soft delete");
    let payload=serde_json::json!({"details":{"manuscriptSwitchRecovery":{
        "operationId":"deleted-uncertain","experimentId":"experiment-1","projectId":"project-1","bindingId":"binding-1","phase":"recovery-required",
        "oldCurrentFileRefId":"old","targetFileRefId":"target","defaultFileRefId":"default","correlationId":"corr",
        "oldCurrentPreHash":"fnv1a64:pre","oldCurrentExpectedPostHash":"fnv1a64:post","oldCurrentPostRevision":"fnv1a64:unknown",
        "occurredAt":"2026-07-21T01:30:00Z"
    }}}).to_string();
    connection.execute("INSERT INTO operation_logs(id,operation_type,source,module,status,risk_level,target,summary,related_entities,confirmation,feedback,warnings,errors,skipped,is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at)
      VALUES('deleted-log','custom','user','experiment','partial','medium','{}','legacy','[]','{}',?1,'[]','[]','[]',1,'local','Local','[]',1,'2026-07-21','2026-07-21')",[payload]).expect("legacy");
    migrate_legacy_experiment_switch_recoveries_in_connection(&connection).expect("migrate");
    let phase:String=connection.query_row("SELECT phase FROM experiment_manuscript_switch_recoveries WHERE operation_id='deleted-uncertain'",[],|r|r.get(0)).expect("phase");
    let active_visible:i64=connection.query_row("SELECT COUNT(*) FROM experiment_manuscript_switch_recoveries r JOIN experiments e ON e.id=r.experiment_id WHERE e.deleted_at IS NULL AND r.phase NOT IN ('resolved','cancelled_safe')",[],|r|r.get(0)).expect("active visibility");
    assert_eq!(phase,"blocked");
    assert_eq!(active_visible,0);
}

#[test]
fn unresolved_recovery_survives_real_process_restart() {
    const STAGE:&str="LABPOD_EXPERIMENT_RECOVERY_STAGE"; const PATH:&str="LABPOD_EXPERIMENT_RECOVERY_PATH";
    if let Ok(stage)=std::env::var(STAGE) {
        let path=PathBuf::from(std::env::var(PATH).expect("path")); let connection=Connection::open(path).expect("child db");
        if stage=="prepare" { schema(&connection);seed(&connection);prepare_experiment_switch_recovery_in_connection(&connection,&prepared("op-restart")).expect("persist"); }
        else { let verify=post_verify_experiment_switch_recovery_in_connection(&connection,"op-restart").expect("rediscover");assert_eq!(verify.status,"not_committed"); }
        return;
    }
    let path=std::env::temp_dir().join(format!("labpod-experiment-recovery-{}-{}.sqlite",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let binary=std::env::current_exe().expect("binary"); let test="db::experiment_manuscript_switch_recovery_tests::unresolved_recovery_survives_real_process_restart";
    for stage in ["prepare","rediscover"] { assert!(Command::new(&binary).args(["--exact",test,"--nocapture"]).env(STAGE,stage).env(PATH,&path).status().expect("child").success()); }
    std::fs::remove_file(path).expect("cleanup");
}
