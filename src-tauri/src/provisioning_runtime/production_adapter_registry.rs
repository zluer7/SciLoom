use super::experiment_adapter::{
    CanonicalExperimentAdapter, ExperimentAdapterResult, ExperimentLifecycleState,
    ExperimentPlanningAuthority, ExperimentPlanningAuthorityVerifier,
    ExperimentProductionInspection,
};
use super::review_adapter::{
    CanonicalReviewAdapter, ReviewAdapterResult, ReviewLifecycleState, ReviewPlanningAuthority,
    ReviewPlanningAuthorityVerifier, ReviewProductionInspection,
};
use super::shared_executor::SharedExecutionAdapter;
use crate::physical_freshness::normalize_path_identity;
use rusqlite::{Connection, OpenFlags};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProductionAdapterOwner {
    Review,
    Experiment,
    #[cfg(test)]
    ExperimentRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProductionAdapterScope {
    Channel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProductionAdapterChannel {
    Primary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ProductionAdapterKey {
    pub(crate) owner: ProductionAdapterOwner,
    pub(crate) scope: ProductionAdapterScope,
    pub(crate) channel: ProductionAdapterChannel,
}

impl ProductionAdapterKey {
    pub(crate) const REVIEW_PRIMARY: Self = Self {
        owner: ProductionAdapterOwner::Review,
        scope: ProductionAdapterScope::Channel,
        channel: ProductionAdapterChannel::Primary,
    };
    pub(crate) const EXPERIMENT_PRIMARY: Self = Self {
        owner: ProductionAdapterOwner::Experiment,
        scope: ProductionAdapterScope::Channel,
        channel: ProductionAdapterChannel::Primary,
    };

    #[cfg(test)]
    const UNREGISTERED_EXPERIMENT_RUN_PRIMARY: Self = Self {
        owner: ProductionAdapterOwner::ExperimentRun,
        scope: ProductionAdapterScope::Channel,
        channel: ProductionAdapterChannel::Primary,
    };

    pub(crate) fn owner_type(self) -> &'static str {
        match self.owner {
            ProductionAdapterOwner::Review => "review",
            ProductionAdapterOwner::Experiment => "experiment",
            #[cfg(test)]
            ProductionAdapterOwner::ExperimentRun => "experimentRun",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProductionAdapterDescriptor {
    pub(crate) key: ProductionAdapterKey,
    pub(crate) adapter_id: &'static str,
    pub(crate) contract_version: &'static str,
    pub(crate) descriptor_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProductionAdapterRegistryError {
    DuplicateRegistration,
    AdapterNotRegistered,
    ContractMismatch,
    InspectionRejected,
    RegistryIdentityMismatch,
    CrossOwnerTargetCollision,
}

pub(crate) struct ProductionAdapterRegistryCore {
    database_path: PathBuf,
    descriptors: [ProductionAdapterDescriptor; 2],
}

pub(crate) struct ProductionAdapterRegistry {
    core: Arc<ProductionAdapterRegistryCore>,
}

pub(crate) struct RegisteredPlanningAuthority {
    pub(crate) owner_id: String,
    pub(crate) project_id: String,
    pub(crate) authority_revision: String,
}

pub(crate) enum RegisteredProductionAdapter {
    Review {
        registry: Weak<ProductionAdapterRegistryCore>,
        descriptor: ProductionAdapterDescriptor,
        adapter: CanonicalReviewAdapter,
    },
    Experiment {
        registry: Weak<ProductionAdapterRegistryCore>,
        descriptor: ProductionAdapterDescriptor,
        adapter: CanonicalExperimentAdapter,
    },
}

pub(crate) enum ProductionInspection {
    Review(ReviewProductionInspection),
    Experiment(ExperimentProductionInspection),
}

struct FixedReviewPlanningAuthority {
    authority: ReviewPlanningAuthority,
}

impl ReviewPlanningAuthorityVerifier for FixedReviewPlanningAuthority {
    fn read_fresh(&self, review_id: &str) -> Result<ReviewPlanningAuthority, ReviewAdapterResult> {
        (review_id == self.authority.review_id)
            .then(|| self.authority.clone())
            .ok_or(ReviewAdapterResult::ReviewLifecycleDenied)
    }
}

struct FixedExperimentPlanningAuthority {
    authority: ExperimentPlanningAuthority,
}

impl ExperimentPlanningAuthorityVerifier for FixedExperimentPlanningAuthority {
    fn read_fresh(
        &self,
        experiment_id: &str,
    ) -> Result<ExperimentPlanningAuthority, ExperimentAdapterResult> {
        (experiment_id == self.authority.experiment_id)
            .then(|| self.authority.clone())
            .ok_or(ExperimentAdapterResult::LifecycleDenied)
    }
}

impl ProductionAdapterRegistry {
    pub(super) fn build_review_and_experiment_primary(
        database_path: PathBuf,
    ) -> Result<Self, ProductionAdapterRegistryError> {
        Self::build_closed(
            database_path,
            &[
                ProductionAdapterKey::REVIEW_PRIMARY,
                ProductionAdapterKey::EXPERIMENT_PRIMARY,
            ],
        )
    }

    fn build_closed(
        database_path: PathBuf,
        registrations: &[ProductionAdapterKey],
    ) -> Result<Self, ProductionAdapterRegistryError> {
        let required = [
            ProductionAdapterKey::REVIEW_PRIMARY,
            ProductionAdapterKey::EXPERIMENT_PRIMARY,
        ];
        if registrations.len() != required.len()
            || required.iter().any(|key| {
                registrations
                    .iter()
                    .filter(|candidate| *candidate == key)
                    .count()
                    != 1
            })
        {
            return Err(
                if registrations.iter().any(|key| {
                    registrations
                        .iter()
                        .filter(|candidate| *candidate == key)
                        .count()
                        > 1
                }) {
                    ProductionAdapterRegistryError::DuplicateRegistration
                } else {
                    ProductionAdapterRegistryError::AdapterNotRegistered
                },
            );
        }
        Ok(Self {
            core: Arc::new(ProductionAdapterRegistryCore {
                database_path,
                descriptors: [
                    ProductionAdapterDescriptor {
                        key: ProductionAdapterKey::REVIEW_PRIMARY,
                        adapter_id: CanonicalReviewAdapter::adapter_id(),
                        contract_version: CanonicalReviewAdapter::contract_version(),
                        descriptor_hash: CanonicalReviewAdapter::descriptor_hash(),
                    },
                    ProductionAdapterDescriptor {
                        key: ProductionAdapterKey::EXPERIMENT_PRIMARY,
                        adapter_id: CanonicalExperimentAdapter::adapter_id(),
                        contract_version: CanonicalExperimentAdapter::contract_version(),
                        descriptor_hash: CanonicalExperimentAdapter::descriptor_hash(),
                    },
                ],
            }),
        })
    }

    pub(crate) fn descriptor(
        &self,
        key: ProductionAdapterKey,
    ) -> Result<ProductionAdapterDescriptor, ProductionAdapterRegistryError> {
        self.core
            .descriptors
            .iter()
            .find(|descriptor| descriptor.key == key)
            .cloned()
            .ok_or(ProductionAdapterRegistryError::AdapterNotRegistered)
    }

    pub(crate) fn inspect(
        &self,
        key: ProductionAdapterKey,
        authority: RegisteredPlanningAuthority,
    ) -> Result<RegisteredProductionAdapter, ProductionAdapterRegistryError> {
        let descriptor = self.descriptor(key)?;
        let owner_id = authority.owner_id.clone();
        let adapter = match key.owner {
            ProductionAdapterOwner::Review => {
                self.validate_descriptor(
                    &descriptor,
                    CanonicalReviewAdapter::adapter_id(),
                    CanonicalReviewAdapter::contract_version(),
                    &CanonicalReviewAdapter::descriptor_hash(),
                )?;
                let verifier = Arc::new(FixedReviewPlanningAuthority {
                    authority: ReviewPlanningAuthority {
                        review_id: authority.owner_id,
                        project_id: authority.project_id,
                        lifecycle: ReviewLifecycleState::Active,
                        authority_revision: authority.authority_revision,
                    },
                });
                RegisteredProductionAdapter::Review {
                    registry: Arc::downgrade(&self.core),
                    descriptor,
                    adapter: CanonicalReviewAdapter::inspect(
                        self.core.database_path.clone(),
                        &owner_id,
                        verifier,
                    )
                    .map_err(|_| ProductionAdapterRegistryError::InspectionRejected)?,
                }
            }
            ProductionAdapterOwner::Experiment => {
                self.validate_descriptor(
                    &descriptor,
                    CanonicalExperimentAdapter::adapter_id(),
                    CanonicalExperimentAdapter::contract_version(),
                    &CanonicalExperimentAdapter::descriptor_hash(),
                )?;
                let verifier = Arc::new(FixedExperimentPlanningAuthority {
                    authority: ExperimentPlanningAuthority {
                        experiment_id: authority.owner_id,
                        project_id: authority.project_id,
                        lifecycle: ExperimentLifecycleState::Active,
                        authority_revision: authority.authority_revision,
                    },
                });
                RegisteredProductionAdapter::Experiment {
                    registry: Arc::downgrade(&self.core),
                    descriptor,
                    adapter: CanonicalExperimentAdapter::inspect(
                        self.core.database_path.clone(),
                        &owner_id,
                        verifier,
                    )
                    .map_err(|_| ProductionAdapterRegistryError::InspectionRejected)?,
                }
            }
            #[cfg(test)]
            ProductionAdapterOwner::ExperimentRun => {
                return Err(ProductionAdapterRegistryError::AdapterNotRegistered)
            }
        };
        self.reject_cross_owner_target_collision(&adapter)?;
        Ok(adapter)
    }

    pub(crate) fn inspection(
        &self,
        adapter: &RegisteredProductionAdapter,
    ) -> Result<ProductionInspection, ProductionAdapterRegistryError> {
        self.validate_provenance(adapter)?;
        Ok(match adapter {
            RegisteredProductionAdapter::Review { adapter, .. } => {
                ProductionInspection::Review(adapter.production_inspection())
            }
            RegisteredProductionAdapter::Experiment { adapter, .. } => {
                ProductionInspection::Experiment(adapter.production_inspection())
            }
        })
    }

    pub(crate) fn admit_execution<'a>(
        &self,
        adapter: &'a mut RegisteredProductionAdapter,
    ) -> Result<&'a mut dyn SharedExecutionAdapter, ProductionAdapterRegistryError> {
        self.validate_provenance(adapter)?;
        Ok(match adapter {
            RegisteredProductionAdapter::Review { adapter, .. } => adapter,
            RegisteredProductionAdapter::Experiment { adapter, .. } => adapter,
        })
    }

    fn validate_descriptor(
        &self,
        descriptor: &ProductionAdapterDescriptor,
        adapter_id: &str,
        contract_version: &str,
        descriptor_hash: &str,
    ) -> Result<(), ProductionAdapterRegistryError> {
        if descriptor.adapter_id != adapter_id
            || descriptor.contract_version != contract_version
            || descriptor.descriptor_hash != descriptor_hash
        {
            return Err(ProductionAdapterRegistryError::ContractMismatch);
        }
        Ok(())
    }

    fn validate_provenance(
        &self,
        adapter: &RegisteredProductionAdapter,
    ) -> Result<(), ProductionAdapterRegistryError> {
        let (weak, descriptor) = match adapter {
            RegisteredProductionAdapter::Review {
                registry,
                descriptor,
                ..
            }
            | RegisteredProductionAdapter::Experiment {
                registry,
                descriptor,
                ..
            } => (registry, descriptor),
        };
        let Some(registry) = weak.upgrade() else {
            return Err(ProductionAdapterRegistryError::RegistryIdentityMismatch);
        };
        if !Arc::ptr_eq(&registry, &self.core)
            || self.descriptor(descriptor.key).as_ref() != Ok(descriptor)
        {
            return Err(ProductionAdapterRegistryError::RegistryIdentityMismatch);
        }
        Ok(())
    }

    fn reject_cross_owner_target_collision(
        &self,
        adapter: &RegisteredProductionAdapter,
    ) -> Result<(), ProductionAdapterRegistryError> {
        let inspection = self.inspection(adapter)?;
        let (owner_type, owner_id, folder_id, folder_key, manuscript_id, manuscript_key) =
            match inspection {
                ProductionInspection::Review(value) => (
                    "review",
                    adapter.owner_id(),
                    value.default_folder_file_ref_id,
                    value.default_folder_path_identity_key,
                    value.default_manuscript_file_ref_id,
                    value.default_manuscript_path_identity_key,
                ),
                ProductionInspection::Experiment(value) => (
                    "experiment",
                    adapter.owner_id(),
                    value.default_folder_file_ref_id,
                    value.default_folder_path_identity_key,
                    value.default_manuscript_file_ref_id,
                    value.default_manuscript_path_identity_key,
                ),
            };
        let connection = Connection::open_with_flags(
            &self.core.database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ProductionAdapterRegistryError::InspectionRejected)?;
        let target_identities = [
            normalize_path_identity(&folder_key),
            normalize_path_identity(&manuscript_key),
        ];
        let mut statement = connection
            .prepare(
                "SELECT path,path_identity_key FROM file_refs
                 WHERE deleted_at IS NULL
                   AND id NOT IN (?1,?2)
                   AND (owner_type<>?3 OR owner_id<>?4)",
            )
            .map_err(|_| ProductionAdapterRegistryError::InspectionRejected)?;
        let candidates = statement
            .query_map(
                rusqlite::params![folder_id, manuscript_id, owner_type, owner_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|_| ProductionAdapterRegistryError::InspectionRejected)?;
        for candidate in candidates {
            let (path, path_identity_key) =
                candidate.map_err(|_| ProductionAdapterRegistryError::InspectionRejected)?;
            let canonical_path = normalize_path_identity(&path);
            let declared_identity = normalize_path_identity(&path_identity_key);
            if target_identities
                .iter()
                .any(|target| target == &canonical_path || target == &declared_identity)
            {
                return Err(ProductionAdapterRegistryError::CrossOwnerTargetCollision);
            }
        }
        if target_identities.iter().any(String::is_empty) {
            return Err(ProductionAdapterRegistryError::CrossOwnerTargetCollision);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn duplicate_review_registration_for_test(
        database_path: PathBuf,
    ) -> Result<Self, ProductionAdapterRegistryError> {
        Self::build_closed(
            database_path,
            &[
                ProductionAdapterKey::REVIEW_PRIMARY,
                ProductionAdapterKey::REVIEW_PRIMARY,
            ],
        )
    }
}

impl RegisteredProductionAdapter {
    fn owner_id(&self) -> &str {
        match self {
            RegisteredProductionAdapter::Review { adapter, .. } => adapter.owner_id_for_registry(),
            RegisteredProductionAdapter::Experiment { adapter, .. } => {
                adapter.owner_id_for_registry()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_registry_contains_exact_review_and_experiment_descriptors() {
        let registry = ProductionAdapterRegistry::build_review_and_experiment_primary(
            PathBuf::from("N:/isolated/not-opened.sqlite3"),
        )
        .expect("closed registry");
        assert_eq!(
            registry
                .descriptor(ProductionAdapterKey::REVIEW_PRIMARY)
                .expect("Review")
                .adapter_id,
            "labpod.review.primary.recovery"
        );
        assert_eq!(
            registry
                .descriptor(ProductionAdapterKey::EXPERIMENT_PRIMARY)
                .expect("Experiment")
                .adapter_id,
            "labpod.experiment.primary.recovery"
        );
        assert_eq!(
            registry.descriptor(ProductionAdapterKey::UNREGISTERED_EXPERIMENT_RUN_PRIMARY),
            Err(ProductionAdapterRegistryError::AdapterNotRegistered)
        );
    }

    #[test]
    fn duplicate_or_incomplete_static_registration_fails_closed() {
        assert_eq!(
            ProductionAdapterRegistry::duplicate_review_registration_for_test(PathBuf::from(
                "N:/isolated/not-opened.sqlite3"
            ))
            .err(),
            Some(ProductionAdapterRegistryError::DuplicateRegistration)
        );
    }
}
