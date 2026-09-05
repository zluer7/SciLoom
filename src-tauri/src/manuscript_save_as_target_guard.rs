use crate::provisioning_runtime_foundation::ProcessGeneration;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{State, WebviewWindow};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsTargetCandidate {
    pub display_path: String,
    pub normalized_path: String,
    pub path_identity_key: String,
    pub parent_path_identity_key: String,
    pub parent_physical_identity_hash: String,
    pub normalized_final_filename: String,
    pub location_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GuardTargetKey {
    path_identity_key: String,
    canonical_parent_path_identity: String,
    parent_physical_identity_hash: String,
    normalized_final_filename: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GuardHolderIdentity {
    operation_id: String,
    operation_generation: u64,
    process_generation: String,
    proof: String,
}

#[derive(Debug, Clone)]
struct StoredGuard {
    target: GuardTargetKey,
    target_metadata: SaveAsTargetCandidate,
    holder: GuardHolderIdentity,
    caller: String,
    reference_count: u32,
    crossed_effect_boundary: bool,
}

#[derive(Debug, Default)]
struct GuardState {
    active: HashMap<String, StoredGuard>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsTargetGuardGrant {
    operation_id: String,
    operation_generation: u64,
    process_generation: String,
    proof: String,
    target: SaveAsTargetCandidate,
    reference_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsTargetGuardRelease {
    released: bool,
    final_release: bool,
    reference_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsTargetGuardDetach {
    released_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsProcessGenerationObservation {
    process_generation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GuardError {
    Invalid,
    Conflict,
    Stale,
    Internal,
}

impl GuardError {
    fn code(self) -> &'static str {
        match self {
            Self::Invalid => "SAVE_AS_TARGET_CANDIDATE_INVALID",
            Self::Conflict => "SAVE_AS_GUARD_CONFLICT",
            Self::Stale => "SAVE_AS_GUARD_STALE",
            Self::Internal => "SAVE_AS_GUARD_RELEASE_FAILED",
        }
    }
}

fn checked(value: &str) -> Result<String, GuardError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') {
        return Err(GuardError::Invalid);
    }
    Ok(value.to_string())
}

fn checked_hash(value: &str) -> Result<String, GuardError> {
    let value = checked(value)?;
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(GuardError::Invalid);
    }
    Ok(value)
}

fn target_key(target: &SaveAsTargetCandidate) -> Result<GuardTargetKey, GuardError> {
    if target.location_mode != "managed" && target.location_mode != "external" {
        return Err(GuardError::Invalid);
    }
    checked(&target.display_path)?;
    checked(&target.normalized_path)?;
    Ok(GuardTargetKey {
        path_identity_key: checked(&target.path_identity_key)?,
        canonical_parent_path_identity: checked(&target.parent_path_identity_key)?,
        parent_physical_identity_hash: checked_hash(&target.parent_physical_identity_hash)?,
        normalized_final_filename: {
            let name = checked(&target.normalized_final_filename)?;
            if crate::physical_freshness::is_posix_path(&target.path_identity_key) {
                name
            } else {
                name.to_lowercase()
            }
        },
    })
}

fn targets_conflict(left: &GuardTargetKey, right: &GuardTargetKey) -> bool {
    left.path_identity_key == right.path_identity_key
        || (left.canonical_parent_path_identity == right.canonical_parent_path_identity
            && left.normalized_final_filename == right.normalized_final_filename)
        || (left.parent_physical_identity_hash == right.parent_physical_identity_hash
            && left.normalized_final_filename == right.normalized_final_filename)
}

fn grant(stored: &StoredGuard) -> SaveAsTargetGuardGrant {
    SaveAsTargetGuardGrant {
        operation_id: stored.holder.operation_id.clone(),
        operation_generation: stored.holder.operation_generation,
        process_generation: stored.holder.process_generation.clone(),
        proof: stored.holder.proof.clone(),
        target: stored.target_metadata.clone(),
        reference_count: stored.reference_count,
    }
}

pub(crate) struct ManuscriptSaveAsTargetGuardAuthority {
    process_generation: String,
    state: Mutex<GuardState>,
}

impl ManuscriptSaveAsTargetGuardAuthority {
    pub(crate) fn from_process_generation(process_generation: Arc<ProcessGeneration>) -> Self {
        Self {
            process_generation: process_generation.canonical().to_string(),
            state: Mutex::new(GuardState::default()),
        }
    }

    pub(crate) fn process_generation(&self) -> &str {
        &self.process_generation
    }

    fn observe_process_generation(&self) -> SaveAsProcessGenerationObservation {
        SaveAsProcessGenerationObservation {
            process_generation: self.process_generation.clone(),
        }
    }

    fn acquire(
        &self,
        caller: &str,
        operation_id: &str,
        operation_generation: u64,
        target: SaveAsTargetCandidate,
    ) -> Result<SaveAsTargetGuardGrant, GuardError> {
        let caller = checked(caller)?;
        let operation_id = checked(operation_id)?;
        if operation_generation == 0 {
            return Err(GuardError::Invalid);
        }
        let key = target_key(&target)?;
        let mut state = self.state.lock().map_err(|_| GuardError::Internal)?;
        if let Some(existing) = state
            .active
            .values_mut()
            .find(|stored| targets_conflict(&stored.target, &key))
        {
            if existing.holder.operation_id == operation_id
                && existing.holder.operation_generation == operation_generation
                && existing.holder.process_generation == self.process_generation
                && existing.target == key
            {
                existing.reference_count = existing
                    .reference_count
                    .checked_add(1)
                    .ok_or(GuardError::Internal)?;
                return Ok(grant(existing));
            }
            return Err(GuardError::Conflict);
        }
        let proof = Uuid::new_v4().to_string();
        let stored = StoredGuard {
            target: key,
            target_metadata: target,
            holder: GuardHolderIdentity {
                operation_id,
                operation_generation,
                process_generation: self.process_generation.clone(),
                proof: proof.clone(),
            },
            caller,
            reference_count: 1,
            crossed_effect_boundary: false,
        };
        let response = grant(&stored);
        state.active.insert(proof, stored);
        Ok(response)
    }

    fn retain(&self, caller: &str, proof: &str) -> Result<SaveAsTargetGuardGrant, GuardError> {
        let mut state = self.state.lock().map_err(|_| GuardError::Internal)?;
        let stored = state.active.get_mut(proof).ok_or(GuardError::Stale)?;
        if stored.caller != caller || stored.holder.process_generation != self.process_generation {
            return Err(GuardError::Stale);
        }
        stored.reference_count = stored
            .reference_count
            .checked_add(1)
            .ok_or(GuardError::Internal)?;
        Ok(grant(stored))
    }

    fn validate(
        &self,
        caller: &str,
        proof: &str,
        target: &SaveAsTargetCandidate,
    ) -> Result<SaveAsTargetGuardGrant, GuardError> {
        let key = target_key(target)?;
        let state = self.state.lock().map_err(|_| GuardError::Internal)?;
        let stored = state.active.get(proof).ok_or(GuardError::Stale)?;
        if stored.caller != caller
            || stored.holder.process_generation != self.process_generation
            || stored.target != key
        {
            return Err(GuardError::Stale);
        }
        Ok(grant(stored))
    }

    pub(crate) fn mark_effect_boundary(
        &self,
        caller: &str,
        proof: &str,
        target: &SaveAsTargetCandidate,
    ) -> Result<(), String> {
        let key = target_key(target).map_err(|error| error.code().to_string())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| GuardError::Internal.code().to_string())?;
        let stored = state
            .active
            .get_mut(proof)
            .ok_or_else(|| GuardError::Stale.code().to_string())?;
        if stored.caller != caller
            || stored.holder.process_generation != self.process_generation
            || stored.target != key
        {
            return Err(GuardError::Stale.code().to_string());
        }
        stored.crossed_effect_boundary = true;
        Ok(())
    }

    pub(crate) fn release_exact(
        &self,
        caller: &str,
        proof: &str,
    ) -> Result<SaveAsTargetGuardRelease, String> {
        self.release(caller, proof)
            .map_err(|error| error.code().to_string())
    }

    pub(crate) fn release_after_effect(&self, caller: &str, proof: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| GuardError::Internal.code().to_string())?;
        let stored = state
            .active
            .get(proof)
            .ok_or_else(|| GuardError::Stale.code().to_string())?;
        if stored.caller != caller || stored.holder.process_generation != self.process_generation {
            return Err(GuardError::Stale.code().to_string());
        }
        state.active.remove(proof);
        Ok(())
    }

    fn release(&self, caller: &str, proof: &str) -> Result<SaveAsTargetGuardRelease, GuardError> {
        let mut state = self.state.lock().map_err(|_| GuardError::Internal)?;
        let stored = state.active.get_mut(proof).ok_or(GuardError::Stale)?;
        if stored.caller != caller || stored.holder.process_generation != self.process_generation {
            return Err(GuardError::Stale);
        }
        if stored.reference_count > 1 {
            stored.reference_count -= 1;
            return Ok(SaveAsTargetGuardRelease {
                released: true,
                final_release: false,
                reference_count: stored.reference_count,
            });
        }
        state.active.remove(proof);
        Ok(SaveAsTargetGuardRelease {
            released: true,
            final_release: true,
            reference_count: 0,
        })
    }

    pub(crate) fn detach_caller(&self, caller: &str) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let before = state.active.len();
        state
            .active
            .retain(|_, stored| stored.caller != caller || stored.crossed_effect_boundary);
        before - state.active.len()
    }
}

#[tauri::command]
pub(crate) fn observe_save_as_process_generation(
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
) -> SaveAsProcessGenerationObservation {
    authority.observe_process_generation()
}

#[tauri::command]
pub(crate) fn acquire_save_as_target_guard(
    window: WebviewWindow,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    operation_id: String,
    operation_generation: u64,
    target: SaveAsTargetCandidate,
) -> Result<SaveAsTargetGuardGrant, String> {
    authority
        .acquire(window.label(), &operation_id, operation_generation, target)
        .map_err(|error| error.code().to_string())
}

#[tauri::command]
pub(crate) fn retain_save_as_target_guard(
    window: WebviewWindow,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    proof: String,
) -> Result<SaveAsTargetGuardGrant, String> {
    authority
        .retain(window.label(), &proof)
        .map_err(|error| error.code().to_string())
}

#[tauri::command]
pub(crate) fn validate_save_as_target_guard(
    window: WebviewWindow,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    proof: String,
    target: SaveAsTargetCandidate,
) -> Result<SaveAsTargetGuardGrant, String> {
    authority
        .validate(window.label(), &proof, &target)
        .map_err(|error| error.code().to_string())
}

#[tauri::command]
pub(crate) fn release_save_as_target_guard(
    window: WebviewWindow,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
    proof: String,
) -> Result<SaveAsTargetGuardRelease, String> {
    authority.release_exact(window.label(), &proof)
}

#[tauri::command]
pub(crate) fn detach_save_as_target_guard_window(
    window: WebviewWindow,
    authority: State<'_, Arc<ManuscriptSaveAsTargetGuardAuthority>>,
) -> SaveAsTargetGuardDetach {
    SaveAsTargetGuardDetach {
        released_count: authority.detach_caller(window.label()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> ManuscriptSaveAsTargetGuardAuthority {
        ManuscriptSaveAsTargetGuardAuthority::from_process_generation(Arc::new(
            ProcessGeneration::fixed_for_test("process-generation"),
        ))
    }

    fn target(location_mode: &str) -> SaveAsTargetCandidate {
        SaveAsTargetCandidate {
            display_path: r"N:\isolated\target.md".to_string(),
            normalized_path: r"n:\isolated\target.md".to_string(),
            path_identity_key: "path:target".to_string(),
            parent_path_identity_key: "path:parent".to_string(),
            parent_physical_identity_hash: "a".repeat(64),
            normalized_final_filename: "target.md".to_string(),
            location_mode: location_mode.to_string(),
        }
    }

    #[test]
    fn lp15_f2_posix_target_names_keep_case_and_windows_names_keep_folding() {
        let mut upper = target("external");
        upper.path_identity_key = "/Users/Ada/Run.md".into();
        upper.parent_path_identity_key = "/Users/Ada".into();
        upper.normalized_final_filename = "Run.md".into();
        let mut lower = upper.clone();
        lower.path_identity_key = "/Users/Ada/run.md".into();
        lower.normalized_final_filename = "run.md".into();
        assert!(!targets_conflict(
            &target_key(&upper).unwrap(),
            &target_key(&lower).unwrap()
        ));
        assert!(targets_conflict(
            &target_key(&upper).unwrap(),
            &target_key(&upper).unwrap()
        ));
        upper.path_identity_key = "c:/ada/run.md".into();
        lower.path_identity_key = "alias:run".into();
        assert!(targets_conflict(
            &target_key(&upper).unwrap(),
            &target_key(&lower).unwrap()
        ));
    }

    #[test]
    fn process_generation_observation_is_read_only() {
        let authority = authority();
        let before = authority.state.lock().unwrap().active.len();
        let observation = authority.observe_process_generation();
        let after = authority.state.lock().unwrap().active.len();
        assert_eq!(observation.process_generation, "process-generation");
        assert_eq!(before, 0);
        assert_eq!(after, 0);
    }

    #[test]
    fn same_operation_is_idempotent_but_cross_owner_or_location_mode_conflicts() {
        let authority = authority();
        let first = authority
            .acquire("window-a", "operation-a", 1, target("managed"))
            .unwrap();
        let retained = authority
            .acquire("window-a", "operation-a", 1, target("managed"))
            .unwrap();
        assert_eq!(retained.proof, first.proof);
        assert_eq!(retained.reference_count, 2);
        assert_eq!(
            authority.acquire("window-b", "operation-b", 1, target("external")),
            Err(GuardError::Conflict)
        );
    }

    #[test]
    fn stale_or_late_release_cannot_release_the_current_holder() {
        let authority = authority();
        let first = authority
            .acquire("window-a", "operation-a", 1, target("managed"))
            .unwrap();
        authority.release("window-a", &first.proof).unwrap();
        let current = authority
            .acquire("window-b", "operation-b", 2, target("managed"))
            .unwrap();
        assert_eq!(
            authority.release("window-a", &first.proof),
            Err(GuardError::Stale)
        );
        assert!(authority
            .validate("window-b", &current.proof, &target("managed"))
            .is_ok());
    }

    #[test]
    fn detach_releases_only_pre_effect_holder() {
        let authority = authority();
        let pre = authority
            .acquire("window-a", "operation-a", 1, target("managed"))
            .unwrap();
        assert_eq!(authority.detach_caller("window-a"), 1);
        assert_eq!(
            authority.validate("window-a", &pre.proof, &target("managed")),
            Err(GuardError::Stale)
        );

        let held = authority
            .acquire("window-a", "operation-b", 2, target("managed"))
            .unwrap();
        authority
            .mark_effect_boundary("window-a", &held.proof, &target("managed"))
            .unwrap();
        assert_eq!(authority.detach_caller("window-a"), 0);
        assert!(authority
            .validate("window-a", &held.proof, &target("managed"))
            .is_ok());
    }
}
