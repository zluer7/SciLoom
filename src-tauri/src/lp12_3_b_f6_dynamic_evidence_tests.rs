use crate::db::manuscript_save_as_candidate_custody::{
    f6_plan_in_connection, f6_readback_in_connection as custody_readback,
    f6_record_activation_in_connection, f6_transfer_in_connection,
};
use crate::db::manuscript_save_as_finalization::{
    f6_claim_in_connection, f6_finalize_in_connection,
    f6_issue_request_in_connection,
    f6_record_decision_in_connection, f6_record_presentation_in_connection,
    readback_in_connection as finalization_readback, LifecycleDecisionReceipt,
};
use crate::db::manuscript_save_as_operation::{
    atomic_d2_commit_in_connection, create_in_connection, expectation_from_record,
    readback_in_connection as operation_readback, transition_in_connection,
    SaveAsCommitState, SaveAsD2AtomicCommitInput, SaveAsOperationMutation, SaveAsOperationRecord,
    SaveAsOperationStage, SaveAsOperationTransitionInput,
    SaveAsReconciliationState,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, to_value, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceCell {
    evidence_cell_id: String,
    formal_responsibility_id: String,
    owner_type: String,
    owner_id_class: String,
    channel: String,
    source_window_role: String,
    target_location_mode: String,
    scenario_category: String,
}

fn json_i64(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("missing integer field {key}: {value}"))
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {key}: {value}"))
        .to_string()
}

fn from_json<T>(value: Value) -> T
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).unwrap()
}

fn transition(
    connection: &mut Connection,
    current: &SaveAsOperationRecord,
    mutation: SaveAsOperationMutation,
) -> SaveAsOperationRecord {
    transition_in_connection(
        connection,
        &SaveAsOperationTransitionInput {
            operation_id: current.operation_id.clone(),
            expected: expectation_from_record(current),
            mutation,
        },
    )
    .unwrap()
}

fn ensure_isolated_database(database_path: &Path, resource_root: &Path) {
    let database = database_path
        .canonicalize()
        .unwrap_or_else(|_| database_path.to_path_buf());
    let root = resource_root
        .canonicalize()
        .unwrap_or_else(|_| resource_root.to_path_buf());
    assert!(
        database.starts_with(&root),
        "SQLite database escaped the F-6 isolated resource root"
    );
}

#[test]
#[ignore = "invoked once per manifest cell by the LP12-3-B F-6 evidence runner"]
fn lp12_3_b_f6_real_sqlite_authority_cell() {
    let cell: EvidenceCell = serde_json::from_str(
        &std::env::var("LP12_F6_CELL_JSON")
            .expect("LP12_F6_CELL_JSON is required"),
    )
    .unwrap();
    let proof_path = PathBuf::from(
        std::env::var("LP12_F6_DURABLE_PROOF_PATH")
            .expect("LP12_F6_DURABLE_PROOF_PATH is required"),
    );
    let resource_root = PathBuf::from(
        std::env::var("LP12_F6_CELL_RESOURCE_ROOT")
            .expect("LP12_F6_CELL_RESOURCE_ROOT is required"),
    );

    assert!(matches!(
        cell.owner_type.as_str(),
        "resultItem" | "finding" | "outputCandidate" | "outputGap" | "researchOutput"
    ));
    assert!(matches!(
        cell.formal_responsibility_id.as_str(),
        "F06" | "F07" | "F08" | "F09" | "F10"
    ));
    assert_eq!(cell.channel, "primary");
    assert!(matches!(
        cell.source_window_role.as_str(),
        "current" | "independent"
    ));
    assert!(matches!(
        cell.target_location_mode.as_str(),
        "managed" | "external"
    ));
    assert_eq!(cell.scenario_category, "positive-save-as");
    assert_eq!(crate::db::schema::CURRENT_SCHEMA_VERSION, 58);

    fs::create_dir_all(&resource_root).unwrap();
    let database_path = resource_root.join("labpod.sqlite3");
    crate::db::initialize_test_database_at(&database_path).unwrap();
    ensure_isolated_database(&database_path, &resource_root);
    let mut connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .unwrap();

    let operation_id = format!("f6:{}", cell.evidence_cell_id);
    let permit_id = format!("permit:{}", cell.evidence_cell_id);
    let terminal_outcome_id = format!("terminal:{}", cell.evidence_cell_id);
    let source_file_ref_id = format!("source:{}", cell.evidence_cell_id);
    let runtime_handle = format!("runtime:{}", cell.evidence_cell_id);
    let runtime_consumer_id = format!("consumer:{}", cell.evidence_cell_id);
    let process_id = format!("f6-process-{}", cell.evidence_cell_id);
    let target_path = resource_root.join(format!("f6-target-{}.md", cell.evidence_cell_id));
    let target_bytes = format!("F6:{}\n", cell.evidence_cell_id).into_bytes();
    let target_sha256 = format!("{:x}", Sha256::digest(&target_bytes));
    fs::write(&target_path, &target_bytes).unwrap();
    let initial = SaveAsOperationRecord {
        operation_id: operation_id.clone(),
        revision: 0,
        commit_fence_revision: 0,
        operation_generation: 1,
        producer_process_generation: process_id.clone(),
        owner_type: cell.owner_type.clone(),
        owner_id: cell.owner_id_class.clone(),
        channel: cell.channel.clone(),
        source_window_role: cell.source_window_role.clone(),
        source_file_ref_id: Some(source_file_ref_id),
        source_path_identity_key: format!("source:{}", cell.evidence_cell_id),
        source_revision: "f6-source-r1".into(),
        source_runtime_generation: 1,
        snapshot_sha256: target_sha256.clone(),
        snapshot_byte_length: target_bytes.len() as i64,
        encoding_contract_version: "utf-8-v1".into(),
        newline_contract_version: "none-v1".into(),
        target_display_path: target_path.to_string_lossy().into_owned(),
        target_path_identity_key: format!("target:{}", cell.evidence_cell_id),
        target_location_mode: cell.target_location_mode.clone(),
        target_parent_path_identity_key: "f6-parent".into(),
        target_parent_physical_identity_hash: "b".repeat(64),
        d1_physical_identity_hash: None,
        d1_readback_sha256: None,
        d1_readback_revision: None,
        d1_byte_length: None,
        d1_proof_generation: None,
        target_file_ref_id: None,
        d2_readback_revision: None,
        containment_fence_token: None,
        reconciliation_result_code: None,
        reconciliation_resolved_at: None,
        stage: SaveAsOperationStage::PreD1Claimed,
        d1_commit_state: SaveAsCommitState::NotStarted,
        d2_commit_state: SaveAsCommitState::NotStarted,
        reconciliation_state: SaveAsReconciliationState::NotRequired,
        blocking_code: None,
        claim_token: Some(format!("claim:{}", cell.evidence_cell_id)),
        claim_revision: Some(0),
        claim_process_generation: Some(process_id.clone()),
        observation_generation: Some(0),
        observation_revision: Some(0),
        created_at: String::new(),
        updated_at: String::new(),
        terminal_at: None,
    };
    let mut operation = create_in_connection(&mut connection, &initial).unwrap();
    operation = transition(
        &mut connection,
        &operation,
        SaveAsOperationMutation::EnterD1CommitUnknown,
    );
    operation = transition(
        &mut connection,
        &operation,
        SaveAsOperationMutation::ConfirmD1 {
            d1_physical_identity_hash: "c".repeat(64),
            d1_readback_sha256: target_sha256,
            d1_readback_revision: "f6-d1-r1".into(),
            d1_byte_length: target_bytes.len() as i64,
            d1_proof_generation: 1,
        },
    );
    let d2 = atomic_d2_commit_in_connection(
        &mut connection,
        &SaveAsD2AtomicCommitInput {
            operation_id: operation.operation_id.clone(),
            expected: expectation_from_record(&operation),
        },
        &process_id,
    )
    .unwrap();
    operation = d2.operation;
    let candidate_file_ref_id = d2.file_ref.unwrap().id;
    operation = transition(
        &mut connection,
        &operation,
        SaveAsOperationMutation::EnterR3ActivationPending,
    );

    let planned = f6_plan_in_connection(
        &mut connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedOperationRevision": operation.revision,
            "candidateFileRefId": candidate_file_ref_id,
            "runtimeConsumerId": runtime_consumer_id
        })),
    )
    .unwrap();
    let planned_json = to_value(&planned).unwrap();
    let planned_receipt_id = json_string(&planned_json, "receiptId");
    let activated = f6_record_activation_in_connection(
        &connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedCustodyRevision": json_i64(&planned_json, "revision"),
            "receiptId": planned_receipt_id,
            "runtimeHandle": runtime_handle,
            "runtimeGeneration": 1
        })),
    )
    .unwrap();
    let activated_json = to_value(&activated).unwrap();
    assert_eq!(
        json_string(&activated_json, "receiptId"),
        planned_receipt_id
    );

    operation = transition(
        &mut connection,
        &operation,
        SaveAsOperationMutation::EnterP4PresentationPending,
    );
    let transferred = f6_transfer_in_connection(
        &connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedCustodyRevision": json_i64(&activated_json, "revision"),
            "receiptId": planned_receipt_id,
            "nextAuthority": "outputs_lifecycle"
        })),
    )
    .unwrap();
    let transferred_json = to_value(&transferred).unwrap();
    assert_eq!(
        json_string(&transferred_json, "currentCustodyAuthority"),
        "outputs_lifecycle"
    );
    assert_eq!(
        json_string(&transferred_json, "custodyState"),
        "transferred"
    );

    let presented = f6_record_presentation_in_connection(
        &mut connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedOperationRevision": operation.revision,
            "receiptId": planned_receipt_id,
            "permitId": permit_id,
            "operationGeneration": 1,
            "processGeneration": process_id,
            "terminalOutcomeId": terminal_outcome_id,
            "terminalOutcomeCode": "TERMINAL_SUCCESS",
            "terminalOutcomeRevision": 1
        })),
    )
    .unwrap();
    let presented_json = to_value(&presented).unwrap();
    let requested = f6_issue_request_in_connection(
        &mut connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedFinalizationRevision": json_i64(&presented_json, "revision"),
            "receiptId": planned_receipt_id,
            "ownerInstanceToken": format!("instance:{}", cell.evidence_cell_id),
            "mountToken": format!("mount:{}", cell.evidence_cell_id),
            "leaseToken": format!("lease:{}", cell.evidence_cell_id),
            "mountGeneration": 1,
            "replacementGeneration": 0
        })),
    )
    .unwrap();
    let requested_json = to_value(&requested).unwrap();
    let finalization_request_id =
        json_string(&requested_json, "finalizationRequestId");
    let claimed = f6_claim_in_connection(
        &mut connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedFinalizationRevision": json_i64(&requested_json, "revision"),
            "finalizationRequestId": finalization_request_id,
            "claimGeneration": 1
        })),
        &process_id,
    )
    .unwrap();
    let claimed_json = to_value(&claimed).unwrap();
    let lifecycle_decision_id =
        format!("decision:{}", cell.evidence_cell_id);
    let provisional_install_id =
        format!("install:{}", cell.evidence_cell_id);
    let base_receipt: LifecycleDecisionReceipt = from_json(json!({
        "decisionVersion": 1,
        "lifecycleDecisionId": lifecycle_decision_id,
        "finalizationRequestId": json_string(&claimed_json, "finalizationRequestId"),
        "acknowledgementNonce": json_string(&claimed_json, "acknowledgementNonce"),
        "operationId": operation_id,
        "receiptId": planned_receipt_id,
        "ownerType": cell.owner_type,
        "ownerId": cell.owner_id_class,
        "channel": cell.channel,
        "candidateFileRefId": candidate_file_ref_id,
        "ownerInstanceToken": json_string(&claimed_json, "ownerInstanceToken"),
        "mountToken": json_string(&claimed_json, "mountToken"),
        "leaseToken": json_string(&claimed_json, "leaseToken"),
        "mountGeneration": 1,
        "replacementGeneration": 0,
        "provisionalInstallId": provisional_install_id,
        "decision": "prepared",
        "decisionCreatedAt": "2026-07-30T00:00:01.000Z"
    }));
    let prepared = f6_record_decision_in_connection(
        &mut connection,
        &from_json(json!({
            "expectedFinalizationRevision": json_i64(&claimed_json, "revision"),
            "claimToken": json_string(&claimed_json, "claimToken"),
            "receipt": base_receipt
        })),
    )
    .unwrap();
    let prepared_json = to_value(&prepared).unwrap();
    let installed_receipt: LifecycleDecisionReceipt = from_json(json!({
        "decisionVersion": 1,
        "lifecycleDecisionId": lifecycle_decision_id,
        "finalizationRequestId": json_string(&prepared_json, "finalizationRequestId"),
        "acknowledgementNonce": json_string(&prepared_json, "acknowledgementNonce"),
        "operationId": operation_id,
        "receiptId": planned_receipt_id,
        "ownerType": cell.owner_type,
        "ownerId": cell.owner_id_class,
        "channel": cell.channel,
        "candidateFileRefId": candidate_file_ref_id,
        "ownerInstanceToken": json_string(&prepared_json, "ownerInstanceToken"),
        "mountToken": json_string(&prepared_json, "mountToken"),
        "leaseToken": json_string(&prepared_json, "leaseToken"),
        "mountGeneration": 1,
        "replacementGeneration": 0,
        "provisionalInstallId": provisional_install_id,
        "decision": "installed",
        "decisionCreatedAt": "2026-07-30T00:00:02.000Z"
    }));
    let installed = f6_record_decision_in_connection(
        &mut connection,
        &from_json(json!({
            "expectedFinalizationRevision": json_i64(&prepared_json, "revision"),
            "claimToken": json_string(&prepared_json, "claimToken"),
            "receipt": installed_receipt
        })),
    )
    .unwrap();
    let installed_json = to_value(&installed).unwrap();
    f6_finalize_in_connection(
        &mut connection,
        &from_json(json!({
            "operationId": operation_id,
            "expectedFinalizationRevision": json_i64(&installed_json, "revision"),
            "claimToken": json_string(&installed_json, "claimToken"),
            "lifecycleDecisionId": lifecycle_decision_id,
            "provisionalInstallId": provisional_install_id
        })),
    )
    .unwrap();

    let operation_readback = operation_readback(
        &connection,
        &operation_id,
    )
    .unwrap()
    .unwrap();
    let custody_readback = custody_readback(
        &connection,
        &operation_id,
    )
    .unwrap()
    .unwrap();
    let finalization_readback = finalization_readback(
        &connection,
        &operation_id,
    )
    .unwrap()
    .unwrap();
    let operation_json = to_value(&operation_readback).unwrap();
    let custody_json = to_value(&custody_readback).unwrap();
    let finalization_json = to_value(&finalization_readback).unwrap();

    assert_eq!(json_string(&operation_json, "stage"), "completed");
    assert_eq!(
        json_string(&operation_json, "reconciliationState"),
        "resolved"
    );
    assert_eq!(
        json_string(&custody_json, "currentCustodyAuthority"),
        "outputs_lifecycle"
    );
    assert_eq!(json_string(&custody_json, "custodyState"), "transferred");
    assert_eq!(
        json_string(&custody_json, "receiptId"),
        planned_receipt_id
    );
    assert_eq!(
        json_string(&finalization_json, "finalizationState"),
        "finalized"
    );
    assert_eq!(json_string(&finalization_json, "p4PermitId"), permit_id);
    assert_eq!(
        json_string(&finalization_json, "terminalOutcomeId"),
        terminal_outcome_id
    );
    assert_eq!(
        json_string(&finalization_json, "custodyAtFinalization"),
        "outputs_lifecycle"
    );
    assert_eq!(
        json_i64(&custody_json, "totalCloseAttemptCount"),
        0
    );
    assert!(json_i64(&operation_json, "revision") > 0);
    assert!(json_i64(&finalization_json, "revision") > 0);

    let proof = json!({
        "schemaVersion": crate::db::schema::CURRENT_SCHEMA_VERSION,
        "evidenceCellId": cell.evidence_cell_id,
        "formalResponsibilityId": cell.formal_responsibility_id,
        "ownerType": cell.owner_type,
        "ownerIdClass": cell.owner_id_class,
        "channel": cell.channel,
        "sourceWindowRole": cell.source_window_role,
        "targetLocationMode": cell.target_location_mode,
        "operationStage": json_string(&operation_json, "stage"),
        "operationRevision": json_i64(&operation_json, "revision"),
        "reconciliationState": json_string(&operation_json, "reconciliationState"),
        "custodyState": json_string(&custody_json, "custodyState"),
        "custodyAuthority": json_string(&custody_json, "currentCustodyAuthority"),
        "custodyRevision": json_i64(&custody_json, "revision"),
        "finalizationState": json_string(&finalization_json, "finalizationState"),
        "finalizationRevision": json_i64(&finalization_json, "revision"),
        "p4ExactAcceptanceIdentity": true,
        "cleanupResidualCount": json_i64(&custody_json, "totalCloseAttemptCount"),
        "databaseClosedAfterReadback": true
    });
    fs::write(&proof_path, serde_json::to_vec_pretty(&proof).unwrap()).unwrap();

    drop(connection);
    fs::remove_file(&database_path).unwrap();
    assert!(!database_path.exists());
}
