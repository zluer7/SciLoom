//! SC3 bounded Planning authority. Each row is the complete canonical fact,
//! not an identity mirror of localStorage. The envelope is reconstructed from
//! these twelve tables; completion is historical provenance, not current CAS.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, State, WebviewWindow};
use crate::planning_authority_transport::PlanningAuthorityTransportFoundation;

pub(crate) const VERSION: i64 = 60;
pub(crate) const COLLECTIONS: [(&str, &str); 12] = [
    ("researchDirections", "planning_directions"), ("projects", "planning_projects"),
    ("routeNodes", "planning_routes"), ("routeCheckpoints", "planning_route_checkpoints"),
    ("taskCheckpoints", "planning_task_checkpoints"), ("researchRoutines", "planning_routines"),
    ("routineCheckIns", "planning_check_ins"), ("tasks", "planning_tasks"),
    ("reviews", "planning_reviews"), ("experimentSummaries", "planning_experiment_summaries"),
    ("entityLinks", "planning_entity_links"), ("changeLogs", "planning_change_logs")
];
const SECOND_LAYER: [&str; 6] = ["reviewType", "outlineSections", "structuredRevision", "descriptorIdentity", "structuredLifecycleEvidence", "structuredLifecycleStatus"];
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { format!("PLANNING_SQLITE: {e}") }
fn hash(v: &str) -> String { format!("{:x}", Sha256::digest(v.as_bytes())) }
fn decimal(v: &Value) -> Result<u128> {
    let s = v.as_str().ok_or("PLANNING_REVISION_INVALID")?;
    let n: u128 = s.parse().map_err(|_| "PLANNING_REVISION_INVALID")?;
    if n.to_string() != s { return Err("PLANNING_REVISION_INVALID".into()); }
    Ok(n)
}

pub(crate) fn install_schema(c: &Connection) -> rusqlite::Result<()> {
    for (_, table) in COLLECTIONS {
        c.execute_batch(&format!("CREATE TABLE {table}(id TEXT PRIMARY KEY NOT NULL, ordinal INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_extract(record_json,'$.id')=id));"))?;
    }
    c.execute_batch("CREATE TABLE planning_repository(id INTEGER PRIMARY KEY CHECK(id=1), envelope_metadata TEXT NOT NULL CHECK(json_valid(envelope_metadata)));
        CREATE TABLE planning_import_completion(id INTEGER PRIMARY KEY CHECK(id=1), record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        INSERT INTO schema_migrations(version,name) VALUES(60,'planning_sqlite_canonical_authority');")
}

pub(crate) fn validate_schema(c: &Connection) -> rusqlite::Result<()> {
    let version=c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0))?;
    if version != VERSION && version != super::ai_conversation_management::VERSION {return Err(rusqlite::Error::InvalidQuery)}
    let marker:i64=c.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version=60 AND name='planning_sqlite_canonical_authority'",[],|r|r.get(0))?;
    if marker!=1 {return Err(rusqlite::Error::InvalidQuery)}
    for (_, table) in COLLECTIONS { c.prepare(&format!("SELECT id,ordinal,record_json FROM {table} LIMIT 0"))?; }
    c.prepare("SELECT envelope_metadata FROM planning_repository LIMIT 0")?;
    c.prepare("SELECT record_json FROM planning_import_completion LIMIT 0")?;
    let imported: bool = c.prepare("SELECT 1 FROM planning_import_completion")?.exists([])?;
    for (table, column) in [("outputs","task_id"),("output_gaps","related_task_id")] {
        let target: String = c.query_row(&format!("SELECT [table] FROM pragma_foreign_key_list('{table}') WHERE [from]=?"), [column], |r|r.get(0))?;
        if target != if imported { "planning_tasks" } else { "tasks" } { return Err(rusqlite::Error::InvalidQuery); }
    }
    Ok(())
}

pub(crate) fn transaction<T>(c: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    // A successful production operation is evidence that its own connection,
    // not a separate diagnostic reader, had FK enforcement enabled.
    if c.query_row("PRAGMA foreign_keys",[],|r|r.get::<_,i64>(0)).map_err(err)? != 1 {
        return Err("PLANNING_FK_REQUIRED".into());
    }
    c.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
    let result = f().and_then(|v| { c.execute_batch("COMMIT").map_err(err)?; Ok(v) });
    if result.is_err() { let _ = c.execute_batch("ROLLBACK"); }
    result
}

fn validate_envelope(e: &Value) -> Result<()> {
    if e["envelopeVersion"] != 1 || uuid::Uuid::parse_str(e["repositoryEpoch"].as_str().unwrap_or("")).ok().and_then(|v|v.get_version()) != Some(uuid::Version::Random) { return Err("PLANNING_ENVELOPE_INVALID".into()); }
    decimal(&e["revision"])?;
    let s=&e["snapshot"];
    if s["app"]!="LabPod" || s["schemaVersion"]!=1 || !s["exportedAt"].is_string() { return Err("PLANNING_SOURCE_VERSION_UNSUPPORTED".into()); }
    for (key,_) in COLLECTIONS {
        let rows=s[key].as_array().ok_or_else(||format!("PLANNING_COLLECTION_INVALID:{key}"))?;
        let mut ids=HashSet::new();
        for row in rows {
            let id=row["id"].as_str().filter(|v|!v.is_empty()).ok_or("PLANNING_ID_INVALID")?;
            if !ids.insert(id) { return Err(format!("PLANNING_DUPLICATE_ID:{key}:{id}")); }
            if key=="reviews" && SECOND_LAYER.iter().any(|k|row.get(*k).is_some()) { return Err("PLANNING_REVIEW_SECOND_LAYER_NOT_OWNED".into()); }
        }
    }
    let exists=|key:&str,id:&str|s[key].as_array().unwrap().iter().any(|v|v["id"]==id);
    for (key, field, owner) in [("projects","directionId","researchDirections"),("routeNodes","projectId","projects"),("routeNodes","parentNodeId","routeNodes"),("tasks","projectId","projects"),("tasks","routeNodeId","routeNodes"),("reviews","projectId","projects"),("routeCheckpoints","routeNodeId","routeNodes"),("taskCheckpoints","taskId","tasks"),("researchRoutines","projectId","projects"),("routineCheckIns","routineId","researchRoutines"),("routineCheckIns","projectId","projects")] {
        for row in s[key].as_array().unwrap() {
            if let Some(id)=row[field].as_str() { if !exists(owner,id) {return Err(format!("PLANNING_ORPHAN:{key}:{}:{field}",row["id"]));} }
        }
    }
    Ok(())
}

fn write_envelope(c: &Connection, e: &Value) -> Result<()> {
    validate_envelope(e)?;
    for (key,table) in COLLECTIONS {
        let rows=e["snapshot"][key].as_array().unwrap();
        for (ordinal,row) in rows.iter().enumerate() {
            c.execute(&format!("INSERT INTO {table}(id,ordinal,record_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,record_json=excluded.record_json"), params![row["id"].as_str().unwrap(),ordinal as i64,row.to_string()]).map_err(err)?;
        }
        let ids: Vec<&str>=rows.iter().map(|v|v["id"].as_str().unwrap()).collect();
        c.execute(&format!("DELETE FROM {table} WHERE id NOT IN (SELECT value FROM json_each(?))"), [json!(ids).to_string()]).map_err(err)?;
    }
    let mut metadata=e.clone();
    for (key,_) in COLLECTIONS { metadata["snapshot"].as_object_mut().unwrap().remove(key); }
    c.execute("INSERT INTO planning_repository(id,envelope_metadata) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET envelope_metadata=excluded.envelope_metadata",[metadata.to_string()]).map_err(err)?;
    Ok(())
}

fn envelope(c: &Connection) -> Result<Option<Value>> {
    let raw: Option<String>=c.query_row("SELECT envelope_metadata FROM planning_repository WHERE id=1",[],|r|r.get(0)).optional().map_err(err)?;
    let Some(raw)=raw else {return Ok(None)};
    let mut e:Value=serde_json::from_str(&raw).map_err(err)?;
    for (key,table) in COLLECTIONS {
        let mut stmt=c.prepare(&format!("SELECT record_json FROM {table} ORDER BY ordinal")).map_err(err)?;
        let rows:Vec<String>=stmt.query_map([],|r|r.get(0)).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
        e["snapshot"][key]=Value::Array(rows.iter().map(|r|serde_json::from_str(r).map_err(err)).collect::<Result<_>>()?);
    }
    validate_envelope(&e)?;
    Ok(Some(e))
}

pub(crate) fn read(c: &Connection, pairing: &Value) -> Result<Option<Value>> {
    let receipt:Option<String>=c.query_row("SELECT record_json FROM planning_import_completion WHERE id=1",[],|r|r.get(0)).optional().map_err(err)?;
    let e=envelope(c)?;
    match (receipt,e) {
        (None,None)=>{
            for (_,table) in COLLECTIONS {if c.prepare(&format!("SELECT 1 FROM {table} LIMIT 1")).map_err(err)?.exists([]).map_err(err)? {return Err("PLANNING_PARTIAL_TARGET_WITHOUT_COMPLETION".into())}}
            Ok(None)
        },
        (Some(raw),Some(e))=>{
            let r:Value=serde_json::from_str(&raw).map_err(err)?;
            if r["protocol"]!=1 || r["pairing"]!=*pairing || r["sourceEpoch"]!=e["repositoryEpoch"] || decimal(&r["sourceRevision"])? > decimal(&e["revision"])? || r["importedDigest"].as_str().is_none_or(|s|s.len()!=64) { return Err("PLANNING_COMPLETION_IDENTITY_CONFLICT".into()); }
            validate_schema(c).map_err(err)?;
            Ok(Some(e))
        },
        _=>Err("PLANNING_COMPLETION_INCONSISTENT".into())
    }
}

fn rewire_relations(c: &Connection) -> Result<()> {
    // Keep FK enforcement ON. Temporarily evacuate the one dependent child
    // table inside this transaction so SQLite DROP does not cascade/delete it.
    c.execute_batch("CREATE TEMP TABLE sc3_gap_feedback AS SELECT * FROM output_gap_feedback_cards; DELETE FROM output_gap_feedback_cards;").map_err(err)?;
    for table in ["outputs","output_gaps"] {
        let sql:String=c.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[table],|r|r.get(0)).map_err(err)?;
        if !sql.contains("REFERENCES tasks(id)") {return Err("PLANNING_RELATION_SCHEMA_UNSUPPORTED".into())}
        let indices:Vec<String>=c.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").map_err(err)?.query_map([table],|r|r.get(0)).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
        let temp=format!("{table}_sc3");
        c.execute_batch(&sql.replacen(&format!("CREATE TABLE {table}"),&format!("CREATE TABLE {temp}"),1).replace("REFERENCES tasks(id)","REFERENCES planning_tasks(id)")).map_err(err)?;
        c.execute_batch(&format!("INSERT INTO {temp} SELECT * FROM {table}; DROP TABLE {table}; ALTER TABLE {temp} RENAME TO {table};")).map_err(err)?;
        for index in indices {c.execute_batch(&index).map_err(err)?;}
    }
    c.execute_batch("INSERT INTO output_gap_feedback_cards SELECT * FROM sc3_gap_feedback; DROP TABLE sc3_gap_feedback;").map_err(err)?;
    super::experiment_planning_relation::integrity(c).map_err(err)
}

pub(crate) fn import(c:&Connection,pairing:&Value,e:&Value,source_raw:Option<&str>) -> Result<Value> {
    transaction(c,||{
        if let Some(current)=read(c,pairing)? {return Ok(current)}
        validate_envelope(e)?;
        let fk:i64=c.query_row("PRAGMA foreign_keys",[],|r|r.get(0)).map_err(err)?;
        if fk!=1 {return Err("PLANNING_FK_REQUIRED".into())}
        if source_raw.is_none() {
            for (key,_) in COLLECTIONS {
                if key!="researchDirections" && key!="changeLogs" && !e["snapshot"][key].as_array().unwrap().is_empty() {return Err("PLANNING_FRESH_INITIALIZATION_MUST_BE_EMPTY".into())}
            }
            for table in ["tasks","milestones","experiments","outputs","output_candidates","output_gaps","review_structured_states"] {
                if c.prepare(&format!("SELECT 1 FROM {table} LIMIT 1")).map_err(err)?.exists([]).map_err(err)? {return Err("PLANNING_MISSING_SOURCE_WITH_EXISTING_FACTS".into())}
            }
        } else {
            let raw:Value=serde_json::from_str(source_raw.unwrap()).map_err(err)?;
            let mut first_layer=raw.clone();
            if let Some(reviews)=first_layer["snapshot"]["reviews"].as_array_mut() {for row in reviews {for key in SECOND_LAYER {row.as_object_mut().ok_or("PLANNING_REVIEW_INVALID")?.remove(key);}}}
            if first_layer!=*e {return Err("PLANNING_SOURCE_IMPORT_MISMATCH".into())}
        }
        for (key,table) in [("tasks","tasks"),("routeNodes","milestones")] {
            for row in e["snapshot"][key].as_array().unwrap() {
                if c.prepare(&format!("SELECT 1 FROM {table} WHERE id=?")).map_err(err)?.exists([row["id"].as_str().unwrap()]).map_err(err)? {return Err(format!("PLANNING_LEGACY_ID_COLLISION:{key}:{}",row["id"]));}
            }
        }
        write_envelope(c,e)?;
        rewire_relations(c)?;
        let receipt=json!({"protocol":1,"pairing":pairing,"sourceKey":"labpod.planning.v1","sourceKind":if source_raw.is_some(){"envelope-v1"}else{"fresh"},"sourceEpoch":e["repositoryEpoch"],"sourceRevision":e["revision"],"sourceEnvelopeVersion":1,"sourceSchemaVersion":1,"targetSchemaAtImport":VERSION,"sourceDigest":source_raw.map(hash),"importedDigest":hash(&e.to_string()),"importedAt":chrono::Utc::now().to_rfc3339()});
        c.execute("INSERT INTO planning_import_completion(id,record_json) VALUES(1,?)",[receipt.to_string()]).map_err(err)?;
        read(c,pairing)?.ok_or("PLANNING_IMPORT_READBACK_MISSING".into())
    })
}

pub(crate) fn commit(c:&Connection,pairing:&Value,request:&Value) -> Result<Value> {
    transaction(c,||{
        let current=read(c,pairing)?.ok_or("PLANNING_NOT_IMPORTED")?;
        let expected=json!({"repositoryEpoch":request["expectedEpoch"],"revision":request["expectedRevision"]});
        let identity=json!({"repositoryEpoch":current["repositoryEpoch"],"revision":current["revision"]});
        let status=if request["expectedEpoch"]!=current["repositoryEpoch"] {"epoch_mismatch"} else if request["expectedRevision"]!=current["revision"] {"revision_stale"}else{"accepted"};
        if status!="accepted" {return Ok(json!({"status":status,"expectedIdentity":expected,"currentIdentity":identity}))}
        if request["nextSnapshot"]==current["snapshot"] {return Ok(json!({"status":"unchanged","expectedIdentity":expected,"envelope":current}))}
        let revision=decimal(&current["revision"])?.checked_add(1).ok_or("PLANNING_REPOSITORY_REVISION_EXHAUSTED")?;
        let next=json!({"envelopeVersion":1,"repositoryEpoch":current["repositoryEpoch"],"revision":revision.to_string(),"snapshot":request["nextSnapshot"]});
        write_envelope(c,&next)?;
        Ok(json!({"status":"committed","expectedIdentity":expected,"envelope":read(c,pairing)?.ok_or("PLANNING_READBACK_MISSING")?}))
    })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct WriterSession {
    pub process_generation:String, pub producer_session_generation:u64,
    pub transport_generation:u64, pub producer_capability:String
}
fn pairing(app:&AppHandle,window:&WebviewWindow)->Result<Value> {
    Ok(json!({"app":app.config().identifier,"profile":crate::runtime_paths::selected(app)?.webview_profile.to_string_lossy(),"origin":window.url().map_err(err)?.origin().ascii_serialization(),"window":window.label(),"key":"labpod.planning.v1","database":super::database_path(app)?.to_string_lossy()}))
}
#[tauri::command]
pub(crate) fn planning_repository_read(app_handle:AppHandle,window:WebviewWindow,state:State<'_,Arc<PlanningAuthorityTransportFoundation>>,session:WriterSession)->Result<Option<Value>> {
    state.with_current_writer(window.label(),&session,||{
        let c=super::open_connection(&app_handle)?;
        let trusted_pairing=pairing(&app_handle,&window)?;
        let result=transaction(&c,||read(&c,&trusted_pairing))?;
        #[cfg(debug_assertions)]
        if let Some(envelope)=result.as_ref().filter(|_| std::env::var("SCILOOM_DEBUG_PLANNING_READBACK").ok().as_deref()==Some("1")) {
            let facts:serde_json::Map<String,Value>=["projects","routeNodes","tasks","researchRoutines"].into_iter().map(|key| {
                let rows=envelope["snapshot"][key].as_array().unwrap();
                (key.to_string(),json!({"count":rows.len(),"ids":rows.iter().map(|row|row["id"].clone()).collect::<Vec<_>>()}))
            }).collect();
            eprintln!("Planning SQLite canonical readback: {}",json!({"databasePath":trusted_pairing["database"],"profilePath":trusted_pairing["profile"],"repositoryEpoch":envelope["repositoryEpoch"],"revision":envelope["revision"],"facts":facts}));
        }
        Ok(result)
    })
}
#[tauri::command]
pub(crate) fn planning_repository_import(app_handle:AppHandle,window:WebviewWindow,state:State<'_,Arc<PlanningAuthorityTransportFoundation>>,session:WriterSession,envelope:Value,source_raw:Option<String>)->Result<Value> {
    state.with_current_writer(window.label(),&session,||import(&super::open_connection(&app_handle)?,&pairing(&app_handle,&window)?,&envelope,source_raw.as_deref()))
}
#[tauri::command]
pub(crate) fn planning_repository_commit(app_handle:AppHandle,window:WebviewWindow,state:State<'_,Arc<PlanningAuthorityTransportFoundation>>,session:WriterSession,request:Value)->Result<Value> {
    state.with_current_writer(window.label(),&session,||commit(&super::open_connection(&app_handle)?,&pairing(&app_handle,&window)?,&request))
}

fn record(c:&Connection,table:&str,id:&str)->Result<Option<Value>> {
    Ok(super::query_records(c,&format!("SELECT * FROM {table} WHERE id=?"),&[&id])?.pop())
}
pub(crate) fn validate_task(c:&Connection,task_id:&str,project_id:&str)->Result<()> {
    let raw:Option<String>=c.query_row("SELECT record_json FROM planning_tasks WHERE id=?",[task_id],|r|r.get(0)).optional().map_err(err)?;
    let task:Value=serde_json::from_str(&raw.ok_or("OUTPUT_CURRENT_TASK_MISSING")?).map_err(err)?;
    if task["projectId"]!=project_id || task["deletedAt"].as_str().is_some_and(|s|!s.is_empty()) || task["archivedAt"].as_str().is_some_and(|s|!s.is_empty()) || task["status"]=="archived" || task["captureState"]=="archived" {return Err("OUTPUT_CURRENT_TASK_NOT_WRITABLE_OR_SCOPE_MISMATCH".into())}
    let project_raw:Option<String>=c.query_row("SELECT record_json FROM planning_projects WHERE id=?",[project_id],|r|r.get(0)).optional().map_err(err)?;
    let project:Value=serde_json::from_str(&project_raw.ok_or("OUTPUT_CURRENT_PROJECT_MISSING")?).map_err(err)?;
    if project["deletedAt"].as_str().is_some_and(|s|!s.is_empty()) || project["archivedAt"].as_str().is_some_and(|s|!s.is_empty()) || project["status"]=="archived" {return Err("OUTPUT_CURRENT_PROJECT_NOT_WRITABLE".into())}
    Ok(())
}
pub(crate) fn validate_task_write(c:&Connection,table:&str,payload:&serde_json::Map<String,Value>)->Result<()> {
    let field=match table {"outputs"=>"task_id","output_gaps"=>"related_task_id",_=>return Ok(())};
    let Some(task)=payload.get(field).and_then(Value::as_str) else {return Ok(())};
    if !c.prepare("SELECT 1 FROM sqlite_master WHERE name='planning_import_completion'").map_err(err)?.exists([]).map_err(err)? || !c.prepare("SELECT 1 FROM planning_import_completion").map_err(err)?.exists([]).map_err(err)? {return Ok(())}
    let id=payload.get("id").and_then(Value::as_str).unwrap_or("");
    let old=record(c,table,id)?;
    let project=payload.get("project_id").and_then(Value::as_str).or_else(||old.as_ref().and_then(|v|v["project_id"].as_str())).ok_or("OUTPUT_PROJECT_REQUIRED")?;
    if old.as_ref().is_some_and(|v|v[field]==task && v["project_id"]==project) {return Ok(())}
    validate_task(c,task,project)
}
pub(crate) fn convert_candidate(c:&Connection,input:&Value)->Result<Value> {
    transaction(c,||{
        if input["confirmedByUser"]!=true {return Err("OUTPUT_CONVERSION_CONFIRMATION_REQUIRED".into())}
        let candidate_id=input["candidateId"].as_str().ok_or("OUTPUT_CANDIDATE_REQUIRED")?;
        let existing:Option<String>=c.query_row("SELECT target_id FROM output_conversion_relations WHERE source_type='outputCandidate' AND source_id=? AND target_type='researchOutput' AND relation_type='converted_to' AND deleted_at IS NULL",[candidate_id],|r|r.get(0)).optional().map_err(err)?;
        if let Some(id)=existing {
            let output=record(c,"outputs",&id)?.ok_or("OUTPUT_CONVERSION_TARGET_MISSING")?;
            if !output["deleted_at"].is_null() {return Err("OUTPUT_CONVERSION_TARGET_DELETED".into())}
            return Ok(json!({"created":false,"output":output}));
        }
        let candidate=record(c,"output_candidates",candidate_id)?.ok_or("OUTPUT_CANDIDATE_MISSING")?;
        if !candidate["deleted_at"].is_null() || candidate["status"]=="converted" || candidate["updated_at"]!=input["expectedCandidateUpdatedAt"] {return Err("OUTPUT_CANDIDATE_STALE_OR_INCONSISTENT".into())}
        if input["allowUnresolvedGaps"]==false && c.prepare("SELECT 1 FROM output_conversion_relations r JOIN output_gaps g ON g.id=r.source_id WHERE r.source_type='outputGap' AND r.target_type='outputCandidate' AND r.target_id=? AND r.relation_type='blocks' AND r.deleted_at IS NULL AND g.deleted_at IS NULL AND g.status NOT IN ('resolved','abandoned')").map_err(err)?.exists([candidate_id]).map_err(err)? {return Err("OUTPUT_UNRESOLVED_GAPS".into())}
        let output=input["outputRecord"].as_object().ok_or("OUTPUT_RECORD_INVALID")?;
        let provenance:Value=serde_json::from_str(output.get("provenance").and_then(Value::as_str).ok_or("OUTPUT_PROVENANCE_REQUIRED")?).map_err(err)?;
        if provenance["sourceCandidateId"]!=candidate_id || provenance["confirmedByUser"]!=true {return Err("OUTPUT_PROVENANCE_MISMATCH".into())}
        if output.get("project_id")!=candidate.get("project_id") || output.get("task_id").unwrap_or(&Value::Null)!=candidate.get("task_id").unwrap_or(&Value::Null) {return Err("OUTPUT_CANDIDATE_RELATION_MISMATCH".into())}
        if let Some(task)=candidate["task_id"].as_str() {validate_task(c,task,candidate["project_id"].as_str().ok_or("OUTPUT_PROJECT_REQUIRED")?)?;}
        let id=output.get("id").and_then(Value::as_str).ok_or("OUTPUT_ID_REQUIRED")?;
        if record(c,"outputs",id)?.is_some() {return Err("OUTPUT_ID_COLLISION".into())}
        super::save_record(c,"outputs",output)?;
        c.execute("UPDATE output_candidates SET status='converted',updated_at=? WHERE id=?",params![output["updated_at"].as_str().ok_or("OUTPUT_TIME_REQUIRED")?,candidate_id]).map_err(err)?;
        let relation=input["relationRecord"].as_object().ok_or("OUTPUT_RELATION_INVALID")?;
        if relation.get("project_id")!=candidate.get("project_id") || relation.get("source_id").and_then(Value::as_str)!=Some(candidate_id) || relation.get("target_id").and_then(Value::as_str)!=Some(id) || relation["relation_type"]!="converted_to" || relation["source_type"]!="outputCandidate" || relation["target_type"]!="researchOutput" {return Err("OUTPUT_RELATION_MISMATCH".into())}
        super::save_record(c,"output_conversion_relations",relation)?;
        Ok(json!({"created":true,"output":record(c,"outputs",id)?.ok_or("OUTPUT_READBACK_MISSING")?}))
    })
}
#[tauri::command]
pub(crate) fn db_convert_output_candidate(app_handle:AppHandle,input:Value)->Result<Value> {
    convert_candidate(&super::open_connection(&app_handle)?,&input)
}
