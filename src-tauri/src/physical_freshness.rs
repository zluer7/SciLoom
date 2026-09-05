#![allow(dead_code)]

use crate::manuscript_provisioning_contract::{
    AdapterOutcome, AppliedEffectKind, ConflictFacts, ConflictKind, EffectCompletionKind,
    EffectReceipt, ReadbackIdentity, StableErrorCode,
};
use crate::provisioning_runtime::non_completed_exit::RuntimeExecutionPermit;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::{c_void, OsStr};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;
use uuid::Uuid;

const CONDITION_DOMAIN: &str = "labpod.physical-condition.v1";
const READBACK_MAX_ATTEMPTS: u8 = 3;
const READBACK_MAX_TOTAL_MILLIS: u64 = 2_000;
const MAX_INITIAL_MARKDOWN_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PhysicalResourceKind {
    Directory,
    MarkdownFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExpectedTargetState {
    Missing,
    ExistingExact,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PhysicalVerificationRequest {
    pub resource_role: String,
    pub owner_type: String,
    pub owner_id: String,
    pub channel: String,
    pub scope: String,
    pub managed_root: PathBuf,
    pub requested_path: PathBuf,
    pub expected_kind: PhysicalResourceKind,
    pub expected_target_state: ExpectedTargetState,
    pub allow_existing_reuse: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PhysicalFailure {
    pub code: StableErrorCode,
}

impl PhysicalFailure {
    fn new(code: StableErrorCode) -> Self {
        Self { code }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsPhysicalIdentity {
    pub volume_serial: u64,
    pub file_id: u64,
    pub reparse_tag: u32,
    pub final_path: String,
    attributes: u32,
}

#[cfg(target_os = "windows")]
type PhysicalIdentity = WindowsPhysicalIdentity;
#[cfg(not(target_os = "windows"))]
type PhysicalIdentity = UnixPhysicalIdentity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExistingDirectoryIdentity {
    pub(crate) normalized_path: String,
    pub(crate) path_identity_key: String,
    pub(crate) physical_identity_hash: String,
}

impl WindowsPhysicalIdentity {
    pub(crate) fn stable_hash(&self) -> String {
        sha256(format!(
            "{}:{}:{}:{}",
            self.volume_serial,
            self.file_id,
            self.reparse_tag,
            normalize_windows_identity(&self.final_path)
        ))
    }

    fn is_reparse(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || self.reparse_tag != 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SaveAsPhysicalPathObservation {
    pub normalized_target_path: String,
    pub normalized_parent_path: String,
    pub parent_physical_identity_hash: String,
    pub target_physical_identity_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsTargetCandidateObservation {
    normalized_target_path: String,
    proposed_target_path_identity: String,
    canonical_parent_path_identity: String,
    parent_physical_identity_hash: String,
    normalized_final_filename: String,
    observation_generation: String,
    observation_proof: String,
    parent_exists: bool,
    target_exists: bool,
    target_physical_identity_hash: Option<String>,
}

pub(crate) fn inspect_save_as_physical_path(
    target_path: &Path,
) -> Result<SaveAsPhysicalPathObservation, PhysicalFailure> {
    if !target_path.is_absolute() {
        return Err(PhysicalFailure::new(StableErrorCode::OperationInvalidInput));
    }
    let parent_path = target_path
        .parent()
        .ok_or_else(|| PhysicalFailure::new(StableErrorCode::OperationInvalidInput))?;
    let parent_metadata = fs::symlink_metadata(parent_path)
        .map_err(|_| PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable))?;
    if !parent_metadata.is_dir() || has_reparse_attribute(&parent_metadata) {
        return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
    }
    let parent_identity = open_identity(parent_path)?;
    if parent_identity.is_reparse() {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalReparseBlocked,
        ));
    }
    let target_physical_identity_hash = match fs::symlink_metadata(target_path) {
        Ok(metadata) => {
            if !metadata.is_file() || has_reparse_attribute(&metadata) {
                return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
            }
            let identity = open_identity(target_path)?;
            if identity.is_reparse() {
                return Err(PhysicalFailure::new(
                    StableErrorCode::PhysicalReparseBlocked,
                ));
            }
            Some(identity.stable_hash())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            return Err(PhysicalFailure::new(
                StableErrorCode::PhysicalAuthorityUnavailable,
            ))
        }
    };
    Ok(SaveAsPhysicalPathObservation {
        normalized_target_path: normalize_absolute_requested_path(target_path)?,
        normalized_parent_path: normalize_path_identity(&parent_identity.final_path),
        parent_physical_identity_hash: parent_identity.stable_hash(),
        target_physical_identity_hash,
    })
}

pub(crate) fn is_posix_path(value: &str) -> bool {
    value.starts_with('/') && !value.starts_with("//")
}

/// Comparison-only key. Filesystem IO keeps its Path/PathBuf or the separately
/// returned canonical filesystem spelling. POSIX paths remain case-sensitive.
pub(crate) fn normalize_path_identity(value: &str) -> String {
    if is_posix_path(value) {
        if value == "/" {
            "/".to_string()
        } else {
            value.trim_end_matches('/').to_string()
        }
    } else {
        normalize_windows_identity(value)
    }
}

fn canonical_filesystem_spelling(value: &str) -> String {
    if is_posix_path(value) {
        normalize_path_identity(value)
    } else {
        display_windows_path(value)
    }
}

pub(crate) fn save_as_path_identity(value: &str) -> String {
    if is_posix_path(value) {
        normalize_path_identity(value)
    } else {
        value.replace('\\', "/").to_lowercase()
    }
}

fn save_as_observation_failure_code(error: PhysicalFailure) -> &'static str {
    match error.code {
        StableErrorCode::PhysicalAuthorityUnavailable => "SAVE_AS_PARENT_MISSING",
        StableErrorCode::OperationInvalidInput => "SAVE_AS_PATH_INVALID",
        StableErrorCode::PhysicalReparseBlocked
        | StableErrorCode::PhysicalWrongType
        | StableErrorCode::PhysicalContainmentBlocked
        | StableErrorCode::PhysicalIdentityMismatch => "SAVE_AS_TARGET_CANDIDATE_INVALID",
        _ => "SAVE_AS_TARGET_CANDIDATE_INVALID",
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn observe_save_as_target_candidate(
    target_path: String,
) -> Result<SaveAsTargetCandidateObservation, String> {
    let requested = Path::new(&target_path);
    let normalized_final_filename = requested
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "SAVE_AS_PATH_INVALID".to_string())?
        .to_string();
    let normalized_extension = normalized_final_filename.to_lowercase();
    if !normalized_extension.ends_with(".md") && !normalized_extension.ends_with(".markdown") {
        return Err("SAVE_AS_PATH_INVALID".to_string());
    }
    let observation = inspect_save_as_physical_path(requested)
        .map_err(|error| save_as_observation_failure_code(error).to_string())?;
    let observation_generation = verifier_generation().to_string();
    let proposed_target_path_identity = save_as_path_identity(&observation.normalized_target_path);
    let canonical_parent_path_identity = save_as_path_identity(&observation.normalized_parent_path);
    let target_exists = observation.target_physical_identity_hash.is_some();
    let observation_proof = sha256(format!(
        "{}|{}|{}|{}|{}|{}",
        observation_generation,
        proposed_target_path_identity,
        canonical_parent_path_identity,
        observation.parent_physical_identity_hash,
        target_exists,
        observation
            .target_physical_identity_hash
            .as_deref()
            .unwrap_or("missing")
    ));
    Ok(SaveAsTargetCandidateObservation {
        normalized_target_path: observation.normalized_target_path,
        proposed_target_path_identity,
        canonical_parent_path_identity,
        parent_physical_identity_hash: observation.parent_physical_identity_hash,
        normalized_final_filename,
        observation_generation,
        observation_proof,
        parent_exists: true,
        target_exists,
        target_physical_identity_hash: observation.target_physical_identity_hash,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObservedTargetState {
    Missing,
    ExistingExact,
}

/// Runtime-only proof of one fresh OS observation.
///
/// The private fields, absent `Clone`/serde implementations, and by-value
/// mutation boundary are intentional. This is not a filesystem revision.
#[derive(Debug)]
pub(crate) struct ValidatedPhysicalCondition {
    domain: &'static str,
    request: PhysicalVerificationRequest,
    normalized_requested_path: String,
    canonical_placement_identity: String,
    managed_root_identity: PhysicalIdentity,
    opened_parent_identity: PhysicalIdentity,
    opened_parent_path: PathBuf,
    missing_components: Vec<String>,
    observed_target_state: ObservedTargetState,
    observed_target_identity: Option<PhysicalIdentity>,
    verifier_generation: Uuid,
    verifier_nonce: Uuid,
    created_at: Instant,
}

impl ValidatedPhysicalCondition {
    pub(crate) fn observed_target_exists(&self) -> bool {
        self.observed_target_state == ObservedTargetState::ExistingExact
    }

    pub(crate) fn missing_component_count(&self) -> usize {
        self.missing_components.len()
    }

    pub(crate) fn authoritative_identity_hash(&self) -> Option<String> {
        self.observed_target_identity
            .as_ref()
            .map(PhysicalIdentity::stable_hash)
    }

    #[cfg(test)]
    pub(crate) fn observed_state_for_test(&self) -> &'static str {
        match self.observed_target_state {
            ObservedTargetState::Missing => "missing",
            ObservedTargetState::ExistingExact => "existing-exact",
        }
    }

    #[cfg(test)]
    pub(crate) fn with_stale_generation_for_test(mut self) -> Self {
        self.verifier_generation = Uuid::new_v4();
        self
    }
}

pub(crate) struct PhysicalFreshVerifier;

impl PhysicalFreshVerifier {
    pub(crate) fn verify(
        request: PhysicalVerificationRequest,
    ) -> Result<ValidatedPhysicalCondition, PhysicalFailure> {
        verify_native(request)
    }

    #[cfg(test)]
    pub(crate) fn inspect_identity_for_test(
        path: &Path,
    ) -> Result<PhysicalIdentity, PhysicalFailure> {
        open_identity(path)
    }

    #[cfg(test)]
    pub(crate) const fn readback_bounds_for_test() -> (u8, u64) {
        (READBACK_MAX_ATTEMPTS, READBACK_MAX_TOTAL_MILLIS)
    }
}

fn verify_native(
    request: PhysicalVerificationRequest,
) -> Result<ValidatedPhysicalCondition, PhysicalFailure> {
    validate_request(&request)?;
    let root_identity = open_identity(&request.managed_root)?;
    if root_identity.is_reparse() {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalReparseBlocked,
        ));
    }
    let normalized_root = normalize_path_identity(&root_identity.final_path);
    let normalized_requested = normalize_absolute_requested_path(&request.requested_path)?;
    if !is_contained(&normalized_root, &normalized_requested) {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalContainmentBlocked,
        ));
    }

    let target_metadata = fs::symlink_metadata(&request.requested_path);
    let (observed_target_state, observed_target_identity) = match target_metadata {
        Ok(metadata) => {
            if has_reparse_attribute(&metadata) {
                return Err(PhysicalFailure::new(
                    StableErrorCode::PhysicalReparseBlocked,
                ));
            }
            let kind_matches = match request.expected_kind {
                PhysicalResourceKind::Directory => metadata.is_dir(),
                PhysicalResourceKind::MarkdownFile => metadata.is_file(),
            };
            if !kind_matches {
                return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
            }
            let identity = open_identity(&request.requested_path)?;
            if identity.is_reparse()
                || !is_contained(
                    &normalized_root,
                    &normalize_path_identity(&identity.final_path),
                )
            {
                return Err(PhysicalFailure::new(
                    StableErrorCode::PhysicalContainmentBlocked,
                ));
            }
            (ObservedTargetState::ExistingExact, Some(identity))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (ObservedTargetState::Missing, None)
        }
        Err(_) => {
            return Err(PhysicalFailure::new(
                StableErrorCode::PhysicalAuthorityUnavailable,
            ))
        }
    };

    if matches!(
        (request.expected_target_state, observed_target_state),
        (
            ExpectedTargetState::ExistingExact,
            ObservedTargetState::Missing
        )
    ) {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalMutationConditionFailed,
        ));
    }
    if observed_target_state == ObservedTargetState::ExistingExact
        && !request.allow_existing_reuse
        && request.expected_target_state == ExpectedTargetState::Missing
    {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalMutationConditionFailed,
        ));
    }

    let ancestor_start = match request.expected_kind {
        PhysicalResourceKind::Directory => request.requested_path.as_path(),
        PhysicalResourceKind::MarkdownFile => request
            .requested_path
            .parent()
            .ok_or_else(|| PhysicalFailure::new(StableErrorCode::OperationInvalidInput))?,
    };
    let (opened_parent_path, opened_parent_identity, missing_components) =
        nearest_existing_ancestor(ancestor_start, &normalized_root)?;

    if request.expected_kind == PhysicalResourceKind::MarkdownFile && !missing_components.is_empty()
    {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalMutationConditionFailed,
        ));
    }

    Ok(ValidatedPhysicalCondition {
        domain: CONDITION_DOMAIN,
        canonical_placement_identity: normalized_requested.clone(),
        normalized_requested_path: normalized_requested,
        request,
        managed_root_identity: root_identity,
        opened_parent_identity,
        opened_parent_path,
        missing_components,
        observed_target_state,
        observed_target_identity,
        verifier_generation: verifier_generation(),
        verifier_nonce: Uuid::new_v4(),
        created_at: Instant::now(),
    })
}

fn validate_request(request: &PhysicalVerificationRequest) -> Result<(), PhysicalFailure> {
    if request.resource_role.trim().is_empty()
        || request.owner_type.trim().is_empty()
        || request.owner_id.trim().is_empty()
        || request.channel.trim().is_empty()
        || request.scope.trim().is_empty()
        || !request.managed_root.is_absolute()
        || !request.requested_path.is_absolute()
    {
        return Err(PhysicalFailure::new(StableErrorCode::OperationInvalidInput));
    }
    Ok(())
}

fn nearest_existing_ancestor(
    start: &Path,
    normalized_root: &str,
) -> Result<(PathBuf, PhysicalIdentity, Vec<String>), PhysicalFailure> {
    let mut cursor = start.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) => {
                if has_reparse_attribute(&metadata) {
                    return Err(PhysicalFailure::new(
                        StableErrorCode::PhysicalReparseBlocked,
                    ));
                }
                if !metadata.is_dir() {
                    return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
                }
                let identity = open_identity(&cursor)?;
                if identity.is_reparse()
                    || !is_contained(
                        normalized_root,
                        &normalize_path_identity(&identity.final_path),
                    )
                {
                    return Err(PhysicalFailure::new(
                        StableErrorCode::PhysicalContainmentBlocked,
                    ));
                }
                missing.reverse();
                return Ok((cursor, identity, missing));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor
                    .file_name()
                    .and_then(OsStr::to_str)
                    .ok_or_else(|| PhysicalFailure::new(StableErrorCode::OperationInvalidInput))?;
                missing.push(name.to_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| PhysicalFailure::new(StableErrorCode::OperationInvalidInput))?
                    .to_path_buf();
            }
            Err(_) => {
                return Err(PhysicalFailure::new(
                    StableErrorCode::PhysicalAuthorityUnavailable,
                ))
            }
        }
    }
}

fn normalize_absolute_requested_path(path: &Path) -> Result<String, PhysicalFailure> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(PhysicalFailure::new(StableErrorCode::OperationInvalidInput));
                }
            }
        }
    }
    Ok(normalize_path_identity(&normalized.to_string_lossy()))
}

pub(crate) fn normalize_windows_identity(value: &str) -> String {
    let mut value = value.replace('/', "\\");
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        value = format!(r"\\{rest}");
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        value = rest.to_string();
    }
    value.trim_end_matches('\\').to_lowercase()
}

fn display_windows_path(value: &str) -> String {
    let mut value = value.replace('/', "\\");
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        value = format!(r"\\{rest}");
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        value = rest.to_string();
    }
    while value.ends_with('\\') && !value.ends_with(":\\") {
        value.pop();
    }
    value
}

/// Reuses the LP12 physical path authority for one existing directory.
///
/// The caller receives a user-readable canonical path, a comparison-only path
/// identity, and a non-path physical identity suitable for bounded auditing.
pub(crate) fn inspect_existing_directory_identity(
    path: &Path,
) -> Result<ExistingDirectoryIdentity, PhysicalFailure> {
    if !path.is_absolute() {
        return Err(PhysicalFailure::new(StableErrorCode::OperationInvalidInput));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable))?;
    if !metadata.is_dir() {
        return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
    }
    if has_reparse_attribute(&metadata) {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalReparseBlocked,
        ));
    }

    let identity = open_identity(path)?;
    if identity.is_reparse() {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalReparseBlocked,
        ));
    }
    Ok(ExistingDirectoryIdentity {
        normalized_path: canonical_filesystem_spelling(&identity.final_path),
        path_identity_key: normalize_path_identity(&identity.final_path),
        physical_identity_hash: identity.stable_hash(),
    })
}

pub(crate) fn apply_creation_only(
    condition: ValidatedPhysicalCondition,
    request: PhysicalVerificationRequest,
    permit: &RuntimeExecutionPermit,
) -> AdapterOutcome {
    if !permit.authorizes_physical_mutation() {
        return conflict(&request, ConflictKind::IdentityMismatch);
    }
    match request.expected_kind {
        PhysicalResourceKind::Directory => {
            if !condition.observed_target_exists() && condition.missing_component_count() != 1 {
                return conflict(&request, ConflictKind::ContainmentFailed);
            }
        }
        PhysicalResourceKind::MarkdownFile => {
            if condition.missing_component_count() != 0 {
                return conflict(&request, ConflictKind::ContainmentFailed);
            }
            if condition.observed_target_exists()
                && fs::metadata(&request.requested_path)
                    .map(|metadata| metadata.len() != 0)
                    .unwrap_or(true)
            {
                return conflict(&request, ConflictKind::PolicyConflict);
            }
        }
    }
    mutate(
        condition,
        ActiveExecutionPermit { _sealed: () },
        request,
        &[],
        #[cfg(test)]
        TestMutationFault::None,
    )
}

pub(crate) fn apply_creation_only_with_initial_bytes(
    condition: ValidatedPhysicalCondition,
    request: PhysicalVerificationRequest,
    permit: &RuntimeExecutionPermit,
    initial_bytes: &[u8],
) -> AdapterOutcome {
    if !permit.authorizes_physical_mutation() {
        return conflict(&request, ConflictKind::IdentityMismatch);
    }
    match request.expected_kind {
        PhysicalResourceKind::Directory => {
            if !initial_bytes.is_empty()
                || (!condition.observed_target_exists() && condition.missing_component_count() != 1)
            {
                return conflict(&request, ConflictKind::ContainmentFailed);
            }
        }
        PhysicalResourceKind::MarkdownFile => {
            if condition.missing_component_count() != 0 {
                return conflict(&request, ConflictKind::ContainmentFailed);
            }
        }
    }
    mutate(
        condition,
        ActiveExecutionPermit { _sealed: () },
        request,
        initial_bytes,
        #[cfg(test)]
        TestMutationFault::None,
    )
}

#[cfg(test)]
pub(crate) fn normalize_windows_identity_for_test(value: &str) -> String {
    normalize_windows_identity(value)
}

pub(crate) fn is_contained(root: &str, candidate: &str) -> bool {
    let separator = if is_posix_path(root) { '/' } else { '\\' };
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|rest| (root == "/" && !rest.is_empty()) || rest.starts_with(separator))
}

fn verifier_generation() -> Uuid {
    static GENERATION: OnceLock<Uuid> = OnceLock::new();
    *GENERATION.get_or_init(Uuid::new_v4)
}

fn sha256(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn request_hash(request: &PhysicalVerificationRequest) -> String {
    sha256(format!(
        "{}|{}|{}|{}|{}|{}|{:?}",
        request.owner_type,
        request.owner_id,
        request.channel,
        request.scope,
        request.resource_role,
        normalize_path_identity(&request.requested_path.to_string_lossy()),
        request.expected_kind
    ))
}

struct ActiveExecutionPermit {
    _sealed: (),
}

#[derive(Debug, Clone)]
#[cfg(test)]
pub(crate) enum TestMutationFault {
    None,
    AfterFirstDirectoryComponent,
    AfterFileCreate,
    AfterFileWrite,
    ReadbackUnavailable,
    PauseBeforeReadback {
        reached: std::sync::Arc<std::sync::Barrier>,
        resume: std::sync::Arc<std::sync::Barrier>,
    },
}

#[cfg(test)]
pub(crate) fn test_mutate(
    condition: ValidatedPhysicalCondition,
    request: PhysicalVerificationRequest,
    initial_bytes: &[u8],
    fault: TestMutationFault,
) -> AdapterOutcome {
    mutate(
        condition,
        ActiveExecutionPermit { _sealed: () },
        request,
        initial_bytes,
        fault,
    )
}

fn mutate(
    condition: ValidatedPhysicalCondition,
    _permit: ActiveExecutionPermit,
    request: PhysicalVerificationRequest,
    initial_bytes: &[u8],
    #[cfg(test)] fault: TestMutationFault,
) -> AdapterOutcome {
    if condition.domain != CONDITION_DOMAIN
        || condition.verifier_generation != verifier_generation()
        || request != condition.request
        || condition.normalized_requested_path
            != normalize_path_identity(&request.requested_path.to_string_lossy())
    {
        return conflict(&request, ConflictKind::IdentityMismatch);
    }
    if revalidate_anchor(&condition).is_err() {
        return conflict(&request, ConflictKind::IdentityMismatch);
    }

    match condition.observed_target_state {
        ObservedTargetState::ExistingExact => {
            return match revalidate_existing_target(&condition) {
                Ok(identity) if request.allow_existing_reuse => {
                    AdapterOutcome::Reused(ReadbackIdentity {
                        canonical_identity_hash: identity.stable_hash(),
                        authoritative_revision: 0,
                    })
                }
                _ => conflict(&request, ConflictKind::PolicyConflict),
            };
        }
        ObservedTargetState::Missing => {}
    }

    match request.expected_kind {
        PhysicalResourceKind::Directory => mutate_directory(
            condition,
            request,
            #[cfg(test)]
            fault,
        ),
        PhysicalResourceKind::MarkdownFile => mutate_markdown(
            condition,
            request,
            initial_bytes,
            #[cfg(test)]
            fault,
        ),
    }
}

fn revalidate_anchor(condition: &ValidatedPhysicalCondition) -> Result<(), PhysicalFailure> {
    let root = open_identity(&condition.request.managed_root)?;
    let parent = open_identity(&condition.opened_parent_path)?;
    if root != condition.managed_root_identity
        || parent != condition.opened_parent_identity
        || root.is_reparse()
        || parent.is_reparse()
    {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalIdentityMismatch,
        ));
    }
    Ok(())
}

fn revalidate_existing_target(
    condition: &ValidatedPhysicalCondition,
) -> Result<PhysicalIdentity, PhysicalFailure> {
    let identity = open_identity(&condition.request.requested_path)?;
    if identity.is_reparse()
        || condition
            .observed_target_identity
            .as_ref()
            .is_some_and(|observed| observed != &identity)
    {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalIdentityMismatch,
        ));
    }
    Ok(identity)
}

fn mutate_directory(
    condition: ValidatedPhysicalCondition,
    request: PhysicalVerificationRequest,
    #[cfg(test)] fault: TestMutationFault,
) -> AdapterOutcome {
    let mut current = condition.opened_parent_path.clone();
    let mut created = 0_u32;
    let mut last_created_identity = None;
    for component in &condition.missing_components {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => {
                created += 1;
                let identity = match open_identity(&current) {
                    Ok(identity) => identity,
                    Err(_) => return indeterminate(&request),
                };
                last_created_identity = Some(identity.stable_hash());
                #[cfg(test)]
                if matches!(fault, TestMutationFault::AfterFirstDirectoryComponent) && created == 1
                {
                    return partial(
                        &request,
                        last_created_identity
                            .as_deref()
                            .expect("created component identity"),
                        None,
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                match open_identity(&current) {
                    Ok(identity) if !identity.is_reparse() => {}
                    _ => return conflict(&request, ConflictKind::WrongType),
                }
            }
            Err(_) if created == 0 => {
                return no_effect_conflict(&request);
            }
            Err(_) => {
                return last_created_identity.as_deref().map_or_else(
                    || indeterminate(&request),
                    |identity| partial(&request, identity, None),
                )
            }
        }
    }
    match bounded_readback(
        &condition,
        &request.requested_path,
        PhysicalResourceKind::Directory,
    ) {
        Ok(identity) if created == 0 => AdapterOutcome::Reused(ReadbackIdentity {
            canonical_identity_hash: identity.stable_hash(),
            authoritative_revision: 0,
        }),
        Ok(identity) => applied(
            &request,
            EffectCompletionKind::CompleteEffect,
            identity.stable_hash(),
            None,
        ),
        Err(_) if created > 0 => last_created_identity.as_deref().map_or_else(
            || indeterminate(&request),
            |identity| partial(&request, identity, None),
        ),
        Err(_) => no_effect_conflict(&request),
    }
}

fn mutate_markdown(
    condition: ValidatedPhysicalCondition,
    request: PhysicalVerificationRequest,
    initial_bytes: &[u8],
    #[cfg(test)] fault: TestMutationFault,
) -> AdapterOutcome {
    if initial_bytes.len() > MAX_INITIAL_MARKDOWN_BYTES {
        return conflict(&request, ConflictKind::PolicyConflict);
    }
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&request.requested_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return match bounded_readback(
                &condition,
                &request.requested_path,
                PhysicalResourceKind::MarkdownFile,
            ) {
                Ok(identity) if request.allow_existing_reuse => {
                    AdapterOutcome::Reused(ReadbackIdentity {
                        canonical_identity_hash: identity.stable_hash(),
                        authoritative_revision: 0,
                    })
                }
                _ => conflict(&request, ConflictKind::WrongType),
            };
        }
        Err(_) => return no_effect_conflict(&request),
    };

    #[cfg(test)]
    if matches!(fault, TestMutationFault::AfterFileCreate) {
        drop(file);
        return match bounded_readback(
            &condition,
            &request.requested_path,
            PhysicalResourceKind::MarkdownFile,
        ) {
            Ok(identity) => applied(
                &request,
                EffectCompletionKind::PartialEffect,
                identity.stable_hash(),
                Some(0),
            ),
            Err(_) => indeterminate(&request),
        };
    }

    if file.write_all(initial_bytes).is_err() {
        drop(file);
        return readback_partial_file(&condition, &request);
    }
    #[cfg(test)]
    if matches!(fault, TestMutationFault::AfterFileWrite) {
        drop(file);
        return readback_partial_file(&condition, &request);
    }
    if file.flush().is_err() || file.sync_all().is_err() {
        drop(file);
        return readback_partial_file(&condition, &request);
    }
    drop(file);

    #[cfg(test)]
    if matches!(fault, TestMutationFault::ReadbackUnavailable) {
        return indeterminate(&request);
    }
    #[cfg(test)]
    if let TestMutationFault::PauseBeforeReadback { reached, resume } = &fault {
        reached.wait();
        resume.wait();
    }

    match bounded_readback(
        &condition,
        &request.requested_path,
        PhysicalResourceKind::MarkdownFile,
    ) {
        Ok(identity) => {
            match read_initial_bytes_bounded(&request.requested_path, initial_bytes.len()) {
                Ok(bytes) if bytes == initial_bytes => applied(
                    &request,
                    EffectCompletionKind::CompleteEffect,
                    identity.stable_hash(),
                    Some(bytes.len() as u64),
                ),
                Ok(bytes) => applied(
                    &request,
                    EffectCompletionKind::PartialEffect,
                    identity.stable_hash(),
                    Some(bytes.len() as u64),
                ),
                Err(_) => indeterminate(&request),
            }
        }
        Err(_) => indeterminate(&request),
    }
}

fn read_initial_bytes_bounded(path: &Path, expected_length: usize) -> std::io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let limit = u64::try_from(expected_length)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::with_capacity(expected_length.saturating_add(1));
    file.take(limit).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn readback_partial_file(
    condition: &ValidatedPhysicalCondition,
    request: &PhysicalVerificationRequest,
) -> AdapterOutcome {
    match bounded_readback(
        condition,
        &request.requested_path,
        PhysicalResourceKind::MarkdownFile,
    ) {
        Ok(identity) => {
            let length = fs::metadata(&request.requested_path)
                .ok()
                .map(|metadata| metadata.len());
            applied(
                request,
                EffectCompletionKind::PartialEffect,
                identity.stable_hash(),
                length,
            )
        }
        Err(_) => indeterminate(request),
    }
}

fn bounded_readback(
    condition: &ValidatedPhysicalCondition,
    path: &Path,
    kind: PhysicalResourceKind,
) -> Result<PhysicalIdentity, PhysicalFailure> {
    let started = Instant::now();
    let mut last = PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable);
    for _ in 0..READBACK_MAX_ATTEMPTS {
        revalidate_anchor(condition)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if has_reparse_attribute(&metadata) {
                    return Err(PhysicalFailure::new(
                        StableErrorCode::PhysicalReparseBlocked,
                    ));
                }
                let kind_matches = match kind {
                    PhysicalResourceKind::Directory => metadata.is_dir(),
                    PhysicalResourceKind::MarkdownFile => metadata.is_file(),
                };
                if !kind_matches {
                    return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
                }
                let identity = open_identity(path)?;
                if identity.is_reparse()
                    || !is_contained(
                        &normalize_path_identity(&condition.managed_root_identity.final_path),
                        &normalize_path_identity(&identity.final_path),
                    )
                {
                    return Err(PhysicalFailure::new(
                        StableErrorCode::PhysicalContainmentBlocked,
                    ));
                }
                revalidate_anchor(condition)?;
                return Ok(identity);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                ) =>
            {
                last = PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable);
            }
            Err(_) => {
                return Err(PhysicalFailure::new(
                    StableErrorCode::PhysicalEffectIndeterminate,
                ))
            }
        }
        if started.elapsed().as_millis() >= u128::from(READBACK_MAX_TOTAL_MILLIS) {
            break;
        }
    }
    Err(last)
}

fn applied(
    request: &PhysicalVerificationRequest,
    completion: EffectCompletionKind,
    identity_hash: String,
    byte_length: Option<u64>,
) -> AdapterOutcome {
    AdapterOutcome::Applied(EffectReceipt {
        effect_kind: AppliedEffectKind::Created,
        completion,
        canonical_identity_hash: identity_hash,
        resource_record_id: Some(request_hash(request)),
        byte_length,
    })
}

fn partial(
    request: &PhysicalVerificationRequest,
    identity_hash: &str,
    byte_length: Option<u64>,
) -> AdapterOutcome {
    applied(
        request,
        EffectCompletionKind::PartialEffect,
        identity_hash.to_string(),
        byte_length,
    )
}

fn conflict(request: &PhysicalVerificationRequest, kind: ConflictKind) -> AdapterOutcome {
    let code = match kind {
        ConflictKind::WrongType => StableErrorCode::PhysicalWrongType,
        ConflictKind::ContainmentFailed => StableErrorCode::PhysicalContainmentBlocked,
        _ => StableErrorCode::PhysicalMutationConditionFailed,
    };
    AdapterOutcome::Conflict(ConflictFacts {
        code: Some(code),
        kind,
        canonical_identity_hash: request_hash(request),
    })
}

fn no_effect_conflict(request: &PhysicalVerificationRequest) -> AdapterOutcome {
    conflict(request, ConflictKind::PolicyConflict)
}

fn indeterminate(request: &PhysicalVerificationRequest) -> AdapterOutcome {
    use crate::manuscript_provisioning_contract::{IndeterminateFacts, IndeterminateStage};
    AdapterOutcome::Indeterminate(IndeterminateFacts {
        stage: IndeterminateStage::AdapterEffect,
        code: StableErrorCode::PhysicalEffectIndeterminate,
        canonical_identity_hash: request_hash(request),
    })
}

#[cfg(target_os = "windows")]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(not(target_os = "windows"))]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0;

#[cfg(target_os = "windows")]
fn has_reparse_attribute(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn has_reparse_attribute(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(not(any(target_os = "windows", unix)))]
fn open_identity(_path: &Path) -> Result<PhysicalIdentity, PhysicalFailure> {
    Err(PhysicalFailure::new(
        StableErrorCode::PhysicalAuthorityUnavailable,
    ))
}

// Runtime-only metadata representation in this owner; never serialized. Keep
// full-width dev/ino and exclude mutable directory nlink/mtime from identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnixPhysicalIdentity {
    device: u64,
    inode: u64,
    kind: PhysicalResourceKind,
    final_path: String,
}

impl UnixPhysicalIdentity {
    pub(crate) fn stable_hash(&self) -> String {
        // Physical identity follows the existing Unix writer's dev/ino tuple.
        // Placement spelling remains in Eq for anchor/replacement revalidation.
        sha256(format!("unix:{}:{}", self.device, self.inode))
    }

    fn is_reparse(&self) -> bool {
        // Unix observations reject symlinks before constructing this value.
        false
    }
}

fn unix_metadata_kind(
    is_symlink: bool,
    is_file: bool,
    is_directory: bool,
    nlink: u64,
) -> Result<PhysicalResourceKind, PhysicalFailure> {
    if is_symlink {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalReparseBlocked,
        ));
    }
    if is_directory {
        // Directory link counts include child directories; they are not the
        // single-link constraint enforced by the existing manuscript writer.
        return Ok(PhysicalResourceKind::Directory);
    }
    if !is_file {
        return Err(PhysicalFailure::new(StableErrorCode::PhysicalWrongType));
    }
    if nlink != 1 {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalIdentityMismatch,
        ));
    }
    Ok(PhysicalResourceKind::MarkdownFile)
}

#[cfg(unix)]
fn open_identity(path: &Path) -> Result<PhysicalIdentity, PhysicalFailure> {
    use std::os::unix::fs::MetadataExt;

    let observe = |at: &Path| -> Result<fs::Metadata, PhysicalFailure> {
        // Same symlink-component policy as the existing Unix manuscript IO.
        for ancestor in at.ancestors() {
            let metadata = fs::symlink_metadata(ancestor)
                .map_err(|_| PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable))?;
            if metadata.file_type().is_symlink() {
                return Err(PhysicalFailure::new(
                    StableErrorCode::PhysicalReparseBlocked,
                ));
            }
        }
        fs::symlink_metadata(at)
            .map_err(|_| PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable))
    };
    let identity = |metadata: &fs::Metadata,
                    final_path: &str|
     -> Result<UnixPhysicalIdentity, PhysicalFailure> {
        Ok(UnixPhysicalIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            kind: unix_metadata_kind(
                metadata.file_type().is_symlink(),
                metadata.is_file(),
                metadata.is_dir(),
                metadata.nlink(),
            )?,
            final_path: final_path.to_string(),
        })
    };
    let before = observe(path)?;
    let canonical = fs::canonicalize(path)
        .map_err(|_| PhysicalFailure::new(StableErrorCode::PhysicalAuthorityUnavailable))?;
    let final_path = canonical
        .to_str()
        .ok_or_else(|| PhysicalFailure::new(StableErrorCode::OperationInvalidInput))?;
    let first = identity(&before, final_path)?;
    let canonical_observation = identity(&observe(&canonical)?, final_path)?;
    let after = identity(&observe(path)?, final_path)?;
    if first != canonical_observation || first != after {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalIdentityMismatch,
        ));
    }
    Ok(after)
}

#[cfg(target_os = "windows")]
fn open_identity(path: &Path) -> Result<PhysicalIdentity, PhysicalFailure> {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalAuthorityUnavailable,
        ));
    }
    let handle = OwnedHandle(raw);
    let mut information = ByHandleFileInformation::default();
    if unsafe { GetFileInformationByHandle(handle.0, &mut information) } == 0 {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalAuthorityUnavailable,
        ));
    }
    let mut tag = FileAttributeTagInfo::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            (&mut tag as *mut FileAttributeTagInfo).cast(),
            std::mem::size_of::<FileAttributeTagInfo>() as u32,
        )
    } == 0
    {
        return Err(PhysicalFailure::new(
            StableErrorCode::PhysicalAuthorityUnavailable,
        ));
    }
    let final_path = final_path_by_handle(handle.0)?;
    Ok(WindowsPhysicalIdentity {
        volume_serial: u64::from(information.volume_serial_number),
        file_id: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
        reparse_tag: tag.reparse_tag,
        final_path,
        attributes: tag.file_attributes,
    })
}

#[cfg(test)]
mod save_as_candidate_observation_tests {
    use super::*;

    fn isolated_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "labpod-pre-r1-physical-observation-{}",
            Uuid::new_v4()
        ))
    }

    #[test]
    fn target_candidate_observation_has_zero_filesystem_effect() {
        let root = isolated_root();
        fs::create_dir_all(&root).unwrap();
        let target = root.join("Target.md");
        let before_entries = fs::read_dir(&root).unwrap().count();
        let before_modified = fs::metadata(&root).unwrap().modified().unwrap();

        let observed =
            observe_save_as_target_candidate(target.to_string_lossy().to_string()).unwrap();

        let after_entries = fs::read_dir(&root).unwrap().count();
        let after_modified = fs::metadata(&root).unwrap().modified().unwrap();
        assert!(observed.parent_exists);
        assert!(!observed.target_exists);
        assert_eq!(observed.normalized_final_filename, "Target.md");
        assert_eq!(observed.observation_proof.len(), 64);
        assert_eq!(before_entries, after_entries);
        assert_eq!(before_modified, after_modified);
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_candidate_observation_reports_existing_without_mutation() {
        let root = isolated_root();
        fs::create_dir_all(&root).unwrap();
        let target = root.join("existing.md");
        fs::write(&target, b"preserved").unwrap();
        let before = fs::read(&target).unwrap();

        let observed =
            observe_save_as_target_candidate(target.to_string_lossy().to_string()).unwrap();

        assert!(observed.target_exists);
        assert_eq!(fs::read(&target).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_candidate_observation_fails_closed_for_missing_parent() {
        let root = isolated_root();
        let target = root.join("missing").join("target.md");
        assert_eq!(
            observe_save_as_target_candidate(target.to_string_lossy().to_string()),
            Err("SAVE_AS_PARENT_MISSING".to_string())
        );
        assert!(!root.exists());
    }
}

#[cfg(target_os = "windows")]
fn final_path_by_handle(handle: *mut c_void) -> Result<String, PhysicalFailure> {
    let mut buffer = vec![0_u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        };
        if length == 0 {
            return Err(PhysicalFailure::new(
                StableErrorCode::PhysicalAuthorityUnavailable,
            ));
        }
        if length < buffer.len() as u32 {
            return Ok(String::from_utf16_lossy(&buffer[..length as usize]));
        }
        buffer.resize(length as usize + 1, 0);
    }
}

#[cfg(target_os = "windows")]
struct OwnedHandle(*mut c_void);

#[cfg(target_os = "windows")]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(target_os = "windows")]
const FILE_READ_ATTRIBUTES: u32 = 0x0080;
#[cfg(target_os = "windows")]
const FILE_SHARE_READ: u32 = 0x0000_0001;
#[cfg(target_os = "windows")]
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
#[cfg(target_os = "windows")]
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
#[cfg(target_os = "windows")]
const OPEN_EXISTING: u32 = 3;
#[cfg(target_os = "windows")]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(target_os = "windows")]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
#[cfg(target_os = "windows")]
const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;
#[cfg(target_os = "windows")]
const INVALID_HANDLE_VALUE: *mut c_void = -1_isize as *mut c_void;

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct ByHandleFileInformation {
    file_attributes: u32,
    creation_time: FileTime,
    last_access_time: FileTime,
    last_write_time: FileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct FileAttributeTagInfo {
    file_attributes: u32,
    reparse_tag: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *mut c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: *mut c_void,
    ) -> *mut c_void;
    fn GetFileInformationByHandle(
        file: *mut c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
    fn GetFileInformationByHandleEx(
        file: *mut c_void,
        information_class: i32,
        information: *mut c_void,
        buffer_size: u32,
    ) -> i32;
    fn GetFinalPathNameByHandleW(
        file: *mut c_void,
        path: *mut u16,
        path_length: u32,
        flags: u32,
    ) -> u32;
    fn CloseHandle(object: *mut c_void) -> i32;
}

#[cfg(test)]
mod lp15_f2_tests {
    use super::*;

    #[test]
    fn posix_filesystem_spelling_case_and_containment_are_preserved() {
        for path in ["/Users/Ada/研究 空格/Run.md", "/Volumes/Data/Project", "/"] {
            assert_eq!(canonical_filesystem_spelling(path), path);
            assert_eq!(normalize_path_identity(path), path);
            assert_eq!(save_as_path_identity(path), path);
        }
        assert_ne!(
            normalize_path_identity("/Users/Ada/A"),
            normalize_path_identity("/Users/Ada/a")
        );
        assert!(is_contained("/Users/Ada", "/Users/Ada/研究 空格"));
        assert!(is_contained("/", "/Volumes/Data"));
        assert!(!is_contained("/Users/Ada", "/Users/Adam/file"));
        assert!(!is_contained("/Users/Ada", "/users/ada/file"));
    }

    #[test]
    fn windows_keys_and_filesystem_spelling_keep_existing_contract() {
        for path in [
            r"C:\Managed\Run.md",
            r"\\?\C:\Managed\Run.md",
            r"\\?\UNC\Server\Share\Run.md",
            r"\\Server\Share/Run.md",
        ] {
            assert_eq!(
                normalize_path_identity(path),
                normalize_windows_identity(path)
            );
            assert_eq!(
                canonical_filesystem_spelling(path),
                display_windows_path(path)
            );
            assert_eq!(
                save_as_path_identity(path),
                path.replace('\\', "/").to_lowercase()
            );
        }
        assert!(is_contained(r"c:\managed", r"c:\managed\run.md"));
        assert!(!is_contained(r"c:\managed", r"c:\managed-other\run.md"));
    }

    #[test]
    fn unix_identity_retains_full_tuple_and_detects_replacement() {
        let original = UnixPhysicalIdentity {
            device: u64::MAX - 1,
            inode: u64::MAX - 2,
            kind: PhysicalResourceKind::Directory,
            final_path: "/Volumes/Data/Root".to_string(),
        };
        let same = original.clone();
        assert_eq!(original, same);
        assert_eq!(original.stable_hash(), same.stable_hash());
        for replacement in [
            UnixPhysicalIdentity {
                inode: original.inode - 1,
                ..original.clone()
            },
            UnixPhysicalIdentity {
                device: original.device - 1,
                ..original.clone()
            },
            UnixPhysicalIdentity {
                inode: u64::from(original.inode as u32),
                ..original.clone()
            },
        ] {
            assert_ne!(original, replacement);
            assert_ne!(original.stable_hash(), replacement.stable_hash());
        }
        let alternate_spelling = UnixPhysicalIdentity {
            final_path: "/Volumes/Data/root".to_string(),
            ..original.clone()
        };
        assert_ne!(original, alternate_spelling, "placement must still be revalidated");
        assert_eq!(original.stable_hash(), alternate_spelling.stable_hash(), "same physical tuple");
    }

    #[test]
    fn unix_links_check_files_and_directories_by_kind() {
        assert_eq!(
            unix_metadata_kind(false, true, false, 1),
            Ok(PhysicalResourceKind::MarkdownFile)
        );
        for links in [0, 2, u64::MAX] {
            assert_eq!(
                unix_metadata_kind(false, true, false, links)
                    .unwrap_err()
                    .code,
                StableErrorCode::PhysicalIdentityMismatch
            );
        }
        for links in [1, 2, 9] {
            assert_eq!(
                unix_metadata_kind(false, false, true, links),
                Ok(PhysicalResourceKind::Directory)
            );
        }
        assert_eq!(
            unix_metadata_kind(true, false, true, 2).unwrap_err().code,
            StableErrorCode::PhysicalReparseBlocked
        );
        assert_eq!(
            unix_metadata_kind(false, false, false, 1).unwrap_err().code,
            StableErrorCode::PhysicalWrongType
        );
    }

    // Retained for the Mac handoff; this is not executed by the Windows gate.
    #[cfg(unix)]
    #[test]
    fn unix_native_identity_link_and_anchor_observations() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let path = std::env::temp_dir().join(format!("lp15-f2-unix-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let root = fs::canonicalize(&path).unwrap();
        let before = open_identity(&root).unwrap();
        let md = fs::metadata(&root).unwrap();
        assert_eq!((before.device, before.inode), (md.dev(), md.ino()));
        fs::create_dir(root.join("child")).unwrap();
        assert_eq!(
            open_identity(&root).unwrap(),
            before,
            "directory nlink may change"
        );
        let file = root.join("研究 Run.md");
        fs::write(&file, b"preserved").unwrap();
        let first = open_identity(&file).unwrap();
        fs::rename(&file, root.join("old.md")).unwrap();
        fs::write(&file, b"replacement").unwrap();
        assert_ne!(open_identity(&file).unwrap(), first);
        let alias = root.join("alias.md");
        fs::hard_link(&file, &alias).unwrap();
        assert_eq!(
            open_identity(&file).unwrap_err().code,
            StableErrorCode::PhysicalIdentityMismatch
        );
        fs::remove_file(&alias).unwrap();
        symlink(&file, &alias).unwrap();
        assert_eq!(
            open_identity(&alias).unwrap_err().code,
            StableErrorCode::PhysicalReparseBlocked
        );
        fs::remove_file(&alias).unwrap();
        symlink(root.join("child"), &alias).unwrap();
        assert_eq!(
            open_identity(&alias).unwrap_err().code,
            StableErrorCode::PhysicalReparseBlocked
        );
        fs::remove_file(&alias).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"replacement");
        fs::remove_dir_all(&root).unwrap();
    }
}
