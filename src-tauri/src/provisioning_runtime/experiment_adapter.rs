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
    AdapterOutcome, DurableStepKind, DurableStepScope, StableErrorCode,
};
use crate::physical_freshness::{
    apply_creation_only_with_initial_bytes, normalize_path_identity, ExpectedTargetState,
    PhysicalFreshVerifier, PhysicalResourceKind, PhysicalVerificationRequest,
    ValidatedPhysicalCondition,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const ADAPTER_ID: &str = "labpod.experiment.primary.recovery";
const CONTRACT_VERSION: &str = "experiment-primary-recovery@1";
const INITIAL_CONTENT_FIELD_ID: &str = "labpod.experiment.canonical-initial-content.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExperimentLifecycleState {
    Active,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExperimentPlanningAuthority {
    pub experiment_id: String,
    pub project_id: String,
    pub lifecycle: ExperimentLifecycleState,
    pub authority_revision: String,
}

pub(crate) trait ExperimentPlanningAuthorityVerifier: Send + Sync {
    fn read_fresh(
        &self,
        experiment_id: &str,
    ) -> Result<ExperimentPlanningAuthority, ExperimentAdapterResult>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExperimentAdapterResult {
    InspectionComplete,
    LifecycleDenied,
    MetadataAuthorityIncomplete,
    ExternalMutationDenied,
    PathIdentityMismatch,
    ContainmentFailed,
    PhysicalConflict,
    ReadbackUnavailable,
    ExecutionRecoveryRequired,
    RepositoryUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExperimentFileRef {
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
    custom_fields: String,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExperimentMetadataSnapshot {
    authority: ExperimentPlanningAuthority,
    experiment_updated_at: String,
    experiment_deleted_at: Option<String>,
    binding_id: String,
    binding_updated_at: String,
    managed_root: PathBuf,
    managed_root_updated_at: String,
    workspace: ExperimentFileRef,
    manuscript: ExperimentFileRef,
    current: ExperimentFileRef,
    initial_bytes: Vec<u8>,
    resource_identity_hash: String,
    placement_identity_hash: String,
    parent_identity_hash: String,
    metadata_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExperimentPhysicalInspectionState {
    Intact,
    Missing,
}

#[derive(Debug)]
pub(crate) struct ExperimentProductionInspection {
    pub(crate) state: ExperimentPhysicalInspectionState,
    pub(crate) project_id: String,
    pub(crate) planning_authority_revision: String,
    pub(crate) owner_updated_at: String,
    pub(crate) owner_deleted_at: Option<String>,
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
    pub(crate) initial_bytes_hash: String,
    pub(crate) metadata_fingerprint: String,
}

impl ExperimentMetadataSnapshot {
    fn target(&self, ordinal: usize) -> (&ExperimentFileRef, PhysicalResourceKind, &'static str) {
        match ordinal {
            0 => (
                &self.workspace,
                PhysicalResourceKind::Directory,
                "managed-experiment-workspace",
            ),
            1 => (
                &self.manuscript,
                PhysicalResourceKind::MarkdownFile,
                "managed-experiment-primary-manuscript",
            ),
            _ => panic!("closed Experiment Adapter ordinal"),
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
            owner_type: "experiment".to_string(),
            owner_id: self.authority.experiment_id.clone(),
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

pub(crate) struct CanonicalExperimentAdapter {
    database_path: PathBuf,
    authority: Arc<dyn ExperimentPlanningAuthorityVerifier>,
    planned: ExperimentMetadataSnapshot,
    initial_physical_state: ExperimentPhysicalInspectionState,
}

impl CanonicalExperimentAdapter {
    pub(crate) fn inspect(
        database_path: PathBuf,
        experiment_id: &str,
        authority: Arc<dyn ExperimentPlanningAuthorityVerifier>,
    ) -> Result<Self, ExperimentAdapterResult> {
        let planned = read_snapshot(&database_path, experiment_id, authority.as_ref())?;
        let initial_physical_state = validate_physical_plan(&planned)?;
        Ok(Self {
            database_path,
            authority,
            planned,
            initial_physical_state,
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
            "labpod.experiment.primary.adapter-descriptor.v1",
            &[
                ADAPTER_ID,
                CONTRACT_VERSION,
                "experiment",
                "primary",
                "ensure-directory:primary",
                "ensure-manuscript:primary",
                "experiment-primary-target-identity@1",
                "experiment-primary-readback@1",
                INITIAL_CONTENT_FIELD_ID,
            ],
        )
    }

    fn capability_fingerprint() -> String {
        length_prefixed_hash(
            "labpod.experiment.primary.adapter-capability.v1",
            &[
                "managed-only",
                "creation-only",
                "directory-final-component-only",
                "file-create-new-canonical-initial-bytes",
                "no-metadata-writes",
                "mandatory-readback",
            ],
        )
    }

    pub(crate) fn production_inspection(&self) -> ExperimentProductionInspection {
        ExperimentProductionInspection {
            state: self.initial_physical_state,
            project_id: self.planned.authority.project_id.clone(),
            planning_authority_revision: self.planned.authority.authority_revision.clone(),
            owner_updated_at: self.planned.experiment_updated_at.clone(),
            owner_deleted_at: self.planned.experiment_deleted_at.clone(),
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
            initial_bytes_hash: format!("{:x}", Sha256::digest(&self.planned.initial_bytes)),
            metadata_fingerprint: self.planned.metadata_fingerprint.clone(),
        }
    }

    pub(crate) fn owner_id_for_registry(&self) -> &str {
        &self.planned.authority.experiment_id
    }

    fn fresh_snapshot(&self) -> Result<ExperimentMetadataSnapshot, ExperimentAdapterResult> {
        let fresh = read_snapshot(
            &self.database_path,
            &self.planned.authority.experiment_id,
            self.authority.as_ref(),
        )?;
        if fresh.metadata_fingerprint != self.planned.metadata_fingerprint
            || fresh.authority.project_id != self.planned.authority.project_id
        {
            return Err(ExperimentAdapterResult::PathIdentityMismatch);
        }
        Ok(fresh)
    }

    fn plan_failure(result: ExperimentAdapterResult) -> AdapterPlanningFailure {
        match result {
            ExperimentAdapterResult::LifecycleDenied => AdapterPlanningFailure::LifecycleDenied,
            ExperimentAdapterResult::MetadataAuthorityIncomplete => {
                AdapterPlanningFailure::MetadataAuthorityIncomplete
            }
            ExperimentAdapterResult::ExternalMutationDenied => {
                AdapterPlanningFailure::ExternalMutationDenied
            }
            ExperimentAdapterResult::PathIdentityMismatch => {
                AdapterPlanningFailure::PathIdentityMismatch
            }
            ExperimentAdapterResult::ContainmentFailed => AdapterPlanningFailure::ContainmentFailed,
            ExperimentAdapterResult::RepositoryUnavailable => {
                AdapterPlanningFailure::RepositoryUnavailable
            }
            _ => AdapterPlanningFailure::PhysicalConflict,
        }
    }
}

impl SharedExecutionAdapter for CanonicalExperimentAdapter {
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
        .expect("static Canonical Experiment Adapter manifest")
    }

    fn validate_plan(
        &self,
        planning: &RecoveryExecutionPlanningFacts,
        project_id: &str,
    ) -> Result<(), AdapterPlanningFailure> {
        if planning.owner_type != "experiment"
            || planning.owner_id != self.planned.authority.experiment_id
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
        let request = self.planned.physical_request(step_ordinal);
        let bytes = if step_ordinal == 1 {
            self.planned.initial_bytes.as_slice()
        } else {
            &[]
        };
        match apply_creation_only_with_initial_bytes(condition, request, invocation.permit(), bytes)
        {
            AdapterOutcome::Applied(receipt) => AdapterInvocationOutcome::Returned {
                effect: ExecutionEffectClassification::Created,
                observed_identity_hash: receipt.canonical_identity_hash,
                resource_record_id: receipt.resource_record_id,
            },
            AdapterOutcome::Reused(identity) => AdapterInvocationOutcome::Returned {
                effect: ExecutionEffectClassification::Reused,
                observed_identity_hash: identity.canonical_identity_hash,
                resource_record_id: Some(self.planned.target(step_ordinal).0.id.clone()),
            },
            AdapterOutcome::NoEffectProven(absence) => AdapterInvocationOutcome::Returned {
                effect: ExecutionEffectClassification::Preserved,
                observed_identity_hash: absence.canonical_identity_hash,
                resource_record_id: None,
            },
            AdapterOutcome::Conflict(facts) => AdapterInvocationOutcome::Returned {
                effect: ExecutionEffectClassification::Preserved,
                observed_identity_hash: facts.canonical_identity_hash,
                resource_record_id: None,
            },
            AdapterOutcome::Unavailable(_) | AdapterOutcome::Indeterminate(_) => {
                AdapterInvocationOutcome::OutcomeUnknown
            }
        }
    }

    fn bounded_authoritative_readback(
        &mut self,
        _planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
        _invocation: &AdapterInvocationOutcome,
    ) -> AdapterReadback {
        let fresh = match self.fresh_snapshot() {
            Ok(snapshot) => snapshot,
            Err(ExperimentAdapterResult::PathIdentityMismatch) => {
                return readback(
                    ExecutionReadbackClassification::IdentityMismatch,
                    None,
                    None,
                )
            }
            Err(_) => return readback(ExecutionReadbackClassification::Unavailable, None, None),
        };
        let (target, kind, role) = fresh.target(step_ordinal);
        match fs::symlink_metadata(&target.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return readback(
                    ExecutionReadbackClassification::VerifiedAbsent,
                    None,
                    Some(target.id.clone()),
                )
            }
            Err(_) => {
                return readback(
                    ExecutionReadbackClassification::Unavailable,
                    None,
                    Some(target.id.clone()),
                )
            }
            Ok(_) => {}
        }
        let request = PhysicalVerificationRequest {
            resource_role: role.to_string(),
            owner_type: "experiment".to_string(),
            owner_id: fresh.authority.experiment_id.clone(),
            channel: "primary".to_string(),
            scope: "channel:primary".to_string(),
            managed_root: fresh.managed_root.clone(),
            requested_path: target.path.clone(),
            expected_kind: kind,
            expected_target_state: ExpectedTargetState::ExistingExact,
            allow_existing_reuse: true,
        };
        match PhysicalFreshVerifier::verify(request) {
            Ok(condition) => match condition.authoritative_identity_hash() {
                Some(identity) => readback(
                    ExecutionReadbackClassification::VerifiedComplete,
                    Some(identity),
                    Some(target.id.clone()),
                ),
                None => readback(
                    ExecutionReadbackClassification::Unavailable,
                    None,
                    Some(target.id.clone()),
                ),
            },
            Err(error) => readback(
                physical_failure_classification(error.code),
                None,
                Some(target.id.clone()),
            ),
        }
    }
}

fn read_snapshot(
    database_path: &Path,
    experiment_id: &str,
    authority: &dyn ExperimentPlanningAuthorityVerifier,
) -> Result<ExperimentMetadataSnapshot, ExperimentAdapterResult> {
    let authority = authority.read_fresh(experiment_id)?;
    if authority.experiment_id != experiment_id
        || authority.project_id.trim().is_empty()
        || authority.authority_revision.trim().is_empty()
        || authority.lifecycle != ExperimentLifecycleState::Active
    {
        return Err(ExperimentAdapterResult::LifecycleDenied);
    }
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ExperimentAdapterResult::RepositoryUnavailable)?;
    let experiment = connection
        .query_row(
            "SELECT project_id,updated_at,deleted_at FROM experiments WHERE id=?1",
            [experiment_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| ExperimentAdapterResult::RepositoryUnavailable)?
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    if experiment.0 != authority.project_id {
        return Err(ExperimentAdapterResult::MetadataAuthorityIncomplete);
    }
    let binding = connection
        .query_row(
            "SELECT id,default_folder_file_ref_id,default_manuscript_file_ref_id,
                    current_file_ref_id,updated_at
             FROM manuscript_bindings
             WHERE owner_type='experiment' AND owner_id=?1
               AND manuscript_channel='primary' AND deleted_at IS NULL",
            [experiment_id],
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
        .map_err(|_| ExperimentAdapterResult::RepositoryUnavailable)?
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    let (binding_id, folder_id, manuscript_id, current_id, binding_updated_at) = (
        binding.0,
        binding
            .1
            .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?,
        binding
            .2
            .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?,
        binding
            .3
            .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?,
        binding.4,
    );
    let workspace = read_file_ref(&connection, &folder_id)?
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    let manuscript = read_file_ref(&connection, &manuscript_id)?
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    let current = read_file_ref(&connection, &current_id)?
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    validate_file_ref(
        &workspace,
        experiment_id,
        "folder",
        "defaultFolder",
        Some("managed"),
    )?;
    validate_file_ref(
        &manuscript,
        experiment_id,
        "file",
        "manuscript",
        Some("managed"),
    )?;
    validate_file_ref(&current, experiment_id, "file", "manuscript", None)?;
    if manuscript.file_type != "markdown"
        || current.file_type != "markdown"
        || manuscript.path.file_name().and_then(|name| name.to_str()) != Some("experiment.md")
    {
        return Err(ExperimentAdapterResult::MetadataAuthorityIncomplete);
    }
    let initial_bytes = canonical_initial_bytes(&manuscript.custom_fields)?;
    let root = connection
        .query_row(
            "SELECT configured_root,updated_at FROM managed_root_settings
             WHERE id='managed-root' AND deleted_at IS NULL",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| ExperimentAdapterResult::RepositoryUnavailable)?
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
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
        return Err(ExperimentAdapterResult::PathIdentityMismatch);
    }
    let deletion_revision = experiment.2.as_deref().unwrap_or("");
    let initial_bytes_hash = format!("{:x}", Sha256::digest(&initial_bytes));
    let resource_identity_hash = length_prefixed_hash(
        "labpod.experiment.primary.resource-identity.v1",
        &[
            experiment_id,
            &binding_id,
            &workspace.id,
            &manuscript.id,
            &current.id,
            &manuscript.path_identity_key,
        ],
    );
    let placement_identity_hash = length_prefixed_hash(
        "labpod.experiment.primary.placement-identity.v1",
        &[
            &managed_root.to_string_lossy(),
            &workspace.id,
            &workspace.path_identity_key,
            &manuscript.path_identity_key,
        ],
    );
    let parent_identity_hash = length_prefixed_hash(
        "labpod.experiment.primary.parent-identity.v1",
        &[
            &authority.project_id,
            &authority.authority_revision,
            &experiment.1,
            deletion_revision,
            &managed_root.to_string_lossy(),
            &root.1,
        ],
    );
    let metadata_fingerprint = length_prefixed_hash(
        "labpod.experiment.primary.metadata-authority.v1",
        &[
            &authority.experiment_id,
            &authority.project_id,
            &authority.authority_revision,
            &experiment.1,
            deletion_revision,
            &binding_id,
            &binding_updated_at,
            &workspace.id,
            &workspace.updated_at,
            &manuscript.id,
            &manuscript.updated_at,
            &current.id,
            &current.updated_at,
            &root.1,
            &initial_bytes_hash,
        ],
    );
    Ok(ExperimentMetadataSnapshot {
        authority,
        experiment_updated_at: experiment.1,
        experiment_deleted_at: experiment.2,
        binding_id,
        binding_updated_at,
        managed_root,
        managed_root_updated_at: root.1,
        workspace,
        manuscript,
        current,
        initial_bytes,
        resource_identity_hash,
        placement_identity_hash,
        parent_identity_hash,
        metadata_fingerprint,
    })
}

fn canonical_initial_bytes(custom_fields: &str) -> Result<Vec<u8>, ExperimentAdapterResult> {
    let fields: Value = serde_json::from_str(custom_fields)
        .map_err(|_| ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    let values = fields
        .as_array()
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)?;
    let matches = values
        .iter()
        .filter(|field| {
            field.get("id").and_then(Value::as_str) == Some(INITIAL_CONTENT_FIELD_ID)
                && field.get("name").and_then(Value::as_str) == Some(INITIAL_CONTENT_FIELD_ID)
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(ExperimentAdapterResult::MetadataAuthorityIncomplete);
    }
    matches[0]
        .get("value")
        .and_then(Value::as_str)
        .map(|value| value.as_bytes().to_vec())
        .ok_or(ExperimentAdapterResult::MetadataAuthorityIncomplete)
}

fn read_file_ref(
    connection: &Connection,
    file_ref_id: &str,
) -> Result<Option<ExperimentFileRef>, ExperimentAdapterResult> {
    connection
        .query_row(
            "SELECT id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                    location_mode,file_type,path,path_identity_key,custom_fields,updated_at
             FROM file_refs WHERE id=?1 AND deleted_at IS NULL",
            [file_ref_id],
            |row| {
                Ok(ExperimentFileRef {
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
                    custom_fields: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(|_| ExperimentAdapterResult::RepositoryUnavailable)
}

fn validate_file_ref(
    file_ref: &ExperimentFileRef,
    experiment_id: &str,
    resource_kind: &str,
    file_role: &str,
    location_mode: Option<&str>,
) -> Result<(), ExperimentAdapterResult> {
    if file_ref.owner_type != "experiment"
        || file_ref.owner_id != experiment_id
        || file_ref.manuscript_channel != "primary"
        || file_ref.resource_kind != resource_kind
        || file_ref.file_role != file_role
    {
        return Err(ExperimentAdapterResult::MetadataAuthorityIncomplete);
    }
    if location_mode.is_some_and(|expected| file_ref.location_mode != expected) {
        return Err(ExperimentAdapterResult::ExternalMutationDenied);
    }
    if !matches!(file_ref.location_mode.as_str(), "managed" | "external") {
        return Err(ExperimentAdapterResult::MetadataAuthorityIncomplete);
    }
    Ok(())
}

fn validate_physical_plan(
    snapshot: &ExperimentMetadataSnapshot,
) -> Result<ExperimentPhysicalInspectionState, ExperimentAdapterResult> {
    let mut missing = false;
    let workspace_exists = match fs::symlink_metadata(&snapshot.workspace.path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(ExperimentAdapterResult::PhysicalConflict);
            }
            PhysicalFreshVerifier::verify(snapshot.physical_request(0)).map_err(map_physical)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let condition = PhysicalFreshVerifier::verify(snapshot.physical_request(0))
                .map_err(map_physical)?;
            if condition.missing_component_count() != 1 {
                return Err(ExperimentAdapterResult::ContainmentFailed);
            }
            missing = true;
            false
        }
        Err(_) => return Err(ExperimentAdapterResult::RepositoryUnavailable),
    };
    match fs::symlink_metadata(&snapshot.manuscript.path) {
        Ok(metadata) => {
            if !workspace_exists || !metadata.is_file() {
                return Err(ExperimentAdapterResult::PhysicalConflict);
            }
            PhysicalFreshVerifier::verify(snapshot.physical_request(1)).map_err(map_physical)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            missing = true;
            if workspace_exists {
                let condition = PhysicalFreshVerifier::verify(snapshot.physical_request(1))
                    .map_err(map_physical)?;
                if condition.missing_component_count() != 0 {
                    return Err(ExperimentAdapterResult::ContainmentFailed);
                }
            }
        }
        Err(_) => return Err(ExperimentAdapterResult::RepositoryUnavailable),
    }
    Ok(if missing {
        ExperimentPhysicalInspectionState::Missing
    } else {
        ExperimentPhysicalInspectionState::Intact
    })
}

fn map_physical(failure: crate::physical_freshness::PhysicalFailure) -> ExperimentAdapterResult {
    match failure.code {
        StableErrorCode::PhysicalContainmentBlocked | StableErrorCode::PhysicalReparseBlocked => {
            ExperimentAdapterResult::ContainmentFailed
        }
        StableErrorCode::PhysicalIdentityMismatch => ExperimentAdapterResult::PathIdentityMismatch,
        StableErrorCode::PhysicalAuthorityUnavailable => {
            ExperimentAdapterResult::RepositoryUnavailable
        }
        _ => ExperimentAdapterResult::PhysicalConflict,
    }
}

fn map_pre_mutation_failure(result: ExperimentAdapterResult) -> AdapterPreMutationFailure {
    match result {
        ExperimentAdapterResult::PathIdentityMismatch => {
            AdapterPreMutationFailure::IdentityMismatch
        }
        ExperimentAdapterResult::ContainmentFailed => AdapterPreMutationFailure::ContainmentFailed,
        ExperimentAdapterResult::RepositoryUnavailable
        | ExperimentAdapterResult::ReadbackUnavailable => AdapterPreMutationFailure::Unavailable,
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

fn length_prefixed_hash(domain: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}
