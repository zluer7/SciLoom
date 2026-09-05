use crate::provisioning_runtime_foundation::ProcessGeneration;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use tauri::{State, WebviewWindow};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthorityLeaseMode {
    Read,
    Write,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AuthorityKey {
    ManagedRoot,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Owner {
        #[serde(rename = "ownerType")]
        owner_type: String,
        #[serde(rename = "ownerId")]
        owner_id: String,
    },
    ChannelScope {
        #[serde(rename = "ownerType")]
        owner_type: String,
        #[serde(rename = "ownerId")]
        owner_id: String,
        scope: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityLeaseRequest {
    pub(crate) key: AuthorityKey,
    pub(crate) mode: AuthorityLeaseMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityLeaseGrant {
    pub(crate) token: String,
    pub(crate) request_id: String,
    pub(crate) holder_kind: &'static str,
    pub(crate) registry_generation: String,
    pub(crate) requests: Vec<AuthorityLeaseRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityLeaseValidation {
    valid: bool,
    registry_generation: String,
    request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityLeaseRelease {
    released: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthorityLeaseError {
    InvalidRequest,
    LeaseBusy,
    LeaseConflict,
    LeaseNotOwned,
    LeaseStale,
    InternalFailure,
}

impl AuthorityLeaseError {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "AUTHORITY_LEASE_INVALID_REQUEST",
            Self::LeaseBusy => "AUTHORITY_LEASE_BUSY",
            Self::LeaseConflict => "AUTHORITY_LEASE_CONFLICT",
            Self::LeaseNotOwned => "AUTHORITY_LEASE_NOT_OWNED",
            Self::LeaseStale => "AUTHORITY_LEASE_STALE",
            Self::InternalFailure => "AUTHORITY_LEASE_INTERNAL_FAILURE",
        }
    }
}

impl fmt::Display for AuthorityLeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

#[derive(Debug, Clone)]
struct StoredLease {
    token: String,
    actual_caller: String,
    request_id: String,
    generation: String,
    requests: Vec<AuthorityLeaseRequest>,
}

#[derive(Debug)]
struct RegistryState {
    generation: String,
    active: HashMap<String, StoredLease>,
    released: HashMap<String, String>,
}

pub(crate) struct OwnerAuthorityLeaseRegistry {
    process_generation: Arc<ProcessGeneration>,
    state: Mutex<RegistryState>,
}

#[cfg(test)]
pub(crate) struct CallerAuthorityLeaseGuard<'a> {
    registry: &'a OwnerAuthorityLeaseRegistry,
    actual_caller: String,
    token: String,
}

#[cfg(test)]
impl Drop for CallerAuthorityLeaseGuard<'_> {
    fn drop(&mut self) {
        let _ = self.registry.release(&self.actual_caller, &self.token);
    }
}

fn normalized_component(value: String) -> Result<String, AuthorityLeaseError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.contains('\0') {
        return Err(AuthorityLeaseError::InvalidRequest);
    }
    Ok(value)
}

fn normalize_key(key: AuthorityKey) -> Result<AuthorityKey, AuthorityLeaseError> {
    match key {
        AuthorityKey::ManagedRoot => Ok(AuthorityKey::ManagedRoot),
        AuthorityKey::Project { project_id } => Ok(AuthorityKey::Project {
            project_id: normalized_component(project_id)?,
        }),
        AuthorityKey::Owner {
            owner_type,
            owner_id,
        } => Ok(AuthorityKey::Owner {
            owner_type: normalized_component(owner_type)?,
            owner_id: normalized_component(owner_id)?,
        }),
        AuthorityKey::ChannelScope {
            owner_type,
            owner_id,
            scope,
        } => Ok(AuthorityKey::ChannelScope {
            owner_type: normalized_component(owner_type)?,
            owner_id: normalized_component(owner_id)?,
            scope: normalized_component(scope)?,
        }),
    }
}

fn key_order(key: &AuthorityKey) -> (u8, &str, &str, &str) {
    match key {
        AuthorityKey::ManagedRoot => (0, "", "", ""),
        AuthorityKey::Project { project_id } => (1, project_id, "", ""),
        AuthorityKey::Owner {
            owner_type,
            owner_id,
        } => (2, owner_type, owner_id, ""),
        AuthorityKey::ChannelScope {
            owner_type,
            owner_id,
            scope,
        } => (3, owner_type, owner_id, scope),
    }
}

fn normalize_requests(
    requests: Vec<AuthorityLeaseRequest>,
) -> Result<Vec<AuthorityLeaseRequest>, AuthorityLeaseError> {
    if requests.is_empty() {
        return Err(AuthorityLeaseError::InvalidRequest);
    }
    let mut by_key = HashMap::<AuthorityKey, AuthorityLeaseMode>::new();
    for request in requests {
        let key = normalize_key(request.key)?;
        by_key
            .entry(key)
            .and_modify(|mode| {
                if request.mode == AuthorityLeaseMode::Write {
                    *mode = AuthorityLeaseMode::Write;
                }
            })
            .or_insert(request.mode);
    }
    let mut normalized: Vec<_> = by_key
        .into_iter()
        .map(|(key, mode)| AuthorityLeaseRequest { key, mode })
        .collect();
    normalized.sort_by(|left, right| {
        let key_comparison = key_order(&left.key).cmp(&key_order(&right.key));
        if key_comparison == Ordering::Equal {
            match (left.mode, right.mode) {
                (AuthorityLeaseMode::Write, AuthorityLeaseMode::Read) => Ordering::Less,
                (AuthorityLeaseMode::Read, AuthorityLeaseMode::Write) => Ordering::Greater,
                _ => Ordering::Equal,
            }
        } else {
            key_comparison
        }
    });
    Ok(normalized)
}

fn modes_conflict(left: AuthorityLeaseMode, right: AuthorityLeaseMode) -> bool {
    left == AuthorityLeaseMode::Write || right == AuthorityLeaseMode::Write
}

impl OwnerAuthorityLeaseRegistry {
    pub(crate) fn from_process_generation(process_generation: Arc<ProcessGeneration>) -> Self {
        let generation = process_generation.canonical().to_string();
        Self {
            process_generation,
            state: Mutex::new(RegistryState {
                generation,
                active: HashMap::new(),
                released: HashMap::new(),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::from_process_generation(Arc::new(ProcessGeneration::fixed_for_test(
            "owner-authority-lease-test-generation",
        )))
    }

    #[cfg(test)]
    pub(crate) fn process_generation_for_test(&self) -> &str {
        self.process_generation().canonical()
    }

    pub(crate) fn process_generation(&self) -> &ProcessGeneration {
        &self.process_generation
    }

    pub(crate) fn try_acquire_many(
        &self,
        actual_caller: &str,
        request_id: &str,
        requests: Vec<AuthorityLeaseRequest>,
    ) -> Result<AuthorityLeaseGrant, AuthorityLeaseError> {
        let actual_caller = normalized_component(actual_caller.to_string())?;
        let request_id = normalized_component(request_id.to_string())?;
        let requests = normalize_requests(requests)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuthorityLeaseError::InternalFailure)?;

        for existing in state.active.values() {
            for requested in &requests {
                if let Some(held) = existing
                    .requests
                    .iter()
                    .find(|held| held.key == requested.key)
                {
                    if existing.actual_caller == actual_caller {
                        return Err(AuthorityLeaseError::LeaseConflict);
                    }
                    if modes_conflict(held.mode, requested.mode) {
                        return Err(AuthorityLeaseError::LeaseBusy);
                    }
                }
            }
        }

        let token = Uuid::new_v4().to_string();
        let generation = state.generation.clone();
        state.active.insert(
            token.clone(),
            StoredLease {
                token: token.clone(),
                actual_caller,
                request_id: request_id.clone(),
                generation: generation.clone(),
                requests: requests.clone(),
            },
        );
        Ok(AuthorityLeaseGrant {
            token,
            request_id,
            holder_kind: "callerBound",
            registry_generation: generation,
            requests,
        })
    }

    #[cfg(test)]
    pub(crate) fn try_acquire_guard(
        &self,
        actual_caller: &str,
        request_id: &str,
        requests: Vec<AuthorityLeaseRequest>,
    ) -> Result<CallerAuthorityLeaseGuard<'_>, AuthorityLeaseError> {
        let grant = self.try_acquire_many(actual_caller, request_id, requests)?;
        Ok(CallerAuthorityLeaseGuard {
            registry: self,
            actual_caller: actual_caller.to_string(),
            token: grant.token,
        })
    }

    pub(crate) fn validate(
        &self,
        actual_caller: &str,
        token: &str,
        expected_requests: &[AuthorityLeaseRequest],
    ) -> Result<AuthorityLeaseValidation, AuthorityLeaseError> {
        let expected_requests = normalize_requests(expected_requests.to_vec())?;
        let state = self
            .state
            .lock()
            .map_err(|_| AuthorityLeaseError::InternalFailure)?;
        let Some(lease) = state.active.get(token) else {
            if let Some(owner) = state.released.get(token) {
                return if owner == actual_caller {
                    Err(AuthorityLeaseError::LeaseStale)
                } else {
                    Err(AuthorityLeaseError::LeaseNotOwned)
                };
            }
            return Err(AuthorityLeaseError::LeaseStale);
        };
        if lease.actual_caller != actual_caller {
            return Err(AuthorityLeaseError::LeaseNotOwned);
        }
        if lease.generation != state.generation {
            return Err(AuthorityLeaseError::LeaseStale);
        }
        if lease.requests != expected_requests {
            return Err(AuthorityLeaseError::LeaseConflict);
        }
        Ok(AuthorityLeaseValidation {
            valid: true,
            registry_generation: state.generation.clone(),
            request_id: lease.request_id.clone(),
        })
    }

    pub(crate) fn release(
        &self,
        actual_caller: &str,
        token: &str,
    ) -> Result<AuthorityLeaseRelease, AuthorityLeaseError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuthorityLeaseError::InternalFailure)?;
        if let Some(lease) = state.active.get(token) {
            if lease.actual_caller != actual_caller {
                return Err(AuthorityLeaseError::LeaseNotOwned);
            }
        } else if let Some(owner) = state.released.get(token) {
            return if owner == actual_caller {
                Ok(AuthorityLeaseRelease { released: false })
            } else {
                Err(AuthorityLeaseError::LeaseNotOwned)
            };
        } else {
            return Err(AuthorityLeaseError::LeaseStale);
        }
        let lease = state
            .active
            .remove(token)
            .ok_or(AuthorityLeaseError::LeaseStale)?;
        state.released.insert(lease.token, lease.actual_caller);
        Ok(AuthorityLeaseRelease { released: true })
    }

    pub(crate) fn release_caller(&self, actual_caller: &str) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let tokens: Vec<_> = state
            .active
            .values()
            .filter(|lease| lease.actual_caller == actual_caller)
            .map(|lease| lease.token.clone())
            .collect();
        for token in &tokens {
            if let Some(lease) = state.active.remove(token) {
                state.released.insert(lease.token, lease.actual_caller);
            }
        }
        tokens.len()
    }

    #[cfg(test)]
    pub(crate) fn active_lease_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.active.len())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn rotate_generation_for_test(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = Uuid::new_v4().to_string();
        }
    }
}

fn command_error(error: AuthorityLeaseError) -> String {
    error.to_string()
}

#[tauri::command]
pub(crate) fn owner_authority_try_acquire_many(
    window: WebviewWindow,
    registry: State<'_, Arc<OwnerAuthorityLeaseRegistry>>,
    request_id: String,
    requests: Vec<AuthorityLeaseRequest>,
) -> Result<AuthorityLeaseGrant, String> {
    registry
        .try_acquire_many(window.label(), &request_id, requests)
        .map_err(command_error)
}

#[tauri::command]
pub(crate) fn owner_authority_validate(
    window: WebviewWindow,
    registry: State<'_, Arc<OwnerAuthorityLeaseRegistry>>,
    token: String,
    requests: Vec<AuthorityLeaseRequest>,
) -> Result<AuthorityLeaseValidation, String> {
    registry
        .validate(window.label(), &token, &requests)
        .map_err(command_error)
}

#[tauri::command]
pub(crate) fn owner_authority_release(
    window: WebviewWindow,
    registry: State<'_, Arc<OwnerAuthorityLeaseRegistry>>,
    token: String,
) -> Result<AuthorityLeaseRelease, String> {
    registry
        .release(window.label(), &token)
        .map_err(command_error)
}
