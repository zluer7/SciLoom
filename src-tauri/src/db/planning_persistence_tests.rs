use super::planning_persistence::*;
use super::{schema, review_structured_state};
use rusqlite::Connection;
use serde_json::{json,Value};

fn fixture()->Value {
    let mut snapshot=json!({"schemaVersion":1,"app":"LabPod","exportedAt":"2026-09-22T00:00:00Z","extraMetadata":{"preserve":"原文"}});
    for (key,_) in COLLECTIONS {
        snapshot[key]=json!([{"id":key,"title":"保留 Unicode / scientific content","createdAt":"created","updatedAt":"updated","archivedAt":null,"deletedAt":null,"source":"user","schemaVersion":1,"customFields":{"nested":[0,false,null,"exact"]},"aiMetadata":{"needsReview":true},"orderIndex":7}]);
    }
    snapshot["projects"][0]["directionId"]=json!("researchDirections");
    for key in ["routeNodes","tasks","reviews","researchRoutines","routineCheckIns","experimentSummaries"] {snapshot[key][0]["projectId"]=json!("projects");}
    snapshot["tasks"][0]["routeNodeId"]=json!("routeNodes"); snapshot["tasks"][0]["status"]=json!("todo");
    snapshot["routeCheckpoints"][0]["routeNodeId"]=json!("routeNodes");
    snapshot["taskCheckpoints"][0]["taskId"]=json!("tasks");
    snapshot["routineCheckIns"][0]["routineId"]=json!("researchRoutines");
    snapshot["routineCheckIns"][0]["periodKey"]=json!("2026-W39");
    snapshot["entityLinks"][0].as_object_mut().unwrap().extend(json!({"sourceType":"review","sourceId":"reviews","targetType":"task","targetId":"tasks","relationType":"summarizes"}).as_object().unwrap().clone());
    snapshot["changeLogs"][0]["effectId"]=json!("exact-effect-id");
    json!({"envelopeVersion":1,"repositoryEpoch":"11111111-1111-4111-8111-111111111111","revision":"9007199254740993","snapshot":snapshot})
}
fn db()->Connection {
    let c=Connection::open_in_memory().unwrap();schema::run_migrations(&c).unwrap();
    assert_eq!(crate::provisioning_runtime::schema_capability::check_sqlite_schema_capability(&c),crate::provisioning_runtime::schema_capability::SchemaCapability::Available);
    c
}
fn pair()->Value {json!({"app":"test-app","profile":"profile-1","origin":"tauri://local","database":"db-1","key":"labpod.planning.v1"})}
fn count(c:&Connection,t:&str)->i64 {c.query_row(&format!("SELECT COUNT(*) FROM {t}"),[],|r|r.get(0)).unwrap()}
fn imported(c:&Connection,e:&Value)->Value {import(c,&pair(),e,Some(&e.to_string())).unwrap()}

#[test]
fn all_twelve_nonempty_facts_and_review_second_layer_survive_actual_import() {
    let mut c=db();let e=fixture();
    let state=review_structured_state::provision_in_connection(&mut c,&review_structured_state::ProvisionReviewStructuredStateInput{review_id:"reviews".into(),review_type:"stage".into(),outline_sections:["stage_summary","key_progress","completed_items","major_problems","cause_analysis","next_plan","other"].iter().map(|k|review_structured_state::ReviewOutlineSectionRecord{key:k.to_string(),content:format!("second-layer-{k}")}).collect()}).unwrap();
    assert_eq!(imported(&c,&e),e);
    for (_,table) in COLLECTIONS {assert_eq!(count(&c,table),1);}
    assert_eq!(count(&c,"tasks"),0);assert_eq!(count(&c,"experiments"),0);
    assert_eq!(review_structured_state::read_state_in_connection(&c,"reviews").unwrap().unwrap(),state);
    schema::run_migrations(&c).unwrap();assert_eq!(read(&c,&pair()).unwrap().unwrap(),e);
    assert_eq!(c.query_row("PRAGMA foreign_keys",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn completion_failure_rolls_back_facts_relationship_schema_and_allows_safe_retry() {
    let c=db();let e=fixture();
    c.execute_batch("CREATE TRIGGER fail_completion BEFORE INSERT ON planning_import_completion BEGIN SELECT RAISE(ABORT,'before completion'); END;").unwrap();
    assert!(import(&c,&pair(),&e,Some(&e.to_string())).unwrap_err().contains("before completion"));
    assert!(read(&c,&pair()).unwrap().is_none());for (_,t) in COLLECTIONS {assert_eq!(count(&c,t),0)}
    validate_schema(&c).unwrap();
    c.execute_batch("DROP TRIGGER fail_completion").unwrap();assert_eq!(imported(&c,&e),e);
}

#[test]
fn target_first_accepts_commit_before_activation_unknown_and_historical_receipt_after_new_writes() {
    let c=db();let e=fixture();imported(&c,&e);
    let receipt:String=c.query_row("SELECT record_json FROM planning_import_completion",[],|r|r.get(0)).unwrap();
    let mut next=e["snapshot"].clone();next["tasks"][0]["title"]=json!("new canonical write");
    let committed=commit(&c,&pair(),&json!({"expectedEpoch":e["repositoryEpoch"],"expectedRevision":e["revision"],"nextSnapshot":next})).unwrap();
    assert_eq!(committed["status"],"committed");assert_eq!(committed["envelope"]["revision"],"9007199254740994");
    // No source is needed even for an identical import replay, missing source,
    // malformed/stale source or an unknown previous result.
    for raw in [None,Some("corrupt"),Some("stale")] {assert_eq!(import(&c,&pair(),&Value::Null,raw).unwrap(),committed["envelope"]);}
    schema::run_migrations(&c).unwrap();assert_eq!(read(&c,&pair()).unwrap().unwrap(),committed["envelope"]);
    assert_eq!(receipt,c.query_row::<String,_,_>("SELECT record_json FROM planning_import_completion",[],|r|r.get(0)).unwrap());
    let mut wrong=pair();wrong["profile"]=json!("another-profile");assert!(read(&c,&wrong).is_err());
}

#[test]
fn native_cas_rejects_stale_epoch_and_overflow_without_changing_durable_facts() {
    let c=db();let mut e=fixture();e["revision"]=json!(u128::MAX.to_string());imported(&c,&e);
    let mut next=e["snapshot"].clone();next["tasks"][0]["title"]=json!("change");
    for (epoch,revision,status) in [("22222222-2222-4222-8222-222222222222",u128::MAX.to_string(),"epoch_mismatch"),(e["repositoryEpoch"].as_str().unwrap(),"0".into(),"revision_stale")] {
        let r=commit(&c,&pair(),&json!({"expectedEpoch":epoch,"expectedRevision":revision,"nextSnapshot":next})).unwrap();assert_eq!(r["status"],status);
    }
    assert!(commit(&c,&pair(),&json!({"expectedEpoch":e["repositoryEpoch"],"expectedRevision":e["revision"],"nextSnapshot":next})).unwrap_err().contains("EXHAUSTED"));
    assert_eq!(read(&c,&pair()).unwrap().unwrap(),e);
}

#[test]
fn conflicting_or_unsupported_source_is_preserved_and_never_activated() {
    for mode in ["duplicate","orphan","review","version","legacy"] {
        let c=db();let mut e=fixture();
        match mode {
            "duplicate"=>{let row=e["snapshot"]["tasks"][0].clone();e["snapshot"]["tasks"].as_array_mut().unwrap().push(row);},
            "orphan"=>e["snapshot"]["tasks"][0]["projectId"]=json!("missing"),
            "review"=>e["snapshot"]["reviews"][0]["reviewType"]=json!("stage"),
            "version"=>e["snapshot"]["schemaVersion"]=json!(2),
            _=>{c.execute_batch("INSERT INTO tasks(id,project_id,title,description,task_type,priority,status,acceptance_criteria,created_at,updated_at) VALUES('tasks','projects','legacy','','research','medium','todo','','c','u')").unwrap();}
        }
        assert!(import(&c,&pair(),&e,Some(&e.to_string())).is_err(),"{mode}");assert_eq!(count(&c,"planning_import_completion"),0);assert_eq!(count(&c,"planning_tasks"),0);
    }
}

#[test]
fn accepted_nonempty_v59_upgrades_without_altering_source_or_existing_business_rows() {
    let c=Connection::open_in_memory().unwrap();schema::run_pre_planning_migrations(&c).unwrap();
    c.execute_batch("INSERT INTO outputs(id,project_id,output_name,output_type,description,created_at,updated_at) VALUES('old','projects','preserve','report','old data','c','u')").unwrap();
    let before=super::query_records(&c,"SELECT * FROM outputs",&[]).unwrap();
    schema::run_migrations(&c).unwrap();assert_eq!(before,super::query_records(&c,"SELECT * FROM outputs",&[]).unwrap());
    assert!(read(&c,&pair()).unwrap().is_none());let e=fixture();imported(&c,&e);assert_eq!(before,super::query_records(&c,"SELECT * FROM outputs",&[]).unwrap());
    assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),schema::CURRENT_SCHEMA_VERSION);
}

#[test]
fn accepted_nonempty_v58_uses_real_d4_preflight_and_full_current_upgrade() {
    let c=super::experiment_planning_relation::tests::predecessor();
    let before=super::query_records(&c,"SELECT * FROM outputs",&[]).unwrap();
    schema::run_migrations(&c).unwrap();assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),schema::CURRENT_SCHEMA_VERSION);
    assert_eq!(before,super::query_records(&c,"SELECT * FROM outputs",&[]).unwrap());
    super::experiment_planning_relation::validate_target(&c).unwrap();validate_schema(&c).unwrap();
    let rejected=super::experiment_planning_relation::tests::predecessor();
    rejected.execute("UPDATE experiments SET route_id='not-admitted'",[]).unwrap();
    assert!(schema::run_migrations(&rejected).is_err());
    assert_eq!(rejected.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),58);
}

fn candidate(c:&Connection) {c.execute_batch("INSERT INTO output_candidates(id,project_id,task_id,title,candidate_type,status,created_at,updated_at) VALUES('candidate','projects','tasks','Candidate','report','ready_for_formal','c','v1')").unwrap();}
fn conversion()->Value {json!({"candidateId":"candidate","expectedCandidateUpdatedAt":"v1","confirmedByUser":true,"allowUnresolvedGaps":false,"outputRecord":{"id":"out","project_id":"projects","task_id":"tasks","output_name":"Output","output_type":"report","status":"draft","structured_summary":"[]","description":"preserve","provenance":"{\"confirmedByUser\":true,\"sourceCandidateId\":\"candidate\"}","created_at":"c","updated_at":"v2"},"relationRecord":{"id":"relation","project_id":"projects","source_type":"outputCandidate","source_id":"candidate","target_type":"researchOutput","target_id":"out","relation_type":"converted_to","created_at":"c","updated_at":"v2"}})}

#[test]
fn conversion_atomicity_idempotence_and_real_canonical_fk() {
    let c=db();imported(&c,&fixture());candidate(&c);
    c.execute_batch("CREATE TRIGGER fail_relation BEFORE INSERT ON output_conversion_relations BEGIN SELECT RAISE(ABORT,'relation failure'); END").unwrap();
    assert!(convert_candidate(&c,&conversion()).unwrap_err().contains("relation failure"));assert_eq!(count(&c,"outputs"),0);
    assert_eq!(c.query_row::<String,_,_>("SELECT status FROM output_candidates",[],|r|r.get(0)).unwrap(),"ready_for_formal");
    c.execute_batch("DROP TRIGGER fail_relation").unwrap();let result=convert_candidate(&c,&conversion()).unwrap();assert_eq!(result["output"]["task_id"],"tasks");
    assert_eq!(convert_candidate(&c,&conversion()).unwrap()["created"],false);assert_eq!(count(&c,"outputs"),1);assert_eq!(count(&c,"output_conversion_relations"),1);
    assert!(c.execute("UPDATE outputs SET task_id='missing'",[]).is_err());
    assert!(validate_task(&c,"tasks","wrong-project").is_err());
}

#[test]
fn relation_rebuild_preserves_nonempty_gap_children_and_fk_is_never_disabled() {
    let c=db();
    c.execute_batch("INSERT INTO output_gaps(id,project_id,title,gap_type,status,created_at,updated_at) VALUES('gap','projects','Gap','validation','pending','c','u'); INSERT INTO output_gap_feedback_cards(id,project_id,output_gap_id,card_type,title,status,priority,created_at,updated_at) VALUES('card','projects','gap','task','Keep child','pending','medium','c','u');").unwrap();
    let before=super::query_records(&c,"SELECT * FROM output_gap_feedback_cards",&[]).unwrap();
    imported(&c,&fixture());assert_eq!(before,super::query_records(&c,"SELECT * FROM output_gap_feedback_cards",&[]).unwrap());
    assert_eq!(c.query_row("PRAGMA foreign_keys",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    assert!(commit(&c,&pair(),&json!({})).unwrap_err().contains("FK_REQUIRED"));
    candidate(&c);assert!(convert_candidate(&c,&conversion()).unwrap_err().contains("FK_REQUIRED"));
}

#[test]
fn two_real_connections_cannot_overwrite_the_same_snapshot_revision() {
    let path=std::env::temp_dir().join(format!("sc3-a1-a1-cas-{}.sqlite3",uuid::Uuid::new_v4()));
    let c=Connection::open(&path).unwrap();schema::run_migrations(&c).unwrap();let e=fixture();imported(&c,&e);
    let mut handles=vec![];
    for name in ["first","second"] {
        let path=path.clone();let e=e.clone();
        handles.push(std::thread::spawn(move||{
            let c=Connection::open(path).unwrap();c.execute_batch("PRAGMA foreign_keys=ON").unwrap();c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
            let mut next=e["snapshot"].clone();next["tasks"][0]["title"]=json!(name);
            commit(&c,&pair(),&json!({"expectedEpoch":e["repositoryEpoch"],"expectedRevision":e["revision"],"nextSnapshot":next})).unwrap()["status"].as_str().unwrap().to_string()
        }));
    }
    let mut statuses:Vec<_>=handles.into_iter().map(|h|h.join().unwrap()).collect();statuses.sort();assert_eq!(statuses,["committed","revision_stale"]);
    assert_eq!(read(&c,&pair()).unwrap().unwrap()["revision"],"9007199254740994");drop(c);std::fs::remove_file(path).unwrap();
}
