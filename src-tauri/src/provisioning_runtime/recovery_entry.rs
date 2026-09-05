use super::database_provider::RuntimeDatabaseProvider;
use super::heartbeat_scheduler::MonotonicClock;
use super::ownership_supervisor::{
    InitialRecoveryOwnershipAttachmentResult, RetainedOwnershipSupervisor,
};
use super::shared_executor::{RecoveryExecutionFoundationReady, SharedExecutorFoundationProvider};
use super::slot::RuntimeRegistryLifecycle;
use crate::db::manuscript_provisioning_operation_state::{
    completed_predecessor_fingerprint, create_successor_recovery_after_completed_atomically,
    initialize_canonical_root_recovery_atomically, read_active_claim_for_operation,
    read_attempt_plan, read_attempt_step_progress, read_audit_state,
    read_literature_child_projections, CompletedRecoveryPredecessorPrecondition,
    RecoveryInitializationRequest, RecoveryInitializationResult, RecoveryMetadataPrecondition,
};
use crate::manuscript_provisioning_contract::ProvisioningScopeIdentity;
use crate::planning_authority_transport::{
    PlanningAuthorityEvidence, PlanningAuthorityTransportFailureStatus,
    PlanningAuthorityTransportFoundation, PlanningRecoveryEntryEvidence,
};
use crate::provisioning_runtime_foundation::ProcessGeneration;
use chrono::{SecondsFormat, Utc};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::sync::Arc;

const ENTRY_AUTHORIZATION_TTL_MS: i64 = 10_000;
const RECOVERY_NEED_TTL_MS: i64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryRuntimeEntryAction {
    InitializeRootRecovery,
    CreateSuccessorRecovery,
    RouteExistingRecovery,
}

impl RecoveryRuntimeEntryAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::InitializeRootRecovery => "InitializeRootRecovery",
            Self::CreateSuccessorRecovery => "CreateSuccessorRecovery",
            Self::RouteExistingRecovery => "RouteExistingRecovery",
        }
    }
}

#[derive(Debug)]
pub(crate) struct RecoveryRuntimeEntryAuthorization {
    owner_id: String,
    project_id: String,
    scope: ProvisioningScopeIdentity,
    action: RecoveryRuntimeEntryAction,
    process_generation: String,
    authorization_generation: u64,
    issued_at_monotonic_ms: i64,
    deadline_monotonic_ms: i64,
}

#[derive(Debug)]
struct ConsumedRecoveryRuntimeEntryAuthorization {
    owner_id: String,
    project_id: String,
    scope: ProvisioningScopeIdentity,
    action: RecoveryRuntimeEntryAction,
    process_generation: String,
    deadline_monotonic_ms: i64,
}

impl RecoveryRuntimeEntryAuthorization {
    pub(super) fn derive_from_confirmed(
        owner_id: String,
        project_id: String,
        scope: ProvisioningScopeIdentity,
        action: RecoveryRuntimeEntryAction,
        process_generation: String,
        authorization_generation: u64,
        issued_at_monotonic_ms: i64,
        deadline_monotonic_ms: i64,
    ) -> Self {
        Self {
            owner_id,
            project_id,
            scope,
            action,
            process_generation,
            authorization_generation,
            issued_at_monotonic_ms,
            deadline_monotonic_ms,
        }
    }

    fn consume(
        self,
        current_process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Result<ConsumedRecoveryRuntimeEntryAuthorization, RecoveryRuntimeEntryResult> {
        if self.owner_id != self.scope.owner_id
            || self.project_id.is_empty()
            || self.process_generation != current_process_generation
            || self.authorization_generation == 0
            || self.issued_at_monotonic_ms > now_monotonic_ms
            || self.deadline_monotonic_ms <= self.issued_at_monotonic_ms
        {
            return Err(RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationRequired);
        }
        if now_monotonic_ms >= self.deadline_monotonic_ms {
            return Err(RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationStale);
        }
        Ok(ConsumedRecoveryRuntimeEntryAuthorization {
            owner_id: self.owner_id,
            project_id: self.project_id,
            scope: self.scope,
            action: self.action,
            process_generation: self.process_generation,
            deadline_monotonic_ms: self.deadline_monotonic_ms,
        })
    }

    #[cfg(test)]
    pub(crate) fn mint_for_test(
        owner_id: &str,
        project_id: &str,
        scope: ProvisioningScopeIdentity,
        action: RecoveryRuntimeEntryAction,
        process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Self {
        Self {
            owner_id: owner_id.to_string(),
            project_id: project_id.to_string(),
            scope,
            action,
            process_generation: process_generation.to_string(),
            authorization_generation: 1,
            issued_at_monotonic_ms: now_monotonic_ms,
            deadline_monotonic_ms: now_monotonic_ms.saturating_add(ENTRY_AUTHORIZATION_TTL_MS),
        }
    }
}

#[derive(Debug)]
struct RecoveryNeedEvidenceCore {
    owner_id: String,
    scope: ProvisioningScopeIdentity,
    target_physical_identity_hash: String,
    inspection_fingerprint: String,
    process_generation: String,
    issued_at_monotonic_ms: i64,
    deadline_monotonic_ms: i64,
    metadata: RecoveryMetadataPrecondition,
}

#[derive(Debug)]
pub(crate) struct RootRecoveryNeedEvidence {
    core: RecoveryNeedEvidenceCore,
}

#[derive(Debug)]
pub(crate) struct SuccessorRecoveryNeedEvidence {
    core: RecoveryNeedEvidenceCore,
    predecessor: CompletedRecoveryPredecessorPrecondition,
}

struct ConsumedRecoveryNeed {
    metadata: RecoveryMetadataPrecondition,
    predecessor: Option<CompletedRecoveryPredecessorPrecondition>,
}

impl RecoveryNeedEvidenceCore {
    fn consume(
        self,
        expected_owner_id: &str,
        expected_scope: &ProvisioningScopeIdentity,
        expected_process_generation: &str,
        now_monotonic_ms: i64,
        evidence_kind: &str,
        predecessor_fingerprint: &str,
    ) -> Result<RecoveryMetadataPrecondition, RecoveryRuntimeEntryResult> {
        let expected_fingerprint = recovery_need_fingerprint(
            &self.owner_id,
            &self.scope,
            &self.target_physical_identity_hash,
            &self.metadata.metadata_fingerprint,
            evidence_kind,
            predecessor_fingerprint,
            &self.process_generation,
        );
        if self.owner_id != expected_owner_id
            || &self.scope != expected_scope
            || self.process_generation != expected_process_generation
            || self.target_physical_identity_hash.is_empty()
            || self.inspection_fingerprint != expected_fingerprint
            || self.issued_at_monotonic_ms > now_monotonic_ms
            || self.deadline_monotonic_ms <= self.issued_at_monotonic_ms
        {
            return Err(RecoveryRuntimeEntryResult::RecoveryNeedEvidenceRequired);
        }
        if now_monotonic_ms >= self.deadline_monotonic_ms {
            return Err(RecoveryRuntimeEntryResult::RecoveryNeedEvidenceStale);
        }
        Ok(self.metadata)
    }
}

impl RootRecoveryNeedEvidence {
    pub(super) fn seal_from_canonical_inspection(
        owner_id: &str,
        scope: ProvisioningScopeIdentity,
        target_physical_identity_hash: &str,
        metadata: RecoveryMetadataPrecondition,
        process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Self {
        let inspection_fingerprint = recovery_need_fingerprint(
            owner_id,
            &scope,
            target_physical_identity_hash,
            &metadata.metadata_fingerprint,
            "root",
            "",
            process_generation,
        );
        Self {
            core: RecoveryNeedEvidenceCore {
                owner_id: owner_id.to_string(),
                scope,
                target_physical_identity_hash: target_physical_identity_hash.to_string(),
                inspection_fingerprint,
                process_generation: process_generation.to_string(),
                issued_at_monotonic_ms: now_monotonic_ms,
                deadline_monotonic_ms: now_monotonic_ms.saturating_add(RECOVERY_NEED_TTL_MS),
                metadata,
            },
        }
    }
}

impl SuccessorRecoveryNeedEvidence {
    pub(super) fn seal_from_canonical_inspection(
        owner_id: &str,
        scope: ProvisioningScopeIdentity,
        target_physical_identity_hash: &str,
        metadata: RecoveryMetadataPrecondition,
        predecessor: CompletedRecoveryPredecessorPrecondition,
        process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Self {
        let inspection_fingerprint = recovery_need_fingerprint(
            owner_id,
            &scope,
            target_physical_identity_hash,
            &metadata.metadata_fingerprint,
            "successor",
            &predecessor.durable_fingerprint,
            process_generation,
        );
        Self {
            core: RecoveryNeedEvidenceCore {
                owner_id: owner_id.to_string(),
                scope,
                target_physical_identity_hash: target_physical_identity_hash.to_string(),
                inspection_fingerprint,
                process_generation: process_generation.to_string(),
                issued_at_monotonic_ms: now_monotonic_ms,
                deadline_monotonic_ms: now_monotonic_ms.saturating_add(RECOVERY_NEED_TTL_MS),
                metadata,
            },
            predecessor,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DurableRecoveryEntryClassification {
    NoOperation,
    ActiveLive,
    ActiveWithoutSafeHandle,
    RecoveryRetained,
    AbandonedEligible,
    Quarantined,
    TerminalCompleted,
    RetryRequired,
    RepairRequired,
    LifecycleDecisionRequired,
    InvestigationRequired,
}

pub(crate) struct DurableRecoveryInspection {
    pub(crate) classification: DurableRecoveryEntryClassification,
    pub(crate) leaf_operation_id: Option<String>,
    pub(crate) completed_predecessor: Option<CompletedRecoveryPredecessorPrecondition>,
}

pub(crate) enum RecoveryRuntimeEntryResult {
    RecoveryEntryAuthorizationRequired,
    RecoveryEntryAuthorizationStale,
    RecoveryEntryAuthorizationConsumed,
    RecoveryPlanningEvidenceRequired,
    RecoveryPlanningEvidenceStale,
    RecoveryNeedEvidenceRequired,
    RecoveryNeedEvidenceStale,
    RecoveryNoOperation,
    RecoveryExistingExecution,
    RecoveryRetained,
    RecoveryTakeoverRequired,
    RecoveryAuthoritativeCompleted,
    RecoveryRetryRequired,
    RecoveryRepairRequired,
    RecoveryLifecycleDecisionRequired,
    RecoveryInvestigationRequired,
    RecoveryCommittedButUnattached,
    RecoveryCommitOutcomeUnknown,
    RecoveryRepositoryBusy,
    RecoveryExecutionFoundationReady(RecoveryExecutionFoundationReady),
}

pub(crate) struct ProvisioningRecoveryRuntimeFacade {
    planning_transport: Arc<PlanningAuthorityTransportFoundation>,
    process_generation: Arc<ProcessGeneration>,
    database_provider: Arc<dyn RuntimeDatabaseProvider>,
    ownership_context: Arc<
        crate::db::manuscript_provisioning_operation_state::claim_ownership::
            ClaimOwnershipRepositoryContext,
    >,
    supervisor: Arc<RetainedOwnershipSupervisor>,
    foundation_provider: Arc<SharedExecutorFoundationProvider>,
    clock: Arc<dyn MonotonicClock>,
}

impl ProvisioningRecoveryRuntimeFacade {
    pub(super) fn new(
        planning_transport: Arc<PlanningAuthorityTransportFoundation>,
        process_generation: Arc<ProcessGeneration>,
        database_provider: Arc<dyn RuntimeDatabaseProvider>,
        ownership_context: Arc<
            crate::db::manuscript_provisioning_operation_state::claim_ownership::
                ClaimOwnershipRepositoryContext,
        >,
        supervisor: Arc<RetainedOwnershipSupervisor>,
        foundation_provider: Arc<SharedExecutorFoundationProvider>,
        clock: Arc<dyn MonotonicClock>,
    ) -> Self {
        Self {
            planning_transport,
            process_generation,
            database_provider,
            ownership_context,
            supervisor,
            foundation_provider,
            clock,
        }
    }

    pub(crate) fn classify_read_only(
        &self,
        scope: &ProvisioningScopeIdentity,
    ) -> Result<DurableRecoveryInspection, RecoveryRuntimeEntryResult> {
        self.classify(scope)
    }

    pub(crate) fn enter_root(
        &self,
        planning_evidence: PlanningAuthorityEvidence,
        authorization: RecoveryRuntimeEntryAuthorization,
        recovery_need: RootRecoveryNeedEvidence,
    ) -> RecoveryRuntimeEntryResult {
        self.enter_missing(
            planning_evidence,
            authorization,
            RecoveryNeedVariant::Root(recovery_need),
        )
    }

    pub(crate) fn enter_successor(
        &self,
        planning_evidence: PlanningAuthorityEvidence,
        authorization: RecoveryRuntimeEntryAuthorization,
        recovery_need: SuccessorRecoveryNeedEvidence,
    ) -> RecoveryRuntimeEntryResult {
        self.enter_missing(
            planning_evidence,
            authorization,
            RecoveryNeedVariant::Successor(recovery_need),
        )
    }

    fn enter_missing(
        &self,
        planning_evidence: PlanningAuthorityEvidence,
        authorization: RecoveryRuntimeEntryAuthorization,
        recovery_need: RecoveryNeedVariant,
    ) -> RecoveryRuntimeEntryResult {
        let now = self.clock.now_ms();
        let authorization = match authorization.consume(self.process_generation.canonical(), now) {
            Ok(value) => value,
            Err(result) => return result,
        };
        let planning = match planning_evidence.consume_for_recovery_runtime_entry(
            authorization.scope.owner_type.as_str(),
            &authorization.owner_id,
            &authorization.project_id,
            &authorization.process_generation,
            now,
        ) {
            Ok(value) => value,
            Err(PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired) => {
                return RecoveryRuntimeEntryResult::RecoveryPlanningEvidenceStale
            }
            Err(_) => return RecoveryRuntimeEntryResult::RecoveryPlanningEvidenceRequired,
        };
        let state = match self.classify(&authorization.scope) {
            Ok(state) => state,
            Err(result) => return result,
        };
        match (authorization.action, state.classification, recovery_need) {
            (
                RecoveryRuntimeEntryAction::InitializeRootRecovery,
                DurableRecoveryEntryClassification::NoOperation,
                RecoveryNeedVariant::Root(need),
            ) => {
                let metadata = match need.core.consume(
                    &authorization.owner_id,
                    &authorization.scope,
                    &authorization.process_generation,
                    self.clock.now_ms(),
                    "root",
                    "",
                ) {
                    Ok(metadata) => metadata,
                    Err(result) => return result,
                };
                self.initialize(
                    authorization,
                    planning,
                    ConsumedRecoveryNeed {
                        metadata,
                        predecessor: None,
                    },
                )
            }
            (
                RecoveryRuntimeEntryAction::CreateSuccessorRecovery,
                DurableRecoveryEntryClassification::TerminalCompleted,
                RecoveryNeedVariant::Successor(need),
            ) => {
                let Some(predecessor_id) = state.leaf_operation_id else {
                    return RecoveryRuntimeEntryResult::RecoveryInvestigationRequired;
                };
                if need.predecessor.operation_id != predecessor_id {
                    return RecoveryRuntimeEntryResult::RecoveryNeedEvidenceRequired;
                }
                let metadata = match need.core.consume(
                    &authorization.owner_id,
                    &authorization.scope,
                    &authorization.process_generation,
                    self.clock.now_ms(),
                    "successor",
                    &need.predecessor.durable_fingerprint,
                ) {
                    Ok(metadata) => metadata,
                    Err(result) => return result,
                };
                self.initialize(
                    authorization,
                    planning,
                    ConsumedRecoveryNeed {
                        metadata,
                        predecessor: Some(need.predecessor),
                    },
                )
            }
            _ => RecoveryRuntimeEntryResult::RecoveryInvestigationRequired,
        }
    }

    fn initialize(
        &self,
        authorization: ConsumedRecoveryRuntimeEntryAuthorization,
        planning: PlanningRecoveryEntryEvidence,
        need: ConsumedRecoveryNeed,
    ) -> RecoveryRuntimeEntryResult {
        let predecessor_operation_id = need
            .predecessor
            .as_ref()
            .map(|predecessor| predecessor.operation_id.clone());
        let request = RecoveryInitializationRequest {
            scope: authorization.scope,
            predecessor_operation_id,
            process_generation: authorization.process_generation,
            planning_challenge_id: planning.challenge_id,
            planning_repository_epoch: planning.repository_epoch,
            planning_repository_revision: planning.repository_revision,
            planning_deadline_monotonic_ms: planning.deadline_monotonic_ms,
            authorization_deadline_monotonic_ms: authorization.deadline_monotonic_ms,
            metadata: need.metadata,
            completed_predecessor: need.predecessor,
            occurred_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let mut connection = match self.database_provider.open_ownership() {
            Ok(connection) => connection,
            Err(_) => return RecoveryRuntimeEntryResult::RecoveryInvestigationRequired,
        };
        let now = || self.clock.now_ms();
        let result = if request.predecessor_operation_id.is_none() {
            initialize_canonical_root_recovery_atomically(
                &mut connection,
                &self.ownership_context,
                request,
                &now,
            )
        } else {
            create_successor_recovery_after_completed_atomically(
                &mut connection,
                &self.ownership_context,
                request,
                &now,
            )
        };
        match result {
            RecoveryInitializationResult::KnownCommitted(authority)
            | RecoveryInitializationResult::AuthoritativeExisting(authority) => {
                match self.supervisor.attach_initial_recovery_ownership(authority) {
                    InitialRecoveryOwnershipAttachmentResult::Attached(attached)
                    | InitialRecoveryOwnershipAttachmentResult::AlreadyAttached(attached) => {
                        match self.foundation_provider.resolve_attached(attached) {
                            Ok(ready) => {
                                RecoveryRuntimeEntryResult::RecoveryExecutionFoundationReady(ready)
                            }
                            Err(_) => RecoveryRuntimeEntryResult::RecoveryInvestigationRequired,
                        }
                    }
                    InitialRecoveryOwnershipAttachmentResult::CommittedButUnattached => {
                        RecoveryRuntimeEntryResult::RecoveryCommittedButUnattached
                    }
                    InitialRecoveryOwnershipAttachmentResult::CrossProcessReattachDenied
                    | InitialRecoveryOwnershipAttachmentResult::Quarantined => {
                        RecoveryRuntimeEntryResult::RecoveryInvestigationRequired
                    }
                }
            }
            RecoveryInitializationResult::AdmissionStale => {
                RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationStale
            }
            RecoveryInitializationResult::RepositoryBusy => {
                RecoveryRuntimeEntryResult::RecoveryRepositoryBusy
            }
            RecoveryInitializationResult::CommitOutcomeUnknown => {
                RecoveryRuntimeEntryResult::RecoveryCommitOutcomeUnknown
            }
            RecoveryInitializationResult::MetadataPreconditionStale => {
                RecoveryRuntimeEntryResult::RecoveryNeedEvidenceStale
            }
            RecoveryInitializationResult::KnownNotCommitted
            | RecoveryInitializationResult::IdentityConflict
            | RecoveryInitializationResult::DurableConflict
            | RecoveryInitializationResult::RepositoryUnavailable
            | RecoveryInitializationResult::InternalInvariantFailure => {
                RecoveryRuntimeEntryResult::RecoveryInvestigationRequired
            }
        }
    }

    fn classify(
        &self,
        scope: &ProvisioningScopeIdentity,
    ) -> Result<DurableRecoveryInspection, RecoveryRuntimeEntryResult> {
        let connection = self
            .database_provider
            .open_read_only()
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let mut statement = connection
            .prepare(
                "SELECT operation_id FROM manuscript_provisioning_operation_attempts AS candidate
                 WHERE owner_type=?1 AND owner_id=?2 AND scope_kind=?3
                   AND ((?4 IS NULL AND manuscript_channel IS NULL) OR manuscript_channel=?4)
                   AND NOT EXISTS (
                     SELECT 1 FROM manuscript_provisioning_operation_attempts AS child
                     WHERE child.previous_operation_id=candidate.operation_id
                   )
                 ORDER BY started_at DESC,operation_id LIMIT 2",
            )
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let leaves = statement
            .query_map(
                params![
                    scope.owner_type.as_str(),
                    scope.owner_id,
                    scope.scope_kind.as_str(),
                    scope.manuscript_channel.map(|value| value.as_str()),
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        if leaves.is_empty() {
            let claim_count = connection
                .query_row(
                    "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
                     WHERE owner_type=?1 AND owner_id=?2 AND scope_kind=?3
                       AND ((?4 IS NULL AND manuscript_channel IS NULL) OR manuscript_channel=?4)",
                    params![
                        scope.owner_type.as_str(),
                        scope.owner_id,
                        scope.scope_kind.as_str(),
                        scope.manuscript_channel.map(|value| value.as_str()),
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
            return Ok(DurableRecoveryInspection {
                classification: if claim_count == 0 {
                    DurableRecoveryEntryClassification::NoOperation
                } else {
                    DurableRecoveryEntryClassification::InvestigationRequired
                },
                leaf_operation_id: None,
                completed_predecessor: None,
            });
        }
        if leaves.len() != 1 {
            return Ok(DurableRecoveryInspection {
                classification: DurableRecoveryEntryClassification::InvestigationRequired,
                leaf_operation_id: None,
                completed_predecessor: None,
            });
        }
        let operation_id = leaves[0].clone();
        let attempt = crate::db::manuscript_provisioning_operation_state::read_operation_attempt(
            &connection,
            &operation_id,
        )
        .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?
        .ok_or(RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let claim = read_active_claim_for_operation(&connection, &operation_id)
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let plan = read_attempt_plan(&connection, &operation_id)
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let steps = read_attempt_step_progress(&connection, &operation_id)
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let scope_claim_count = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
                 WHERE owner_type=?1 AND owner_id=?2 AND scope_kind=?3
                   AND ((?4 IS NULL AND manuscript_channel IS NULL) OR manuscript_channel=?4)",
                params![
                    scope.owner_type.as_str(),
                    scope.owner_id,
                    scope.scope_kind.as_str(),
                    scope.manuscript_channel.map(|value| value.as_str()),
                ],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let projection_valid = if attempt.scope_kind == "literature-aggregate" {
            read_literature_child_projections(&connection, &operation_id).is_ok_and(|rows| {
                rows.len() == 2
                    && rows
                        .iter()
                        .all(|row| row.current_operation_id == operation_id)
            })
        } else {
            true
        };
        let outbox = read_audit_state(&connection, &operation_id)
            .map_err(|_| RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
        let outbox_valid = attempt.operation_status == "active" || outbox.is_some();
        let tuple_valid = projection_valid
            && outbox_valid
            && plan.as_ref().is_some_and(|plan| {
                plan.operation_id == attempt.operation_id
                    && plan.owner_type.as_str() == attempt.owner_type
                    && plan.owner_id == attempt.owner_id
                    && plan.scope_kind.as_str() == attempt.scope_kind
                    && plan.manuscript_channel.map(|value| value.as_str())
                        == attempt.manuscript_channel.as_deref()
                    && plan.intent.as_str() == attempt.intent
                    && plan.step_count == steps.len() as i64
            });
        if !tuple_valid {
            return Ok(DurableRecoveryInspection {
                classification: DurableRecoveryEntryClassification::InvestigationRequired,
                leaf_operation_id: Some(operation_id),
                completed_predecessor: None,
            });
        }
        let classification = match attempt.operation_status.as_str() {
            "active" => {
                let Some(claim) = claim.as_ref() else {
                    return Ok(DurableRecoveryInspection {
                        classification: DurableRecoveryEntryClassification::InvestigationRequired,
                        leaf_operation_id: Some(operation_id),
                        completed_predecessor: None,
                    });
                };
                if scope_claim_count != 1 {
                    return Ok(DurableRecoveryInspection {
                        classification: DurableRecoveryEntryClassification::InvestigationRequired,
                        leaf_operation_id: Some(operation_id),
                        completed_predecessor: None,
                    });
                }
                match self
                    .supervisor
                    .registry_lifecycle_for_claim(&claim.claim_id)
                {
                    Some(RuntimeRegistryLifecycle::Live)
                    | Some(RuntimeRegistryLifecycle::ExecutionOwned)
                    | Some(RuntimeRegistryLifecycle::RecoveryOwned) => {
                        DurableRecoveryEntryClassification::ActiveLive
                    }
                    Some(RuntimeRegistryLifecycle::Retained) => {
                        DurableRecoveryEntryClassification::RecoveryRetained
                    }
                    Some(RuntimeRegistryLifecycle::AbandonedEligible) => {
                        DurableRecoveryEntryClassification::AbandonedEligible
                    }
                    Some(RuntimeRegistryLifecycle::Quarantined)
                    | Some(RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined) => {
                        DurableRecoveryEntryClassification::Quarantined
                    }
                    _ => DurableRecoveryEntryClassification::ActiveWithoutSafeHandle,
                }
            }
            "terminal-completed"
                if claim.is_none()
                    && scope_claim_count == 0
                    && attempt.phase == "completed"
                    && attempt.result_classification.as_deref() == Some("completed")
                    && attempt.next_action.as_deref() == Some("none")
                    && attempt.final_verification_outcome == "passed" =>
            {
                DurableRecoveryEntryClassification::TerminalCompleted
            }
            "terminal-failed" | "terminal-partial"
                if attempt.result_classification.as_deref() == Some("retryable")
                    && attempt.next_action.as_deref() == Some("retry") =>
            {
                DurableRecoveryEntryClassification::RetryRequired
            }
            "terminal-failed" | "terminal-partial" | "terminal-blocked"
                if attempt.result_classification.as_deref() == Some("repair-required")
                    && attempt.next_action.as_deref() == Some("repair") =>
            {
                DurableRecoveryEntryClassification::RepairRequired
            }
            "terminal-lifecycle-required"
                if attempt.result_classification.as_deref()
                    == Some("lifecycle-decision-required")
                    && attempt.next_action.as_deref() == Some("lifecycle-decision") =>
            {
                DurableRecoveryEntryClassification::LifecycleDecisionRequired
            }
            "terminal-recovery-required"
                if attempt.result_classification.as_deref()
                    == Some("provisioning-recovery-required")
                    && attempt.next_action.as_deref() == Some("recover")
                    && claim.is_some() =>
            {
                DurableRecoveryEntryClassification::RecoveryRetained
            }
            _ => DurableRecoveryEntryClassification::InvestigationRequired,
        };
        let completed_predecessor =
            if classification == DurableRecoveryEntryClassification::TerminalCompleted {
                let plan = plan
                    .as_ref()
                    .ok_or(RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
                let outbox = outbox
                    .as_ref()
                    .ok_or(RecoveryRuntimeEntryResult::RecoveryInvestigationRequired)?;
                let root_operation_id = attempt
                    .root_operation_id
                    .clone()
                    .unwrap_or_else(|| attempt.operation_id.clone());
                Some(CompletedRecoveryPredecessorPrecondition {
                    operation_id: attempt.operation_id.clone(),
                    root_operation_id: root_operation_id.clone(),
                    attempt_revision: attempt.revision,
                    plan_id: plan.plan_id.clone(),
                    plan_identity_fingerprint: plan.plan_identity_fingerprint.clone(),
                    outbox_revision: outbox.revision,
                    durable_fingerprint: completed_predecessor_fingerprint(
                        &attempt.operation_id,
                        &root_operation_id,
                        attempt.revision,
                        &plan.plan_id,
                        &plan.plan_identity_fingerprint,
                        outbox.revision,
                    ),
                })
            } else {
                None
            };
        Ok(DurableRecoveryInspection {
            classification,
            leaf_operation_id: Some(operation_id),
            completed_predecessor,
        })
    }

    #[cfg(test)]
    pub(crate) fn dependencies_share_process_generation_for_test(&self) -> bool {
        self.planning_transport.process_generation_for_test() == self.process_generation.canonical()
            && self.ownership_context.process_generation().canonical()
                == self.process_generation.canonical()
    }
}

enum RecoveryNeedVariant {
    Root(RootRecoveryNeedEvidence),
    Successor(SuccessorRecoveryNeedEvidence),
}

fn recovery_need_fingerprint(
    owner_id: &str,
    scope: &ProvisioningScopeIdentity,
    target_physical_identity_hash: &str,
    metadata_fingerprint: &str,
    evidence_kind: &str,
    predecessor_fingerprint: &str,
    process_generation: &str,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        "labpod.recovery-need-evidence@1",
        owner_id,
        scope.owner_type.as_str(),
        scope.scope_kind.as_str(),
        scope
            .manuscript_channel
            .map(|value| value.as_str())
            .unwrap_or(""),
        target_physical_identity_hash,
        metadata_fingerprint,
        evidence_kind,
        predecessor_fingerprint,
        "missing",
        process_generation,
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manuscript_provisioning_contract::{
        DurableManuscriptChannel, DurablePlanOwnerType, DurablePlanScopeKind,
    };
    use crate::provisioning_runtime::ownership_supervisor::{
        AttachedRecoveryOwnership, RecoveryOwnershipSource,
    };
    use crate::provisioning_runtime::shared_executor::SharedExecutorFoundationProvider;

    fn scope() -> ProvisioningScopeIdentity {
        ProvisioningScopeIdentity {
            owner_type: DurablePlanOwnerType::Review,
            owner_id: "review-1".to_string(),
            scope_kind: DurablePlanScopeKind::Channel,
            manuscript_channel: Some(DurableManuscriptChannel::Primary),
        }
    }

    fn metadata() -> RecoveryMetadataPrecondition {
        RecoveryMetadataPrecondition {
            project_id: "project-1".to_string(),
            planning_authority_revision: "epoch:1".to_string(),
            owner_updated_at: None,
            owner_deleted_at: None,
            binding_id: "binding-1".to_string(),
            binding_updated_at: "binding-revision".to_string(),
            default_folder_file_ref_id: "folder-1".to_string(),
            default_folder_updated_at: "folder-revision".to_string(),
            default_folder_path_identity_key: "folder-key".to_string(),
            default_manuscript_file_ref_id: "file-1".to_string(),
            default_manuscript_updated_at: "file-revision".to_string(),
            default_manuscript_path_identity_key: "file-key".to_string(),
            current_file_ref_id: "file-1".to_string(),
            current_updated_at: "file-revision".to_string(),
            current_path_identity_key: "file-key".to_string(),
            managed_root_updated_at: "root-revision".to_string(),
            canonical_resource_identity_hash: "a".repeat(64),
            canonical_placement_identity_hash: "b".repeat(64),
            parent_shared_identity_hash: "c".repeat(64),
            initial_bytes_hash: None,
            metadata_fingerprint: "d".repeat(64),
        }
    }

    #[test]
    fn sealed_authorization_is_action_process_and_deadline_bound() {
        let authorization = RecoveryRuntimeEntryAuthorization::mint_for_test(
            "review-1",
            "project-1",
            scope(),
            RecoveryRuntimeEntryAction::InitializeRootRecovery,
            "process-1",
            10,
        );
        let consumed = match authorization.consume("process-1", 11) {
            Ok(consumed) => consumed,
            Err(_) => panic!("fresh authorization"),
        };
        assert_eq!(
            consumed.action,
            RecoveryRuntimeEntryAction::InitializeRootRecovery
        );

        let stale = RecoveryRuntimeEntryAuthorization::mint_for_test(
            "review-1",
            "project-1",
            scope(),
            RecoveryRuntimeEntryAction::RouteExistingRecovery,
            "process-1",
            10,
        );
        assert!(matches!(
            stale.consume("process-1", 10 + ENTRY_AUTHORIZATION_TTL_MS),
            Err(RecoveryRuntimeEntryResult::RecoveryEntryAuthorizationStale)
        ));
    }

    #[test]
    fn root_recovery_need_evidence_is_fingerprint_process_and_type_bound() {
        let evidence = RootRecoveryNeedEvidence::seal_from_canonical_inspection(
            "review-1",
            scope(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            metadata(),
            "process-1",
            10,
        );
        assert!(evidence
            .core
            .consume("review-1", &scope(), "process-1", 11, "root", "",)
            .is_ok());

        let stale = RootRecoveryNeedEvidence::seal_from_canonical_inspection(
            "review-1",
            scope(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            metadata(),
            "process-1",
            10,
        );
        assert!(matches!(
            stale.core.consume(
                "review-1",
                &scope(),
                "process-1",
                10 + RECOVERY_NEED_TTL_MS,
                "root",
                "",
            ),
            Err(RecoveryRuntimeEntryResult::RecoveryNeedEvidenceStale)
        ));
    }

    #[test]
    fn foundation_provider_failure_is_closed_before_adapter_or_plan_work() {
        let result = SharedExecutorFoundationProvider::unavailable_for_test().resolve_attached(
            AttachedRecoveryOwnership {
                operation_id: "operation-1".to_string(),
                claim_id: "claim-1".to_string(),
                source: RecoveryOwnershipSource::InitialRootOwnership,
            },
        );
        assert!(result.is_err());
    }
}
