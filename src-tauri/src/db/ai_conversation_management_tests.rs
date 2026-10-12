use super::*;
use crate::db::{schema,ai_durable_foundation as ai};
use serde_json::json;
fn fixture()->(std::path::PathBuf,Connection){
    let root=std::env::temp_dir().join(format!("sc3-conversation-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();let path=root.join("test.sqlite3");
    crate::db::initialize_test_database_at(&path).unwrap();
    let c=Connection::open(&path).unwrap();c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    ai::create_ai_conversation_in_connection(&c,&ai::CreateAIConversationInput{id:"c".into(),stable_key:"key-c".into(),created_at:"2026-10-07T00:00:00Z".into()}).unwrap();
    c.execute("INSERT INTO ai_messages(id,conversation_id,sequence,role,content,created_at) VALUES('m','c',1,'user','preserve me','2026-10-07T00:00:00Z')",[]).unwrap();
    c.execute("INSERT INTO planning_projects(id,ordinal,record_json) VALUES('scientific-owner',0,?1)",[json!({"id":"scientific-owner","title":"Shared research fact"}).to_string()]).unwrap();
    (path,c)
}
fn input(revision:i64,action:&str)->ManageConversationInput {ManageConversationInput{conversation_id:"c".into(),expected_revision:revision,action:action.into(),title:None,confirmed:None}}
fn action(c:&mut Connection,revision:i64,name:&str)->ConversationManagement{manage(c,&input(revision,name)).unwrap()}
fn count(c:&Connection,t:&str)->i64{c.query_row(&format!("SELECT COUNT(*) FROM {t}"),[],|r|r.get(0)).unwrap()}
fn attempt(c:&Connection,status:&str){
    c.execute("INSERT INTO ai_call_attempts(id,request_id,conversation_id,sequence,purpose,trigger_message_id,provider,model,status,context_package_id,context_package_version,context_source_refs_json,warnings_json,prompt_package_id,prompt_created_at,started_at,settled_at,error_code) VALUES('a','request-a','c',1,'chat_response','m','offline','test',?1,'ctx','1','[]','[]','prompt','2026-10-07','2026-10-07',?2,?3)",params![status,if status=="failed"{Some("2026-10-07")}else{None},if status=="failed"{Some("cancelled")}else{None}]).unwrap();
}

#[test]
fn lifecycle_identity_restore_restart_and_scientific_isolation(){
    let(path,mut c)=fixture();let mut rename=input(0,"rename");rename.title=Some("Renamed Ω".into());manage(&mut c,&rename).unwrap();
    let a=action(&mut c,1,"archive");assert!(a.archived_at.is_some());
    action(&mut c,2,"trash");drop(c);
    let mut c=Connection::open(&path).unwrap();c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();schema::run_migrations(&c).unwrap();
    assert!(read(&c,"c").unwrap().trashed_at.is_some());let restored=action(&mut c,3,"restore");
    assert_eq!(restored.archived_at,a.archived_at);assert_eq!(restored.title,Some("Renamed Ω".into()));
    action(&mut c,4,"unarchive");action(&mut c,5,"trash");let restored=action(&mut c,6,"restore");assert!(restored.archived_at.is_none());
    assert_eq!(count(&c,"ai_messages"),1);assert_eq!(count(&c,"planning_projects"),1);
    assert_eq!(ai::read_ai_conversation_in_connection(&c,"c").unwrap().conversation.id,"c");
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn busy_stale_and_invalid_actions_fail_without_mutation(){
    let(path,mut c)=fixture();attempt(&c,"started");
    for action_name in ["archive","trash","rename","permanentDelete"] {assert!(manage(&mut c,&input(0,action_name)).unwrap_err().contains("BUSY"));}
    assert_eq!(read(&c,"c").unwrap().revision,0);
    c.execute("UPDATE ai_call_attempts SET status='failed',settled_at='2026-10-07',error_code='cancelled' WHERE id='a'",[]).unwrap();
    assert!(manage(&mut c,&input(2,"trash")).unwrap_err().contains("STATE_CHANGED"));
    assert!(manage(&mut c,&input(0,"restore")).is_err());
    let mut bad=input(0,"rename");bad.title=Some(" ".into());assert!(manage(&mut c,&bad).is_err());
    action(&mut c,0,"archive");
    assert!(c.execute("UPDATE ai_call_attempts SET status='started' WHERE id='a'",[]).is_err());
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn permanent_delete_confirm_scope_cascade_and_late_create_protection(){
    let(path,mut c)=fixture();attempt(&c,"failed");
    c.execute("INSERT INTO ai_call_attempt_file_ref_authorizations(call_attempt_id,file_ref_id,display_name,resource_kind,file_type,authorized_at) VALUES('a','shared-file','Shared file','file','md','2026-10-07')",[]).unwrap();
    assert!(manage(&mut c,&input(0,"permanentDelete")).is_err());action(&mut c,0,"trash");
    assert!(manage(&mut c,&input(1,"permanentDelete")).is_err());assert_eq!(count(&c,"ai_messages"),1);
    let mut purge=input(1,"permanentDelete");purge.confirmed=Some(true);manage(&mut c,&purge).unwrap();
    for t in ["ai_conversations","ai_messages","ai_call_attempts","ai_call_attempt_file_ref_authorizations"]{assert_eq!(count(&c,t),0);}
    assert_eq!(count(&c,"planning_projects"),1);
    assert!(ai::create_ai_conversation_in_connection(&c,&ai::CreateAIConversationInput{id:"c".into(),stable_key:"key-c".into(),created_at:"2026-10-07".into()}).is_err());
    assert_eq!(c.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
    assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn unknown_shared_incoming_reference_rolls_back_purge_atomically(){
    let(path,mut c)=fixture();c.execute_batch("CREATE TABLE foreign_owner(id TEXT PRIMARY KEY,message_id TEXT REFERENCES ai_messages(id)); INSERT INTO foreign_owner VALUES('shared','m');").unwrap();
    action(&mut c,0,"trash");let mut purge=input(1,"permanentDelete");purge.confirmed=Some(true);assert!(manage(&mut c,&purge).is_err());
    assert_eq!(count(&c,"ai_conversations"),1);assert_eq!(count(&c,"ai_messages"),1);assert_eq!(read(&c,"c").unwrap().revision,1);
    let purged:Option<String>=c.query_row("SELECT purged_at FROM ai_conversation_management WHERE conversation_id='c'",[],|r|r.get(0)).unwrap();assert!(purged.is_none());
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn admitted_v60_additive_upgrade_preserves_all_owner_bytes(){
    let(path,c)=fixture();
    // Manufacture the exact pre-lifecycle schema, keeping every v60 owner fact.
    c.execute_batch("DROP TABLE ai_conversation_management; DROP TRIGGER trg_ai_conversation_create_tombstone; DROP TRIGGER trg_ai_attempt_active_owner; DROP TRIGGER trg_ai_standard_result_active_owner; DROP TRIGGER trg_ai_context_request_active_owner; DROP TRIGGER trg_ai_context_request_delete_guard; DROP TRIGGER trg_ai_standard_result_delete_forbidden; CREATE TRIGGER trg_ai_context_request_delete_guard BEFORE DELETE ON ai_context_requests BEGIN SELECT RAISE(ABORT,'AI_CONTEXT_REQUEST_DELETE_FORBIDDEN'); END; CREATE TRIGGER trg_ai_standard_result_delete_forbidden BEFORE DELETE ON ai_standard_results BEGIN SELECT RAISE(ABORT,'AI_STANDARD_RESULT_DELETE_FORBIDDEN'); END; DELETE FROM schema_migrations WHERE version=61; PRAGMA user_version=60;").unwrap();
    let before:String=c.query_row("SELECT record_json FROM planning_projects",[],|r|r.get(0)).unwrap();schema::run_migrations(&c).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),61);
    assert_eq!(c.query_row("SELECT record_json FROM planning_projects",[],|r|r.get::<_,String>(0)).unwrap(),before);
    schema::run_migrations(&c).unwrap();validate_schema(&c).unwrap();assert_eq!(count(&c,"ai_messages"),1);
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
#[ignore="opt-in task-owned stdin IPC bridge; no HTTP/WebSocket or real user data"]
fn service_bridge(){
    use std::io::{BufRead,Write};
    let root=std::path::PathBuf::from(std::env::var("SC3_CONVERSATION_BRIDGE_ROOT").expect("explicit isolated root"));
    assert!(root.starts_with(std::path::Path::new(r"N:\SciLoom\Records\.tmp\series-native")));
    std::fs::create_dir_all(root.join("Database")).unwrap();
    let path=root.join("Database/labpod.sqlite3");crate::db::initialize_test_database_at(&path).unwrap();
    let app=tauri::test::mock_builder()
        .manage(crate::runtime_paths::RuntimePaths{app_data:root.clone(),database_directory:root.join("Database"),webview_profile:root.join("WebView"),webview_data_directory:Some(root.join("WebView"))})
        .invoke_handler(tauri::generate_handler![db_manage_ai_conversation,ai::db_create_ai_conversation,ai::db_list_ai_conversations,ai::db_read_ai_conversation])
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
    println!("SC3_READY");std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines(){
        let value:serde_json::Value=serde_json::from_str(&line.unwrap()).unwrap();let cmd=value["command"].as_str().unwrap();
        if cmd=="__finish"{break}
        assert!(["db_manage_ai_conversation","db_create_ai_conversation","db_list_ai_conversations","db_read_ai_conversation"].contains(&cmd));
        let request=tauri::webview::InvokeRequest{cmd:cmd.into(),callback:tauri::ipc::CallbackFn(0),error:tauri::ipc::CallbackFn(1),url:"http://tauri.localhost".parse().unwrap(),body:tauri::ipc::InvokeBody::Json(value["args"].clone()),headers:Default::default(),invoke_key:tauri::test::INVOKE_KEY.to_string()};
        let result=tauri::test::get_ipc_response(&window,request).map(|v|v.deserialize::<serde_json::Value>().unwrap());
        println!("SC3_RESPONSE {}",serde_json::json!({"id":value["id"],"result":result}));std::io::stdout().flush().unwrap();
    }
}

#[test]
fn owned_trace_guards_and_confirmed_business_effect_survive_local_purge() {
    let (path, mut c) = fixture(); attempt(&c,"failed");
    c.execute("INSERT INTO ai_context_requests(id,conversation_id,source_message_id,source_call_attempt_id,source_snapshot_json,reason,requested_refs_json,reviewed_candidates_json,state,created_at) VALUES('context','c','m','a','{}','reason','[]','[]','PENDING','2026-10-07')",[]).unwrap();
    c.execute("INSERT INTO ai_standard_results(id,batch_id,ordinal,conversation_id,parse_call_attempt_id,category,action,target_json,source_json,original_payload_json,visible_payload_json,visible_payload_fingerprint,validation_issues_json,disposition,confirmation_started_at,authorization_id,confirmed_payload_json,confirmed_payload_fingerprint,decided_at,effect_receipt_json,created_at,updated_at) VALUES('result','batch',1,'c','a','DATA_OPERATION','CREATE','{}','{}','{}','{}','fp','[]','CONFIRMED','start','auth','{}','fp','decided','{\"createdOwner\":\"scientific-owner\"}','2026-10-07','2026-10-07')",[]).unwrap();
    assert!(c.execute("DELETE FROM ai_context_requests WHERE id='context'",[]).is_err());
    assert!(c.execute("DELETE FROM ai_standard_results WHERE id='result'",[]).is_err());
    action(&mut c,0,"archive");
    assert!(c.execute("UPDATE ai_context_requests SET reason='changed' WHERE id='context'",[]).is_err());
    let rejected=c.execute("INSERT INTO ai_call_attempts(id,request_id,conversation_id,sequence,purpose,trigger_message_id,provider,model,status,context_package_id,context_package_version,context_source_refs_json,warnings_json,prompt_package_id,prompt_created_at,started_at,settled_at,error_code) VALUES('late','late-request','c',2,'chat_response','m','offline','test','failed','ctx','1','[]','[]','prompt','2026-10-07','2026-10-07','2026-10-07','cancelled')",[]).unwrap_err();
    assert!(rejected.to_string().contains("AI_CONVERSATION_NOT_ACTIVE"));
    action(&mut c,1,"trash");let mut purge=input(2,"permanentDelete");purge.confirmed=Some(true);manage(&mut c,&purge).unwrap();
    assert_eq!(count(&c,"ai_context_requests"),0);assert_eq!(count(&c,"ai_standard_results"),0);assert_eq!(count(&c,"planning_projects"),1);
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn unconfirmed_business_effect_blocks_lifecycle_before_any_write() {
    let (path, mut c) = fixture(); attempt(&c,"failed");
    c.execute("INSERT INTO ai_standard_results(id,batch_id,ordinal,conversation_id,parse_call_attempt_id,category,action,target_json,source_json,original_payload_json,visible_payload_json,visible_payload_fingerprint,validation_issues_json,disposition,confirmation_started_at,authorization_id,confirmed_payload_json,confirmed_payload_fingerprint,created_at,updated_at) VALUES('result','batch',1,'c','a','DATA_OPERATION','CREATE','{}','{}','{}','{}','fp','[]','PENDING','start','auth','{}','fp','2026-10-07','2026-10-07')",[]).unwrap();
    assert!(manage(&mut c,&input(0,"trash")).unwrap_err().contains("BUSY"));assert_eq!(read(&c,"c").unwrap().revision,0);
    assert_eq!(count(&c,"ai_messages"),1);assert_eq!(count(&c,"ai_standard_results"),1);
    drop(c);std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
