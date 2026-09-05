#![allow(dead_code)]

use super::ownership_supervisor::RecoveryExecutionPlanningFacts;
use super::shared_executor::{
    AdapterContractManifest, AdapterInvocationOutcome, AdapterPlanningFailure,
    AdapterPreMutationFailure, AdapterReadback, ExecutionInvocationContext, SharedExecutionAdapter,
};
use crate::db::manuscript_provisioning_operation_state::{
    ExecutionEffectClassification, ExecutionReadbackClassification,
};
use crate::manuscript_provisioning_contract::{
    AdapterOutcome, ConflictKind, DurableStepKind, DurableStepScope, EffectCompletionKind,
    StableErrorCode,
};
use crate::physical_freshness::{
    apply_creation_only, normalize_path_identity, ExpectedTargetState, PhysicalFreshVerifier,
    PhysicalResourceKind, PhysicalVerificationRequest, ValidatedPhysicalCondition,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const ADAPTER_ID: &str = "labpod.review.primary.recovery";
const CONTRACT_VERSION: &str = "review-primary-recovery@1";
const TARGET_IDENTITY_CONTRACT_VERSION: &str = "review-primary-target-identity@1";
const READBACK_CONTRACT_VERSION: &str = "review-primary-readback@1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewLifecycleState {
    Active,
    Restored,
    SoftDeleted,
    Deleting,
    ParentUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReviewPlanningAuthority {
    pub review_id: String,
    pub project_id: String,
    pub lifecycle: ReviewLifecycleState,
    pub authority_revision: String,
}

/// Narrow consumer of the already-frozen Planning Authority Port contract.
/// It does not own or mutate Planning state and has no production registration
/// in CRA-1.
pub(crate) trait ReviewPlanningAuthorityVerifier: Send + Sync {
    fn read_fresh(&self, review_id: &str) -> Result<ReviewPlanningAuthority, ReviewAdapterResult>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewAdapterResult {
    ReviewInspectionComplete,
    ReviewPlanMaterialized,
    ReviewWorkspaceDirectoryCreated,
    ReviewPrimaryManuscriptCreated,
    ReviewTargetReused,
    ReviewNoEffectProven,
    ReviewPartialEffect,
    ReviewPhysicalConflict,
    MetadataAuthorityIncomplete,
    ReviewLifecycleDenied,
    ReviewExternalMutationDenied,
    ReviewPathIdentityMismatch,
    ReviewContainmentFailed,
    ReviewAdapterContractMismatch,
    ReviewReadbackUnavailable,
    ReviewExecutionRecoveryRequired,
    ReviewExecutionQuarantined,
    RepositoryBusy,
    RepositoryUnavailable,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewAdapterFault {
    None,
    PreMutationUnavailable,
    InvocationInterrupted,
    InvocationOutcomeUnknownAfterEffect,
    ReadbackUnavailable,
    ReadbackPartial,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReviewFileRef {
    id: String,
    owner_type: String,
    owner_id: String,
    manuscript_channel: String,
    resource_kind: String,
    file_role: String,
    location_mode: String,
    file_type: String,
    path: PathBuf,
    path_identity_key: String,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReviewMetadataSnapshot {
    authority: ReviewPlanningAuthority,
    binding_id: String,
    binding_updated_at: String,
    managed_root: PathBuf,
    managed_root_updated_at: String,
    workspace: ReviewFileRef,
    manuscript: ReviewFileRef,
    current: ReviewFileRef,
    resource_identity_hash: String,
    placement_identity_hash: String,
    parent_identity_hash: String,
    metadata_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewPhysicalInspectionState {
    Intact,
    Missing,
}

#[derive(Debug)]
pub(crate) struct ReviewProductionInspection {
    pub(crate) state: ReviewPhysicalInspectionState,
    pub(crate) project_id: String,
    pub(crate) planning_authority_revision: String,
    pub(crate) binding_id: String,
    pub(crate) binding_updated_at: String,
    pub(crate) default_folder_file_ref_id: String,
    pub(crate) default_folder_updated_at: String,
    pub(crate) default_folder_path_identity_key: String,
    pub(crate) default_manuscript_file_ref_id: String,
    pub(crate) default_manuscript_updated_at: String,
    pub(crate) default_manuscript_path_identity_key: String,
    pub(crate) current_file_ref_id: String,
    pub(crate) current_updated_at: String,
    pub(crate) current_path_identity_key: String,
    pub(crate) managed_root_updated_at: String,
    pub(crate) canonical_resource_identity_hash: String,
    pub(crate) canonical_placement_identity_hash: String,
    pub(crate) parent_shared_identity_hash: String,
    pub(crate) metadata_fingerprint: String,
}

impl ReviewMetadataSnapshot {
    fn target(&self, ordinal: usize) -> (&ReviewFileRef, PhysicalResourceKind, &'static str) {
        match ordinal {
            0 => (
                &self.workspace,
                PhysicalResourceKind::Directory,
                "managed-review-workspace",
            ),
            1 => (
                &self.manuscript,
                PhysicalResourceKind::MarkdownFile,
                "managed-review-primary-manuscript",
            ),
            _ => panic!("closed Review Adapter ordinal"),
        }
    }

    fn physical_request(&self, ordinal: usize) -> PhysicalVerificationRequest {
        let (target, expected_kind, role) = self.target(ordinal);
        let expected_target_state = match fs::symlink_metadata(&target.path) {
            Ok(_) => ExpectedTargetState::ExistingExact,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ExpectedTargetState::Missing
            }
            Err(_) => ExpectedTargetState::ExistingExact,
        };
        PhysicalVerificationRequest {
            resource_role: role.to_string(),
            owner_type: "review".to_string(),
            owner_id: self.authority.review_id.clone(),
            channel: "primary".to_string(),
            scope: "channel:primary".to_string(),
            managed_root: self.managed_root.clone(),
            requested_path: target.path.clone(),
            expected_kind,
            expected_target_state,
            allow_existing_reuse: true,
        }
    }
}

pub(crate) struct CanonicalReviewAdapter {
    database_path: PathBuf,
    authority: Arc<dyn ReviewPlanningAuthorityVerifier>,
    planned: ReviewMetadataSnapshot,
    initial_physical_state: ReviewPhysicalInspectionState,
    last_result: ReviewAdapterResult,
    #[cfg(test)]
    fault: ReviewAdapterFault,
}

impl CanonicalReviewAdapter {
    pub(crate) fn inspect(
        database_path: PathBuf,
        review_id: &str,
        authority: Arc<dyn ReviewPlanningAuthorityVerifier>,
    ) -> Result<Self, ReviewAdapterResult> {
        let planned = read_snapshot(&database_path, review_id, authority.as_ref())?;
        let initial_physical_state = validate_physical_plan(&planned)?;
        Ok(Self {
            database_path,
            authority,
            planned,
            initial_physical_state,
            last_result: ReviewAdapterResult::ReviewInspectionComplete,
            #[cfg(test)]
            fault: ReviewAdapterFault::None,
        })
    }

    pub(crate) fn adapter_id() -> &'static str {
        ADAPTER_ID
    }

    pub(crate) fn contract_version() -> &'static str {
        CONTRACT_VERSION
    }

    pub(crate) fn descriptor_hash() -> String {
        length_prefixed_hash(
            "labpod.review.primary.adapter-descriptor.v1",
            &[
                ADAPTER_ID,
                CONTRACT_VERSION,
                "review",
                "primary",
                "ensure-directory:primary",
                "ensure-manuscript:primary",
                TARGET_IDENTITY_CONTRACT_VERSION,
                READBACK_CONTRACT_VERSION,
            ],
        )
    }

    pub(crate) fn capability_fingerprint() -> String {
        length_prefixed_hash(
            "labpod.review.primary.adapter-capability.v1",
            &[
                "managed-only",
                "creation-only",
                "directory-final-component-only",
                "file-create-new-zero-byte",
                "no-metadata-writes",
                "mandatory-readback",
            ],
        )
    }

    pub(crate) fn canonical_resource_identity_hash(&self) -> &str {
        &self.planned.resource_identity_hash
    }

    pub(crate) fn owner_id_for_registry(&self) -> &str {
        &self.planned.authority.review_id
    }

    pub(crate) fn canonical_placement_identity_hash(&self) -> &str {
        &self.planned.placement_identity_hash
    }

    pub(crate) fn parent_identity_hash(&self) -> &str {
        &self.planned.parent_identity_hash
    }

    pub(crate) fn last_result(&self) -> ReviewAdapterResult {
        self.last_result
    }

    pub(crate) fn production_inspection(&self) -> ReviewProductionInspection {
        ReviewProductionInspection {
            state: self.initial_physical_state,
            project_id: self.planned.authority.project_id.clone(),
            planning_authority_revision: self.planned.authority.authority_revision.clone(),
            binding_id: self.planned.binding_id.clone(),
            binding_updated_at: self.planned.binding_updated_at.clone(),
            default_folder_file_ref_id: self.planned.workspace.id.clone(),
            default_folder_updated_at: self.planned.workspace.updated_at.clone(),
            default_folder_path_identity_key: self.planned.workspace.path_identity_key.clone(),
            default_manuscript_file_ref_id: self.planned.manuscript.id.clone(),
            default_manuscript_updated_at: self.planned.manuscript.updated_at.clone(),
            default_manuscript_path_identity_key: self.planned.manuscript.path_identity_key.clone(),
            current_file_ref_id: self.planned.current.id.clone(),
            current_updated_at: self.planned.current.updated_at.clone(),
            current_path_identity_key: self.planned.current.path_identity_key.clone(),
            managed_root_updated_at: self.planned.managed_root_updated_at.clone(),
            canonical_resource_identity_hash: self.planned.resource_identity_hash.clone(),
            canonical_placement_identity_hash: self.planned.placement_identity_hash.clone(),
            parent_shared_identity_hash: self.planned.parent_identity_hash.clone(),
            metadata_fingerprint: self.planned.metadata_fingerprint.clone(),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_fault_for_test(&mut self, fault: ReviewAdapterFault) {
        self.fault = fault;
    }

    fn fresh_snapshot(&self) -> Result<ReviewMetadataSnapshot, ReviewAdapterResult> {
        let fresh = read_snapshot(
            &self.database_path,
            &self.planned.authority.review_id,
            self.authority.as_ref(),
        )?;
        if fresh.metadata_fingerprint != self.planned.metadata_fingerprint
            || fresh.authority.project_id != self.planned.authority.project_id
        {
            return Err(ReviewAdapterResult::ReviewPathIdentityMismatch);
        }
        Ok(fresh)
    }

    fn plan_failure(result: ReviewAdapterResult) -> AdapterPlanningFailure {
        match result {
            ReviewAdapterResult::ReviewLifecycleDenied => AdapterPlanningFailure::LifecycleDenied,
            ReviewAdapterResult::MetadataAuthorityIncomplete => {
                AdapterPlanningFailure::MetadataAuthorityIncomplete
            }
            ReviewAdapterResult::ReviewExternalMutationDenied => {
                AdapterPlanningFailure::ExternalMutationDenied
            }
            ReviewAdapterResult::ReviewPathIdentityMismatch => {
                AdapterPlanningFailure::PathIdentityMismatch
            }
            ReviewAdapterResult::ReviewContainmentFailed => {
                AdapterPlanningFailure::ContainmentFailed
            }
            ReviewAdapterResult::ReviewAdapterContractMismatch => {
                AdapterPlanningFailure::ContractMismatch
            }
            ReviewAdapterResult::RepositoryUnavailable | ReviewAdapterResult::RepositoryBusy => {
                AdapterPlanningFailure::RepositoryUnavailable
            }
            _ => AdapterPlanningFailure::PhysicalConflict,
        }
    }
}

impl SharedExecutionAdapter for CanonicalReviewAdapter {
    fn manifest(&self) -> AdapterContractManifest {
        AdapterContractManifest::new(
            ADAPTER_ID,
            CONTRACT_VERSION,
            Self::descriptor_hash(),
            Self::capability_fingerprint(),
            vec![
                (DurableStepKind::EnsureDirectory, DurableStepScope::Primary),
                (DurableStepKind::EnsureManuscript, DurableStepScope::Primary),
            ],
        )
        .expect("static Canonical Review Adapter manifest")
    }

    fn validate_plan(
        &self,
        planning: &RecoveryExecutionPlanningFacts,
        project_id: &str,
    ) -> Result<(), AdapterPlanningFailure> {
        if planning.owner_type != "review"
            || planning.owner_id != self.planned.authority.review_id
            || planning.scope_kind != "channel"
            || planning.manuscript_channel.as_deref() != Some("primary")
            || project_id != self.planned.authority.project_id
            || planning.canonical_resource_identity_hash != self.planned.resource_identity_hash
            || planning.canonical_placement_identity_hash != self.planned.placement_identity_hash
            || planning.parent_shared_identity_hash.as_deref()
                != Some(self.planned.parent_identity_hash.as_str())
        {
            return Err(AdapterPlanningFailure::ContractMismatch);
        }
        let fresh = self.fresh_snapshot().map_err(Self::plan_failure)?;
        validate_physical_plan(&fresh)
            .map(|_| ())
            .map_err(Self::plan_failure)
    }

    fn physical_request(
        &self,
        _planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
    ) -> PhysicalVerificationRequest {
        self.planned.physical_request(step_ordinal)
    }

    fn pre_mutation_check(
        &mut self,
        _planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
        condition: ValidatedPhysicalCondition,
    ) -> Result<ValidatedPhysicalCondition, AdapterPreMutationFailure> {
        #[cfg(test)]
        if self.fault == ReviewAdapterFault::PreMutationUnavailable {
            return Err(AdapterPreMutationFailure::Unavailable);
        }
        let fresh = self.fresh_snapshot().map_err(map_pre_mutation_failure)?;
        let (_, kind, _) = fresh.target(step_ordinal);
        match kind {
            PhysicalResourceKind::Directory => {
                if !condition.observed_target_exists() && condition.missing_component_count() != 1 {
                    return Err(AdapterPreMutationFailure::ContainmentFailed);
                }
            }
            PhysicalResourceKind::MarkdownFile => {
                if condition.missing_component_count() != 0 {
                    return Err(AdapterPreMutationFailure::ContainmentFailed);
                }
                if condition.observed_target_exists()
                    && fs::metadata(&fresh.manuscript.path)
                        .map(|metadata| metadata.len() != 0)
                        .unwrap_or(true)
                {
                    return Err(AdapterPreMutationFailure::Conflict);
                }
            }
        }
        Ok(condition)
    }

    fn invoke_once(
        &mut self,
        step_ordinal: usize,
        invocation: &mut ExecutionInvocationContext<'_>,
        condition: ValidatedPhysicalCondition,
    ) -> AdapterInvocationOutcome {
        #[cfg(test)]
        if self.fault == ReviewAdapterFault::InvocationInterrupted {
            self.last_result = ReviewAdapterResult::ReviewExecutionRecoveryRequired;
            return AdapterInvocationOutcome::Interrupted;
        }
        let request = self.planned.physical_request(step_ordinal);
        let outcome = match apply_creation_only(condition, request, invocation.permit()) {
            AdapterOutcome::Applied(receipt) => {
                self.last_result = if receipt.completion == EffectCompletionKind::PartialEffect {
                    ReviewAdapterResult::ReviewPartialEffect
                } else if step_ordinal == 0 {
                    ReviewAdapterResult::ReviewWorkspaceDirectoryCreated
                } else {
                    ReviewAdapterResult::ReviewPrimaryManuscriptCreated
                };
                AdapterInvocationOutcome::Returned {
                    effect: ExecutionEffectClassification::Created,
                    observed_identity_hash: receipt.canonical_identity_hash,
                    resource_record_id: receipt.resource_record_id,
                }
            }
            AdapterOutcome::Reused(identity) => {
                self.last_result = ReviewAdapterResult::ReviewTargetReused;
                AdapterInvocationOutcome::Returned {
                    effect: ExecutionEffectClassification::Reused,
                    observed_identity_hash: identity.canonical_identity_hash,
                    resource_record_id: Some(self.planned.target(step_ordinal).0.id.clone()),
                }
            }
            AdapterOutcome::NoEffectProven(absence) => {
                self.last_result = ReviewAdapterResult::ReviewNoEffectProven;
                AdapterInvocationOutcome::Returned {
                    effect: ExecutionEffectClassification::Preserved,
                    observed_identity_hash: absence.canonical_identity_hash,
                    resource_record_id: None,
                }
            }
            AdapterOutcome::Conflict(facts) => {
                self.last_result = match facts.kind {
                    ConflictKind::ContainmentFailed => ReviewAdapterResult::ReviewContainmentFailed,
                    ConflictKind::IdentityMismatch => {
                        ReviewAdapterResult::ReviewPathIdentityMismatch
                    }
                    _ => ReviewAdapterResult::ReviewPhysicalConflict,
                };
                AdapterInvocationOutcome::Returned {
                    effect: ExecutionEffectClassification::Preserved,
                    observed_identity_hash: facts.canonical_identity_hash,
                    resource_record_id: None,
                }
            }
            AdapterOutcome::Unavailable(_) | AdapterOutcome::Indeterminate(_) => {
                self.last_result = ReviewAdapterResult::ReviewExecutionRecoveryRequired;
                AdapterInvocationOutcome::OutcomeUnknown
            }
        };
        #[cfg(test)]
        if self.fault == ReviewAdapterFault::InvocationOutcomeUnknownAfterEffect {
            self.last_result = ReviewAdapterResult::ReviewExecutionRecoveryRequired;
            return AdapterInvocationOutcome::OutcomeUnknown;
        }
        outcome
    }

    fn bounded_authoritative_readback(
        &mut self,
        _planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
        _invocation: &AdapterInvocationOutcome,
    ) -> AdapterReadback {
        #[cfg(test)]
        match self.fault {
            ReviewAdapterFault::ReadbackUnavailable => {
                self.last_result = ReviewAdapterResult::ReviewReadbackUnavailable;
                return readback(ExecutionReadbackClassification::Unavailable, None, None);
            }
            ReviewAdapterFault::ReadbackPartial => {
                self.last_result = ReviewAdapterResult::ReviewPartialEffect;
                return readback(ExecutionReadbackClassification::VerifiedPartial, None, None);
            }
            _ => {}
        }
        let fresh = match self.fresh_snapshot() {
            Ok(snapshot) => snapshot,
            Err(ReviewAdapterResult::ReviewPathIdentityMismatch) => {
                self.last_result = ReviewAdapterResult::ReviewPathIdentityMismatch;
                return readback(
                    ExecutionReadbackClassification::IdentityMismatch,
                    None,
                    None,
                );
            }
            Err(_) => {
                self.last_result = ReviewAdapterResult::ReviewReadbackUnavailable;
                return readback(ExecutionReadbackClassification::Unavailable, None, None);
            }
        };
        let (target, kind, role) = fresh.target(step_ordinal);
        match fs::symlink_metadata(&target.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.last_result = ReviewAdapterResult::ReviewNoEffectProven;
                return readback(
                    ExecutionReadbackClassification::VerifiedAbsent,
                    None,
                    Some(target.id.clone()),
                );
            }
            Err(_) => {
                self.last_result = ReviewAdapterResult::ReviewReadbackUnavailable;
                return readback(
                    ExecutionReadbackClassification::Unavailable,
                    None,
                    Some(target.id.clone()),
                );
            }
            Ok(metadata) if kind == PhysicalResourceKind::MarkdownFile && metadata.len() != 0 => {
                self.last_result = ReviewAdapterResult::ReviewPhysicalConflict;
                return readback(
                    ExecutionReadbackClassification::Conflict,
                    None,
                    Some(target.id.clone()),
                );
            }
            Ok(_) => {}
        }
        let request = PhysicalVerificationRequest {
            resource_role: role.to_string(),
            owner_type: "review".to_string(),
            owner_id: fresh.authority.review_id.clone(),
            channel: "primary".to_string(),
            scope: "channel:primary".to_string(),
            managed_root: fresh.managed_root.clone(),
            requested_path: target.path.clone(),
            expected_kind: kind,
            expected_target_state: ExpectedTargetState::ExistingExact,
            allow_existing_reuse: true,
        };
        match PhysicalFreshVerifier::verify(request) {
            Ok(condition) => {
                let identity = condition.authoritative_identity_hash();
                if identity.is_none() {
                    self.last_result = ReviewAdapterResult::ReviewReadbackUnavailable;
                    return readback(
                        ExecutionReadbackClassification::Unavailable,
                        None,
                        Some(target.id.clone()),
                    );
                }
                readback(
                    ExecutionReadbackClassification::VerifiedComplete,
                    identity,
                    Some(target.id.clone()),
                )
            }
            Err(error) => {
                let classification = physical_failure_classification(error.code);
                self.last_result = match classification {
                    ExecutionReadbackClassification::IdentityMismatch => {
                        ReviewAdapterResult::ReviewPathIdentityMismatch
                    }
                    ExecutionReadbackClassification::ContainmentFailed => {
                        ReviewAdapterResult::ReviewContainmentFailed
                    }
                    ExecutionReadbackClassification::Unavailable => {
                        ReviewAdapterResult::ReviewReadbackUnavailable
                    }
                    _ => ReviewAdapterResult::ReviewPhysicalConflict,
                };
                readback(classification, None, Some(target.id.clone()))
            }
        }
    }
}

fn readback(
    classification: ExecutionReadbackClassification,
    observed_identity_hash: Option<String>,
    resource_record_id: Option<String>,
) -> AdapterReadback {
    AdapterReadback {
        classification,
        observed_identity_hash,
        resource_record_id,
    }
}

fn read_snapshot(
    database_path: &Path,
    review_id: &str,
    authority: &dyn ReviewPlanningAuthorityVerifier,
) -> Result<ReviewMetadataSnapshot, ReviewAdapterResult> {
    let authority = authority.read_fresh(review_id)?;
    if authority.review_id != review_id
        || authority.project_id.trim().is_empty()
        || authority.authority_revision.trim().is_empty()
        || !matches!(
            authority.lifecycle,
            ReviewLifecycleState::Active | ReviewLifecycleState::Restored
        )
    {
        return Err(ReviewAdapterResult::ReviewLifecycleDenied);
    }
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ReviewAdapterResult::RepositoryUnavailable)?;
    let binding = connection
        .query_row(
            "SELECT id,default_folder_file_ref_id,default_manuscript_file_ref_id,
                    current_file_ref_id,updated_at
             FROM manuscript_bindings
             WHERE owner_type='review' AND owner_id=?1
               AND manuscript_channel='primary' AND deleted_at IS NULL",
            [review_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| ReviewAdapterResult::RepositoryUnavailable)?
        .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?;
    let (binding_id, folder_id, manuscript_id, current_id, binding_updated_at) = (
        binding.0,
        binding
            .1
            .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?,
        binding
            .2
            .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?,
        binding
            .3
            .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?,
        binding.4,
    );
    let workspace = read_file_ref(&connection, &folder_id)?
        .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?;
    let manuscript = read_file_ref(&connection, &manuscript_id)?
        .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?;
    let current = read_file_ref(&connection, &current_id)?
        .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?;
    validate_file_ref(
        &workspace,
        review_id,
        "folder",
        "defaultFolder",
        Some("managed"),
    )?;
    validate_file_ref(
        &manuscript,
        review_id,
        "file",
        "manuscript",
        Some("managed"),
    )?;
    validate_file_ref(&current, review_id, "file", "manuscript", None)?;
    if manuscript.file_type != "markdown" || current.file_type != "markdown" {
        return Err(ReviewAdapterResult::MetadataAuthorityIncomplete);
    }
    let root = connection
        .query_row(
            "SELECT configured_root,updated_at FROM managed_root_settings
             WHERE id='managed-root' AND deleted_at IS NULL",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| ReviewAdapterResult::RepositoryUnavailable)?
        .ok_or(ReviewAdapterResult::MetadataAuthorityIncomplete)?;
    let managed_root = PathBuf::from(root.0);
    if !managed_root.is_absolute()
        || !workspace.path.is_absolute()
        || !manuscript.path.is_absolute()
        || manuscript.path.parent() != Some(workspace.path.as_path())
        || normalize_path_identity(&workspace.path.to_string_lossy())
            != normalize_path_identity(&workspace.path_identity_key)
        || normalize_path_identity(&manuscript.path.to_string_lossy())
            != normalize_path_identity(&manuscript.path_identity_key)
        || normalize_path_identity(&current.path.to_string_lossy())
            != normalize_path_identity(&current.path_identity_key)
    {
        return Err(ReviewAdapterResult::ReviewPathIdentityMismatch);
    }
    let resource_identity_hash = length_prefixed_hash(
        "labpod.review.primary.resource-identity.v1",
        &[
            review_id,
            &binding_id,
            &workspace.id,
            &manuscript.id,
            &current.id,
            &manuscript.path_identity_key,
        ],
    );
    let placement_identity_hash = length_prefixed_hash(
        "labpod.review.primary.placement-identity.v1",
        &[
            &managed_root.to_string_lossy(),
            &workspace.id,
            &workspace.path_identity_key,
            &manuscript.path_identity_key,
        ],
    );
    let parent_identity_hash = length_prefixed_hash(
        "labpod.review.primary.parent-identity.v1",
        &[
            &authority.project_id,
            &authority.authority_revision,
            &managed_root.to_string_lossy(),
            &root.1,
        ],
    );
    let metadata_fingerprint = length_prefixed_hash(
        "labpod.review.primary.metadata-authority.v1",
        &[
            &authority.review_id,
            &authority.project_id,
            &authority.authority_revision,
            &binding_id,
            &binding_updated_at,
            &workspace.id,
            &workspace.updated_at,
            &manuscript.id,
            &manuscript.updated_at,
            &current.id,
            &current.updated_at,
            &root.1,
        ],
    );
    Ok(ReviewMetadataSnapshot {
        authority,
        binding_id,
        binding_updated_at,
        managed_root,
        managed_root_updated_at: root.1,
        workspace,
        manuscript,
        current,
        resource_identity_hash,
        placement_identity_hash,
        parent_identity_hash,
        metadata_fingerprint,
    })
}

fn read_file_ref(
    connection: &Connection,
    file_ref_id: &str,
) -> Result<Option<ReviewFileRef>, ReviewAdapterResult> {
    connection
        .query_row(
            "SELECT id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                    location_mode,file_type,path,path_identity_key,updated_at
             FROM file_refs WHERE id=?1 AND deleted_at IS NULL",
            [file_ref_id],
            |row| {
                Ok(ReviewFileRef {
                    id: row.get(0)?,
                    owner_type: row.get(1)?,
                    owner_id: row.get(2)?,
                    manuscript_channel: row.get(3)?,
                    resource_kind: row.get(4)?,
                    file_role: row.get(5)?,
                    location_mode: row.get(6)?,
                    file_type: row.get(7)?,
                    path: PathBuf::from(row.get::<_, String>(8)?),
                    path_identity_key: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|_| ReviewAdapterResult::RepositoryUnavailable)
}

fn validate_file_ref(
    file_ref: &ReviewFileRef,
    review_id: &str,
    resource_kind: &str,
    file_role: &str,
    location_mode: Option<&str>,
) -> Result<(), ReviewAdapterResult> {
    if file_ref.owner_type != "review"
        || file_ref.owner_id != review_id
        || file_ref.manuscript_channel != "primary"
        || file_ref.resource_kind != resource_kind
        || file_ref.file_role != file_role
    {
        return Err(ReviewAdapterResult::MetadataAuthorityIncomplete);
    }
    if location_mode.is_some_and(|expected| file_ref.location_mode != expected) {
        return Err(ReviewAdapterResult::ReviewExternalMutationDenied);
    }
    if !matches!(file_ref.location_mode.as_str(), "managed" | "external") {
        return Err(ReviewAdapterResult::MetadataAuthorityIncomplete);
    }
    Ok(())
}

fn validate_physical_plan(
    snapshot: &ReviewMetadataSnapshot,
) -> Result<ReviewPhysicalInspectionState, ReviewAdapterResult> {
    let mut missing = false;
    let workspace_exists = match fs::symlink_metadata(&snapshot.workspace.path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(ReviewAdapterResult::ReviewPhysicalConflict);
            }
            let condition = PhysicalFreshVerifier::verify(snapshot.physical_request(0))
                .map_err(map_physical)?;
            if !condition.observed_target_exists() {
                return Err(ReviewAdapterResult::ReviewPhysicalConflict);
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let condition = PhysicalFreshVerifier::verify(snapshot.physical_request(0))
                .map_err(map_physical)?;
            if condition.missing_component_count() != 1 {
                return Err(ReviewAdapterResult::ReviewContainmentFailed);
            }
            missing = true;
            false
        }
        Err(_) => return Err(ReviewAdapterResult::RepositoryUnavailable),
    };
    match fs::symlink_metadata(&snapshot.manuscript.path) {
        Ok(metadata) => {
            if !workspace_exists || !metadata.is_file() || metadata.len() != 0 {
                return Err(ReviewAdapterResult::ReviewPhysicalConflict);
            }
            PhysicalFreshVerifier::verify(snapshot.physical_request(1)).map_err(map_physical)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            missing = true;
            if workspace_exists {
                let condition = PhysicalFreshVerifier::verify(snapshot.physical_request(1))
                    .map_err(map_physical)?;
                if condition.missing_component_count() != 0 {
                    return Err(ReviewAdapterResult::ReviewContainmentFailed);
                }
            }
        }
        Err(_) => return Err(ReviewAdapterResult::RepositoryUnavailable),
    }
    Ok(if missing {
        ReviewPhysicalInspectionState::Missing
    } else {
        ReviewPhysicalInspectionState::Intact
    })
}

fn map_physical(failure: crate::physical_freshness::PhysicalFailure) -> ReviewAdapterResult {
    match failure.code {
        StableErrorCode::PhysicalContainmentBlocked | StableErrorCode::PhysicalReparseBlocked => {
            ReviewAdapterResult::ReviewContainmentFailed
        }
        StableErrorCode::PhysicalIdentityMismatch => {
            ReviewAdapterResult::ReviewPathIdentityMismatch
        }
        StableErrorCode::PhysicalAuthorityUnavailable => ReviewAdapterResult::RepositoryUnavailable,
        _ => ReviewAdapterResult::ReviewPhysicalConflict,
    }
}

fn map_pre_mutation_failure(result: ReviewAdapterResult) -> AdapterPreMutationFailure {
    match result {
        ReviewAdapterResult::ReviewPathIdentityMismatch => {
            AdapterPreMutationFailure::IdentityMismatch
        }
        ReviewAdapterResult::ReviewContainmentFailed => {
            AdapterPreMutationFailure::ContainmentFailed
        }
        ReviewAdapterResult::RepositoryUnavailable
        | ReviewAdapterResult::ReviewReadbackUnavailable => AdapterPreMutationFailure::Unavailable,
        _ => AdapterPreMutationFailure::Conflict,
    }
}

fn physical_failure_classification(code: StableErrorCode) -> ExecutionReadbackClassification {
    match code {
        StableErrorCode::PhysicalIdentityMismatch => {
            ExecutionReadbackClassification::IdentityMismatch
        }
        StableErrorCode::PhysicalContainmentBlocked | StableErrorCode::PhysicalReparseBlocked => {
            ExecutionReadbackClassification::ContainmentFailed
        }
        StableErrorCode::PhysicalAuthorityUnavailable => {
            ExecutionReadbackClassification::Unavailable
        }
        _ => ExecutionReadbackClassification::Conflict,
    }
}

fn length_prefixed_hash(domain: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}
