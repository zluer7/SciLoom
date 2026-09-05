use super::experiment_adapter::ExperimentPhysicalInspectionState;
use super::production_adapter_registry::{
    ProductionAdapterKey, ProductionAdapterRegistry, ProductionInspection,
    RegisteredPlanningAuthority, RegisteredProductionAdapter,
};
use super::recovery_entry::{
    DurableRecoveryEntryClassification, DurableRecoveryInspection, RootRecoveryNeedEvidence,
    SuccessorRecoveryNeedEvidence,
};
use super::review_adapter::ReviewPhysicalInspectionState;
use crate::db::manuscript_provisioning_operation_state::RecoveryMetadataPrecondition;
use crate::manuscript_provisioning_contract::ProvisioningScopeIdentity;
use std::sync::Arc;

pub(crate) struct CanonicalRecoveryNeedBridge {
    registry: Arc<ProductionAdapterRegistry>,
}

pub(crate) enum CanonicalRecoveryNeedInspection {
    AuthoritativeIntact,
    RootMissing {
        evidence: RootRecoveryNeedEvidence,
        adapter: RegisteredProductionAdapter,
    },
    SuccessorMissing {
        evidence: SuccessorRecoveryNeedEvidence,
        adapter: RegisteredProductionAdapter,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanonicalRecoveryNeedBridgeError {
    ClassificationNotInspectable,
    AdapterUnavailable,
    MetadataIdentityMismatch,
}

impl CanonicalRecoveryNeedBridge {
    pub(super) fn new(registry: Arc<ProductionAdapterRegistry>) -> Self {
        Self { registry }
    }

    pub(crate) fn inspect_after_durable_classification(
        &self,
        key: ProductionAdapterKey,
        scope: ProvisioningScopeIdentity,
        durable: DurableRecoveryInspection,
        authority: RegisteredPlanningAuthority,
        expected_preview_fingerprint: &str,
        process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Result<CanonicalRecoveryNeedInspection, CanonicalRecoveryNeedBridgeError> {
        if authority.owner_id != scope.owner_id || key.owner_type() != scope.owner_type.as_str() {
            return Err(CanonicalRecoveryNeedBridgeError::MetadataIdentityMismatch);
        }
        let adapter = self
            .registry
            .inspect(key, authority)
            .map_err(|_| CanonicalRecoveryNeedBridgeError::AdapterUnavailable)?;
        let inspection = self
            .registry
            .inspection(&adapter)
            .map_err(|_| CanonicalRecoveryNeedBridgeError::AdapterUnavailable)?;
        let (intact, target_identity, metadata) = recovery_metadata(inspection);
        if metadata.metadata_fingerprint != expected_preview_fingerprint {
            return Err(CanonicalRecoveryNeedBridgeError::MetadataIdentityMismatch);
        }
        if intact {
            return Ok(CanonicalRecoveryNeedInspection::AuthoritativeIntact);
        }
        let owner_id = scope.owner_id.clone();
        match durable.classification {
            DurableRecoveryEntryClassification::NoOperation => {
                Ok(CanonicalRecoveryNeedInspection::RootMissing {
                    evidence: RootRecoveryNeedEvidence::seal_from_canonical_inspection(
                        &owner_id,
                        scope,
                        &target_identity,
                        metadata,
                        process_generation,
                        now_monotonic_ms,
                    ),
                    adapter,
                })
            }
            DurableRecoveryEntryClassification::TerminalCompleted => {
                let predecessor = durable
                    .completed_predecessor
                    .ok_or(CanonicalRecoveryNeedBridgeError::MetadataIdentityMismatch)?;
                Ok(CanonicalRecoveryNeedInspection::SuccessorMissing {
                    evidence: SuccessorRecoveryNeedEvidence::seal_from_canonical_inspection(
                        &owner_id,
                        scope,
                        &target_identity,
                        metadata,
                        predecessor,
                        process_generation,
                        now_monotonic_ms,
                    ),
                    adapter,
                })
            }
            _ => Err(CanonicalRecoveryNeedBridgeError::ClassificationNotInspectable),
        }
    }

    #[cfg(test)]
    pub(crate) fn shares_registry_for_test(
        &self,
        registry: &Arc<ProductionAdapterRegistry>,
    ) -> bool {
        Arc::ptr_eq(&self.registry, registry)
    }
}

fn recovery_metadata(
    inspection: ProductionInspection,
) -> (bool, String, RecoveryMetadataPrecondition) {
    match inspection {
        ProductionInspection::Review(value) => {
            let target = value.canonical_resource_identity_hash.clone();
            (
                value.state == ReviewPhysicalInspectionState::Intact,
                target,
                RecoveryMetadataPrecondition {
                    project_id: value.project_id,
                    planning_authority_revision: value.planning_authority_revision,
                    owner_updated_at: None,
                    owner_deleted_at: None,
                    binding_id: value.binding_id,
                    binding_updated_at: value.binding_updated_at,
                    default_folder_file_ref_id: value.default_folder_file_ref_id,
                    default_folder_updated_at: value.default_folder_updated_at,
                    default_folder_path_identity_key: value.default_folder_path_identity_key,
                    default_manuscript_file_ref_id: value.default_manuscript_file_ref_id,
                    default_manuscript_updated_at: value.default_manuscript_updated_at,
                    default_manuscript_path_identity_key: value
                        .default_manuscript_path_identity_key,
                    current_file_ref_id: value.current_file_ref_id,
                    current_updated_at: value.current_updated_at,
                    current_path_identity_key: value.current_path_identity_key,
                    managed_root_updated_at: value.managed_root_updated_at,
                    canonical_resource_identity_hash: value.canonical_resource_identity_hash,
                    canonical_placement_identity_hash: value.canonical_placement_identity_hash,
                    parent_shared_identity_hash: value.parent_shared_identity_hash,
                    initial_bytes_hash: None,
                    metadata_fingerprint: value.metadata_fingerprint,
                },
            )
        }
        ProductionInspection::Experiment(value) => {
            let target = value.canonical_resource_identity_hash.clone();
            let initial_bytes_hash = value.initial_bytes_hash.clone();
            (
                value.state == ExperimentPhysicalInspectionState::Intact,
                target,
                RecoveryMetadataPrecondition {
                    project_id: value.project_id,
                    planning_authority_revision: value.planning_authority_revision,
                    owner_updated_at: Some(value.owner_updated_at),
                    owner_deleted_at: value.owner_deleted_at,
                    binding_id: value.binding_id,
                    binding_updated_at: value.binding_updated_at,
                    default_folder_file_ref_id: value.default_folder_file_ref_id,
                    default_folder_updated_at: value.default_folder_updated_at,
                    default_folder_path_identity_key: value.default_folder_path_identity_key,
                    default_manuscript_file_ref_id: value.default_manuscript_file_ref_id,
                    default_manuscript_updated_at: value.default_manuscript_updated_at,
                    default_manuscript_path_identity_key: value
                        .default_manuscript_path_identity_key,
                    current_file_ref_id: value.current_file_ref_id,
                    current_updated_at: value.current_updated_at,
                    current_path_identity_key: value.current_path_identity_key,
                    managed_root_updated_at: value.managed_root_updated_at,
                    canonical_resource_identity_hash: value.canonical_resource_identity_hash,
                    canonical_placement_identity_hash: value.canonical_placement_identity_hash,
                    parent_shared_identity_hash: value.parent_shared_identity_hash,
                    initial_bytes_hash: Some(initial_bytes_hash),
                    metadata_fingerprint: value.metadata_fingerprint,
                },
            )
        }
    }
}
