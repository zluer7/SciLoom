use crate::markdown_file::{
    inspect_explicit_admission_target, manuscript_physical_revision,
    read_explicit_physical_facts_with_limit,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{State, WebviewWindow};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritableTargetRequest {
    file_ref_id: String,
    file_path: String,
    expected_path_identity: String,
    expected_file_name: String,
    location_mode: String,
    configured_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthoritativeTargetKey {
    file_ref_id: String,
    canonical_path_identity: String,
    physical_identity: String,
}

#[derive(Debug, Clone)]
struct StoredAdmission {
    proof: String,
    caller: String,
    request_id: String,
    logical_session_key: String,
    generation: String,
    target: AuthoritativeTargetKey,
    references: u32,
    renew_sequence: u64,
}

#[derive(Debug)]
struct AdmissionState {
    generation: String,
    active: HashMap<String, StoredAdmission>,
    request_index: HashMap<(String, String), String>,
    released: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritableAdmissionGrant {
    proof: String,
    generation: String,
    logical_session_key: String,
    file_ref_id: String,
    canonical_path_identity: String,
    reference_count: u32,
    renew_sequence: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritableAdmissionValidation {
    valid: bool,
    generation: String,
    reference_count: u32,
    renew_sequence: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritableAdmissionRelease {
    released: bool,
    final_release: bool,
    reference_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritableAdmissionDetach {
    released_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WritableAdmissionError {
    InvalidRequest,
    TargetUnavailable,
    TargetConflict,
    LogicalSessionConflict,
    ProofStale,
    ProofNotOwned,
    TargetChanged,
    InternalFailure,
}

impl WritableAdmissionError {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "MANUSCRIPT_ADMISSION_INVALID_REQUEST",
            Self::TargetUnavailable => "MANUSCRIPT_ADMISSION_TARGET_UNAVAILABLE",
            Self::TargetConflict => "MANUSCRIPT_ADMISSION_TARGET_CONFLICT",
            Self::LogicalSessionConflict => "MANUSCRIPT_ADMISSION_LOGICAL_SESSION_CONFLICT",
            Self::ProofStale => "MANUSCRIPT_ADMISSION_PROOF_STALE",
            Self::ProofNotOwned => "MANUSCRIPT_ADMISSION_PROOF_NOT_OWNED",
            Self::TargetChanged => "MANUSCRIPT_ADMISSION_TARGET_CHANGED",
            Self::InternalFailure => "MANUSCRIPT_ADMISSION_INTERNAL_FAILURE",
        }
    }
}

fn normalized(value: &str) -> Result<String, WritableAdmissionError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.contains('\0') || value.len() > 4_096 {
        return Err(WritableAdmissionError::InvalidRequest);
    }
    Ok(value)
}

fn resolve_target(
    request: &WritableTargetRequest,
) -> Result<AuthoritativeTargetKey, WritableAdmissionError> {
    let file_ref_id = normalized(&request.file_ref_id)?;
    if request.location_mode != "managed" && request.location_mode != "external" {
        return Err(WritableAdmissionError::InvalidRequest);
    }
    let facts = inspect_explicit_admission_target(
        &request.file_path,
        &request.expected_path_identity,
        &request.expected_file_name,
        Some(&request.location_mode),
        request.configured_root.as_deref(),
    )
    .map_err(|_| WritableAdmissionError::TargetUnavailable)?;
    Ok(AuthoritativeTargetKey {
        file_ref_id,
        canonical_path_identity: facts.canonical_path_identity,
        physical_identity: facts.physical_identity,
    })
}

fn targets_conflict(left: &AuthoritativeTargetKey, right: &AuthoritativeTargetKey) -> bool {
    left.file_ref_id == right.file_ref_id
        || left.physical_identity == right.physical_identity
        || left.canonical_path_identity == right.canonical_path_identity
}

pub(crate) struct ManuscriptWritableAdmissionAuthority {
    state: Mutex<AdmissionState>,
}

impl ManuscriptWritableAdmissionAuthority {
    pub(crate) fn from_process_generation(process_generation: Arc<ProcessGeneration>) -> Self {
        Self {
            state: Mutex::new(AdmissionState {
                generation: process_generation.canonical().to_string(),
                active: HashMap::new(),
                request_index: HashMap::new(),
                released: HashMap::new(),
            }),
        }
    }

    #[cfg(test)]
    fn new_for_test(generation: &str) -> Self {
        Self::from_process_generation(Arc::new(ProcessGeneration::fixed_for_test(
            generation,
        )))
    }

    pub(crate) fn admit(
        &self,
        caller: &str,
        request_id: &str,
        logical_session_key: &str,
        request: &WritableTargetRequest,
    ) -> Result<WritableAdmissionGrant, WritableAdmissionError> {
        let caller = normalized(caller)?;
        let request_id = normalized(request_id)?;
        let logical_session_key = normalized(logical_session_key)?;
        let target = resolve_target(request)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| WritableAdmissionError::InternalFailure)?;
        if let Some(proof) = state
            .request_index
            .get(&(caller.clone(), request_id.clone()))
            .cloned()
        {
            let existing = state
                .active
                .get(&proof)
                .ok_or(WritableAdmissionError::ProofStale)?;
            if existing.logical_session_key != logical_session_key || existing.target != target {
                return Err(WritableAdmissionError::InvalidRequest);
            }
            return Ok(grant(existing));
        }
        for existing in state.active.values() {
            if existing.logical_session_key == logical_session_key {
                return Err(WritableAdmissionError::LogicalSessionConflict);
            }
            if targets_conflict(&existing.target, &target) {
                return Err(WritableAdmissionError::TargetConflict);
            }
        }
        let proof = Uuid::new_v4().to_string();
        let generation = state.generation.clone();
        let stored = StoredAdmission {
            proof: proof.clone(),
            caller: caller.clone(),
            request_id: request_id.clone(),
            logical_session_key,
            generation,
            target,
            references: 1,
            renew_sequence: 0,
        };
        let response = grant(&stored);
        state
            .request_index
            .insert((caller, request_id), proof.clone());
        state.active.insert(proof, stored);
        Ok(response)
    }

    pub(crate) fn retain(
        &self,
        caller: &str,
        proof: &str,
    ) -> Result<WritableAdmissionGrant, WritableAdmissionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| WritableAdmissionError::InternalFailure)?;
        let generation = state.generation.clone();
        let admission = active_owned(&mut state, caller, proof)?;
        if admission.generation != generation {
            return Err(WritableAdmissionError::ProofStale);
        }
        admission.references = admission
            .references
            .checked_add(1)
            .ok_or(WritableAdmissionError::InternalFailure)?;
        Ok(grant(admission))
    }

    pub(crate) fn validate(
        &self,
        caller: &str,
        proof: &str,
        request: &WritableTargetRequest,
        renew: bool,
    ) -> Result<WritableAdmissionValidation, WritableAdmissionError> {
        let target = resolve_target(request)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| WritableAdmissionError::InternalFailure)?;
        let generation = state.generation.clone();
        let admission = active_owned(&mut state, caller, proof)?;
        if admission.generation != generation {
            return Err(WritableAdmissionError::ProofStale);
        }
        if admission.target != target {
            return Err(WritableAdmissionError::TargetChanged);
        }
        if renew {
            admission.renew_sequence = admission
                .renew_sequence
                .checked_add(1)
                .ok_or(WritableAdmissionError::InternalFailure)?;
        }
        Ok(WritableAdmissionValidation {
            valid: true,
            generation,
            reference_count: admission.references,
            renew_sequence: admission.renew_sequence,
        })
    }

    pub(crate) fn refresh_after_write(
        &self,
        caller: &str,
        proof: &str,
        request: &WritableTargetRequest,
        expected_revision: &str,
    ) -> Result<WritableAdmissionValidation, WritableAdmissionError> {
        let expected_revision = normalized(expected_revision)?;
        if !expected_revision.starts_with("manuscript-physical-v2:") {
            return Err(WritableAdmissionError::InvalidRequest);
        }
        let target = resolve_target(request)?;
        let (bytes, metadata, readback_physical_identity) =
            read_explicit_physical_facts_with_limit(
                Path::new(request.file_path.trim()),
                16 * 1024 * 1024,
            )
            .map_err(|_| WritableAdmissionError::TargetUnavailable)?;
        if readback_physical_identity != target.physical_identity {
            return Err(WritableAdmissionError::TargetChanged);
        }
        let actual_revision = manuscript_physical_revision(
            &target.canonical_path_identity,
            &readback_physical_identity,
            &metadata,
            &bytes,
        )
        .map_err(|_| WritableAdmissionError::InternalFailure)?;
        if actual_revision != expected_revision {
            return Err(WritableAdmissionError::TargetChanged);
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| WritableAdmissionError::InternalFailure)?;
        let generation = state.generation.clone();
        let current = state
            .active
            .get(proof)
            .cloned()
            .ok_or(WritableAdmissionError::ProofStale)?;
        if current.caller != caller {
            return Err(WritableAdmissionError::ProofNotOwned);
        }
        if current.generation != generation {
            return Err(WritableAdmissionError::ProofStale);
        }
        if current.target.file_ref_id != target.file_ref_id
            || current.target.canonical_path_identity != target.canonical_path_identity
        {
            return Err(WritableAdmissionError::TargetChanged);
        }
        if state
            .active
            .iter()
            .any(|(other_proof, other)| other_proof != proof && targets_conflict(&other.target, &target))
        {
            return Err(WritableAdmissionError::TargetConflict);
        }
        let admission = state
            .active
            .get_mut(proof)
            .ok_or(WritableAdmissionError::ProofStale)?;
        admission.target = target;
        admission.renew_sequence = admission
            .renew_sequence
            .checked_add(1)
            .ok_or(WritableAdmissionError::InternalFailure)?;
        Ok(WritableAdmissionValidation {
            valid: true,
            generation,
            reference_count: admission.references,
            renew_sequence: admission.renew_sequence,
        })
    }

    pub(crate) fn release(
        &self,
        caller: &str,
        proof: &str,
    ) -> Result<WritableAdmissionRelease, WritableAdmissionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| WritableAdmissionError::InternalFailure)?;
        if let Some(owner) = state.released.get(proof) {
            return if owner == caller {
                Ok(WritableAdmissionRelease {
                    released: false,
                    final_release: true,
                    reference_count: 0,
                })
            } else {
                Err(WritableAdmissionError::ProofNotOwned)
            };
        }
        let generation = state.generation.clone();
        let admission = state
            .active
            .get_mut(proof)
            .ok_or(WritableAdmissionError::ProofStale)?;
        if admission.caller != caller {
            return Err(WritableAdmissionError::ProofNotOwned);
        }
        if admission.generation != generation {
            return Err(WritableAdmissionError::ProofStale);
        }
        if admission.references > 1 {
            admission.references -= 1;
            return Ok(WritableAdmissionRelease {
                released: true,
                final_release: false,
                reference_count: admission.references,
            });
        }
        let admission = state
            .active
            .remove(proof)
            .ok_or(WritableAdmissionError::ProofStale)?;
        state
            .request_index
            .remove(&(admission.caller.clone(), admission.request_id));
        state
            .released
            .insert(admission.proof, admission.caller);
        Ok(WritableAdmissionRelease {
            released: true,
            final_release: true,
            reference_count: 0,
        })
    }

    pub(crate) fn detach_caller(&self, caller: &str) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let proofs: Vec<_> = state
            .active
            .values()
            .filter(|admission| admission.caller == caller)
            .map(|admission| admission.proof.clone())
            .collect();
        for proof in &proofs {
            if let Some(admission) = state.active.remove(proof) {
                state
                    .request_index
                    .remove(&(admission.caller.clone(), admission.request_id));
                state
                    .released
                    .insert(admission.proof, admission.caller);
            }
        }
        proofs.len()
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.active.len())
            .unwrap_or_default()
    }
}

fn active_owned<'a>(
    state: &'a mut AdmissionState,
    caller: &str,
    proof: &str,
) -> Result<&'a mut StoredAdmission, WritableAdmissionError> {
    let admission = state
        .active
        .get_mut(proof)
        .ok_or(WritableAdmissionError::ProofStale)?;
    if admission.caller != caller {
        return Err(WritableAdmissionError::ProofNotOwned);
    }
    Ok(admission)
}

fn grant(admission: &StoredAdmission) -> WritableAdmissionGrant {
    WritableAdmissionGrant {
        proof: admission.proof.clone(),
        generation: admission.generation.clone(),
        logical_session_key: admission.logical_session_key.clone(),
        file_ref_id: admission.target.file_ref_id.clone(),
        canonical_path_identity: admission.target.canonical_path_identity.clone(),
        reference_count: admission.references,
        renew_sequence: admission.renew_sequence,
    }
}

fn command_error(error: WritableAdmissionError) -> String {
    error.code().to_string()
}

#[tauri::command]
pub(crate) fn manuscript_writable_admit<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    authority: State<'_, Arc<ManuscriptWritableAdmissionAuthority>>,
    request_id: String,
    logical_session_key: String,
    target: WritableTargetRequest,
) -> Result<WritableAdmissionGrant, String> {
    authority
        .admit(window.label(), &request_id, &logical_session_key, &target)
        .map_err(command_error)
}

#[tauri::command]
pub(crate) fn manuscript_writable_retain<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    authority: State<'_, Arc<ManuscriptWritableAdmissionAuthority>>,
    proof: String,
) -> Result<WritableAdmissionGrant, String> {
    authority.retain(window.label(), &proof).map_err(command_error)
}

#[tauri::command]
pub(crate) fn manuscript_writable_validate<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    authority: State<'_, Arc<ManuscriptWritableAdmissionAuthority>>,
    proof: String,
    target: WritableTargetRequest,
) -> Result<WritableAdmissionValidation, String> {
    authority
        .validate(window.label(), &proof, &target, false)
        .map_err(command_error)
}

#[tauri::command]
pub(crate) fn manuscript_writable_renew<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    authority: State<'_, Arc<ManuscriptWritableAdmissionAuthority>>,
    proof: String,
    target: WritableTargetRequest,
    expected_revision: Option<String>,
) -> Result<WritableAdmissionValidation, String> {
    match expected_revision {
        Some(revision) => authority
            .refresh_after_write(window.label(), &proof, &target, &revision),
        None => authority.validate(window.label(), &proof, &target, true),
    }
    .map_err(command_error)
}

#[tauri::command]
pub(crate) fn manuscript_writable_release<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    authority: State<'_, Arc<ManuscriptWritableAdmissionAuthority>>,
    proof: String,
) -> Result<WritableAdmissionRelease, String> {
    authority.release(window.label(), &proof).map_err(command_error)
}

#[tauri::command]
pub(crate) fn manuscript_writable_detach_window<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    authority: State<'_, Arc<ManuscriptWritableAdmissionAuthority>>,
) -> WritableAdmissionDetach {
    WritableAdmissionDetach {
        released_count: authority.detach_caller(window.label()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioning::path_for_result;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::webview::InvokeRequest;

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("labpod-t2-admission-{label}-{nonce}"))
    }

    fn target(root: &PathBuf, file_ref_id: &str, name: &str) -> WritableTargetRequest {
        let file = root.join(name);
        fs::write(&file, "raw").expect("write fixture");
        let canonical = fs::canonicalize(&file).expect("canonical fixture");
        let mut identity = path_for_result(&canonical).replace('\\', "/");
        if cfg!(windows) {
            identity = identity.to_lowercase();
        }
        WritableTargetRequest {
            file_ref_id: file_ref_id.into(),
            file_path: path_for_result(&canonical),
            expected_path_identity: identity,
            expected_file_name: name.into(),
            location_mode: "managed".into(),
            configured_root: Some(path_for_result(root)),
        }
    }

    fn admit_ipc_request(
        request_id: &str,
        logical_session_key: &str,
        target: &WritableTargetRequest,
    ) -> InvokeRequest {
        InvokeRequest {
            cmd: "manuscript_writable_admit".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("IPC URL"),
            body: InvokeBody::Json(serde_json::json!({
                "requestId": request_id,
                "logicalSessionKey": logical_session_key,
                "target": {
                    "fileRefId": target.file_ref_id,
                    "filePath": target.file_path,
                    "expectedPathIdentity": target.expected_path_identity,
                    "expectedFileName": target.expected_file_name,
                    "locationMode": target.location_mode,
                    "configuredRoot": target.configured_root
                }
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn two_webviews_through_real_tauri_ipc_cannot_admit_the_same_target() {
        let root = test_root("two-webview-ipc");
        fs::create_dir_all(&root).expect("root");
        let request = target(&root, "file-a", "a.md");
        let authority = Arc::new(ManuscriptWritableAdmissionAuthority::new_for_test(
            "process-ipc",
        ));
        let app = tauri::test::mock_builder()
            .manage(authority.clone())
            .invoke_handler(tauri::generate_handler![manuscript_writable_admit])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let first =
            tauri::WebviewWindowBuilder::new(&app, "window-a", Default::default())
                .build()
                .expect("first WebView");
        let second =
            tauri::WebviewWindowBuilder::new(&app, "window-b", Default::default())
                .build()
                .expect("second WebView");

        let first_response = tauri::test::get_ipc_response(
            &first,
            admit_ipc_request("request-a", "logical-a", &request),
        )
        .expect("first writer admitted")
        .deserialize::<serde_json::Value>()
        .expect("grant JSON");
        assert_eq!(first_response["fileRefId"], "file-a");

        let second_response = tauri::test::get_ipc_response(
            &second,
            admit_ipc_request("request-b", "logical-b", &request),
        )
        .expect_err("second WebView must be rejected");
        assert_eq!(
            second_response,
            serde_json::Value::String("MANUSCRIPT_ADMISSION_TARGET_CONFLICT".into())
        );
        assert_eq!(authority.active_count(), 1);
        assert_eq!(authority.detach_caller("window-a"), 1);
        assert_eq!(authority.detach_caller("window-b"), 0);
        assert_eq!(authority.active_count(), 0);
        first.close().expect("close first test WebView");
        second.close().expect("close second test WebView");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn simultaneous_same_target_has_one_winner_and_different_targets_run_concurrently() {
        let root = test_root("concurrency");
        fs::create_dir_all(&root).expect("root");
        let same = target(&root, "file-a", "a.md");
        let other = target(&root, "file-b", "b.md");
        let authority = Arc::new(ManuscriptWritableAdmissionAuthority::new_for_test("process-a"));
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = ["window-a", "window-b"]
            .into_iter()
            .map(|caller| {
                let authority = authority.clone();
                let barrier = barrier.clone();
                let same = same.clone();
                thread::spawn(move || {
                    barrier.wait();
                    authority.admit(caller, caller, caller, &same)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().expect("join"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(authority.active_count(), 1);
        assert!(authority
            .admit("window-c", "request-c", "logical-c", &other)
            .is_ok());
        assert_eq!(authority.active_count(), 2);
        authority.detach_caller("window-a");
        authority.detach_caller("window-b");
        authority.detach_caller("window-c");
        assert_eq!(authority.active_count(), 0);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn aliases_stale_proofs_references_detach_and_restart_are_closed() {
        let root = test_root("lifecycle");
        fs::create_dir_all(&root).expect("root");
        let original = target(&root, "file-a", "a.md");
        let authority = ManuscriptWritableAdmissionAuthority::new_for_test("process-a");
        let grant = authority
            .admit("window-a", "request-a", "logical-a", &original)
            .expect("admit");
        let retry = authority
            .admit("window-a", "request-a", "logical-a", &original)
            .expect("response-loss retry");
        assert_eq!(grant.proof, retry.proof);
        assert_eq!(retry.reference_count, 1);
        assert_eq!(
            authority
                .admit("window-b", "request-b", "logical-b", &original)
                .expect_err("same physical target"),
            WritableAdmissionError::TargetConflict
        );
        authority.retain("window-a", &grant.proof).expect("retain");
        assert_eq!(
            authority.release("window-a", &grant.proof).expect("release").reference_count,
            1
        );
        assert_eq!(authority.detach_caller("window-a"), 1);
        assert_eq!(
            authority
                .validate("window-a", &grant.proof, &original, false)
                .expect_err("detached proof"),
            WritableAdmissionError::ProofStale
        );
        assert_eq!(authority.active_count(), 0);
        let restarted = ManuscriptWritableAdmissionAuthority::new_for_test("process-b");
        assert_eq!(restarted.active_count(), 0);
        assert_eq!(
            restarted
                .validate("window-a", &grant.proof, &original, false)
                .expect_err("old process proof"),
            WritableAdmissionError::ProofStale
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn physical_replacement_invalidates_proof_and_timeout_never_transfers_writer() {
        let root = test_root("replacement");
        fs::create_dir_all(&root).expect("root");
        let request = target(&root, "file-a", "a.md");
        let authority = ManuscriptWritableAdmissionAuthority::new_for_test("process-a");
        let grant = authority
            .admit("window-a", "request-a", "logical-a", &request)
            .expect("admit");
        thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(
            authority
                .admit("window-b", "request-b", "logical-b", &request)
                .expect_err("time alone cannot transfer"),
            WritableAdmissionError::TargetConflict
        );
        let displaced = root.join("old.md");
        fs::rename(root.join("a.md"), &displaced).expect("displace");
        fs::write(root.join("a.md"), "raw").expect("replacement");
        assert_eq!(
            authority
                .validate("window-a", &grant.proof, &request, false)
                .expect_err("physical replacement"),
            WritableAdmissionError::TargetChanged
        );
        assert_eq!(authority.detach_caller("window-a"), 1);
        assert_eq!(authority.active_count(), 0);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn authoritative_post_write_revision_refreshes_only_the_owned_replacement() {
        let root = test_root("post-write-refresh");
        fs::create_dir_all(&root).expect("root");
        let request = target(&root, "file-a", "a.md");
        let authority = ManuscriptWritableAdmissionAuthority::new_for_test("process-a");
        let grant = authority
            .admit("window-a", "request-a", "logical-a", &request)
            .expect("admit");

        fs::remove_file(root.join("a.md")).expect("remove old identity");
        fs::write(root.join("a.md"), "owned replacement").expect("owned replacement");
        assert_eq!(
            authority
                .validate("window-a", &grant.proof, &request, false)
                .expect_err("old proof target must be stale"),
            WritableAdmissionError::TargetChanged
        );
        let target_after_write = resolve_target(&request).expect("target after write");
        let (bytes, metadata, physical_identity) = read_explicit_physical_facts_with_limit(
            Path::new(&request.file_path),
            16 * 1024 * 1024,
        )
        .expect("authoritative readback");
        let revision = manuscript_physical_revision(
            &target_after_write.canonical_path_identity,
            &physical_identity,
            &metadata,
            &bytes,
        )
        .expect("canonical revision");
        let refreshed = authority
            .refresh_after_write("window-a", &grant.proof, &request, &revision)
            .expect("refresh owned replacement");
        assert_eq!(refreshed.renew_sequence, 1);
        authority
            .validate("window-a", &grant.proof, &request, false)
            .expect("refreshed proof validates");

        fs::remove_file(root.join("a.md")).expect("remove owned identity");
        fs::write(root.join("a.md"), "external replacement").expect("external replacement");
        assert_eq!(
            authority
                .refresh_after_write("window-a", &grant.proof, &request, &revision)
                .expect_err("stale revision cannot bless external replacement"),
            WritableAdmissionError::TargetChanged
        );
        assert_eq!(
            authority
                .validate("window-a", &grant.proof, &request, false)
                .expect_err("external replacement remains rejected"),
            WritableAdmissionError::TargetChanged
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn t7_isolated_sqlite_managed_root_and_admission_resources_cleanup_without_side_effects() {
        let root = test_root("t7-isolated-acceptance");
        let managed_root = root.join("managed");
        fs::create_dir_all(&managed_root).expect("isolated managed root");
        assert!(
            root.starts_with(std::env::temp_dir()),
            "T7 acceptance must stay inside the OS temporary root"
        );

        let sqlite_path = root.join("acceptance.sqlite");
        let connection = Connection::open(&sqlite_path).expect("isolated SQLite");
        connection
            .execute_batch(
                "CREATE TABLE canary (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO canary (id, value) VALUES (1, 'unchanged');",
            )
            .expect("seed isolated canary");

        let request = target(&managed_root, "file-t7", "t7.md");
        let authority =
            ManuscriptWritableAdmissionAuthority::new_for_test("t7-isolated-process");
        let grant = authority
            .admit("t7-webview", "t7-request", "t7-logical", &request)
            .expect("isolated admission");
        assert_eq!(authority.active_count(), 1);
        assert_eq!(
            connection
                .query_row("SELECT value FROM canary WHERE id = 1", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("read canary"),
            "unchanged"
        );
        assert_eq!(
            authority
                .release("t7-webview", &grant.proof)
                .expect("final release")
                .reference_count,
            0
        );
        assert_eq!(authority.active_count(), 0);

        drop(connection);
        fs::remove_dir_all(&root).expect("isolated resource cleanup");
        assert!(!root.exists(), "temporary T7 root must be removable");
    }
}
