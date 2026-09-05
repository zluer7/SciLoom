use crate::db::manuscript_save_as_operation::{
    expectation_from_record, readback_in_connection, transition_in_connection, SaveAsCommitState,
    SaveAsFailureCode, SaveAsOperationMutation, SaveAsOperationRecord, SaveAsOperationStage,
    SaveAsOperationTransitionInput,
};
use crate::manuscript_save_as_target_guard::{
    ManuscriptSaveAsTargetGuardAuthority, SaveAsTargetCandidate,
};
use crate::markdown_file::{
    manuscript_physical_revision, read_explicit_physical_facts_with_limit,
};
use crate::physical_freshness::{inspect_save_as_physical_path, save_as_path_identity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State, WebviewWindow};

const MAX_SAVE_AS_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD1SourceProof {
    operation_id: String,
    operation_generation: i64,
    process_generation: String,
    source_path_identity_key: String,
    source_revision: String,
    source_runtime_generation: i64,
    snapshot_sha256: String,
    snapshot_byte_length: i64,
    encoding_contract_version: String,
    newline_contract_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD1ClaimIdentity {
    claim_token: String,
    claim_revision: i64,
    claim_process_generation: String,
    observation_generation: i64,
    observation_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD1Request {
    source: SaveAsD1SourceProof,
    target: SaveAsTargetCandidate,
    j0_revision: i64,
    claim_identity: SaveAsD1ClaimIdentity,
    guard_proof: String,
    frozen_raw_text: String,
    source_physical_identity_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD1Proof {
    normalized_target_identity: String,
    physical_target_identity_hash: String,
    d1_readback_sha256: String,
    d1_readback_revision: String,
    byte_length: usize,
    encoding_contract_version: String,
    newline_contract_version: String,
    proof_generation: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsD1Result {
    proof: SaveAsD1Proof,
    readback_text: String,
    write_applied: bool,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn path_identity(value: &str) -> String {
    save_as_path_identity(value)
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn validate_snapshot(request: &SaveAsD1Request) -> Result<&[u8], String> {
    let bytes = request.frozen_raw_text.as_bytes();
    if request.source.operation_id.trim().is_empty()
        || request.source.operation_generation <= 0
        || request.source.process_generation.trim().is_empty()
        || request.source.source_revision.trim().is_empty()
        || request.source.source_runtime_generation < 0
        || request.source.snapshot_byte_length != bytes.len() as i64
        || !valid_hash(&request.source.snapshot_sha256)
        || sha256(bytes) != request.source.snapshot_sha256
        || request.source.encoding_contract_version.trim().is_empty()
        || request.source.newline_contract_version.trim().is_empty()
        || bytes.len() > MAX_SAVE_AS_BYTES
    {
        return Err("SAVE_AS_SOURCE_SNAPSHOT_INVALID".to_string());
    }
    if request.source.source_path_identity_key == request.target.path_identity_key {
        return Err("SAVE_AS_SOURCE_TARGET_SAME_PATH".to_string());
    }
    Ok(bytes)
}

fn validate_j0(
    app_handle: &AppHandle,
    request: &SaveAsD1Request,
) -> Result<SaveAsOperationRecord, String> {
    let connection = crate::db::open_connection(app_handle)?;
    let record = readback_in_connection(&connection, &request.source.operation_id)?
        .ok_or_else(|| "SAVE_AS_J0_CAS_CONFLICT".to_string())?;
    if record.revision != request.j0_revision
        || record.operation_generation != request.source.operation_generation
        || record.producer_process_generation != request.source.process_generation
        || record.source_path_identity_key != request.source.source_path_identity_key
        || record.source_revision != request.source.source_revision
        || record.source_runtime_generation != request.source.source_runtime_generation
        || record.snapshot_sha256 != request.source.snapshot_sha256
        || record.snapshot_byte_length != request.source.snapshot_byte_length
        || record.encoding_contract_version != request.source.encoding_contract_version
        || record.newline_contract_version != request.source.newline_contract_version
        || record.target_path_identity_key != request.target.path_identity_key
        || record.target_parent_path_identity_key != request.target.parent_path_identity_key
        || record.target_parent_physical_identity_hash
            != request.target.parent_physical_identity_hash
        || record.stage != SaveAsOperationStage::PreD1Claimed
        || record.d1_commit_state != SaveAsCommitState::NotStarted
        || record.claim_token.as_deref() != Some(&request.claim_identity.claim_token)
        || record.claim_revision != Some(request.claim_identity.claim_revision)
        || record.claim_process_generation.as_deref()
            != Some(&request.claim_identity.claim_process_generation)
        || record.observation_generation != Some(request.claim_identity.observation_generation)
        || record.observation_revision != Some(request.claim_identity.observation_revision)
    {
        return Err("SAVE_AS_J0_CAS_CONFLICT".to_string());
    }
    Ok(record)
}

fn preflight_target(request: &SaveAsD1Request) -> Result<(), String> {
    let target_path = Path::new(&request.target.display_path);
    let before = inspect_save_as_physical_path(target_path)
        .map_err(|_| "SAVE_AS_TARGET_CANDIDATE_INVALID".to_string())?;
    if before.target_physical_identity_hash.is_some() {
        return Err("SAVE_AS_TARGET_ALREADY_EXISTS".to_string());
    }
    if path_identity(&before.normalized_target_path) != request.target.path_identity_key
        || path_identity(&before.normalized_parent_path) != request.target.parent_path_identity_key
        || before.parent_physical_identity_hash != request.target.parent_physical_identity_hash
    {
        return Err("SAVE_AS_TARGET_CANDIDATE_INVALID".to_string());
    }
    Ok(())
}

fn create_new_with_readback(request: &SaveAsD1Request) -> Result<SaveAsD1Result, String> {
    let bytes = validate_snapshot(request)?;
    let target_path = Path::new(&request.target.display_path);
    preflight_target(request)?;

    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target_path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => "SAVE_AS_TARGET_ALREADY_EXISTS".to_string(),
            std::io::ErrorKind::PermissionDenied => "SAVE_AS_PERMISSION_DENIED".to_string(),
            std::io::ErrorKind::NotFound => "SAVE_AS_PARENT_MISSING".to_string(),
            _ => "SAVE_AS_PATH_INVALID".to_string(),
        })?;
    writer
        .write_all(bytes)
        .map_err(|_| "SAVE_AS_D1_WRITE_FAILED".to_string())?;
    writer
        .flush()
        .map_err(|_| "SAVE_AS_D1_FLUSH_FAILED".to_string())?;
    writer
        .sync_all()
        .map_err(|_| "SAVE_AS_D1_SYNC_FAILED".to_string())?;
    drop(writer);

    let (readback, metadata, physical_identity) = read_explicit_physical_facts_with_limit(
        target_path,
        (MAX_SAVE_AS_BYTES + 1) as u64,
    )
    .map_err(|_| "SAVE_AS_D1_READBACK_FAILED".to_string())?;
    if readback.len() > MAX_SAVE_AS_BYTES || readback.len() != bytes.len() || readback != bytes {
        return Err("SAVE_AS_D1_READBACK_MISMATCH".to_string());
    }
    let readback_text =
        String::from_utf8(readback).map_err(|_| "SAVE_AS_ENCODING_NEWLINE_MISMATCH".to_string())?;
    let after = inspect_save_as_physical_path(target_path)
        .map_err(|_| "SAVE_AS_D1_READBACK_FAILED".to_string())?;
    let physical_target_identity_hash = after
        .target_physical_identity_hash
        .ok_or_else(|| "SAVE_AS_D1_READBACK_FAILED".to_string())?;
    if request
        .source_physical_identity_hash
        .as_deref()
        .is_some_and(|source| source == physical_target_identity_hash)
    {
        return Err("SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL".to_string());
    }
    let readback_sha256 = sha256(readback_text.as_bytes());
    if readback_sha256 != request.source.snapshot_sha256 {
        return Err("SAVE_AS_D1_READBACK_MISMATCH".to_string());
    }
    let readback_revision = manuscript_physical_revision(
        &request.target.path_identity_key,
        &physical_identity,
        &metadata,
        readback_text.as_bytes(),
    )
    .map_err(|_| "SAVE_AS_D1_READBACK_FAILED".to_string())?;
    Ok(SaveAsD1Result {
        proof: SaveAsD1Proof {
            normalized_target_identity: request.target.path_identity_key.clone(),
            physical_target_identity_hash,
            d1_readback_sha256: readback_sha256,
            d1_readback_revision: readback_revision,
            byte_length: bytes.len(),
            encoding_contract_version: request.source.encoding_contract_version.clone(),
            newline_contract_version: request.source.newline_contract_version.clone(),
            proof_generation: request.source.operation_generation,
        },
        readback_text,
        write_applied: true,
    })
}

fn transition_j0_unknown(
    app_handle: &AppHandle,
    current: &SaveAsOperationRecord,
) -> Result<SaveAsOperationRecord, String> {
    let mut connection = crate::db::open_connection(app_handle)?;
    transition_in_connection(
        &mut connection,
        &SaveAsOperationTransitionInput {
            operation_id: current.operation_id.clone(),
            expected: expectation_from_record(current),
            mutation: SaveAsOperationMutation::EnterD1CommitUnknown,
        },
    )
    .map_err(|error| error.code.to_string())
}

fn transition_j0_confirmed(
    app_handle: &AppHandle,
    current: &SaveAsOperationRecord,
    proof: &SaveAsD1Proof,
) -> Result<SaveAsOperationRecord, String> {
    let mut connection = crate::db::open_connection(app_handle)?;
    transition_in_connection(
        &mut connection,
        &SaveAsOperationTransitionInput {
            operation_id: current.operation_id.clone(),
            expected: expectation_from_record(current),
            mutation: SaveAsOperationMutation::ConfirmD1 {
                d1_physical_identity_hash: proof.physical_target_identity_hash.clone(),
                d1_readback_sha256: proof.d1_readback_sha256.clone(),
                d1_readback_revision: proof.d1_readback_revision.clone(),
                d1_byte_length: proof.byte_length as i64,
                d1_proof_generation: proof.proof_generation,
            },
        },
    )
    .map_err(|error| error.code.to_string())
}

fn transition_j0_no_effect(
    app_handle: &AppHandle,
    current: &SaveAsOperationRecord,
    failure: SaveAsFailureCode,
) -> Result<SaveAsOperationRecord, String> {
    let mut connection = crate::db::open_connection(app_handle)?;
    transition_in_connection(
        &mut connection,
        &SaveAsOperationTransitionInput {
            operation_id: current.operation_id.clone(),
            expected: expectation_from_record(current),
            mutation: SaveAsOperationMutation::BlockReconciliation {
                blocking_code: failure,
            },
        },
    )
    .map_err(|error| error.code.to_string())
}

#[tauri::command]
pub(crate) fn save_as_create_new_with_readback(
    app_handle: AppHandle,
    window: WebviewWindow,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    input: SaveAsD1Request,
) -> Result<SaveAsD1Result, String> {
    validate_snapshot(&input)?;
    if let Err(error) = preflight_target(&input) {
        authority.release_after_effect(window.label(), &input.guard_proof)?;
        return Err(error);
    }
    let claimed = match validate_j0(&app_handle, &input) {
        Ok(record) => record,
        Err(error) => {
            authority.release_after_effect(window.label(), &input.guard_proof)?;
            return Err(error);
        }
    };
    let unknown = match transition_j0_unknown(&app_handle, &claimed) {
        Ok(record) => record,
        Err(error) => {
            authority.release_after_effect(window.label(), &input.guard_proof)?;
            return Err(error);
        }
    };
    if let Err(error) =
        authority.mark_effect_boundary(window.label(), &input.guard_proof, &input.target)
    {
        transition_j0_no_effect(&app_handle, &unknown, SaveAsFailureCode::SaveAsGuardStale)?;
        return Err(error);
    }
    let result = create_new_with_readback(&input);
    match &result {
        Ok(value) => {
            transition_j0_confirmed(&app_handle, &unknown, &value.proof)?;
            authority.release_after_effect(window.label(), &input.guard_proof)?
        }
        Err(code)
            if matches!(
                code.as_str(),
                "SAVE_AS_TARGET_ALREADY_EXISTS"
                    | "SAVE_AS_PARENT_MISSING"
                    | "SAVE_AS_PERMISSION_DENIED"
                    | "SAVE_AS_PATH_INVALID"
                    | "SAVE_AS_TARGET_CANDIDATE_INVALID"
            ) =>
        {
            let failure = match code.as_str() {
                "SAVE_AS_TARGET_ALREADY_EXISTS" => SaveAsFailureCode::SaveAsTargetAlreadyExists,
                "SAVE_AS_PARENT_MISSING" => SaveAsFailureCode::SaveAsParentMissing,
                "SAVE_AS_PERMISSION_DENIED" => SaveAsFailureCode::SaveAsPermissionDenied,
                "SAVE_AS_PATH_INVALID" => SaveAsFailureCode::SaveAsPathInvalid,
                _ => SaveAsFailureCode::SaveAsTargetCandidateInvalid,
            };
            transition_j0_no_effect(&app_handle, &unknown, failure)?;
            authority.release_after_effect(window.label(), &input.guard_proof)?
        }
        Err(_) => {}
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn target_path() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("labpod-ip1-d1-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root.join("target.md")
    }

    fn request(path: &Path, parent_hash: String) -> SaveAsD1Request {
        let text = "# exact\r\n";
        let target_identity = path_identity(&path.to_string_lossy());
        let parent_identity = path_identity(&path.parent().unwrap().to_string_lossy());
        SaveAsD1Request {
            source: SaveAsD1SourceProof {
                operation_id: "operation".into(),
                operation_generation: 1,
                process_generation: "process".into(),
                source_path_identity_key: "n:/source.md".into(),
                source_revision: "r1".into(),
                source_runtime_generation: 1,
                snapshot_sha256: sha256(text.as_bytes()),
                snapshot_byte_length: text.len() as i64,
                encoding_contract_version: "utf-8-v1".into(),
                newline_contract_version: "crlf-v1".into(),
            },
            target: SaveAsTargetCandidate {
                display_path: path.to_string_lossy().to_string(),
                normalized_path: target_identity.clone(),
                path_identity_key: target_identity,
                parent_path_identity_key: parent_identity,
                parent_physical_identity_hash: parent_hash,
                normalized_final_filename: "target.md".into(),
                location_mode: "external".into(),
            },
            j0_revision: 2,
            claim_identity: SaveAsD1ClaimIdentity {
                claim_token: "claim".into(),
                claim_revision: 2,
                claim_process_generation: "process".into(),
                observation_generation: 1,
                observation_revision: 1,
            },
            guard_proof: "guard".into(),
            frozen_raw_text: text.into(),
            source_physical_identity_hash: None,
        }
    }

    #[test]
    fn direct_final_target_create_new_has_exact_readback_and_physical_proof() {
        let path = target_path();
        let before = inspect_save_as_physical_path(&path).unwrap();
        let value = request(&path, before.parent_physical_identity_hash);
        let result = create_new_with_readback(&value).unwrap();
        assert_eq!(result.readback_text, value.frozen_raw_text);
        assert_eq!(
            result.proof.d1_readback_sha256,
            value.source.snapshot_sha256
        );
        assert!(result
            .proof
            .d1_readback_revision
            .starts_with("manuscript-physical-v2:"));
        assert_ne!(
            result.proof.d1_readback_revision,
            result.proof.d1_readback_sha256
        );
        assert!(valid_hash(&result.proof.physical_target_identity_hash));
        let parent = path.parent().unwrap().to_path_buf();
        fs::remove_file(&path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn existing_final_target_is_never_overwritten() {
        let path = target_path();
        fs::write(&path, "external").unwrap();
        let observation = inspect_save_as_physical_path(&path).unwrap();
        let request = request(&path, observation.parent_physical_identity_hash);
        assert_eq!(
            create_new_with_readback(&request),
            Err("SAVE_AS_TARGET_ALREADY_EXISTS".into())
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        let parent = path.parent().unwrap().to_path_buf();
        fs::remove_file(&path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn invalid_snapshot_has_zero_filesystem_effect() {
        let path = target_path();
        let before = inspect_save_as_physical_path(&path).unwrap();
        let mut request = request(&path, before.parent_physical_identity_hash);
        request.source.snapshot_sha256 = "0".repeat(64);
        assert_eq!(
            create_new_with_readback(&request),
            Err("SAVE_AS_SOURCE_SNAPSHOT_INVALID".into())
        );
        assert!(!path.exists());
        fs::remove_dir(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn save_as_revision_drives_two_ordinary_saves_and_preserves_true_conflicts() {
        let parent = std::env::temp_dir().join(format!(
            "labpod d1c 中文 {}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("target copy 中文.md");
        let before = inspect_save_as_physical_path(&path).unwrap();
        let request = request(&path, before.parent_physical_identity_hash);
        let created = create_new_with_readback(&request).unwrap();
        let file_path = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap()
            .to_string();
        let target_identity = path_identity(&file_path);

        let first = crate::markdown_file::save_explicit_manuscript_file_atomic(
            file_path.clone(),
            target_identity.clone(),
            file_name.clone(),
            created.proof.d1_readback_revision.clone(),
            "# first target edit\r\n".into(),
            "external".into(),
            None,
        );
        let first = serde_json::to_value(first).unwrap();
        assert_eq!(first["status"], "success");
        assert_eq!(first["writeApplied"], true);
        let first_revision = first["revision"].as_str().unwrap();
        assert!(first_revision.starts_with("manuscript-physical-v2:"));

        let same_content = crate::markdown_file::save_explicit_manuscript_file_atomic(
            file_path.clone(),
            target_identity.clone(),
            file_name.clone(),
            first_revision.into(),
            "# first target edit\r\n".into(),
            "external".into(),
            None,
        );
        let same_content = serde_json::to_value(same_content).unwrap();
        assert_eq!(same_content["status"], "success");
        assert_eq!(same_content["writeApplied"], false);
        assert_eq!(same_content["revision"], first_revision);

        let second = crate::markdown_file::save_explicit_manuscript_file_atomic(
            file_path.clone(),
            target_identity.clone(),
            file_name.clone(),
            first_revision.into(),
            "# second target edit\n中文 and spaces\n".into(),
            "external".into(),
            None,
        );
        let second = serde_json::to_value(second).unwrap();
        assert_eq!(second["status"], "success");
        assert_eq!(second["writeApplied"], true);
        let second_revision = second["revision"].as_str().unwrap().to_string();
        assert!(second_revision.starts_with("manuscript-physical-v2:"));

        fs::write(&path, "# external authoritative edit\n").unwrap();
        let conflict = crate::markdown_file::save_explicit_manuscript_file_atomic(
            file_path,
            target_identity,
            file_name,
            second_revision,
            "# draft that must not overwrite external\n".into(),
            "external".into(),
            None,
        );
        let conflict = serde_json::to_value(conflict).unwrap();
        assert_eq!(conflict["status"], "error");
        assert_eq!(conflict["errorCode"], "MANUSCRIPT_REVISION_CONFLICT");
        assert_eq!(conflict["writeApplied"], false);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# external authoritative edit\n"
        );

        fs::remove_file(&path).unwrap();
        fs::remove_dir(parent).unwrap();
    }
}
