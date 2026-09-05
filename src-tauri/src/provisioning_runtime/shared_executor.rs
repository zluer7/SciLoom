#![allow(dead_code)]

use super::core::ProvisioningRuntime;
use super::database_provider::RuntimeDatabaseProvider;
use super::non_completed_exit::RuntimeExecutionPermit;
use super::ownership_supervisor::{
    AttachedRecoveryOwnership, MaterializedRecoveryExecution,
    RecoveryExecutionMaterializationResult, RecoveryExecutionPlanningFacts,
    RecoveryOwnershipSource, RetainedOwnershipSupervisor,
};
use super::production_adapter_registry::{ProductionAdapterRegistry, RegisteredProductionAdapter};
use super::slot::{RecoveryExecutionRegistryAttachment, SlotCoordinator};
use crate::db::manuscript_provisioning_operation_state::claim_ownership::ClaimOwnershipRepositoryContext;
use crate::db::manuscript_provisioning_operation_state::step_progress::DurableStepProgressRow;
use crate::db::manuscript_provisioning_operation_state::{
    commit_shared_execution_step_result, mark_shared_execution_step_started,
    read_active_claim_for_operation, read_attempt_plan, read_attempt_step_progress,
    read_audit_state, read_operation_attempt, record_claim_heartbeat_with_repository_clock,
    DurableStepPlanInput, DurableStepSkeletonInput, ExecutionEffectClassification,
    ExecutionInvocationExposure, ExecutionReadbackClassification, ProgressAuthorityInput,
    SharedExecutionStepDisposition, SharedExecutionStepResultInput,
};
use crate::manuscript_provisioning_contract::{
    DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind, DurableStepKind,
    DurableStepScope,
};
use crate::owner_authority_lease::{
    AuthorityKey, AuthorityLeaseGrant, AuthorityLeaseMode, AuthorityLeaseRequest,
    OwnerAuthorityLeaseRegistry,
};
use crate::physical_freshness::{
    PhysicalFreshVerifier, PhysicalVerificationRequest, ValidatedPhysicalCondition,
};
use crate::planning_authority_transport::{PlanningAuthorityEvidence, PlanningAuthorityPurpose};
use chrono::{SecondsFormat, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use uuid::Uuid;

const ADAPTER_MANIFEST_DOMAIN: &str = "labpod.shared-executor-adapter-manifest.v1";
const PLAN_FINGERPRINT_DOMAIN: &str = "labpod.provisioning-plan-identity";
const PLAN_ID_DOMAIN: &str = "labpod.provisioning-plan-id";
const STEP_ID_DOMAIN: &str = "labpod.provisioning-step-id";
const EXECUTION_AUTHORIZATION_ID: &str = "sealed-se1-recovery-execution";
const STEP_VERSION: i64 = 1;

fn sha256(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
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

#[derive(Debug, Clone)]
pub(crate) struct AdapterContractManifest {
    adapter_id: &'static str,
    contract_version: &'static str,
    descriptor_hash: String,
    capability_fingerprint: String,
    steps: Vec<(DurableStepKind, DurableStepScope)>,
}

impl AdapterContractManifest {
    pub(crate) fn new(
        adapter_id: &'static str,
        contract_version: &'static str,
        descriptor_hash: String,
        capability_fingerprint: String,
        steps: Vec<(DurableStepKind, DurableStepScope)>,
    ) -> Option<Self> {
        if adapter_id.is_empty()
            || contract_version.is_empty()
            || descriptor_hash.len() != 64
            || capability_fingerprint.len() != 64
            || steps.is_empty()
            || steps.len() > 32
        {
            return None;
        }
        Some(Self {
            adapter_id,
            contract_version,
            descriptor_hash,
            capability_fingerprint,
            steps,
        })
    }

    pub(crate) fn canonical_hash(&self) -> String {
        let step_contract = self
            .steps
            .iter()
            .enumerate()
            .map(|(ordinal, (kind, scope))| {
                format!(
                    "{ordinal}:{}:{}:{STEP_VERSION}:1",
                    kind.as_str(),
                    scope.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join("|");
        length_prefixed_hash(
            ADAPTER_MANIFEST_DOMAIN,
            &[
                self.adapter_id,
                self.contract_version,
                &self.descriptor_hash,
                &self.capability_fingerprint,
                &step_contract,
            ],
        )
    }

    #[cfg(test)]
    pub(crate) fn step_count_for_test(&self) -> usize {
        self.steps.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdapterPreMutationFailure {
    VerifiedAbsent,
    Conflict,
    Unavailable,
    IdentityMismatch,
    ContainmentFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdapterPlanningFailure {
    LifecycleDenied,
    MetadataAuthorityIncomplete,
    ExternalMutationDenied,
    PhysicalConflict,
    PathIdentityMismatch,
    ContainmentFailed,
    ContractMismatch,
    RepositoryUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AdapterInvocationOutcome {
    Returned {
        effect: ExecutionEffectClassification,
        observed_identity_hash: String,
        resource_record_id: Option<String>,
    },
    Interrupted,
    OutcomeUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdapterReadback {
    pub classification: ExecutionReadbackClassification,
    pub observed_identity_hash: Option<String>,
    pub resource_record_id: Option<String>,
}

/// Owner-neutral typed SPI. No production Adapter implements it in SE1.
pub(crate) trait SharedExecutionAdapter {
    fn manifest(&self) -> AdapterContractManifest;
    fn validate_plan(
        &self,
        planning: &RecoveryExecutionPlanningFacts,
        project_id: &str,
    ) -> Result<(), AdapterPlanningFailure>;
    fn physical_request(
        &self,
        planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
    ) -> PhysicalVerificationRequest;
    fn pre_mutation_check(
        &mut self,
        planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
        condition: ValidatedPhysicalCondition,
    ) -> Result<ValidatedPhysicalCondition, AdapterPreMutationFailure>;
    fn invoke_once(
        &mut self,
        step_ordinal: usize,
        invocation: &mut ExecutionInvocationContext<'_>,
        condition: ValidatedPhysicalCondition,
    ) -> AdapterInvocationOutcome;
    fn bounded_authoritative_readback(
        &mut self,
        planning: &RecoveryExecutionPlanningFacts,
        step_ordinal: usize,
        invocation: &AdapterInvocationOutcome,
    ) -> AdapterReadback;
}

/// Cooperative in-apply heartbeat bridge. It does not grant mutation
/// authority: the Adapter can only inspect the issued Permit and request that
/// the Executor renew and propagate the latest durable Claim proof.
pub(crate) struct ExecutionInvocationContext<'a> {
    handle: &'a mut RecoveryExecutionHandle,
    permit: &'a mut RuntimeExecutionPermit,
    heartbeat_failed: bool,
}

impl ExecutionInvocationContext<'_> {
    pub(crate) fn permit(&self) -> &RuntimeExecutionPermit {
        self.permit
    }

    pub(crate) fn renew_claim_heartbeat(&mut self) -> Result<i64, SharedExecutionResult> {
        let expected_revision = self.permit.recovery_execution_claim_revision();
        let fresh_revision = match self.handle.renew_claim_heartbeat() {
            Ok(revision) => revision,
            Err(error) => {
                self.heartbeat_failed = true;
                return Err(error);
            }
        };
        if !self
            .permit
            .refresh_recovery_execution_claim_revision(expected_revision, fresh_revision)
        {
            self.heartbeat_failed = true;
            return Err(SharedExecutionResult::ClaimHeartbeatFailed);
        }
        Ok(fresh_revision)
    }
}

struct ExecutionPlanningLease {
    registry: Arc<OwnerAuthorityLeaseRegistry>,
    caller: String,
    grant: AuthorityLeaseGrant,
    released: bool,
}

impl ExecutionPlanningLease {
    fn validate(&self) -> bool {
        !self.released
            && self
                .registry
                .validate(&self.caller, &self.grant.token, &self.grant.requests)
                .is_ok()
    }

    fn release(&mut self) -> bool {
        if self.released {
            return true;
        }
        let released = self
            .registry
            .release(&self.caller, &self.grant.token)
            .is_ok();
        self.released = released;
        released
    }
}

impl Drop for ExecutionPlanningLease {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

pub(crate) struct SharedExecutorFoundation {
    database_provider: Arc<dyn RuntimeDatabaseProvider>,
    ownership_context: Arc<ClaimOwnershipRepositoryContext>,
    supervisor: Arc<RetainedOwnershipSupervisor>,
    registry: Arc<SlotCoordinator>,
    authority_registry: Arc<OwnerAuthorityLeaseRegistry>,
    production_adapter_registry: Option<Arc<ProductionAdapterRegistry>>,
}

pub(crate) struct SharedExecutorFoundationProvider {
    foundation: Option<Arc<SharedExecutorFoundation>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SharedExecutorFoundationUnavailable;

pub(crate) struct RecoveryExecutionFoundationReady {
    pub(crate) operation_id: String,
    pub(crate) claim_id: String,
    pub(crate) ownership_source: RecoveryOwnershipSource,
    foundation: Arc<SharedExecutorFoundation>,
}

impl RecoveryExecutionFoundationReady {
    pub(crate) fn shared_foundation(&self) -> &Arc<SharedExecutorFoundation> {
        &self.foundation
    }
}

impl SharedExecutorFoundationProvider {
    pub(crate) fn new(foundation: Arc<SharedExecutorFoundation>) -> Self {
        Self {
            foundation: Some(foundation),
        }
    }

    pub(crate) fn resolve_attached(
        &self,
        attached: AttachedRecoveryOwnership,
    ) -> Result<RecoveryExecutionFoundationReady, SharedExecutorFoundationUnavailable> {
        let foundation = self
            .foundation
            .as_ref()
            .ok_or(SharedExecutorFoundationUnavailable)?
            .clone();
        Ok(RecoveryExecutionFoundationReady {
            operation_id: attached.operation_id,
            claim_id: attached.claim_id,
            ownership_source: attached.source,
            foundation,
        })
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self { foundation: None }
    }
}

impl SharedExecutorFoundation {
    pub(super) fn new(
        database_provider: Arc<dyn RuntimeDatabaseProvider>,
        ownership_context: Arc<ClaimOwnershipRepositoryContext>,
        supervisor: Arc<RetainedOwnershipSupervisor>,
        registry: Arc<SlotCoordinator>,
        authority_registry: Arc<OwnerAuthorityLeaseRegistry>,
        production_adapter_registry: Option<Arc<ProductionAdapterRegistry>>,
    ) -> Self {
        Self {
            database_provider,
            ownership_context,
            supervisor,
            registry,
            authority_registry,
            production_adapter_registry,
        }
    }

    pub(crate) fn from_runtime(
        runtime: &ProvisioningRuntime,
        authority_registry: Arc<OwnerAuthorityLeaseRegistry>,
        production_adapter_registry: Arc<ProductionAdapterRegistry>,
    ) -> Option<Self> {
        let production = runtime.inner.production.as_ref()?;
        Some(Self::new(
            production.database_provider.clone(),
            runtime.inner.ownership_context.clone(),
            production.ownership_supervisor.clone(),
            runtime.inner.slots.clone(),
            authority_registry,
            Some(production_adapter_registry),
        ))
    }

    #[cfg(test)]
    pub(crate) fn from_runtime_for_test(
        runtime: &ProvisioningRuntime,
        authority_registry: Arc<OwnerAuthorityLeaseRegistry>,
    ) -> Option<Self> {
        let production = runtime.inner.production.as_ref()?;
        Some(Self::new(
            production.database_provider.clone(),
            runtime.inner.ownership_context.clone(),
            production.ownership_supervisor.clone(),
            runtime.inner.slots.clone(),
            authority_registry,
            None,
        ))
    }

    #[cfg(test)]
    pub(crate) fn materialize_recovery_execution<A: SharedExecutionAdapter>(
        &self,
        recovery_claim_id: &str,
        project_id: &str,
        actual_caller: &str,
        request_id: &str,
        adapter: &A,
    ) -> Result<RecoveryExecutionHandle, SharedExecutionResult> {
        self.materialize_recovery_execution_inner(
            recovery_claim_id,
            project_id,
            actual_caller,
            request_id,
            adapter,
        )
    }

    fn materialize_recovery_execution_inner<A: SharedExecutionAdapter + ?Sized>(
        &self,
        recovery_claim_id: &str,
        project_id: &str,
        actual_caller: &str,
        request_id: &str,
        adapter: &A,
    ) -> Result<RecoveryExecutionHandle, SharedExecutionResult> {
        let planning = self
            .supervisor
            .inspect_recovery_execution_planning_facts(recovery_claim_id)
            .ok_or(SharedExecutionResult::RecoveryAuthorityUnavailable)?;
        let lease_requests = vec![
            AuthorityLeaseRequest {
                key: AuthorityKey::ManagedRoot,
                mode: AuthorityLeaseMode::Read,
            },
            AuthorityLeaseRequest {
                key: AuthorityKey::Project {
                    project_id: project_id.to_string(),
                },
                mode: AuthorityLeaseMode::Read,
            },
            AuthorityLeaseRequest {
                key: AuthorityKey::Owner {
                    owner_type: planning.owner_type.clone(),
                    owner_id: planning.owner_id.clone(),
                },
                mode: AuthorityLeaseMode::Read,
            },
            AuthorityLeaseRequest {
                key: AuthorityKey::ChannelScope {
                    owner_type: planning.owner_type.clone(),
                    owner_id: planning.owner_id.clone(),
                    scope: format!(
                        "{}:{}",
                        planning.scope_kind,
                        planning.manuscript_channel.as_deref().unwrap_or("")
                    ),
                },
                mode: AuthorityLeaseMode::Write,
            },
        ];
        let grant = self
            .authority_registry
            .try_acquire_many(actual_caller, request_id, lease_requests)
            .map_err(|_| SharedExecutionResult::PlanningLeaseUnavailable)?;
        let mut planning_lease = ExecutionPlanningLease {
            registry: self.authority_registry.clone(),
            caller: actual_caller.to_string(),
            grant,
            released: false,
        };
        if !planning_lease.validate() {
            return Err(SharedExecutionResult::PlanningLeaseStale);
        }
        adapter
            .validate_plan(&planning, project_id)
            .map_err(|_| SharedExecutionResult::AdapterPlanningRejected)?;
        let manifest = adapter.manifest();
        let manifest_hash = manifest.canonical_hash();
        let execution_operation_id = Uuid::new_v4().to_string();
        let execution_claim_id = Uuid::new_v4().to_string();
        let (plan, steps) = build_executable_plan(
            &planning,
            &manifest,
            &manifest_hash,
            &execution_operation_id,
        )?;
        let occurred_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let MaterializedRecoveryExecution {
            proof,
            registry_attachment,
        } = self
            .supervisor
            .materialize_recovery_execution(
                recovery_claim_id,
                execution_operation_id,
                execution_claim_id,
                plan,
                steps,
                occurred_at,
            )
            .map_err(|result| match result {
                RecoveryExecutionMaterializationResult::AuthorityUnavailable => {
                    SharedExecutionResult::RecoveryAuthorityUnavailable
                }
                RecoveryExecutionMaterializationResult::KnownNotCommitted => {
                    SharedExecutionResult::KnownNotCommitted
                }
                RecoveryExecutionMaterializationResult::Quarantined => {
                    SharedExecutionResult::Quarantined
                }
            })?;
        if proof.execution_adapter_manifest_hash() != manifest_hash {
            let _ = self
                .registry
                .quarantine_recovery_execution(&registry_attachment);
            let _ = planning_lease.release();
            return Err(SharedExecutionResult::AdapterContractMismatch);
        }
        let adapter_step_offset = planning.adapter_step_offset;
        Ok(RecoveryExecutionHandle {
            database_provider: self.database_provider.clone(),
            ownership_context: self.ownership_context.clone(),
            registry: self.registry.clone(),
            planning,
            planning_lease,
            proof,
            registry_attachment,
            adapter_manifest_hash: manifest_hash,
            adapter_step_offset,
            next_step_ordinal: 0,
            closed: false,
            #[cfg(test)]
            force_not_invoked_once: false,
            #[cfg(test)]
            force_result_response_loss_once: false,
        })
    }

    pub(crate) fn materialize_registered_recovery(
        &self,
        ready: RecoveryExecutionFoundationReady,
        project_id: &str,
        process_generation: &str,
        request_id: &str,
        planning_evidence: PlanningAuthorityEvidence,
        now_monotonic_ms: i64,
        mut adapter: RegisteredProductionAdapter,
    ) -> Result<RegisteredRecoveryExecution, SharedExecutionResult> {
        let registry = self
            .production_adapter_registry
            .as_ref()
            .ok_or(SharedExecutionResult::AdapterContractMismatch)?
            .clone();
        let planning = match self
            .supervisor
            .inspect_recovery_execution_planning_facts(&ready.claim_id)
        {
            Some(planning) => planning,
            None => return Err(SharedExecutionResult::RecoveryAuthorityUnavailable),
        };
        planning_evidence
            .consume_for_phase(
                &planning.owner_type,
                &planning.owner_id,
                project_id,
                process_generation,
                PlanningAuthorityPurpose::PlanMaterialization,
                now_monotonic_ms,
            )
            .map_err(|_| SharedExecutionResult::PlanningLeaseStale)?;
        let execution_adapter = registry
            .admit_execution(&mut adapter)
            .map_err(|_| SharedExecutionResult::AdapterContractMismatch)?;
        let actual_caller = format!(
            "canonical-recovery-application-orchestration:{}",
            planning.owner_type
        );
        let handle = self.materialize_recovery_execution_inner(
            &ready.claim_id,
            project_id,
            &actual_caller,
            request_id,
            execution_adapter,
        )?;
        Ok(RegisteredRecoveryExecution {
            handle,
            adapter,
            registry,
            owner_id: planning.owner_id,
            owner_type: planning.owner_type,
            project_id: project_id.to_string(),
            process_generation: process_generation.to_string(),
        })
    }
}

fn build_executable_plan(
    planning: &RecoveryExecutionPlanningFacts,
    manifest: &AdapterContractManifest,
    manifest_hash: &str,
    operation_id: &str,
) -> Result<(DurableStepPlanInput, Vec<DurableStepSkeletonInput>), SharedExecutionResult> {
    let owner_type = planning
        .owner_type
        .parse::<DurablePlanOwnerType>()
        .map_err(|_| SharedExecutionResult::AdapterContractMismatch)?;
    let scope_kind = planning
        .scope_kind
        .parse::<DurablePlanScopeKind>()
        .map_err(|_| SharedExecutionResult::AdapterContractMismatch)?;
    let channel = planning.manuscript_channel.as_deref();
    if planning.adapter_step_offset >= manifest.steps.len() {
        return Err(SharedExecutionResult::RecoveryAuthorityUnavailable);
    }
    let executable_manifest_steps = manifest
        .steps
        .iter()
        .skip(planning.adapter_step_offset)
        .collect::<Vec<_>>();
    let steps_json = executable_manifest_steps
        .iter()
        .enumerate()
        .map(|(ordinal, (kind, scope))| {
            json!({
                "kind": kind.as_str(),
                "ordinal": ordinal,
                "scope": scope.as_str(),
                "version": STEP_VERSION,
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "authorizationId": EXECUTION_AUTHORIZATION_ID,
        "canonicalPlacementIdentityHash": planning.canonical_placement_identity_hash,
        "canonicalResourceIdentityHash": planning.canonical_resource_identity_hash,
        "descriptorKey": manifest.adapter_id,
        "domain": PLAN_FINGERPRINT_DOMAIN,
        "intent": DurablePlanIntent::Recover.as_str(),
        "manuscriptChannel": channel,
        "operationId": operation_id,
        "ownerId": planning.owner_id,
        "ownerType": owner_type.as_str(),
        "parentSharedIdentityHash": planning.parent_shared_identity_hash,
        "planTemplateKind": planning.plan_template_kind.as_str(),
        "planVersion": 1,
        "plannerVersion": manifest_hash,
        "predecessorExpectedRevision": planning.recovery_attempt_revision,
        "predecessorOperationId": planning.recovery_operation_id,
        "scopeKind": scope_kind.as_str(),
        "steps": steps_json,
    });
    let canonical = serde_json::to_string(&payload)
        .map_err(|_| SharedExecutionResult::InternalInvariantFailure)?;
    let plan_fingerprint = sha256(canonical);
    let plan_id = sha256(format!(
        "{PLAN_ID_DOMAIN}\n{operation_id}\n{plan_fingerprint}"
    ));
    let precondition_hash = length_prefixed_hash(
        "labpod.shared-executor-durable-precondition.v1",
        &[
            &planning.recovery_operation_id,
            &planning.recovery_attempt_revision.to_string(),
            &planning.canonical_resource_identity_hash,
            &planning.canonical_placement_identity_hash,
            manifest_hash,
        ],
    );
    let steps = executable_manifest_steps
        .iter()
        .enumerate()
        .map(|(ordinal, (kind, scope))| DurableStepSkeletonInput {
            step_id: sha256(format!(
                "{STEP_ID_DOMAIN}\n{plan_id}\n{ordinal}\n{}\n{}",
                kind.as_str(),
                scope.as_str()
            )),
            step_ordinal: ordinal as i64,
            step_kind: *kind,
            step_scope: *scope,
            step_version: STEP_VERSION,
        })
        .collect::<Vec<_>>();
    Ok((
        DurableStepPlanInput {
            plan_id,
            plan_version: 1,
            plan_template_kind: planning.plan_template_kind,
            plan_identity_fingerprint: plan_fingerprint,
            precondition_snapshot_hash: precondition_hash,
            fingerprint_profile: planning.fingerprint_profile,
            canonical_resource_identity_hash: planning.canonical_resource_identity_hash.clone(),
            canonical_placement_identity_hash: planning.canonical_placement_identity_hash.clone(),
            parent_shared_identity_hash: planning.parent_shared_identity_hash.clone(),
            declared_step_count: steps.len() as i64,
            planner_version: manifest_hash.to_string(),
        },
        steps,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SharedExecutionResult {
    StepConverged,
    Completed,
    RecoveryRequired,
    RecoveryAuthorityUnavailable,
    PlanningLeaseUnavailable,
    PlanningLeaseStale,
    ClaimHeartbeatFailed,
    StepCheckoutConflict,
    PermitIssueFailed,
    PhysicalVerificationFailed,
    AdapterPlanningRejected,
    AdapterPreMutationRejected,
    AdapterContractMismatch,
    DurableAuthorityStale,
    KnownNotCommitted,
    Quarantined,
    InternalInvariantFailure,
}

pub(crate) struct RecoveryExecutionHandle {
    database_provider: Arc<dyn RuntimeDatabaseProvider>,
    ownership_context: Arc<ClaimOwnershipRepositoryContext>,
    registry: Arc<SlotCoordinator>,
    planning: RecoveryExecutionPlanningFacts,
    planning_lease: ExecutionPlanningLease,
    proof: crate::db::manuscript_provisioning_operation_state::RecoveryExecutionOwnershipProof,
    registry_attachment: RecoveryExecutionRegistryAttachment,
    adapter_manifest_hash: String,
    adapter_step_offset: usize,
    next_step_ordinal: usize,
    closed: bool,
    #[cfg(test)]
    force_not_invoked_once: bool,
    #[cfg(test)]
    force_result_response_loss_once: bool,
}

pub(crate) struct RegisteredRecoveryExecution {
    handle: RecoveryExecutionHandle,
    adapter: RegisteredProductionAdapter,
    registry: Arc<ProductionAdapterRegistry>,
    owner_id: String,
    owner_type: String,
    project_id: String,
    process_generation: String,
}

impl RegisteredRecoveryExecution {
    pub(crate) fn execute_next_step(
        &mut self,
        planning_evidence: PlanningAuthorityEvidence,
        now_monotonic_ms: i64,
    ) -> SharedExecutionResult {
        if planning_evidence
            .consume_for_phase(
                &self.owner_type,
                &self.owner_id,
                &self.project_id,
                &self.process_generation,
                PlanningAuthorityPurpose::MutationPoint,
                now_monotonic_ms,
            )
            .is_err()
        {
            return SharedExecutionResult::PlanningLeaseStale;
        }
        let adapter = match self.registry.admit_execution(&mut self.adapter) {
            Ok(adapter) => adapter,
            Err(_) => return SharedExecutionResult::AdapterContractMismatch,
        };
        self.handle.execute_next_step_inner(adapter)
    }
}

impl Drop for RecoveryExecutionHandle {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self
                .registry
                .quarantine_recovery_execution(&self.registry_attachment);
        }
        let _ = self.planning_lease.release();
    }
}

impl RecoveryExecutionHandle {
    fn validate_planning(&self) -> Result<(), SharedExecutionResult> {
        self.planning_lease
            .validate()
            .then_some(())
            .ok_or(SharedExecutionResult::PlanningLeaseStale)
    }

    fn renew_claim_heartbeat(&mut self) -> Result<i64, SharedExecutionResult> {
        self.validate_planning()?;
        let connection = self
            .database_provider
            .open_read_only()
            .map_err(|_| SharedExecutionResult::ClaimHeartbeatFailed)?;
        let claim =
            read_active_claim_for_operation(&connection, self.proof.execution_operation_id())
                .map_err(|_| SharedExecutionResult::ClaimHeartbeatFailed)?
                .ok_or(SharedExecutionResult::ClaimHeartbeatFailed)?;
        let expected_revision = claim.claim_revision;
        let proof = self
            .ownership_context
            .create_proof_from_fresh_claim(claim, self.registry_attachment.registry_generation())
            .map_err(|_| SharedExecutionResult::ClaimHeartbeatFailed)?;
        let snapshot = proof.sealed_snapshot();
        let mut write = self
            .database_provider
            .open_ownership()
            .map_err(|_| SharedExecutionResult::ClaimHeartbeatFailed)?;
        record_claim_heartbeat_with_repository_clock(
            &mut write,
            &self.ownership_context,
            &snapshot,
        )
        .map_err(|_| SharedExecutionResult::ClaimHeartbeatFailed)?;
        drop(write);
        let fresh = self
            .database_provider
            .open_read_only()
            .ok()
            .and_then(|connection| {
                read_active_claim_for_operation(&connection, self.proof.execution_operation_id())
                    .ok()
                    .flatten()
            })
            .ok_or(SharedExecutionResult::ClaimHeartbeatFailed)?;
        let fresh_revision = fresh.claim_revision;
        let fresh_proof = self
            .ownership_context
            .create_proof_from_fresh_claim(fresh, self.registry_attachment.registry_generation())
            .map_err(|_| SharedExecutionResult::ClaimHeartbeatFailed)?;
        if !self.registry.replace_recovery_execution_claim_proof(
            &self.registry_attachment,
            expected_revision,
            fresh_proof,
        ) {
            return Err(SharedExecutionResult::ClaimHeartbeatFailed);
        }
        Ok(fresh_revision)
    }

    #[cfg(test)]
    pub(crate) fn execute_next_step<A: SharedExecutionAdapter>(
        &mut self,
        adapter: &mut A,
    ) -> SharedExecutionResult {
        self.execute_next_step_inner(adapter)
    }

    fn execute_next_step_inner<A: SharedExecutionAdapter + ?Sized>(
        &mut self,
        adapter: &mut A,
    ) -> SharedExecutionResult {
        if self.closed || self.next_step_ordinal >= self.proof.execution_step_count() as usize {
            return SharedExecutionResult::DurableAuthorityStale;
        }
        if adapter.manifest().canonical_hash() != self.adapter_manifest_hash {
            return SharedExecutionResult::AdapterContractMismatch;
        }
        let adapter_step_ordinal = self.adapter_step_offset + self.next_step_ordinal;
        if let Err(result) = self.renew_claim_heartbeat() {
            let _ = self
                .registry
                .quarantine_recovery_execution(&self.registry_attachment);
            return result;
        }
        if self.validate_planning().is_err()
            || !self
                .registry
                .checkout_recovery_execution_step(&self.registry_attachment)
        {
            return SharedExecutionResult::StepCheckoutConflict;
        }
        let (_, intended_step) = match self.inspect_current_step() {
            Ok(result) => result,
            Err(result) => {
                let _ = self
                    .registry
                    .restore_recovery_execution_step(&self.registry_attachment);
                return result;
            }
        };
        if self.validate_planning().is_err() {
            let _ = self
                .registry
                .restore_recovery_execution_step(&self.registry_attachment);
            return SharedExecutionResult::PlanningLeaseStale;
        }
        let condition = match PhysicalFreshVerifier::verify(
            adapter.physical_request(&self.planning, adapter_step_ordinal),
        ) {
            Ok(condition) => condition,
            Err(_) => {
                let _ = self
                    .registry
                    .restore_recovery_execution_step(&self.registry_attachment);
                return SharedExecutionResult::PhysicalVerificationFailed;
            }
        };
        let condition =
            match adapter.pre_mutation_check(&self.planning, adapter_step_ordinal, condition) {
                Ok(condition) => condition,
                Err(_) => {
                    let _ = self
                        .registry
                        .restore_recovery_execution_step(&self.registry_attachment);
                    return SharedExecutionResult::AdapterPreMutationRejected;
                }
            };
        if self.validate_planning().is_err() {
            let _ = self
                .registry
                .restore_recovery_execution_step(&self.registry_attachment);
            return SharedExecutionResult::PlanningLeaseStale;
        }
        let claim_revision = match self.renew_claim_heartbeat() {
            Ok(revision) => revision,
            Err(result) => {
                let _ = self
                    .registry
                    .quarantine_recovery_execution(&self.registry_attachment);
                return result;
            }
        };
        let occurred_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let (attempt_revision, step) =
            match self.start_step(claim_revision, &intended_step, &occurred_at) {
                Ok(result) => result,
                Err(result) => {
                    let _ = self
                        .registry
                        .restore_recovery_execution_step(&self.registry_attachment);
                    return result;
                }
            };
        let mut permit = RuntimeExecutionPermit::seal_recovery_execution(
            self.proof.execution_operation_id().to_string(),
            self.proof.execution_claim_id().to_string(),
            claim_revision,
            self.proof.execution_plan_id().to_string(),
            self.proof.execution_plan_identity_fingerprint().to_string(),
            step.step_id.clone(),
            step.progress_revision,
            self.registry_attachment.runtime_instance_id().to_string(),
            self.registry_attachment.registry_generation(),
            self.registry_attachment.execution_generation(),
        );
        if !permit.matches_recovery_execution(
            self.proof.execution_operation_id(),
            self.proof.execution_claim_id(),
            claim_revision,
            self.proof.execution_plan_id(),
            self.proof.execution_plan_identity_fingerprint(),
            &step.step_id,
            step.progress_revision,
            self.registry_attachment.runtime_instance_id(),
            self.registry_attachment.registry_generation(),
            self.registry_attachment.execution_generation(),
        ) {
            return self.finish_non_completed(
                permit,
                attempt_revision,
                claim_revision,
                &step.step_id,
                step.progress_revision,
                ExecutionInvocationExposure::InvocationOutcomeUnknown,
                ExecutionReadbackClassification::Unavailable,
                None,
                None,
                None,
            );
        }
        #[cfg(test)]
        if std::mem::take(&mut self.force_not_invoked_once) {
            let _ = permit.seal_not_invoked();
            let invocation = AdapterInvocationOutcome::OutcomeUnknown;
            let readback = adapter.bounded_authoritative_readback(
                &self.planning,
                adapter_step_ordinal,
                &invocation,
            );
            return self.finish_non_completed(
                permit,
                attempt_revision,
                claim_revision,
                &step.step_id,
                step.progress_revision,
                ExecutionInvocationExposure::NotInvoked,
                readback.classification,
                None,
                readback.observed_identity_hash,
                readback.resource_record_id,
            );
        }
        let step_ordinal = adapter_step_ordinal;
        let (invocation, heartbeat_failed) = {
            let mut context = ExecutionInvocationContext {
                handle: self,
                permit: &mut permit,
                heartbeat_failed: false,
            };
            let invocation = catch_unwind(AssertUnwindSafe(|| {
                adapter.invoke_once(step_ordinal, &mut context, condition)
            }))
            .unwrap_or(AdapterInvocationOutcome::Interrupted);
            (invocation, context.heartbeat_failed)
        };
        let claim_revision = permit.recovery_execution_claim_revision();
        let exposure = match invocation {
            AdapterInvocationOutcome::Returned { .. } if permit.seal_invocation_returned() => {
                ExecutionInvocationExposure::InvocationReturned
            }
            AdapterInvocationOutcome::Interrupted => {
                ExecutionInvocationExposure::InvocationInterrupted
            }
            AdapterInvocationOutcome::OutcomeUnknown => {
                ExecutionInvocationExposure::InvocationOutcomeUnknown
            }
            AdapterInvocationOutcome::Returned { .. } => {
                ExecutionInvocationExposure::InvocationOutcomeUnknown
            }
        };
        let readback = catch_unwind(AssertUnwindSafe(|| {
            adapter.bounded_authoritative_readback(
                &self.planning,
                adapter_step_ordinal,
                &invocation,
            )
        }))
        .unwrap_or(AdapterReadback {
            classification: ExecutionReadbackClassification::Unavailable,
            observed_identity_hash: None,
            resource_record_id: None,
        });
        let (effect, invocation_identity, invocation_resource) = match invocation {
            AdapterInvocationOutcome::Returned {
                effect,
                observed_identity_hash,
                resource_record_id,
            } => (
                Some(effect),
                Some(observed_identity_hash),
                resource_record_id,
            ),
            AdapterInvocationOutcome::Interrupted | AdapterInvocationOutcome::OutcomeUnknown => {
                (None, None, None)
            }
        };
        self.finish_non_completed(
            permit,
            attempt_revision,
            claim_revision,
            &step.step_id,
            step.progress_revision,
            if heartbeat_failed {
                ExecutionInvocationExposure::InvocationOutcomeUnknown
            } else {
                exposure
            },
            readback.classification,
            if heartbeat_failed { None } else { effect },
            readback.observed_identity_hash.or(invocation_identity),
            readback.resource_record_id.or(invocation_resource),
        )
    }

    fn inspect_current_step(&self) -> Result<(i64, DurableStepProgressRow), SharedExecutionResult> {
        self.validate_planning()?;
        let connection = self
            .database_provider
            .open_read_only()
            .map_err(|_| SharedExecutionResult::DurableAuthorityStale)?;
        let attempt = read_operation_attempt(&connection, self.proof.execution_operation_id())
            .map_err(|_| SharedExecutionResult::DurableAuthorityStale)?
            .ok_or(SharedExecutionResult::DurableAuthorityStale)?;
        let plan = read_attempt_plan(&connection, self.proof.execution_operation_id())
            .map_err(|_| SharedExecutionResult::DurableAuthorityStale)?
            .ok_or(SharedExecutionResult::DurableAuthorityStale)?;
        let steps = read_attempt_step_progress(&connection, self.proof.execution_operation_id())
            .map_err(|_| SharedExecutionResult::DurableAuthorityStale)?;
        let step = steps
            .get(self.next_step_ordinal)
            .ok_or(SharedExecutionResult::DurableAuthorityStale)?;
        if attempt.operation_status != "active"
            || plan.plan_id != self.proof.execution_plan_id()
            || plan.plan_identity_fingerprint != self.proof.execution_plan_identity_fingerprint()
            || plan.planner_version != self.adapter_manifest_hash
            || step.boundary.as_str() != "intended"
        {
            return Err(SharedExecutionResult::DurableAuthorityStale);
        }
        Ok((attempt.revision, step.clone()))
    }

    fn start_step(
        &self,
        claim_revision: i64,
        intended_step: &DurableStepProgressRow,
        occurred_at: &str,
    ) -> Result<(i64, DurableStepProgressRow), SharedExecutionResult> {
        self.validate_planning()?;
        let connection = self
            .database_provider
            .open_read_only()
            .map_err(|_| SharedExecutionResult::DurableAuthorityStale)?;
        let attempt = read_operation_attempt(&connection, self.proof.execution_operation_id())
            .map_err(|_| SharedExecutionResult::DurableAuthorityStale)?
            .ok_or(SharedExecutionResult::DurableAuthorityStale)?;
        let authority = ProgressAuthorityInput {
            operation_id: attempt.operation_id,
            plan_id: self.proof.execution_plan_id().to_string(),
            step_id: intended_step.step_id.clone(),
            claim_id: self.proof.execution_claim_id().to_string(),
            claim_owner_token: self.proof.execution_claim_owner_token().to_string(),
            expected_progress_revision: intended_step.progress_revision,
            occurred_at: occurred_at.to_string(),
        };
        drop(connection);
        let mut write = self
            .database_provider
            .open_ownership()
            .map_err(|_| SharedExecutionResult::PermitIssueFailed)?;
        let result = mark_shared_execution_step_started(&mut write, &authority, claim_revision)
            .map_err(|_| SharedExecutionResult::PermitIssueFailed)?;
        Ok((attempt.revision, result.step))
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_non_completed(
        &mut self,
        permit: RuntimeExecutionPermit,
        attempt_revision: i64,
        claim_revision: i64,
        step_id: &str,
        progress_revision: i64,
        invocation_exposure: ExecutionInvocationExposure,
        readback: ExecutionReadbackClassification,
        effect: Option<ExecutionEffectClassification>,
        observed_identity_hash: Option<String>,
        resource_record_id: Option<String>,
    ) -> SharedExecutionResult {
        if !permit.bindings_match_recovery_execution(
            self.proof.execution_operation_id(),
            self.proof.execution_claim_id(),
            claim_revision,
            self.proof.execution_plan_id(),
            self.proof.execution_plan_identity_fingerprint(),
            step_id,
            progress_revision,
            self.registry_attachment.runtime_instance_id(),
            self.registry_attachment.registry_generation(),
            self.registry_attachment.execution_generation(),
        ) {
            let _ = self
                .registry
                .quarantine_recovery_execution(&self.registry_attachment);
            return SharedExecutionResult::Quarantined;
        }
        if self.validate_planning().is_err() {
            let _ = self
                .registry
                .quarantine_recovery_execution(&self.registry_attachment);
            return SharedExecutionResult::PlanningLeaseStale;
        }
        let input = SharedExecutionStepResultInput {
            operation_id: self.proof.execution_operation_id().to_string(),
            expected_attempt_revision: attempt_revision,
            claim_id: self.proof.execution_claim_id().to_string(),
            claim_owner_token: self.proof.execution_claim_owner_token().to_string(),
            expected_claim_revision: claim_revision,
            plan_id: self.proof.execution_plan_id().to_string(),
            plan_identity_fingerprint: self.proof.execution_plan_identity_fingerprint().to_string(),
            adapter_manifest_hash: self.adapter_manifest_hash.clone(),
            step_id: step_id.to_string(),
            expected_progress_revision: progress_revision,
            invocation_exposure,
            readback,
            effect,
            observed_identity_hash,
            resource_record_id,
            occurred_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            #[cfg(test)]
            simulate_response_lost_after_commit: std::mem::take(
                &mut self.force_result_response_loss_once,
            ),
        };
        let mut connection = match self.database_provider.open_ownership() {
            Ok(connection) => connection,
            Err(_) => {
                let _ = self
                    .registry
                    .quarantine_recovery_execution(&self.registry_attachment);
                return SharedExecutionResult::Quarantined;
            }
        };
        let disposition = match commit_shared_execution_step_result(&mut connection, &input) {
            Ok(result) => result.disposition,
            Err(_error) => {
                #[cfg(test)]
                eprintln!(
                    "SE1 result writer failed: {} {}",
                    _error.code, _error.message
                );
                match self.reconcile_committed_disposition(step_id) {
                    Some(disposition) => disposition,
                    None => {
                        let _ = self
                            .registry
                            .quarantine_recovery_execution(&self.registry_attachment);
                        return SharedExecutionResult::Quarantined;
                    }
                }
            }
        };
        drop(connection);
        let post_commit_valid = self
            .database_provider
            .open_read_only()
            .ok()
            .and_then(|connection| {
                let attempt =
                    read_operation_attempt(&connection, self.proof.execution_operation_id())
                        .ok()
                        .flatten()?;
                let claim = read_active_claim_for_operation(
                    &connection,
                    self.proof.execution_operation_id(),
                )
                .ok()?;
                let step =
                    read_attempt_step_progress(&connection, self.proof.execution_operation_id())
                        .ok()?
                        .into_iter()
                        .find(|candidate| candidate.step_id == step_id)?;
                let outbox =
                    read_audit_state(&connection, self.proof.execution_operation_id()).ok()?;
                Some(match disposition {
                    SharedExecutionStepDisposition::ExecutionContinues => {
                        attempt.operation_status == "active"
                            && claim.is_some()
                            && step.boundary.as_str() == "converged"
                            && outbox.is_none()
                    }
                    SharedExecutionStepDisposition::CompletedAndReleased => {
                        attempt.operation_status == "terminal-completed"
                            && claim.is_none()
                            && step.boundary.as_str() == "converged"
                            && outbox.is_some()
                    }
                    SharedExecutionStepDisposition::RecoveryRequiredAndRetained => {
                        attempt.operation_status == "terminal-recovery-required"
                            && claim.is_some()
                            && step.boundary.as_str() == "started"
                            && outbox.is_some()
                    }
                })
            })
            .unwrap_or(false);
        if !post_commit_valid {
            let _ = self
                .registry
                .quarantine_recovery_execution(&self.registry_attachment);
            return SharedExecutionResult::Quarantined;
        }
        drop(permit);
        match disposition {
            SharedExecutionStepDisposition::ExecutionContinues => {
                self.next_step_ordinal += 1;
                if self
                    .registry
                    .restore_recovery_execution_step(&self.registry_attachment)
                {
                    SharedExecutionResult::StepConverged
                } else {
                    SharedExecutionResult::Quarantined
                }
            }
            SharedExecutionStepDisposition::CompletedAndReleased => {
                self.closed = self
                    .registry
                    .close_recovery_execution(&self.registry_attachment);
                let lease_released = self.planning_lease.release();
                if self.closed && lease_released {
                    SharedExecutionResult::Completed
                } else {
                    SharedExecutionResult::Quarantined
                }
            }
            SharedExecutionStepDisposition::RecoveryRequiredAndRetained => {
                self.closed = self
                    .registry
                    .retain_recovery_execution(&self.registry_attachment);
                let lease_released = self.planning_lease.release();
                if self.closed && lease_released {
                    SharedExecutionResult::RecoveryRequired
                } else {
                    SharedExecutionResult::Quarantined
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn operation_id_for_test(&self) -> &str {
        self.proof.execution_operation_id()
    }

    #[cfg(test)]
    pub(crate) fn adapter_manifest_hash_for_test(&self) -> &str {
        &self.adapter_manifest_hash
    }

    #[cfg(test)]
    pub(crate) fn recovery_operation_id_for_test(&self) -> &str {
        self.proof.recovery_operation_id()
    }

    #[cfg(test)]
    pub(crate) fn force_not_invoked_once_for_test(&mut self) {
        self.force_not_invoked_once = true;
    }

    #[cfg(test)]
    pub(crate) fn force_result_response_loss_once_for_test(&mut self) {
        self.force_result_response_loss_once = true;
    }

    fn reconcile_committed_disposition(
        &self,
        step_id: &str,
    ) -> Option<SharedExecutionStepDisposition> {
        let connection = self.database_provider.open_read_only().ok()?;
        let attempt =
            read_operation_attempt(&connection, self.proof.execution_operation_id()).ok()??;
        let claim =
            read_active_claim_for_operation(&connection, self.proof.execution_operation_id())
                .ok()?;
        let step = read_attempt_step_progress(&connection, self.proof.execution_operation_id())
            .ok()?
            .into_iter()
            .find(|candidate| candidate.step_id == step_id)?;
        let outbox = read_audit_state(&connection, self.proof.execution_operation_id()).ok()?;
        if attempt.operation_status == "terminal-completed"
            && claim.is_none()
            && step.boundary.as_str() == "converged"
            && outbox.is_some()
        {
            Some(SharedExecutionStepDisposition::CompletedAndReleased)
        } else if attempt.operation_status == "active"
            && claim.is_some()
            && step.boundary.as_str() == "converged"
            && outbox.is_none()
        {
            Some(SharedExecutionStepDisposition::ExecutionContinues)
        } else if attempt.operation_status == "terminal-recovery-required"
            && claim.is_some()
            && step.boundary.as_str() == "started"
            && outbox.is_some()
        {
            Some(SharedExecutionStepDisposition::RecoveryRequiredAndRetained)
        } else {
            None
        }
    }
}
