use super::heartbeat_scheduler::MonotonicClock;
use super::production_adapter_registry::{ProductionAdapterKey, RegisteredPlanningAuthority};
use super::recovery_entry::{
    DurableRecoveryEntryClassification, ProvisioningRecoveryRuntimeFacade,
    RecoveryRuntimeEntryAction, RecoveryRuntimeEntryAuthorization, RecoveryRuntimeEntryResult,
};
use super::review_recovery::{
    CanonicalRecoveryNeedBridge, CanonicalRecoveryNeedBridgeError, CanonicalRecoveryNeedInspection,
};
use super::shared_executor::SharedExecutionResult;
use crate::manuscript_provisioning_contract::{
    DurableManuscriptChannel, DurablePlanOwnerType, DurablePlanScopeKind, ProvisioningScopeIdentity,
};
use crate::planning_authority_transport::{
    PlanningAuthorityChallengeRequest, PlanningAuthorityOwner, PlanningAuthorityPurpose,
    PlanningAuthorityTransportFoundation, PlanningFreshnessExpectation,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use std::sync::Arc;

const CONFIRMATION_TTL_MS: i64 = 10_000;

#[derive(Debug)]
pub(crate) struct ConfirmedReviewRecoveryRequest {
    core: ConfirmedRecoveryCore,
}

#[derive(Debug)]
pub(crate) struct ConfirmedExperimentRecoveryRequest {
    core: ConfirmedRecoveryCore,
}

#[derive(Debug)]
struct ConfirmedRecoveryCore {
    owner_id: String,
    project_id: String,
    process_generation: String,
    preview_repository_epoch: String,
    preview_repository_revision: String,
    preview_fingerprint: String,
    authorization_generation: u64,
    issued_at_monotonic_ms: i64,
    deadline_monotonic_ms: i64,
}

struct ConsumedConfirmedRecovery {
    key: ProductionAdapterKey,
    owner: PlanningAuthorityOwner,
    owner_id: String,
    project_id: String,
    process_generation: String,
    preview_repository_epoch: String,
    preview_repository_revision: String,
    preview_fingerprint: String,
    authorization_generation: u64,
    issued_at_monotonic_ms: i64,
    deadline_monotonic_ms: i64,
}

impl ConfirmedRecoveryCore {
    fn consume(
        self,
        key: ProductionAdapterKey,
        owner: PlanningAuthorityOwner,
        current_process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Result<ConsumedConfirmedRecovery, CanonicalRecoveryApplicationResult> {
        if self.owner_id.is_empty()
            || self.project_id.is_empty()
            || self.process_generation != current_process_generation
            || self.preview_repository_epoch.is_empty()
            || self.preview_repository_revision.is_empty()
            || self.preview_fingerprint.len() != 64
            || self.authorization_generation == 0
            || self.issued_at_monotonic_ms > now_monotonic_ms
            || self.deadline_monotonic_ms <= self.issued_at_monotonic_ms
        {
            return Err(CanonicalRecoveryApplicationResult::MetadataRejected);
        }
        if now_monotonic_ms >= self.deadline_monotonic_ms {
            return Err(CanonicalRecoveryApplicationResult::PlanningRejected);
        }
        Ok(ConsumedConfirmedRecovery {
            key,
            owner,
            owner_id: self.owner_id,
            project_id: self.project_id,
            process_generation: self.process_generation,
            preview_repository_epoch: self.preview_repository_epoch,
            preview_repository_revision: self.preview_repository_revision,
            preview_fingerprint: self.preview_fingerprint,
            authorization_generation: self.authorization_generation,
            issued_at_monotonic_ms: self.issued_at_monotonic_ms,
            deadline_monotonic_ms: self.deadline_monotonic_ms,
        })
    }
}

macro_rules! test_minter {
    ($type:ty, $key:expr, $owner:expr) => {
        impl $type {
            #[cfg(test)]
            pub(crate) fn mint_for_test(
                owner_id: &str,
                project_id: &str,
                process_generation: &str,
                preview_repository_epoch: &str,
                preview_repository_revision: &str,
                preview_fingerprint: &str,
                now_monotonic_ms: i64,
            ) -> Self {
                let _fixed_identity = ($key, $owner);
                Self {
                    core: ConfirmedRecoveryCore {
                        owner_id: owner_id.to_string(),
                        project_id: project_id.to_string(),
                        process_generation: process_generation.to_string(),
                        preview_repository_epoch: preview_repository_epoch.to_string(),
                        preview_repository_revision: preview_repository_revision.to_string(),
                        preview_fingerprint: preview_fingerprint.to_string(),
                        authorization_generation: 1,
                        issued_at_monotonic_ms: now_monotonic_ms,
                        deadline_monotonic_ms: now_monotonic_ms.saturating_add(CONFIRMATION_TTL_MS),
                    },
                }
            }
        }
    };
}

test_minter!(
    ConfirmedReviewRecoveryRequest,
    ProductionAdapterKey::REVIEW_PRIMARY,
    PlanningAuthorityOwner::Review
);
test_minter!(
    ConfirmedExperimentRecoveryRequest,
    ProductionAdapterKey::EXPERIMENT_PRIMARY,
    PlanningAuthorityOwner::Experiment
);

#[derive(Debug)]
pub(crate) struct ReviewRecoveryAuditContext {
    correlation_id: String,
}

#[derive(Debug)]
pub(crate) struct ExperimentRecoveryAuditContext {
    correlation_id: String,
}

impl ReviewRecoveryAuditContext {
    #[cfg(test)]
    pub(crate) fn mint_for_test(correlation_id: &str) -> Self {
        Self {
            correlation_id: correlation_id.to_string(),
        }
    }
}

impl ExperimentRecoveryAuditContext {
    #[cfg(test)]
    pub(crate) fn mint_for_test(correlation_id: &str) -> Self {
        Self {
            correlation_id: correlation_id.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CanonicalRecoveryApplicationResult {
    PlanningRejected,
    LifecycleRejected,
    MetadataRejected,
    NotRequired,
    AlreadyInProgress,
    Completed,
    RecoveryRequired,
    Quarantined,
    InvestigationRequired,
    AdapterNotRegistered,
    AdapterContractMismatch,
    RepositoryBusy,
    RepositoryUnavailable,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewRecoveryApplicationResult {
    ReviewRecoveryPlanningRejected,
    ReviewRecoveryLifecycleRejected,
    ReviewRecoveryMetadataRejected,
    ReviewRecoveryNotRequired,
    ReviewRecoveryAlreadyInProgress,
    ReviewRecoveryCompleted,
    ReviewRecoveryRequired,
    ReviewRecoveryQuarantined,
    ReviewRecoveryInvestigationRequired,
    ReviewAdapterNotRegistered,
    ReviewAdapterContractMismatch,
    RepositoryBusy,
    RepositoryUnavailable,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExperimentRecoveryApplicationResult {
    ExperimentRecoveryPlanningRejected,
    ExperimentRecoveryLifecycleRejected,
    ExperimentRecoveryMetadataRejected,
    ExperimentRecoveryNotRequired,
    ExperimentRecoveryAlreadyInProgress,
    ExperimentRecoveryCompleted,
    ExperimentRecoveryRequired,
    ExperimentRecoveryQuarantined,
    ExperimentRecoveryInvestigationRequired,
    ExperimentAdapterNotRegistered,
    ExperimentAdapterContractMismatch,
    RepositoryBusy,
    RepositoryUnavailable,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

pub(crate) struct CanonicalRecoveryApplicationOrchestration {
    planning_transport: Arc<PlanningAuthorityTransportFoundation>,
    process_generation: Arc<ProcessGeneration>,
    facade: Arc<ProvisioningRecoveryRuntimeFacade>,
    bridge: Arc<CanonicalRecoveryNeedBridge>,
    clock: Arc<dyn MonotonicClock>,
    #[cfg(test)]
    controlled_planning: Option<
        Arc<
            dyn Fn(
                    PlanningAuthorityOwner,
                    PlanningAuthorityPurpose,
                )
                    -> crate::planning_authority_transport::PlanningAuthorityEvidence
                + Send
                + Sync,
        >,
    >,
}

impl CanonicalRecoveryApplicationOrchestration {
    pub(super) fn new(
        planning_transport: Arc<PlanningAuthorityTransportFoundation>,
        process_generation: Arc<ProcessGeneration>,
        facade: Arc<ProvisioningRecoveryRuntimeFacade>,
        bridge: Arc<CanonicalRecoveryNeedBridge>,
        clock: Arc<dyn MonotonicClock>,
    ) -> Self {
        Self {
            planning_transport,
            process_generation,
            facade,
            bridge,
            clock,
            #[cfg(test)]
            controlled_planning: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_controlled_planning_for_test(
        planning_transport: Arc<PlanningAuthorityTransportFoundation>,
        process_generation: Arc<ProcessGeneration>,
        facade: Arc<ProvisioningRecoveryRuntimeFacade>,
        bridge: Arc<CanonicalRecoveryNeedBridge>,
        clock: Arc<dyn MonotonicClock>,
        controlled_planning: Arc<
            dyn Fn(
                    PlanningAuthorityOwner,
                    PlanningAuthorityPurpose,
                )
                    -> crate::planning_authority_transport::PlanningAuthorityEvidence
                + Send
                + Sync,
        >,
    ) -> Self {
        Self {
            planning_transport,
            process_generation,
            facade,
            bridge,
            clock,
            controlled_planning: Some(controlled_planning),
        }
    }

    async fn execute(
        &self,
        confirmed: ConsumedConfirmedRecovery,
        correlation_id: &str,
    ) -> CanonicalRecoveryApplicationResult {
        if correlation_id.trim().is_empty() {
            return CanonicalRecoveryApplicationResult::InternalInvariantFailure;
        }
        let preflight = match self
            .fresh_planning(&confirmed, PlanningAuthorityPurpose::PreparePreflight)
            .await
        {
            Ok(evidence) => evidence,
            Err(result) => return result,
        };
        let preflight = match preflight.consume_for_phase(
            confirmed.key.owner_type(),
            &confirmed.owner_id,
            &confirmed.project_id,
            &confirmed.process_generation,
            PlanningAuthorityPurpose::PreparePreflight,
            self.clock.now_ms(),
        ) {
            Ok(evidence) => evidence,
            Err(_) => return CanonicalRecoveryApplicationResult::PlanningRejected,
        };
        let scope = primary_scope(confirmed.key, &confirmed.owner_id);
        let durable = match self.facade.classify_read_only(&scope) {
            Ok(durable) => durable,
            Err(result) => return map_runtime_result(result),
        };
        let classification = durable.classification;
        if !matches!(
            classification,
            DurableRecoveryEntryClassification::NoOperation
                | DurableRecoveryEntryClassification::TerminalCompleted
        ) {
            return map_non_inspection_classification(classification);
        }
        let authority = RegisteredPlanningAuthority {
            owner_id: confirmed.owner_id.clone(),
            project_id: confirmed.project_id.clone(),
            authority_revision: format!(
                "{}:{}",
                preflight.repository_epoch, preflight.repository_revision
            ),
        };
        let inspection = match self.bridge.inspect_after_durable_classification(
            confirmed.key,
            scope.clone(),
            durable,
            authority,
            &confirmed.preview_fingerprint,
            &confirmed.process_generation,
            self.clock.now_ms(),
        ) {
            Ok(inspection) => inspection,
            Err(error) => return map_bridge_error(error),
        };
        let (ready, adapter) = match inspection {
            CanonicalRecoveryNeedInspection::AuthoritativeIntact => {
                return if classification == DurableRecoveryEntryClassification::NoOperation {
                    CanonicalRecoveryApplicationResult::NotRequired
                } else {
                    CanonicalRecoveryApplicationResult::Completed
                };
            }
            CanonicalRecoveryNeedInspection::RootMissing { evidence, adapter } => {
                let planning = match self
                    .fresh_planning(&confirmed, PlanningAuthorityPurpose::RecoveryRuntimeEntry)
                    .await
                {
                    Ok(evidence) => evidence,
                    Err(result) => return result,
                };
                let authorization = confirmed.authorization(
                    scope.clone(),
                    RecoveryRuntimeEntryAction::InitializeRootRecovery,
                );
                match self.facade.enter_root(planning, authorization, evidence) {
                    RecoveryRuntimeEntryResult::RecoveryExecutionFoundationReady(ready) => {
                        (ready, adapter)
                    }
                    other => return map_runtime_result(other),
                }
            }
            CanonicalRecoveryNeedInspection::SuccessorMissing { evidence, adapter } => {
                let planning = match self
                    .fresh_planning(&confirmed, PlanningAuthorityPurpose::RecoveryRuntimeEntry)
                    .await
                {
                    Ok(evidence) => evidence,
                    Err(result) => return result,
                };
                let authorization = confirmed.authorization(
                    scope.clone(),
                    RecoveryRuntimeEntryAction::CreateSuccessorRecovery,
                );
                match self
                    .facade
                    .enter_successor(planning, authorization, evidence)
                {
                    RecoveryRuntimeEntryResult::RecoveryExecutionFoundationReady(ready) => {
                        (ready, adapter)
                    }
                    other => return map_runtime_result(other),
                }
            }
        };
        let plan_evidence = match self
            .fresh_planning(&confirmed, PlanningAuthorityPurpose::PlanMaterialization)
            .await
        {
            Ok(evidence) => evidence,
            Err(result) => return result,
        };
        let foundation = ready.shared_foundation().clone();
        let mut execution = match foundation.materialize_registered_recovery(
            ready,
            &confirmed.project_id,
            &confirmed.process_generation,
            correlation_id,
            plan_evidence,
            self.clock.now_ms(),
            adapter,
        ) {
            Ok(execution) => execution,
            Err(result) => return map_execution_result(result),
        };
        for _ in 0..2 {
            let mutation_evidence = match self
                .fresh_planning(&confirmed, PlanningAuthorityPurpose::MutationPoint)
                .await
            {
                Ok(evidence) => evidence,
                Err(result) => return result,
            };
            match execution.execute_next_step(mutation_evidence, self.clock.now_ms()) {
                SharedExecutionResult::StepConverged => {}
                SharedExecutionResult::Completed => {
                    return CanonicalRecoveryApplicationResult::Completed
                }
                result => return map_execution_result(result),
            }
        }
        CanonicalRecoveryApplicationResult::InternalInvariantFailure
    }

    async fn fresh_planning(
        &self,
        confirmed: &ConsumedConfirmedRecovery,
        purpose: PlanningAuthorityPurpose,
    ) -> Result<
        crate::planning_authority_transport::PlanningAuthorityEvidence,
        CanonicalRecoveryApplicationResult,
    > {
        #[cfg(test)]
        if let Some(controlled) = self.controlled_planning.as_ref() {
            return Ok(controlled(confirmed.owner, purpose));
        }
        self.planning_transport
            .request_evidence(PlanningAuthorityChallengeRequest {
                owner: confirmed.owner,
                owner_id: confirmed.owner_id.clone(),
                project_id: confirmed.project_id.clone(),
                purpose,
                freshness: PlanningFreshnessExpectation::Exact,
                expected_repository_epoch: Some(confirmed.preview_repository_epoch.clone()),
                expected_repository_revision: Some(confirmed.preview_repository_revision.clone()),
            })
            .await
            .map_err(|_| CanonicalRecoveryApplicationResult::PlanningRejected)
    }
}

pub(crate) struct ReviewRecoveryApplicationService {
    orchestration: Arc<CanonicalRecoveryApplicationOrchestration>,
}

pub(crate) struct ExperimentRecoveryApplicationService {
    orchestration: Arc<CanonicalRecoveryApplicationOrchestration>,
}

impl ReviewRecoveryApplicationService {
    pub(super) fn new(orchestration: Arc<CanonicalRecoveryApplicationOrchestration>) -> Self {
        Self { orchestration }
    }

    pub(crate) async fn execute(
        &self,
        request: ConfirmedReviewRecoveryRequest,
        audit: ReviewRecoveryAuditContext,
    ) -> ReviewRecoveryApplicationResult {
        let confirmed = match request.core.consume(
            ProductionAdapterKey::REVIEW_PRIMARY,
            PlanningAuthorityOwner::Review,
            self.orchestration.process_generation.canonical(),
            self.orchestration.clock.now_ms(),
        ) {
            Ok(value) => value,
            Err(result) => return map_review_result(result),
        };
        map_review_result(
            self.orchestration
                .execute(confirmed, &audit.correlation_id)
                .await,
        )
    }
}

impl ExperimentRecoveryApplicationService {
    pub(super) fn new(orchestration: Arc<CanonicalRecoveryApplicationOrchestration>) -> Self {
        Self { orchestration }
    }

    pub(crate) async fn execute(
        &self,
        request: ConfirmedExperimentRecoveryRequest,
        audit: ExperimentRecoveryAuditContext,
    ) -> ExperimentRecoveryApplicationResult {
        let confirmed = match request.core.consume(
            ProductionAdapterKey::EXPERIMENT_PRIMARY,
            PlanningAuthorityOwner::Experiment,
            self.orchestration.process_generation.canonical(),
            self.orchestration.clock.now_ms(),
        ) {
            Ok(value) => value,
            Err(result) => return map_experiment_result(result),
        };
        map_experiment_result(
            self.orchestration
                .execute(confirmed, &audit.correlation_id)
                .await,
        )
    }
}

impl ConsumedConfirmedRecovery {
    fn authorization(
        &self,
        scope: ProvisioningScopeIdentity,
        action: RecoveryRuntimeEntryAction,
    ) -> RecoveryRuntimeEntryAuthorization {
        RecoveryRuntimeEntryAuthorization::derive_from_confirmed(
            self.owner_id.clone(),
            self.project_id.clone(),
            scope,
            action,
            self.process_generation.clone(),
            self.authorization_generation,
            self.issued_at_monotonic_ms,
            self.deadline_monotonic_ms,
        )
    }
}

fn primary_scope(key: ProductionAdapterKey, owner_id: &str) -> ProvisioningScopeIdentity {
    ProvisioningScopeIdentity {
        owner_type: match key {
            ProductionAdapterKey::REVIEW_PRIMARY => DurablePlanOwnerType::Review,
            ProductionAdapterKey::EXPERIMENT_PRIMARY => DurablePlanOwnerType::Experiment,
            #[cfg(test)]
            _ => unreachable!("unregistered ExperimentRun cannot enter typed orchestration"),
        },
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
    }
}

fn map_non_inspection_classification(
    classification: DurableRecoveryEntryClassification,
) -> CanonicalRecoveryApplicationResult {
    match classification {
        DurableRecoveryEntryClassification::ActiveLive => {
            CanonicalRecoveryApplicationResult::AlreadyInProgress
        }
        DurableRecoveryEntryClassification::RecoveryRetained
        | DurableRecoveryEntryClassification::AbandonedEligible => {
            CanonicalRecoveryApplicationResult::RecoveryRequired
        }
        DurableRecoveryEntryClassification::Quarantined => {
            CanonicalRecoveryApplicationResult::Quarantined
        }
        DurableRecoveryEntryClassification::RetryRequired
        | DurableRecoveryEntryClassification::RepairRequired
        | DurableRecoveryEntryClassification::LifecycleDecisionRequired
        | DurableRecoveryEntryClassification::ActiveWithoutSafeHandle
        | DurableRecoveryEntryClassification::InvestigationRequired => {
            CanonicalRecoveryApplicationResult::InvestigationRequired
        }
        DurableRecoveryEntryClassification::NoOperation
        | DurableRecoveryEntryClassification::TerminalCompleted => {
            CanonicalRecoveryApplicationResult::InternalInvariantFailure
        }
    }
}

fn map_bridge_error(error: CanonicalRecoveryNeedBridgeError) -> CanonicalRecoveryApplicationResult {
    match error {
        CanonicalRecoveryNeedBridgeError::AdapterUnavailable => {
            CanonicalRecoveryApplicationResult::AdapterNotRegistered
        }
        CanonicalRecoveryNeedBridgeError::MetadataIdentityMismatch => {
            CanonicalRecoveryApplicationResult::MetadataRejected
        }
        CanonicalRecoveryNeedBridgeError::ClassificationNotInspectable => {
            CanonicalRecoveryApplicationResult::InternalInvariantFailure
        }
    }
}

fn map_runtime_result(result: RecoveryRuntimeEntryResult) -> CanonicalRecoveryApplicationResult {
    match result {
        RecoveryRuntimeEntryResult::RecoveryRepositoryBusy => {
            CanonicalRecoveryApplicationResult::RepositoryBusy
        }
        RecoveryRuntimeEntryResult::RecoveryCommitOutcomeUnknown => {
            CanonicalRecoveryApplicationResult::CommitOutcomeUnknown
        }
        RecoveryRuntimeEntryResult::RecoveryPlanningEvidenceRequired
        | RecoveryRuntimeEntryResult::RecoveryPlanningEvidenceStale
        | RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationRequired
        | RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationStale
        | RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationConsumed => {
            CanonicalRecoveryApplicationResult::PlanningRejected
        }
        RecoveryRuntimeEntryResult::RecoveryNeedEvidenceRequired
        | RecoveryRuntimeEntryResult::RecoveryNeedEvidenceStale => {
            CanonicalRecoveryApplicationResult::MetadataRejected
        }
        RecoveryRuntimeEntryResult::RecoveryExistingExecution => {
            CanonicalRecoveryApplicationResult::AlreadyInProgress
        }
        RecoveryRuntimeEntryResult::RecoveryRetained
        | RecoveryRuntimeEntryResult::RecoveryTakeoverRequired
        | RecoveryRuntimeEntryResult::RecoveryRetryRequired
        | RecoveryRuntimeEntryResult::RecoveryRepairRequired => {
            CanonicalRecoveryApplicationResult::RecoveryRequired
        }
        RecoveryRuntimeEntryResult::RecoveryNoOperation => {
            CanonicalRecoveryApplicationResult::NotRequired
        }
        RecoveryRuntimeEntryResult::RecoveryAuthoritativeCompleted => {
            CanonicalRecoveryApplicationResult::Completed
        }
        RecoveryRuntimeEntryResult::RecoveryLifecycleDecisionRequired => {
            CanonicalRecoveryApplicationResult::LifecycleRejected
        }
        RecoveryRuntimeEntryResult::RecoveryInvestigationRequired
        | RecoveryRuntimeEntryResult::RecoveryCommittedButUnattached => {
            CanonicalRecoveryApplicationResult::InvestigationRequired
        }
        RecoveryRuntimeEntryResult::RecoveryExecutionFoundationReady(_) => {
            CanonicalRecoveryApplicationResult::InternalInvariantFailure
        }
    }
}

fn map_execution_result(result: SharedExecutionResult) -> CanonicalRecoveryApplicationResult {
    match result {
        SharedExecutionResult::Completed => CanonicalRecoveryApplicationResult::Completed,
        SharedExecutionResult::RecoveryRequired => {
            CanonicalRecoveryApplicationResult::RecoveryRequired
        }
        SharedExecutionResult::AdapterContractMismatch => {
            CanonicalRecoveryApplicationResult::AdapterContractMismatch
        }
        SharedExecutionResult::PlanningLeaseUnavailable
        | SharedExecutionResult::PlanningLeaseStale
        | SharedExecutionResult::AdapterPlanningRejected => {
            CanonicalRecoveryApplicationResult::PlanningRejected
        }
        SharedExecutionResult::KnownNotCommitted => {
            CanonicalRecoveryApplicationResult::RepositoryBusy
        }
        SharedExecutionResult::Quarantined => CanonicalRecoveryApplicationResult::Quarantined,
        SharedExecutionResult::StepConverged
        | SharedExecutionResult::RecoveryAuthorityUnavailable
        | SharedExecutionResult::ClaimHeartbeatFailed
        | SharedExecutionResult::StepCheckoutConflict
        | SharedExecutionResult::PermitIssueFailed
        | SharedExecutionResult::PhysicalVerificationFailed
        | SharedExecutionResult::AdapterPreMutationRejected
        | SharedExecutionResult::DurableAuthorityStale
        | SharedExecutionResult::InternalInvariantFailure => {
            CanonicalRecoveryApplicationResult::InternalInvariantFailure
        }
    }
}

fn map_review_result(
    result: CanonicalRecoveryApplicationResult,
) -> ReviewRecoveryApplicationResult {
    match result {
        CanonicalRecoveryApplicationResult::PlanningRejected => {
            ReviewRecoveryApplicationResult::ReviewRecoveryPlanningRejected
        }
        CanonicalRecoveryApplicationResult::LifecycleRejected => {
            ReviewRecoveryApplicationResult::ReviewRecoveryLifecycleRejected
        }
        CanonicalRecoveryApplicationResult::MetadataRejected => {
            ReviewRecoveryApplicationResult::ReviewRecoveryMetadataRejected
        }
        CanonicalRecoveryApplicationResult::NotRequired => {
            ReviewRecoveryApplicationResult::ReviewRecoveryNotRequired
        }
        CanonicalRecoveryApplicationResult::AlreadyInProgress => {
            ReviewRecoveryApplicationResult::ReviewRecoveryAlreadyInProgress
        }
        CanonicalRecoveryApplicationResult::Completed => {
            ReviewRecoveryApplicationResult::ReviewRecoveryCompleted
        }
        CanonicalRecoveryApplicationResult::RecoveryRequired => {
            ReviewRecoveryApplicationResult::ReviewRecoveryRequired
        }
        CanonicalRecoveryApplicationResult::Quarantined => {
            ReviewRecoveryApplicationResult::ReviewRecoveryQuarantined
        }
        CanonicalRecoveryApplicationResult::InvestigationRequired => {
            ReviewRecoveryApplicationResult::ReviewRecoveryInvestigationRequired
        }
        CanonicalRecoveryApplicationResult::AdapterNotRegistered => {
            ReviewRecoveryApplicationResult::ReviewAdapterNotRegistered
        }
        CanonicalRecoveryApplicationResult::AdapterContractMismatch => {
            ReviewRecoveryApplicationResult::ReviewAdapterContractMismatch
        }
        CanonicalRecoveryApplicationResult::RepositoryBusy => {
            ReviewRecoveryApplicationResult::RepositoryBusy
        }
        CanonicalRecoveryApplicationResult::RepositoryUnavailable => {
            ReviewRecoveryApplicationResult::RepositoryUnavailable
        }
        CanonicalRecoveryApplicationResult::CommitOutcomeUnknown => {
            ReviewRecoveryApplicationResult::CommitOutcomeUnknown
        }
        CanonicalRecoveryApplicationResult::InternalInvariantFailure => {
            ReviewRecoveryApplicationResult::InternalInvariantFailure
        }
    }
}

fn map_experiment_result(
    result: CanonicalRecoveryApplicationResult,
) -> ExperimentRecoveryApplicationResult {
    match result {
        CanonicalRecoveryApplicationResult::PlanningRejected => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryPlanningRejected
        }
        CanonicalRecoveryApplicationResult::LifecycleRejected => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryLifecycleRejected
        }
        CanonicalRecoveryApplicationResult::MetadataRejected => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryMetadataRejected
        }
        CanonicalRecoveryApplicationResult::NotRequired => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryNotRequired
        }
        CanonicalRecoveryApplicationResult::AlreadyInProgress => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryAlreadyInProgress
        }
        CanonicalRecoveryApplicationResult::Completed => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryCompleted
        }
        CanonicalRecoveryApplicationResult::RecoveryRequired => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryRequired
        }
        CanonicalRecoveryApplicationResult::Quarantined => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryQuarantined
        }
        CanonicalRecoveryApplicationResult::InvestigationRequired => {
            ExperimentRecoveryApplicationResult::ExperimentRecoveryInvestigationRequired
        }
        CanonicalRecoveryApplicationResult::AdapterNotRegistered => {
            ExperimentRecoveryApplicationResult::ExperimentAdapterNotRegistered
        }
        CanonicalRecoveryApplicationResult::AdapterContractMismatch => {
            ExperimentRecoveryApplicationResult::ExperimentAdapterContractMismatch
        }
        CanonicalRecoveryApplicationResult::RepositoryBusy => {
            ExperimentRecoveryApplicationResult::RepositoryBusy
        }
        CanonicalRecoveryApplicationResult::RepositoryUnavailable => {
            ExperimentRecoveryApplicationResult::RepositoryUnavailable
        }
        CanonicalRecoveryApplicationResult::CommitOutcomeUnknown => {
            ExperimentRecoveryApplicationResult::CommitOutcomeUnknown
        }
        CanonicalRecoveryApplicationResult::InternalInvariantFailure => {
            ExperimentRecoveryApplicationResult::InternalInvariantFailure
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
        ClaimOwnershipRepositoryContext, FixedRepositoryUtcClock,
    };
    use crate::owner_authority_lease::OwnerAuthorityLeaseRegistry;
    use crate::provisioning_runtime::database_provider::SqliteRuntimeDatabaseProvider;
    use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
    use crate::provisioning_runtime::lifecycle::{InlineRuntimeTaskSpawner, NoopRuntimeEventSink};
    use crate::provisioning_runtime::production_adapter_registry::{
        ProductionAdapterRegistry, ProductionInspection, RegisteredPlanningAuthority,
    };
    use crate::provisioning_runtime::shared_executor::{
        SharedExecutorFoundation, SharedExecutorFoundationProvider,
    };
    use crate::provisioning_runtime_non_completed_exit_tests::TempDatabase;
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use uuid::Uuid;

    const TEST_EPOCH: &str = "11111111-1111-4111-8111-111111111111";
    const TEST_REVISION: &str = "1";
    const TEST_PROCESS: &str = "lp12-c-2-isolated-process";
    const INITIAL_EXPERIMENT_MARKDOWN: &str = "# 实验记录：隔离实验\n\n## 结构化纲要\n\n### 实验目的\n\n### 研究问题\n\n### 假设\n\n### 条件摘要\n\n### 方法摘要\n\n### 结果摘要\n\n### 结论与下一步\n\n### 其他\n\n## 实验正文\n\n请在此记录实验过程、观察与分析。\n";

    struct SeededOwners {
        review_manuscript: PathBuf,
        experiment_manuscript: PathBuf,
    }

    type ControlledPlanning = Arc<
        dyn Fn(
                PlanningAuthorityOwner,
                PlanningAuthorityPurpose,
            ) -> crate::planning_authority_transport::PlanningAuthorityEvidence
            + Send
            + Sync,
    >;

    struct ExperimentHarness {
        service: Arc<ExperimentRecoveryApplicationService>,
        fingerprint: String,
        process_generation: String,
    }

    fn seed_owners(database: &TempDatabase, bare_id: &str) -> SeededOwners {
        let managed_root = database
            .path()
            .parent()
            .expect("fixture parent")
            .join("lp12-c-2-managed");
        fs::create_dir(&managed_root).expect("managed root");
        let review_workspace = managed_root.join("review-workspace");
        let experiment_workspace = managed_root.join("experiment-workspace");
        let review_manuscript = review_workspace.join("review.md");
        let experiment_manuscript = experiment_workspace.join("experiment.md");
        let connection = database.open();
        let now = "2026-07-27T00:00:00.000Z";
        connection
            .execute(
                "INSERT INTO managed_root_settings (
                   id,configured_root,created_at,updated_at
                 ) VALUES ('managed-root',?1,?2,?2)",
                params![managed_root.to_string_lossy(), now],
            )
            .expect("managed root metadata");
        connection
            .execute(
                "INSERT INTO experiments (
                   id,project_id,title,experiment_name,machine_object,fault_type,
                   sensor_config,data_path,result_summary,created_local_date,
                   created_local_time,workspace_title_identity,created_at,updated_at
                 ) VALUES (?1,'project-1','隔离实验','隔离实验','','unknown','','','',
                           '2026-07-27','0000','experiment',?2,?2)",
                params![bare_id, now],
            )
            .expect("Experiment owner");
        let initial_fields = serde_json::json!([{
            "id": "labpod.experiment.canonical-initial-content.v1",
            "name": "labpod.experiment.canonical-initial-content.v1",
            "value": INITIAL_EXPERIMENT_MARKDOWN,
            "valueType": "text"
        }])
        .to_string();
        for (id, owner_type, path, kind, role, file_type, custom_fields) in [
            (
                "review-folder",
                "review",
                review_workspace.as_path(),
                "folder",
                "defaultFolder",
                "folder",
                "[]",
            ),
            (
                "review-file",
                "review",
                review_manuscript.as_path(),
                "file",
                "manuscript",
                "markdown",
                "[]",
            ),
            (
                "experiment-folder",
                "experiment",
                experiment_workspace.as_path(),
                "folder",
                "defaultFolder",
                "folder",
                "[]",
            ),
            (
                "experiment-file",
                "experiment",
                experiment_manuscript.as_path(),
                "file",
                "manuscript",
                "markdown",
                initial_fields.as_str(),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO file_refs (
                       id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                       location_mode,file_type,path,path_identity_key,title,custom_fields,
                       created_at,updated_at
                     ) VALUES (?1,?2,?3,'primary',?4,?5,'managed',?6,?7,?7,?1,?8,?9,?9)",
                    params![
                        id,
                        owner_type,
                        bare_id,
                        kind,
                        role,
                        file_type,
                        path.to_string_lossy(),
                        custom_fields,
                        now
                    ],
                )
                .expect("owner FileRef");
        }
        for (binding_id, owner_type, folder_id, file_id) in [
            ("review-binding", "review", "review-folder", "review-file"),
            (
                "experiment-binding",
                "experiment",
                "experiment-folder",
                "experiment-file",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO manuscript_bindings (
                       id,owner_type,owner_id,manuscript_channel,default_folder_file_ref_id,
                       default_manuscript_file_ref_id,current_file_ref_id,created_at,updated_at
                     ) VALUES (?1,?2,?3,'primary',?4,?5,?5,?6,?6)",
                    params![binding_id, owner_type, bare_id, folder_id, file_id, now],
                )
                .expect("owner Binding");
        }
        SeededOwners {
            review_manuscript,
            experiment_manuscript,
        }
    }

    fn build_experiment_harness(
        database: &TempDatabase,
        owner_id: &str,
        project_id: &str,
        process_generation_text: &str,
        controlled_planning: ControlledPlanning,
    ) -> ExperimentHarness {
        let process_generation =
            Arc::new(ProcessGeneration::fixed_for_test(process_generation_text));
        let clock = Arc::new(FixedMonotonicClock::new(0));
        let ownership_context = Arc::new(ClaimOwnershipRepositoryContext::new(
            process_generation.clone(),
            Arc::new(FixedRepositoryUtcClock::new(1_800_000_000_000)),
        ));
        let database_provider = Arc::new(
            SqliteRuntimeDatabaseProvider::new_isolated(
                database.path().to_path_buf(),
                &format!("local.labpod.lp12c2.harness.{}.test", Uuid::new_v4()),
            )
            .expect("isolated provider"),
        );
        let runtime = crate::provisioning_runtime::core::ProvisioningRuntime::new_production(
            database_provider.clone(),
            ownership_context.clone(),
            clock.clone(),
            Arc::new(RecordingTicker::default()),
            Arc::new(InlineRuntimeTaskSpawner),
            Arc::new(NoopRuntimeEventSink),
        );
        let authority_registry = Arc::new(OwnerAuthorityLeaseRegistry::from_process_generation(
            process_generation.clone(),
        ));
        let adapter_registry = Arc::new(
            ProductionAdapterRegistry::build_review_and_experiment_primary(
                database.path().to_path_buf(),
            )
            .expect("two-owner Registry"),
        );
        let preview = adapter_registry
            .inspect(
                ProductionAdapterKey::EXPERIMENT_PRIMARY,
                RegisteredPlanningAuthority {
                    owner_id: owner_id.to_string(),
                    project_id: project_id.to_string(),
                    authority_revision: format!("{TEST_EPOCH}:{TEST_REVISION}"),
                },
            )
            .expect("Experiment preview");
        let fingerprint = match adapter_registry
            .inspection(&preview)
            .expect("Experiment inspection")
        {
            ProductionInspection::Experiment(value) => value.metadata_fingerprint,
            _ => panic!("Experiment dispatch isolation"),
        };
        let foundation = Arc::new(
            SharedExecutorFoundation::from_runtime(
                &runtime,
                authority_registry,
                adapter_registry.clone(),
            )
            .expect("Shared Executor"),
        );
        let planning_transport = Arc::new(PlanningAuthorityTransportFoundation::new(
            process_generation.clone(),
            clock.clone(),
        ));
        let facade = Arc::new(ProvisioningRecoveryRuntimeFacade::new(
            planning_transport.clone(),
            process_generation.clone(),
            database_provider,
            ownership_context,
            runtime
                .retained_ownership_supervisor_for_test()
                .expect("supervisor"),
            Arc::new(SharedExecutorFoundationProvider::new(foundation)),
            clock.clone(),
        ));
        let orchestration = Arc::new(
            CanonicalRecoveryApplicationOrchestration::new_with_controlled_planning_for_test(
                planning_transport,
                process_generation,
                facade,
                Arc::new(CanonicalRecoveryNeedBridge::new(adapter_registry)),
                clock,
                controlled_planning,
            ),
        );
        ExperimentHarness {
            service: Arc::new(ExperimentRecoveryApplicationService::new(orchestration)),
            fingerprint,
            process_generation: process_generation_text.to_string(),
        }
    }

    fn execute_experiment_harness(
        harness: &ExperimentHarness,
        owner_id: &str,
        project_id: &str,
        correlation_id: &str,
    ) -> ExperimentRecoveryApplicationResult {
        tauri::async_runtime::block_on(harness.service.execute(
            ConfirmedExperimentRecoveryRequest::mint_for_test(
                owner_id,
                project_id,
                &harness.process_generation,
                TEST_EPOCH,
                TEST_REVISION,
                &harness.fingerprint,
                0,
            ),
            ExperimentRecoveryAuditContext::mint_for_test(correlation_id),
        ))
    }

    #[test]
    fn review_and_experiment_share_one_orchestration_and_remain_cross_owner_isolated() {
        let database = TempDatabase::new("lp12-c-2-production-graph");
        let owner_id = "same-bare-owner-id";
        let project_id = "project-1";
        let seeded = seed_owners(&database, owner_id);
        let process_generation = Arc::new(ProcessGeneration::fixed_for_test(TEST_PROCESS));
        let clock = Arc::new(FixedMonotonicClock::new(0));
        let ownership_context = Arc::new(ClaimOwnershipRepositoryContext::new(
            process_generation.clone(),
            Arc::new(FixedRepositoryUtcClock::new(1_800_000_000_000)),
        ));
        let database_provider = Arc::new(
            SqliteRuntimeDatabaseProvider::new_isolated(
                database.path().to_path_buf(),
                &format!("local.labpod.lp12c2.{}.test", Uuid::new_v4()),
            )
            .expect("isolated provider"),
        );
        let runtime = crate::provisioning_runtime::core::ProvisioningRuntime::new_production(
            database_provider.clone(),
            ownership_context.clone(),
            clock.clone(),
            Arc::new(RecordingTicker::default()),
            Arc::new(InlineRuntimeTaskSpawner),
            Arc::new(NoopRuntimeEventSink),
        );
        let authority_registry = Arc::new(OwnerAuthorityLeaseRegistry::from_process_generation(
            process_generation.clone(),
        ));
        let adapter_registry = Arc::new(
            ProductionAdapterRegistry::build_review_and_experiment_primary(
                database.path().to_path_buf(),
            )
            .expect("two-owner Registry"),
        );
        let foundation = Arc::new(
            SharedExecutorFoundation::from_runtime(
                &runtime,
                authority_registry,
                adapter_registry.clone(),
            )
            .expect("Shared Executor"),
        );
        let planning_transport = Arc::new(PlanningAuthorityTransportFoundation::new(
            process_generation.clone(),
            clock.clone(),
        ));
        let facade = Arc::new(ProvisioningRecoveryRuntimeFacade::new(
            planning_transport.clone(),
            process_generation.clone(),
            database_provider,
            ownership_context,
            runtime
                .retained_ownership_supervisor_for_test()
                .expect("supervisor"),
            Arc::new(SharedExecutorFoundationProvider::new(foundation)),
            clock.clone(),
        ));
        let bridge = Arc::new(CanonicalRecoveryNeedBridge::new(adapter_registry.clone()));
        let authority_revision = format!("{TEST_EPOCH}:{TEST_REVISION}");
        let review_preview = adapter_registry
            .inspect(
                ProductionAdapterKey::REVIEW_PRIMARY,
                RegisteredPlanningAuthority {
                    owner_id: owner_id.to_string(),
                    project_id: project_id.to_string(),
                    authority_revision: authority_revision.clone(),
                },
            )
            .expect("Review preview");
        let experiment_preview = adapter_registry
            .inspect(
                ProductionAdapterKey::EXPERIMENT_PRIMARY,
                RegisteredPlanningAuthority {
                    owner_id: owner_id.to_string(),
                    project_id: project_id.to_string(),
                    authority_revision,
                },
            )
            .expect("Experiment preview");
        let review_fingerprint = match adapter_registry
            .inspection(&review_preview)
            .expect("Review inspection")
        {
            ProductionInspection::Review(value) => value.metadata_fingerprint,
            _ => panic!("Review dispatch isolation"),
        };
        let experiment_fingerprint = match adapter_registry
            .inspection(&experiment_preview)
            .expect("Experiment inspection")
        {
            ProductionInspection::Experiment(value) => value.metadata_fingerprint,
            _ => panic!("Experiment dispatch isolation"),
        };
        let controlled_planning = Arc::new(move |owner, purpose| {
            crate::planning_authority_transport::PlanningAuthorityEvidence::mint_for_owner_test(
                owner,
                owner_id,
                project_id,
                purpose,
                TEST_PROCESS,
                TEST_EPOCH,
                TEST_REVISION,
                0,
            )
        });
        let orchestration = Arc::new(
            CanonicalRecoveryApplicationOrchestration::new_with_controlled_planning_for_test(
                planning_transport,
                process_generation,
                facade,
                bridge,
                clock,
                controlled_planning,
            ),
        );
        let review_service = Arc::new(ReviewRecoveryApplicationService::new(orchestration.clone()));
        let experiment_service = Arc::new(ExperimentRecoveryApplicationService::new(orchestration));
        let execute_review = || {
            tauri::async_runtime::block_on(review_service.execute(
                ConfirmedReviewRecoveryRequest::mint_for_test(
                    owner_id,
                    project_id,
                    TEST_PROCESS,
                    TEST_EPOCH,
                    TEST_REVISION,
                    &review_fingerprint,
                    0,
                ),
                ReviewRecoveryAuditContext::mint_for_test("review-correlation"),
            ))
        };
        let execute_experiment = || {
            tauri::async_runtime::block_on(experiment_service.execute(
                ConfirmedExperimentRecoveryRequest::mint_for_test(
                    owner_id,
                    project_id,
                    TEST_PROCESS,
                    TEST_EPOCH,
                    TEST_REVISION,
                    &experiment_fingerprint,
                    0,
                ),
                ExperimentRecoveryAuditContext::mint_for_test("experiment-correlation"),
            ))
        };
        let (review_result, experiment_result) = std::thread::scope(|scope| {
            let review = scope.spawn(|| execute_review());
            let experiment = scope.spawn(|| execute_experiment());
            (
                review.join().expect("Review execution thread"),
                experiment.join().expect("Experiment execution thread"),
            )
        });
        assert_eq!(
            review_result,
            ReviewRecoveryApplicationResult::ReviewRecoveryCompleted
        );
        assert_eq!(
            experiment_result,
            ExperimentRecoveryApplicationResult::ExperimentRecoveryCompleted
        );
        assert_eq!(
            fs::read_to_string(&seeded.experiment_manuscript).expect("Experiment bytes"),
            INITIAL_EXPERIMENT_MARKDOWN
        );
        assert_eq!(
            fs::metadata(&seeded.review_manuscript)
                .expect("Review manuscript")
                .len(),
            0
        );
        let connection = database.open();
        let review_attempts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE owner_type='review' AND owner_id=?1",
                [owner_id],
                |row| row.get(0),
            )
            .expect("Review attempts");
        let experiment_attempts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE owner_type='experiment' AND owner_id=?1",
                [owner_id],
                |row| row.get(0),
            )
            .expect("Experiment attempts");
        assert_eq!(review_attempts, 2);
        assert_eq!(experiment_attempts, 2);
        drop(connection);
        assert_eq!(
            execute_experiment(),
            ExperimentRecoveryApplicationResult::ExperimentRecoveryCompleted
        );
        fs::remove_file(&seeded.experiment_manuscript)
            .expect("remove isolated Experiment manuscript");
        assert_eq!(
            execute_experiment(),
            ExperimentRecoveryApplicationResult::ExperimentRecoveryCompleted
        );
        assert_eq!(
            fs::read_to_string(&seeded.experiment_manuscript).expect("successor bytes"),
            INITIAL_EXPERIMENT_MARKDOWN
        );
        assert!(seeded.review_manuscript.is_file());
    }

    #[test]
    fn cross_owner_physical_target_collision_is_rejected_before_attempt_creation() {
        let database = TempDatabase::new("lp12-c-2-cross-owner-collision");
        let owner_id = "collision-owner";
        let seeded = seed_owners(&database, owner_id);
        database
            .open()
            .execute(
                "UPDATE file_refs SET path=?1,path_identity_key=?1
                 WHERE id='review-file'",
                [seeded.experiment_manuscript.to_string_lossy().to_string()],
            )
            .expect("force isolated collision");
        let registry = ProductionAdapterRegistry::build_review_and_experiment_primary(
            database.path().to_path_buf(),
        )
        .expect("Registry");
        assert_eq!(
            registry
                .inspect(
                ProductionAdapterKey::EXPERIMENT_PRIMARY,
                RegisteredPlanningAuthority {
                    owner_id: owner_id.to_string(),
                    project_id: "project-1".to_string(),
                    authority_revision: format!("{TEST_EPOCH}:{TEST_REVISION}"),
                },
            )
                .err(),
            Some(
                crate::provisioning_runtime::production_adapter_registry::ProductionAdapterRegistryError::CrossOwnerTargetCollision
            )
        );
        let attempts: i64 = database
            .open()
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts",
                [],
                |row| row.get(0),
            )
            .expect("attempt count");
        assert_eq!(attempts, 0);
    }

    #[test]
    fn external_current_is_identity_only_and_restart_keeps_completed_intact() {
        let database = TempDatabase::new("lp12-c-2-external-current-restart");
        let owner_id = "external-current-owner";
        let project_id = "project-1";
        let seeded = seed_owners(&database, owner_id);
        let external_current = database
            .path()
            .parent()
            .expect("fixture parent")
            .join("external-current.md");
        fs::write(&external_current, b"external-current-must-not-change")
            .expect("external current fixture");
        let connection = database.open();
        connection
            .execute(
                "INSERT INTO file_refs (
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,custom_fields,
                   created_at,updated_at
                 ) VALUES ('external-current','experiment',?1,'primary','file','manuscript',
                           'external','markdown',?2,?2,'external-current','[]',?3,?3)",
                params![
                    owner_id,
                    external_current.to_string_lossy(),
                    "2026-07-27T00:00:00.000Z"
                ],
            )
            .expect("external current FileRef");
        connection
            .execute(
                "UPDATE manuscript_bindings SET current_file_ref_id='external-current'
                 WHERE id='experiment-binding'",
                [],
            )
            .expect("select external current");
        drop(connection);
        let planning_for = |process: &'static str| {
            Arc::new(move |owner, purpose| {
                crate::planning_authority_transport::PlanningAuthorityEvidence::mint_for_owner_test(
                    owner,
                    owner_id,
                    project_id,
                    purpose,
                    process,
                    TEST_EPOCH,
                    TEST_REVISION,
                    0,
                )
            }) as ControlledPlanning
        };
        let first = build_experiment_harness(
            &database,
            owner_id,
            project_id,
            TEST_PROCESS,
            planning_for(TEST_PROCESS),
        );
        assert_eq!(
            execute_experiment_harness(&first, owner_id, project_id, "external-current-first"),
            ExperimentRecoveryApplicationResult::ExperimentRecoveryCompleted
        );
        assert_eq!(
            fs::read(&external_current).expect("external current bytes"),
            b"external-current-must-not-change"
        );
        assert_eq!(
            fs::read_to_string(&seeded.experiment_manuscript).expect("managed default bytes"),
            INITIAL_EXPERIMENT_MARKDOWN
        );
        let attempts_before_restart: i64 = database
            .open()
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE owner_type='experiment' AND owner_id=?1",
                [owner_id],
                |row| row.get(0),
            )
            .expect("attempts before restart");
        const RESTART_PROCESS: &str = "lp12-c-2-restarted-process";
        let restarted = build_experiment_harness(
            &database,
            owner_id,
            project_id,
            RESTART_PROCESS,
            planning_for(RESTART_PROCESS),
        );
        assert_eq!(
            execute_experiment_harness(
                &restarted,
                owner_id,
                project_id,
                "external-current-restarted"
            ),
            ExperimentRecoveryApplicationResult::ExperimentRecoveryCompleted
        );
        let attempts_after_restart: i64 = database
            .open()
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE owner_type='experiment' AND owner_id=?1",
                [owner_id],
                |row| row.get(0),
            )
            .expect("attempts after restart");
        assert_eq!(attempts_after_restart, attempts_before_restart);
        assert_eq!(
            fs::read(&external_current).expect("external current after restart"),
            b"external-current-must-not-change"
        );
    }

    #[test]
    fn experiment_metadata_drift_is_rejected_before_attempt_or_filesystem_effect() {
        let database = TempDatabase::new("lp12-c-2-experiment-toctou");
        let owner_id = "experiment-toctou-owner";
        let project_id = "project-1";
        let seeded = seed_owners(&database, owner_id);
        let database_path = database.path().to_path_buf();
        let drifted = Arc::new(AtomicBool::new(false));
        let controlled_planning = {
            let drifted = drifted.clone();
            Arc::new(move |owner, purpose| {
                if owner == PlanningAuthorityOwner::Experiment
                    && purpose == PlanningAuthorityPurpose::RecoveryRuntimeEntry
                    && !drifted.swap(true, Ordering::SeqCst)
                {
                    Connection::open(&database_path)
                        .expect("open TOCTOU fixture")
                        .execute(
                            "UPDATE experiments SET updated_at='2026-07-27T00:00:01.000Z'
                             WHERE id=?1",
                            [owner_id],
                        )
                        .expect("drift Experiment revision");
                }
                crate::planning_authority_transport::PlanningAuthorityEvidence::mint_for_owner_test(
                    owner,
                    owner_id,
                    project_id,
                    purpose,
                    TEST_PROCESS,
                    TEST_EPOCH,
                    TEST_REVISION,
                    0,
                )
            }) as ControlledPlanning
        };
        let harness = build_experiment_harness(
            &database,
            owner_id,
            project_id,
            TEST_PROCESS,
            controlled_planning,
        );
        assert_eq!(
            execute_experiment_harness(&harness, owner_id, project_id, "experiment-toctou"),
            ExperimentRecoveryApplicationResult::ExperimentRecoveryMetadataRejected
        );
        assert!(drifted.load(Ordering::SeqCst));
        let attempts: i64 = database
            .open()
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts",
                [],
                |row| row.get(0),
            )
            .expect("attempt count");
        assert_eq!(attempts, 0);
        assert!(!seeded.experiment_manuscript.exists());
    }
}
