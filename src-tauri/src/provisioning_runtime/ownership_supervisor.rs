use super::core::RuntimeResource;
use super::database_provider::RuntimeDatabaseProvider;
use super::heartbeat_scheduler::MonotonicClock;
use super::literature_gate::LiteratureScope;
use super::slot::{
    ClaimOwnershipCheckout, ClaimOwnershipCheckoutAction, RecoveryExecutionRegistryAttachment,
    ResourceKey, RuntimeRegistryLifecycle, SlotCoordinator,
};
use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
    derive_claim_expiry_epoch_ms, ClaimOwnershipRepositoryContext,
};
use crate::db::manuscript_provisioning_operation_state::step_progress::PlanFingerprintProfile;
use crate::db::manuscript_provisioning_operation_state::{
    discover_unrepresented_durable_claims, inspect_durable_claim, read_active_claim_for_operation,
    read_attempt_plan, read_initial_recovery_ownership_proof, read_operation_attempt,
    read_recovery_execution_ownership_proof, read_recovery_ownership_proof,
    record_claim_heartbeat_with_repository_clock,
    record_retained_claim_heartbeat_with_repository_clock, replace_abandoned_claim_for_recovery,
    transition_recovery_ownership_to_execution, AbandonmentObservationFingerprint,
    DurableClaimObservation, DurableStepPlanInput, DurableStepSkeletonInput,
    RecoveryEligibilityDurableEvidence, RecoveryExecutionOwnershipProof,
    RecoveryExecutionTransitionContext, RecoveryInitializationAuthority,
    RecoveryInitializationKind, RecoveryOwnershipContext, RecoveryOwnershipProof,
    PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN,
    PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED, PROVISIONING_OPERATION_CAS_CONFLICT,
};
use chrono::{SecondsFormat, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

pub(crate) const HEARTBEAT_INTERVAL_MS: i64 = 30_000;
pub(crate) const GRACE_PERIOD_MS: i64 = 30_000;
pub(crate) const ABANDONMENT_CONFIRMATION_INTERVAL_MS: i64 = 30_000;
pub(crate) const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;
pub(crate) const SCHEDULING_JITTER_BUDGET_MS: i64 = 30_000;
pub(crate) const MAX_CONSECUTIVE_RENEW_FAILURES: u8 = 1;

const _: () = assert!(HEARTBEAT_INTERVAL_MS > 0);
const _: () = assert!(HEARTBEAT_INTERVAL_MS < 300_000);
const _: () = assert!(GRACE_PERIOD_MS >= HEARTBEAT_INTERVAL_MS);
const _: () = assert!(ABANDONMENT_CONFIRMATION_INTERVAL_MS > 0);
const _: () = assert!(
    300_000 > HEARTBEAT_INTERVAL_MS + SQLITE_BUSY_TIMEOUT_MS as i64 + SCHEDULING_JITTER_BUDGET_MS
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnershipSupervisorTypedResult {
    OwnershipRenewed,
    OwnershipStillValid,
    OwnershipExpiring,
    DurableClaimDiscovered,
    OrphanedDurableClaimRegistered,
    OwnershipCheckoutIssued,
    OwnershipCheckoutConflict,
    ExpiredCandidateCreated,
    ExpiredCandidateCancelled,
    DroppedAwaitingExpiry,
    QuarantinedClassifiedSafeClosed,
    QuarantinedClassifiedRetained,
    OriginalActiveRestoredLive,
    OriginalActiveClassifiedDropped,
    OriginalActiveClassifiedOrphaned,
    AbandonedEligibleForHandoff,
    ClaimRevisionStale,
    ClaimOwnerMismatch,
    ProcessGenerationMismatch,
    RegistryProofStale,
    RegistryTransitionConflict,
    OwnershipConflict,
    PartialInvariantBroken,
    RecoveryInvestigationRequired,
    AuthorityUnavailable,
    ClockAuthorityUnavailable,
    RepositoryBusy,
    RepositoryUnavailable,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnershipSupervisorEvent {
    pub(crate) operation_id: String,
    pub(crate) claim_id: String,
    pub(crate) result: OwnershipSupervisorTypedResult,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct OwnershipSupervisorTickReport {
    pub(crate) events: Vec<OwnershipSupervisorEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AbandonmentReason {
    DroppedUnclosed,
    OrphanedProcessGeneration,
}

/// Process-local first-stage confirmation state. Deliberately non-Clone and
/// non-Serde.
#[derive(Debug)]
pub(crate) struct OwnershipExpiredCandidate {
    operation_id: String,
    claim_id: String,
    owner_type: String,
    owner_id: String,
    scope_kind: String,
    manuscript_channel: Option<String>,
    claim_owner_token: String,
    claim_revision: i64,
    last_heartbeat_at: i64,
    derived_expiry: i64,
    first_repository_utc_observation: i64,
    candidate_monotonic_start: i64,
    registry_slot_generation: u64,
    checkout_generation: u64,
    creator_process_generation: String,
    candidate_generation: u64,
    origin: RuntimeRegistryLifecycle,
    reason: AbandonmentReason,
    first_fingerprint: AbandonmentObservationFingerprint,
}

/// P1-04 entry qualification only. It cannot modify/release/transfer/takeover a
/// Claim and is deliberately non-Clone and non-Serde.
#[derive(Debug)]
pub(crate) struct RecoveryHandoffEligibility {
    durable_evidence: RecoveryEligibilityDurableEvidence,
    monotonic_confirmation_elapsed: i64,
    registry_slot_generation: u64,
    creator_process_generation: String,
    candidate_generation: u64,
    eligibility_generation: u64,
    reason: AbandonmentReason,
}

impl RecoveryHandoffEligibility {
    #[cfg(test)]
    pub(crate) fn claim_id_for_test(&self) -> &str {
        self.durable_evidence.claim_id()
    }

    #[cfg(test)]
    pub(crate) fn claim_revision_for_test(&self) -> i64 {
        self.durable_evidence.claim_revision()
    }
}

/// Process-local attachment facts. They are never persisted or accepted as
/// durable ownership evidence.
#[derive(Debug)]
pub(crate) struct RecoveryGuardAttachment {
    process_generation: String,
    runtime_instance_id: String,
    registry_slot_generation: u64,
    checkout_generation: u64,
    candidate_generation: u64,
    eligibility_generation: u64,
    source: RecoveryOwnershipSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryOwnershipSource {
    InitialRootOwnership,
    SuccessorRecoveryOwnership,
    TakeoverOwnership,
}

#[derive(Debug)]
struct RecoveryGuard {
    proof: RecoveryOwnershipProof,
    attachment: RecoveryGuardAttachment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryOwnershipAcquisitionResult {
    RecoveryOwnershipAcquiredExecutionNotStarted,
    KnownNotCommitted,
    RecoveryTakeoverQuarantined,
    AuthorityUnavailable,
}

#[derive(Debug)]
pub(crate) struct AttachedRecoveryOwnership {
    pub(crate) operation_id: String,
    pub(crate) claim_id: String,
    pub(crate) source: RecoveryOwnershipSource,
}

#[derive(Debug)]
pub(crate) enum InitialRecoveryOwnershipAttachmentResult {
    Attached(AttachedRecoveryOwnership),
    AlreadyAttached(AttachedRecoveryOwnership),
    CommittedButUnattached,
    CrossProcessReattachDenied,
    Quarantined,
}

#[derive(Debug)]
pub(crate) struct MaterializedRecoveryExecution {
    pub(crate) proof: RecoveryExecutionOwnershipProof,
    pub(crate) registry_attachment: RecoveryExecutionRegistryAttachment,
}

/// Read-only planning facts. This DTO is not ownership authority and cannot
/// consume or replace the Recovery guard.
#[derive(Debug, Clone)]
pub(crate) struct RecoveryExecutionPlanningFacts {
    pub(crate) recovery_operation_id: String,
    pub(crate) recovery_attempt_revision: i64,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) scope_kind: String,
    pub(crate) manuscript_channel: Option<String>,
    pub(crate) plan_template_kind: crate::manuscript_provisioning_contract::PlanTemplateKind,
    pub(crate) fingerprint_profile: PlanFingerprintProfile,
    pub(crate) canonical_resource_identity_hash: String,
    pub(crate) canonical_placement_identity_hash: String,
    pub(crate) parent_shared_identity_hash: Option<String>,
    pub(crate) adapter_step_offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryExecutionMaterializationResult {
    AuthorityUnavailable,
    KnownNotCommitted,
    Quarantined,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryTakeoverFault {
    ResponseLostAfterCommit,
    AttachmentFailsOnce,
}

#[derive(Default)]
struct SupervisorState {
    last_renew_attempt_at: HashMap<String, i64>,
    consecutive_renew_failures: HashMap<String, u8>,
    candidates: HashMap<String, OwnershipExpiredCandidate>,
    eligibility: HashMap<String, RecoveryHandoffEligibility>,
    recovery_guards: HashMap<String, RecoveryGuard>,
    next_candidate_generation: u64,
    next_eligibility_generation: u64,
}

pub(crate) struct RetainedOwnershipSupervisor {
    database_provider: Arc<dyn RuntimeDatabaseProvider>,
    ownership_context: Arc<ClaimOwnershipRepositoryContext>,
    registry: Arc<SlotCoordinator>,
    monotonic_clock: Arc<dyn MonotonicClock>,
    state: Mutex<SupervisorState>,
}

impl RetainedOwnershipSupervisor {
    pub(super) fn new(
        database_provider: Arc<dyn RuntimeDatabaseProvider>,
        ownership_context: Arc<ClaimOwnershipRepositoryContext>,
        registry: Arc<SlotCoordinator>,
        monotonic_clock: Arc<dyn MonotonicClock>,
    ) -> Self {
        Self {
            database_provider,
            ownership_context,
            registry,
            monotonic_clock,
            state: Mutex::new(SupervisorState::default()),
        }
    }

    pub(crate) fn registry_lifecycle_for_claim(
        &self,
        claim_id: &str,
    ) -> Option<RuntimeRegistryLifecycle> {
        self.registry
            .runtime_registry_candidates()
            .into_iter()
            .find(|snapshot| snapshot.claim_id == claim_id)
            .map(|snapshot| snapshot.lifecycle)
    }

    /// Explicit tick primitive. No production startup/lifecycle code calls it
    /// in P1-03-R2.
    pub(crate) fn tick(&self) -> OwnershipSupervisorTickReport {
        let mut report = OwnershipSupervisorTickReport::default();
        let initial_registry = self.registry.runtime_registry_candidates();
        let represented: HashSet<String> = initial_registry
            .iter()
            .map(|snapshot| snapshot.claim_id.clone())
            .collect();
        match self.database_provider.open_read_only() {
            Ok(connection) => {
                match discover_unrepresented_durable_claims(&connection, &represented) {
                    Ok(discovered) => {
                        for observation in discovered {
                            self.register_discovered(observation, &mut report);
                        }
                    }
                    Err(_) => report.events.push(event(
                        "",
                        "",
                        OwnershipSupervisorTypedResult::RepositoryUnavailable,
                    )),
                }
            }
            Err(_) => report.events.push(event(
                "",
                "",
                OwnershipSupervisorTypedResult::RepositoryUnavailable,
            )),
        }

        for snapshot in self.registry.runtime_registry_candidates() {
            match snapshot.lifecycle {
                RuntimeRegistryLifecycle::Live
                | RuntimeRegistryLifecycle::ExecutionOwned
                | RuntimeRegistryLifecycle::Retained => {
                    self.maybe_renew(&snapshot.claim_id, &mut report);
                }
                RuntimeRegistryLifecycle::Quarantined => {
                    self.classify_quarantined(&snapshot.claim_id, &mut report);
                }
                RuntimeRegistryLifecycle::DroppedUnclosed
                | RuntimeRegistryLifecycle::OrphanedDurableClaim
                | RuntimeRegistryLifecycle::OwnershipExpiredCandidate => {
                    self.inspect_expiry(&snapshot.claim_id, &mut report);
                }
                RuntimeRegistryLifecycle::RenewInFlight
                | RuntimeRegistryLifecycle::InspectionInFlight
                | RuntimeRegistryLifecycle::ClassificationInFlight
                | RuntimeRegistryLifecycle::TakeoverInFlight
                | RuntimeRegistryLifecycle::StepExecutionInFlight => {
                    report.events.push(event(
                        &snapshot.operation_id,
                        &snapshot.claim_id,
                        OwnershipSupervisorTypedResult::OwnershipCheckoutConflict,
                    ));
                }
                RuntimeRegistryLifecycle::AbandonedEligible
                | RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached
                | RuntimeRegistryLifecycle::RecoveryOwned
                | RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined
                | RuntimeRegistryLifecycle::Closed
                | RuntimeRegistryLifecycle::Exiting => {}
            }
        }
        report
    }

    fn register_discovered(
        &self,
        observation: DurableClaimObservation,
        report: &mut OwnershipSupervisorTickReport,
    ) {
        let Some(claim) = observation.claim.as_ref() else {
            return;
        };
        let claim_id = claim.claim_id.clone();
        let operation_id = claim.operation_id.clone();
        report.events.push(event(
            &operation_id,
            &claim_id,
            OwnershipSupervisorTypedResult::DurableClaimDiscovered,
        ));
        let current_owner = claim.claim_owner_token == self.ownership_context.claim_owner_token();
        let lifecycle = if observation.is_recovery_retained_complete() {
            if current_owner {
                RuntimeRegistryLifecycle::Retained
            } else {
                RuntimeRegistryLifecycle::OrphanedDurableClaim
            }
        } else if observation.is_original_active_complete() {
            if current_owner {
                RuntimeRegistryLifecycle::DroppedUnclosed
            } else {
                RuntimeRegistryLifecycle::OrphanedDurableClaim
            }
        } else {
            RuntimeRegistryLifecycle::Quarantined
        };
        let resource = resource_for_claim(claim);
        let now = self.monotonic_clock.now_ms();
        let Ok((lease, generation, runtime_instance_id)) = self.registry.register_durable_sentinel(
            &resource,
            &operation_id,
            &claim_id,
            &claim.claim_owner_token,
            lifecycle,
            now,
        ) else {
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::RegistryTransitionConflict,
            ));
            return;
        };
        if lifecycle == RuntimeRegistryLifecycle::Retained {
            let proof = observation.claim.and_then(|claim| {
                self.ownership_context
                    .create_proof_from_fresh_claim(claim, generation)
                    .ok()
            });
            if !proof.is_some_and(|proof| {
                self.registry.install_claim_ownership_proof(
                    &lease,
                    generation,
                    &runtime_instance_id,
                    proof,
                )
            }) {
                let _ = self.registry.transition_runtime_handle(
                    &lease,
                    generation,
                    &runtime_instance_id,
                    RuntimeRegistryLifecycle::Retained,
                    RuntimeRegistryLifecycle::Quarantined,
                );
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::RegistryProofStale,
                ));
                return;
            }
        }
        if lifecycle == RuntimeRegistryLifecycle::OrphanedDurableClaim {
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::OrphanedDurableClaimRegistered,
            ));
        }
    }

    fn maybe_renew(&self, claim_id: &str, report: &mut OwnershipSupervisorTickReport) {
        let now = self.monotonic_clock.now_ms();
        let due = {
            let state = self.state.lock().expect("ownership supervisor state");
            state
                .last_renew_attempt_at
                .get(claim_id)
                .is_none_or(|last| now.saturating_sub(*last) >= HEARTBEAT_INTERVAL_MS)
        };
        if !due {
            return;
        }
        let checkout = match self
            .registry
            .checkout_claim_ownership(claim_id, ClaimOwnershipCheckoutAction::Renew)
        {
            Ok(checkout) => checkout,
            Err(_) => {
                report.events.push(event(
                    "",
                    claim_id,
                    OwnershipSupervisorTypedResult::OwnershipCheckoutConflict,
                ));
                return;
            }
        };
        report.events.push(event(
            checkout.operation_id(),
            checkout.claim_id(),
            OwnershipSupervisorTypedResult::OwnershipCheckoutIssued,
        ));
        {
            let mut state = self.state.lock().expect("ownership supervisor state");
            state
                .last_renew_attempt_at
                .insert(claim_id.to_string(), now);
        }
        let Some(snapshot) = checkout.ownership_snapshot() else {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::RegistryProofStale,
                report,
            );
            return;
        };
        let mut connection = match self.database_provider.open_ownership() {
            Ok(connection) => connection,
            Err(_) => {
                self.renew_failed(
                    checkout,
                    OwnershipSupervisorTypedResult::RepositoryUnavailable,
                    false,
                    report,
                );
                return;
            }
        };
        if connection
            .busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
            .is_err()
        {
            self.renew_failed(
                checkout,
                OwnershipSupervisorTypedResult::RepositoryUnavailable,
                false,
                report,
            );
            return;
        }
        let renewed = if checkout.previous_lifecycle() == RuntimeRegistryLifecycle::Retained {
            record_retained_claim_heartbeat_with_repository_clock(
                &mut connection,
                &self.ownership_context,
                &snapshot,
            )
        } else {
            record_claim_heartbeat_with_repository_clock(
                &mut connection,
                &self.ownership_context,
                &snapshot,
            )
        };
        let renewed = match renewed {
            Ok(_) => {
                let reopened =
                    self.database_provider
                        .open_read_only()
                        .ok()
                        .and_then(|connection| {
                            read_active_claim_for_operation(&connection, checkout.operation_id())
                                .ok()
                                .flatten()
                        });
                let proof = reopened.and_then(|claim| {
                    self.ownership_context
                        .create_proof_from_fresh_claim(claim, checkout.slot_generation())
                        .ok()
                });
                let Some(proof) = proof else {
                    self.complete_quarantined(
                        checkout,
                        OwnershipSupervisorTypedResult::AuthorityUnavailable,
                        report,
                    );
                    return;
                };
                let operation_id = checkout.operation_id().to_string();
                let claim_id = checkout.claim_id().to_string();
                let target = checkout.previous_lifecycle();
                if self
                    .registry
                    .complete_claim_ownership_checkout(checkout, target, Some(proof))
                {
                    let mut state = self.state.lock().expect("ownership supervisor state");
                    state.consecutive_renew_failures.remove(&claim_id);
                    state.candidates.remove(&claim_id);
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::OwnershipRenewed,
                    ));
                } else {
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                    ));
                }
                return;
            }
            Err(error) => error,
        };
        let (typed, known_not_committed) = match renewed.code {
            PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED => {
                (OwnershipSupervisorTypedResult::RepositoryBusy, true)
            }
            PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN => {
                (OwnershipSupervisorTypedResult::CommitOutcomeUnknown, false)
            }
            PROVISIONING_OPERATION_CAS_CONFLICT => {
                (OwnershipSupervisorTypedResult::ClaimRevisionStale, false)
            }
            _ => (OwnershipSupervisorTypedResult::RepositoryUnavailable, false),
        };
        self.renew_failed(checkout, typed, known_not_committed, report);
    }

    fn renew_failed(
        &self,
        checkout: ClaimOwnershipCheckout,
        typed: OwnershipSupervisorTypedResult,
        known_not_committed: bool,
        report: &mut OwnershipSupervisorTickReport,
    ) {
        let operation_id = checkout.operation_id().to_string();
        let claim_id = checkout.claim_id().to_string();
        let tolerate = if known_not_committed {
            let mut state = self.state.lock().expect("ownership supervisor state");
            let failures = state
                .consecutive_renew_failures
                .entry(claim_id.clone())
                .or_default();
            *failures = failures.saturating_add(1);
            *failures <= MAX_CONSECUTIVE_RENEW_FAILURES
        } else {
            false
        };
        let transitioned = if tolerate {
            self.registry.restore_claim_ownership_checkout(checkout)
        } else {
            self.registry.complete_claim_ownership_checkout(
                checkout,
                RuntimeRegistryLifecycle::Quarantined,
                None,
            )
        };
        report.events.push(event(&operation_id, &claim_id, typed));
        if !transitioned {
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::RegistryTransitionConflict,
            ));
        }
    }

    fn classify_quarantined(&self, claim_id: &str, report: &mut OwnershipSupervisorTickReport) {
        let checkout = match self
            .registry
            .checkout_claim_ownership(claim_id, ClaimOwnershipCheckoutAction::Classify)
        {
            Ok(checkout) => checkout,
            Err(_) => return,
        };
        let observation = match self.inspect(checkout.operation_id()) {
            Some(observation) => observation,
            None => {
                let operation_id = checkout.operation_id().to_string();
                let claim_id = checkout.claim_id().to_string();
                let restored = self.registry.restore_claim_ownership_checkout(checkout);
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::AuthorityUnavailable,
                ));
                if !restored {
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                    ));
                }
                return;
            }
        };
        let operation_id = checkout.operation_id().to_string();
        let claim_id = checkout.claim_id().to_string();
        if observation.is_safe_terminal_complete() {
            if self.registry.complete_claim_ownership_checkout(
                checkout,
                RuntimeRegistryLifecycle::Closed,
                None,
            ) {
                self.clear_process_local_claim_state(&claim_id);
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::QuarantinedClassifiedSafeClosed,
                ));
            }
            return;
        }
        if observation.is_recovery_retained_complete() {
            let Some(claim) = observation.claim else {
                self.complete_quarantined(
                    checkout,
                    OwnershipSupervisorTypedResult::PartialInvariantBroken,
                    report,
                );
                return;
            };
            if claim.claim_owner_token != self.ownership_context.claim_owner_token() {
                let _ = self.registry.complete_claim_ownership_checkout(
                    checkout,
                    RuntimeRegistryLifecycle::OrphanedDurableClaim,
                    None,
                );
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::OriginalActiveClassifiedOrphaned,
                ));
                return;
            }
            let proof = self
                .ownership_context
                .create_proof_from_fresh_claim(claim, checkout.slot_generation())
                .ok();
            if proof.is_some_and(|proof| {
                self.registry.complete_claim_ownership_checkout(
                    checkout,
                    RuntimeRegistryLifecycle::Retained,
                    Some(proof),
                )
            }) {
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::QuarantinedClassifiedRetained,
                ));
            } else {
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                ));
            }
            return;
        }
        if observation.is_original_active_complete() {
            let claim = observation.claim.expect("active observation claim");
            if claim.claim_owner_token != self.ownership_context.claim_owner_token() {
                let _ = self.registry.complete_claim_ownership_checkout(
                    checkout,
                    RuntimeRegistryLifecycle::OrphanedDurableClaim,
                    None,
                );
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::OriginalActiveClassifiedOrphaned,
                ));
                return;
            }
            if checkout.allows_live_restore() {
                let proof = self
                    .ownership_context
                    .create_proof_from_fresh_claim(claim, checkout.slot_generation())
                    .ok();
                if proof.is_some_and(|proof| {
                    self.registry.complete_claim_ownership_checkout(
                        checkout,
                        RuntimeRegistryLifecycle::Live,
                        Some(proof),
                    )
                }) {
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::OriginalActiveRestoredLive,
                    ));
                } else {
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                    ));
                }
            } else if checkout.is_discovered_sentinel() {
                let _ = self.registry.complete_claim_ownership_checkout(
                    checkout,
                    RuntimeRegistryLifecycle::DroppedUnclosed,
                    None,
                );
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::OriginalActiveClassifiedDropped,
                ));
            } else {
                self.complete_quarantined(
                    checkout,
                    OwnershipSupervisorTypedResult::OwnershipConflict,
                    report,
                );
            }
            return;
        }
        self.complete_quarantined(
            checkout,
            OwnershipSupervisorTypedResult::PartialInvariantBroken,
            report,
        );
        report.events.push(event(
            &operation_id,
            &claim_id,
            OwnershipSupervisorTypedResult::RecoveryInvestigationRequired,
        ));
    }

    fn inspect_expiry(&self, claim_id: &str, report: &mut OwnershipSupervisorTickReport) {
        let checkout = match self
            .registry
            .checkout_claim_ownership(claim_id, ClaimOwnershipCheckoutAction::Inspect)
        {
            Ok(checkout) => checkout,
            Err(_) => return,
        };
        let operation_id = checkout.operation_id().to_string();
        let claim_id = checkout.claim_id().to_string();
        let observation = match self.inspect(&operation_id) {
            Some(observation) => observation,
            None => {
                let restored = self.registry.restore_claim_ownership_checkout(checkout);
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::AuthorityUnavailable,
                ));
                if !restored {
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                    ));
                }
                return;
            }
        };
        if observation.is_safe_terminal_complete() {
            let _ = self.registry.complete_claim_ownership_checkout(
                checkout,
                RuntimeRegistryLifecycle::Closed,
                None,
            );
            self.clear_process_local_claim_state(&claim_id);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::QuarantinedClassifiedSafeClosed,
            ));
            return;
        }
        if !observation.is_original_active_complete()
            && !observation.is_recovery_retained_complete()
        {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::PartialInvariantBroken,
                report,
            );
            return;
        }
        let claim = observation.claim.as_ref().expect("complete claim");
        if claim.claim_owner_token != checkout.process_generation() {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::ClaimOwnerMismatch,
                report,
            );
            return;
        }
        let last_heartbeat_at = match claim.last_heartbeat_at.parse::<i64>() {
            Ok(value) => value,
            Err(_) => {
                self.complete_quarantined(
                    checkout,
                    OwnershipSupervisorTypedResult::InternalInvariantFailure,
                    report,
                );
                return;
            }
        };
        let observed_now = match self.ownership_context.sample_sealed_epoch_ms() {
            Ok(value) if value >= last_heartbeat_at => value,
            _ => {
                let restored = self.registry.restore_claim_ownership_checkout(checkout);
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::ClockAuthorityUnavailable,
                ));
                if !restored {
                    report.events.push(event(
                        &operation_id,
                        &claim_id,
                        OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                    ));
                }
                return;
            }
        };
        let expiry = match derive_claim_expiry_epoch_ms(last_heartbeat_at) {
            Ok(value) => value,
            Err(_) => {
                self.complete_quarantined(
                    checkout,
                    OwnershipSupervisorTypedResult::InternalInvariantFailure,
                    report,
                );
                return;
            }
        };
        let expiry_with_grace = match expiry.checked_add(GRACE_PERIOD_MS) {
            Some(value) => value,
            None => {
                self.complete_quarantined(
                    checkout,
                    OwnershipSupervisorTypedResult::InternalInvariantFailure,
                    report,
                );
                return;
            }
        };
        if observed_now <= expiry {
            let restored = self.registry.restore_claim_ownership_checkout(checkout);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::OwnershipStillValid,
            ));
            if !restored {
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                ));
            }
            return;
        }
        if observed_now <= expiry_with_grace {
            let restored = self.registry.restore_claim_ownership_checkout(checkout);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::OwnershipExpiring,
            ));
            if !restored {
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                ));
            }
            return;
        }
        if checkout.previous_lifecycle() == RuntimeRegistryLifecycle::OwnershipExpiredCandidate {
            self.confirm_candidate(checkout, observation, observed_now, expiry, report);
        } else {
            self.create_candidate(
                checkout,
                observation,
                observed_now,
                expiry,
                last_heartbeat_at,
                report,
            );
        }
    }

    fn create_candidate(
        &self,
        checkout: ClaimOwnershipCheckout,
        observation: DurableClaimObservation,
        observed_now: i64,
        expiry: i64,
        last_heartbeat_at: i64,
        report: &mut OwnershipSupervisorTickReport,
    ) {
        let operation_id = checkout.operation_id().to_string();
        let claim_id = checkout.claim_id().to_string();
        let Some(fingerprint) = observation.create_abandonment_fingerprint() else {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::PartialInvariantBroken,
                report,
            );
            return;
        };
        let claim = observation.claim.expect("fingerprinted claim");
        let candidate_generation = {
            let mut state = self.state.lock().expect("ownership supervisor state");
            state.next_candidate_generation = state
                .next_candidate_generation
                .checked_add(1)
                .expect("candidate generation overflow");
            state.next_candidate_generation
        };
        let candidate = OwnershipExpiredCandidate {
            operation_id: operation_id.clone(),
            claim_id: claim_id.clone(),
            owner_type: claim.owner_type,
            owner_id: claim.owner_id,
            scope_kind: claim.scope_kind,
            manuscript_channel: claim.manuscript_channel,
            claim_owner_token: claim.claim_owner_token,
            claim_revision: claim.claim_revision,
            last_heartbeat_at,
            derived_expiry: expiry,
            first_repository_utc_observation: observed_now,
            candidate_monotonic_start: self.monotonic_clock.now_ms(),
            registry_slot_generation: checkout.slot_generation(),
            checkout_generation: checkout.checkout_generation(),
            creator_process_generation: self.ownership_context.claim_owner_token().to_string(),
            candidate_generation,
            origin: checkout.previous_lifecycle(),
            reason: if checkout.previous_lifecycle()
                == RuntimeRegistryLifecycle::OrphanedDurableClaim
            {
                AbandonmentReason::OrphanedProcessGeneration
            } else {
                AbandonmentReason::DroppedUnclosed
            },
            first_fingerprint: fingerprint,
        };
        if self.registry.complete_claim_ownership_checkout(
            checkout,
            RuntimeRegistryLifecycle::OwnershipExpiredCandidate,
            None,
        ) {
            self.state
                .lock()
                .expect("ownership supervisor state")
                .candidates
                .insert(claim_id.clone(), candidate);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::ExpiredCandidateCreated,
            ));
        } else {
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::RegistryTransitionConflict,
            ));
        }
    }

    fn confirm_candidate(
        &self,
        checkout: ClaimOwnershipCheckout,
        observation: DurableClaimObservation,
        observed_now: i64,
        expiry: i64,
        report: &mut OwnershipSupervisorTickReport,
    ) {
        let operation_id = checkout.operation_id().to_string();
        let claim_id = checkout.claim_id().to_string();
        let candidate = self
            .state
            .lock()
            .expect("ownership supervisor state")
            .candidates
            .remove(&claim_id);
        let Some(candidate) = candidate else {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::InternalInvariantFailure,
                report,
            );
            return;
        };
        let monotonic_now = self.monotonic_clock.now_ms();
        if monotonic_now < candidate.candidate_monotonic_start {
            self.state
                .lock()
                .expect("ownership supervisor state")
                .candidates
                .insert(claim_id.clone(), candidate);
            let restored = self.registry.restore_claim_ownership_checkout(checkout);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::ClockAuthorityUnavailable,
            ));
            if !restored {
                report.events.push(event(
                    &operation_id,
                    &claim_id,
                    OwnershipSupervisorTypedResult::RegistryTransitionConflict,
                ));
            }
            return;
        }
        let elapsed = monotonic_now - candidate.candidate_monotonic_start;
        if elapsed < ABANDONMENT_CONFIRMATION_INTERVAL_MS {
            self.state
                .lock()
                .expect("ownership supervisor state")
                .candidates
                .insert(claim_id.clone(), candidate);
            let _ = self.registry.restore_claim_ownership_checkout(checkout);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::DroppedAwaitingExpiry,
            ));
            return;
        }
        let Some(second_fingerprint) = observation.create_abandonment_fingerprint() else {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::PartialInvariantBroken,
                report,
            );
            return;
        };
        let fingerprint_matches = candidate.first_fingerprint.matches(&second_fingerprint);
        let claim = observation.claim.as_ref().expect("fingerprinted claim");
        let identity_matches = candidate.claim_revision == claim.claim_revision
            && candidate.claim_owner_token == claim.claim_owner_token
            && candidate.last_heartbeat_at
                == claim.last_heartbeat_at.parse::<i64>().unwrap_or(i64::MIN)
            && candidate.derived_expiry == expiry
            && candidate.registry_slot_generation == checkout.slot_generation()
            && checkout.checkout_generation() > candidate.checkout_generation
            && candidate.creator_process_generation == self.ownership_context.claim_owner_token()
            && candidate.operation_id == operation_id
            && candidate.claim_id == claim_id;
        if !fingerprint_matches || !identity_matches {
            let origin = candidate.origin;
            let _ = self
                .registry
                .complete_claim_ownership_checkout(checkout, origin, None);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::ExpiredCandidateCancelled,
            ));
            return;
        }
        let Some(durable_evidence) = RecoveryEligibilityDurableEvidence::seal(
            candidate.operation_id,
            candidate.claim_id,
            candidate.owner_type,
            candidate.owner_id,
            candidate.scope_kind,
            candidate.manuscript_channel,
            candidate.claim_owner_token,
            candidate.claim_revision,
            candidate.last_heartbeat_at,
            candidate.derived_expiry,
            candidate.first_repository_utc_observation,
            observed_now,
            candidate.first_fingerprint,
            second_fingerprint,
        ) else {
            self.complete_quarantined(
                checkout,
                OwnershipSupervisorTypedResult::InternalInvariantFailure,
                report,
            );
            return;
        };
        let eligibility_generation = {
            let mut state = self.state.lock().expect("ownership supervisor state");
            state.next_eligibility_generation = state
                .next_eligibility_generation
                .checked_add(1)
                .expect("eligibility generation overflow");
            state.next_eligibility_generation
        };
        let eligibility = RecoveryHandoffEligibility {
            durable_evidence,
            monotonic_confirmation_elapsed: elapsed,
            registry_slot_generation: candidate.registry_slot_generation,
            creator_process_generation: candidate.creator_process_generation,
            candidate_generation: candidate.candidate_generation,
            eligibility_generation,
            reason: candidate.reason,
        };
        if self.registry.complete_claim_ownership_checkout(
            checkout,
            RuntimeRegistryLifecycle::AbandonedEligible,
            None,
        ) {
            self.state
                .lock()
                .expect("ownership supervisor state")
                .eligibility
                .insert(claim_id.clone(), eligibility);
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::AbandonedEligibleForHandoff,
            ));
        } else {
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::RegistryTransitionConflict,
            ));
        }
    }

    fn inspect(&self, operation_id: &str) -> Option<DurableClaimObservation> {
        let connection = self.database_provider.open_read_only().ok()?;
        inspect_durable_claim(&connection, operation_id).ok()
    }

    fn complete_quarantined(
        &self,
        checkout: ClaimOwnershipCheckout,
        typed: OwnershipSupervisorTypedResult,
        report: &mut OwnershipSupervisorTickReport,
    ) {
        let operation_id = checkout.operation_id().to_string();
        let claim_id = checkout.claim_id().to_string();
        let transitioned = self.registry.complete_claim_ownership_checkout(
            checkout,
            RuntimeRegistryLifecycle::Quarantined,
            None,
        );
        self.clear_process_local_claim_state(&claim_id);
        report.events.push(event(&operation_id, &claim_id, typed));
        if !transitioned {
            report.events.push(event(
                &operation_id,
                &claim_id,
                OwnershipSupervisorTypedResult::RegistryTransitionConflict,
            ));
        }
    }

    pub(crate) fn attach_initial_recovery_ownership(
        &self,
        authority: RecoveryInitializationAuthority,
    ) -> InitialRecoveryOwnershipAttachmentResult {
        self.attach_initial_recovery_ownership_inner(authority, false)
    }

    #[cfg(test)]
    pub(crate) fn attach_initial_recovery_ownership_with_fault_for_test(
        &self,
        authority: RecoveryInitializationAuthority,
    ) -> InitialRecoveryOwnershipAttachmentResult {
        self.attach_initial_recovery_ownership_inner(authority, true)
    }

    fn attach_initial_recovery_ownership_inner(
        &self,
        authority: RecoveryInitializationAuthority,
        fail_first_attachment: bool,
    ) -> InitialRecoveryOwnershipAttachmentResult {
        let source = match authority.kind {
            RecoveryInitializationKind::InitialRoot => {
                RecoveryOwnershipSource::InitialRootOwnership
            }
            RecoveryInitializationKind::CompletedSuccessor => {
                RecoveryOwnershipSource::SuccessorRecoveryOwnership
            }
        };
        let operation_id = authority.operation.operation_id.clone();
        let claim_id = authority.claim.claim_id.clone();
        let current_process_generation = self.ownership_context.claim_owner_token();
        if authority.claim.claim_owner_token != current_process_generation {
            return InitialRecoveryOwnershipAttachmentResult::CrossProcessReattachDenied;
        }
        let proof = self
            .database_provider
            .open_read_only()
            .ok()
            .and_then(|connection| {
                read_initial_recovery_ownership_proof(
                    &connection,
                    authority.kind,
                    authority.predecessor_operation_id.as_deref(),
                    &operation_id,
                    current_process_generation,
                )
                .ok()
            });
        let Some(proof) = proof else {
            return InitialRecoveryOwnershipAttachmentResult::Quarantined;
        };
        let existing = self
            .registry
            .committed_recovery_attachment_identity(&claim_id, current_process_generation);
        let (slot_generation, runtime_instance_id, lifecycle) = match existing {
            Some(existing) => existing,
            None => {
                let resource = resource_for_claim(&authority.claim);
                match self.registry.register_durable_sentinel(
                    &resource,
                    &operation_id,
                    &claim_id,
                    current_process_generation,
                    RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached,
                    self.monotonic_clock.now_ms(),
                ) {
                    Ok((_lease, generation, runtime_instance_id)) => (
                        generation,
                        runtime_instance_id,
                        RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached,
                    ),
                    Err(_) => {
                        return InitialRecoveryOwnershipAttachmentResult::CommittedButUnattached
                    }
                }
            }
        };
        let attachment = RecoveryGuardAttachment {
            process_generation: current_process_generation.to_string(),
            runtime_instance_id,
            registry_slot_generation: slot_generation,
            checkout_generation: 0,
            candidate_generation: 0,
            eligibility_generation: 0,
            source,
        };
        if lifecycle == RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached {
            if fail_first_attachment {
                return InitialRecoveryOwnershipAttachmentResult::CommittedButUnattached;
            }
            if !self
                .registry
                .attach_committed_recovery_ownership(&claim_id, slot_generation)
            {
                return InitialRecoveryOwnershipAttachmentResult::CommittedButUnattached;
            }
        }
        let already_attached = lifecycle == RuntimeRegistryLifecycle::RecoveryOwned;
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return InitialRecoveryOwnershipAttachmentResult::Quarantined,
        };
        if state.recovery_guards.contains_key(&claim_id) {
            return InitialRecoveryOwnershipAttachmentResult::AlreadyAttached(
                AttachedRecoveryOwnership {
                    operation_id,
                    claim_id,
                    source,
                },
            );
        }
        state
            .recovery_guards
            .insert(claim_id.clone(), RecoveryGuard { proof, attachment });
        let attached = AttachedRecoveryOwnership {
            operation_id,
            claim_id,
            source,
        };
        if already_attached {
            InitialRecoveryOwnershipAttachmentResult::AlreadyAttached(attached)
        } else {
            InitialRecoveryOwnershipAttachmentResult::Attached(attached)
        }
    }

    /// P1-04 primitive. It is production-compiled but has no production
    /// caller, timer, worker, Tauri command, or UI entry.
    pub(crate) fn acquire_recovery_ownership(
        &self,
        claim_id: &str,
    ) -> RecoveryOwnershipAcquisitionResult {
        self.acquire_recovery_ownership_inner(claim_id, None)
    }

    #[cfg(test)]
    pub(crate) fn acquire_recovery_ownership_with_fault_for_test(
        &self,
        claim_id: &str,
        fault: RecoveryTakeoverFault,
    ) -> RecoveryOwnershipAcquisitionResult {
        self.acquire_recovery_ownership_inner(claim_id, Some(fault))
    }

    fn acquire_recovery_ownership_inner(
        &self,
        claim_id: &str,
        #[cfg(test)] fault: Option<RecoveryTakeoverFault>,
        #[cfg(not(test))] _fault: Option<()>,
    ) -> RecoveryOwnershipAcquisitionResult {
        let eligibility = {
            let mut state = self.state.lock().expect("ownership supervisor state");
            state.eligibility.remove(claim_id)
        };
        let Some(eligibility) = eligibility else {
            return RecoveryOwnershipAcquisitionResult::AuthorityUnavailable;
        };
        let checkout = match self
            .registry
            .checkout_claim_ownership(claim_id, ClaimOwnershipCheckoutAction::Takeover)
        {
            Ok(checkout) => checkout,
            Err(_) => {
                self.state
                    .lock()
                    .expect("ownership supervisor state")
                    .eligibility
                    .insert(claim_id.to_string(), eligibility);
                return RecoveryOwnershipAcquisitionResult::AuthorityUnavailable;
            }
        };
        let current_process_generation = self.ownership_context.claim_owner_token().to_string();
        let generation_valid = eligibility.registry_slot_generation == checkout.slot_generation()
            && eligibility.creator_process_generation == current_process_generation
            && eligibility.monotonic_confirmation_elapsed >= ABANDONMENT_CONFIRMATION_INTERVAL_MS
            && eligibility.candidate_generation > 0
            && eligibility.eligibility_generation > 0;
        if !generation_valid {
            let _ = self.registry.complete_claim_ownership_checkout(
                checkout,
                RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined,
                None,
            );
            return RecoveryOwnershipAcquisitionResult::RecoveryTakeoverQuarantined;
        }
        let predecessor_operation_id = eligibility.durable_evidence.operation_id().to_string();
        let expected_fingerprint = eligibility
            .durable_evidence
            .fingerprint()
            .as_sha256()
            .to_string();
        let recovery_operation_id = Uuid::new_v4().to_string();
        let recovery_claim_id = Uuid::new_v4().to_string();
        let attachment = RecoveryGuardAttachment {
            process_generation: current_process_generation.clone(),
            runtime_instance_id: checkout.runtime_instance_id().to_string(),
            registry_slot_generation: checkout.slot_generation(),
            checkout_generation: checkout.checkout_generation(),
            candidate_generation: eligibility.candidate_generation,
            eligibility_generation: eligibility.eligibility_generation,
            source: RecoveryOwnershipSource::TakeoverOwnership,
        };
        let saved = (
            eligibility.monotonic_confirmation_elapsed,
            eligibility.registry_slot_generation,
            eligibility.creator_process_generation,
            eligibility.candidate_generation,
            eligibility.eligibility_generation,
            eligibility.reason,
        );
        let context = RecoveryOwnershipContext::seal(
            eligibility.durable_evidence,
            recovery_operation_id.clone(),
            recovery_claim_id.clone(),
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        let mut connection = match self.database_provider.open_ownership() {
            Ok(connection) => connection,
            Err(_) => {
                let evidence = context.into_evidence();
                let restored = self.registry.restore_claim_ownership_checkout(checkout);
                if restored {
                    self.state
                        .lock()
                        .expect("ownership supervisor state")
                        .eligibility
                        .insert(
                            claim_id.to_string(),
                            RecoveryHandoffEligibility {
                                durable_evidence: evidence,
                                monotonic_confirmation_elapsed: saved.0,
                                registry_slot_generation: saved.1,
                                creator_process_generation: saved.2,
                                candidate_generation: saved.3,
                                eligibility_generation: saved.4,
                                reason: saved.5,
                            },
                        );
                }
                return RecoveryOwnershipAcquisitionResult::AuthorityUnavailable;
            }
        };
        let write_result = replace_abandoned_claim_for_recovery(
            &mut connection,
            &self.ownership_context,
            &context,
        );
        drop(connection);
        #[cfg(test)]
        let response_lost = matches!(fault, Some(RecoveryTakeoverFault::ResponseLostAfterCommit));
        #[cfg(not(test))]
        let response_lost = false;
        let writer_reported_success = write_result.is_ok() && !response_lost;

        let fresh_proof = self
            .database_provider
            .open_read_only()
            .ok()
            .and_then(|connection| {
                read_recovery_ownership_proof(
                    &connection,
                    &predecessor_operation_id,
                    &recovery_operation_id,
                    &current_process_generation,
                )
                .ok()
            });
        let mut proof = match (writer_reported_success, fresh_proof) {
            (_, Some(proof)) => proof,
            (true, None) => {
                let _ = self.registry.complete_recovery_takeover_checkout(
                    checkout,
                    RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined,
                    &recovery_operation_id,
                    &recovery_claim_id,
                    &current_process_generation,
                );
                return RecoveryOwnershipAcquisitionResult::RecoveryTakeoverQuarantined;
            }
            (false, None) => {
                let old_is_intact = self
                    .database_provider
                    .open_read_only()
                    .ok()
                    .and_then(|connection| {
                        inspect_durable_claim(&connection, &predecessor_operation_id).ok()
                    })
                    .and_then(|observation| observation.create_abandonment_fingerprint())
                    .is_some_and(|fingerprint| fingerprint.as_sha256() == expected_fingerprint);
                if old_is_intact {
                    let evidence = context.into_evidence();
                    if self.registry.restore_claim_ownership_checkout(checkout) {
                        self.state
                            .lock()
                            .expect("ownership supervisor state")
                            .eligibility
                            .insert(
                                claim_id.to_string(),
                                RecoveryHandoffEligibility {
                                    durable_evidence: evidence,
                                    monotonic_confirmation_elapsed: saved.0,
                                    registry_slot_generation: saved.1,
                                    creator_process_generation: saved.2,
                                    candidate_generation: saved.3,
                                    eligibility_generation: saved.4,
                                    reason: saved.5,
                                },
                            );
                        return RecoveryOwnershipAcquisitionResult::KnownNotCommitted;
                    }
                } else {
                    let _ = self.registry.complete_claim_ownership_checkout(
                        checkout,
                        RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined,
                        None,
                    );
                }
                return RecoveryOwnershipAcquisitionResult::RecoveryTakeoverQuarantined;
            }
        };
        if !self.registry.complete_recovery_takeover_checkout(
            checkout,
            RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached,
            &recovery_operation_id,
            &recovery_claim_id,
            &current_process_generation,
        ) {
            return RecoveryOwnershipAcquisitionResult::RecoveryTakeoverQuarantined;
        }
        let fail_first_attachment = {
            #[cfg(test)]
            {
                matches!(fault, Some(RecoveryTakeoverFault::AttachmentFailsOnce))
            }
            #[cfg(not(test))]
            {
                false
            }
        };
        let mut attached = !fail_first_attachment
            && self.registry.attach_committed_recovery_ownership(
                &recovery_claim_id,
                attachment.registry_slot_generation,
            );
        if !attached {
            if let Some(reconstructed) =
                self.database_provider
                    .open_read_only()
                    .ok()
                    .and_then(|connection| {
                        read_recovery_ownership_proof(
                            &connection,
                            &predecessor_operation_id,
                            &recovery_operation_id,
                            &current_process_generation,
                        )
                        .ok()
                    })
            {
                proof = reconstructed;
                attached = self.registry.attach_committed_recovery_ownership(
                    &recovery_claim_id,
                    attachment.registry_slot_generation,
                );
            }
        }
        if !attached {
            let _ = self.registry.quarantine_committed_recovery_ownership(
                &recovery_claim_id,
                attachment.registry_slot_generation,
            );
            return RecoveryOwnershipAcquisitionResult::RecoveryTakeoverQuarantined;
        }
        self.state
            .lock()
            .expect("ownership supervisor state")
            .recovery_guards
            .insert(recovery_claim_id, RecoveryGuard { proof, attachment });
        RecoveryOwnershipAcquisitionResult::RecoveryOwnershipAcquiredExecutionNotStarted
    }

    /// SE1 primitive. It consumes one P1-04 Recovery guard and atomically
    /// creates a non-empty executable successor. There is intentionally no
    /// production caller, worker, timer, Tauri command, or UI entry.
    pub(crate) fn inspect_recovery_execution_planning_facts(
        &self,
        recovery_claim_id: &str,
    ) -> Option<RecoveryExecutionPlanningFacts> {
        let state = self.state.lock().ok()?;
        let guard = state.recovery_guards.get(recovery_claim_id)?;
        let connection = self.database_provider.open_read_only().ok()?;
        let fresh = match guard.attachment.source {
            RecoveryOwnershipSource::InitialRootOwnership => read_initial_recovery_ownership_proof(
                &connection,
                RecoveryInitializationKind::InitialRoot,
                None,
                guard.proof.recovery_operation_id(),
                guard.proof.recovery_claim_owner_token(),
            ),
            RecoveryOwnershipSource::SuccessorRecoveryOwnership => {
                read_initial_recovery_ownership_proof(
                    &connection,
                    RecoveryInitializationKind::CompletedSuccessor,
                    Some(guard.proof.predecessor_operation_id()),
                    guard.proof.recovery_operation_id(),
                    guard.proof.recovery_claim_owner_token(),
                )
            }
            RecoveryOwnershipSource::TakeoverOwnership => read_recovery_ownership_proof(
                &connection,
                guard.proof.predecessor_operation_id(),
                guard.proof.recovery_operation_id(),
                guard.proof.recovery_claim_owner_token(),
            ),
        }
        .ok()?;
        if fresh.recovery_claim_id() != recovery_claim_id
            || fresh.recovery_claim_revision() != guard.proof.recovery_claim_revision()
            || fresh.recovery_plan_identity_fingerprint()
                != guard.proof.recovery_plan_identity_fingerprint()
        {
            return None;
        }
        let attempt = read_operation_attempt(&connection, fresh.recovery_operation_id())
            .ok()
            .flatten()?;
        let plan = read_attempt_plan(&connection, fresh.recovery_operation_id())
            .ok()
            .flatten()?;
        let adapter_step_offset = match guard.attachment.source {
            RecoveryOwnershipSource::InitialRootOwnership
            | RecoveryOwnershipSource::SuccessorRecoveryOwnership => {
                let ownership_steps =
                    crate::db::manuscript_provisioning_operation_state::read_attempt_step_progress(
                        &connection,
                        fresh.recovery_operation_id(),
                    )
                    .ok()?;
                if plan.step_count != 0 || !ownership_steps.is_empty() {
                    return None;
                }
                0
            }
            RecoveryOwnershipSource::TakeoverOwnership => {
                let predecessor_steps =
                    crate::db::manuscript_provisioning_operation_state::read_attempt_step_progress(
                        &connection,
                        fresh.predecessor_operation_id(),
                    )
                    .ok()?;
                let offset = predecessor_steps
                    .iter()
                    .take_while(|step| step.boundary.as_str() == "converged")
                    .count();
                let remaining_are_fresh_intended =
                    predecessor_steps.iter().skip(offset).all(|step| {
                        step.boundary.as_str() == "intended"
                            && step.effect_outcome.as_str() == "unobserved"
                            && step.readback_outcome.as_str() == "not-run"
                    });
                if !remaining_are_fresh_intended || offset == predecessor_steps.len() {
                    return None;
                }
                offset
            }
        };
        Some(RecoveryExecutionPlanningFacts {
            recovery_operation_id: attempt.operation_id,
            recovery_attempt_revision: attempt.revision,
            owner_type: attempt.owner_type,
            owner_id: attempt.owner_id,
            scope_kind: attempt.scope_kind,
            manuscript_channel: attempt.manuscript_channel,
            plan_template_kind: plan.plan_template_kind,
            fingerprint_profile: plan.fingerprint_profile,
            canonical_resource_identity_hash: plan.canonical_resource_identity_hash,
            canonical_placement_identity_hash: plan.canonical_placement_identity_hash,
            parent_shared_identity_hash: plan.parent_shared_identity_hash,
            adapter_step_offset,
        })
    }

    pub(crate) fn materialize_recovery_execution(
        &self,
        recovery_claim_id: &str,
        execution_operation_id: String,
        execution_claim_id: String,
        durable_plan: DurableStepPlanInput,
        durable_steps: Vec<DurableStepSkeletonInput>,
        occurred_at: String,
    ) -> Result<MaterializedRecoveryExecution, RecoveryExecutionMaterializationResult> {
        let guard = self
            .state
            .lock()
            .expect("ownership supervisor state")
            .recovery_guards
            .remove(recovery_claim_id)
            .ok_or(RecoveryExecutionMaterializationResult::AuthorityUnavailable)?;
        let RecoveryGuard { proof, attachment } = guard;
        let source_generation_valid = match attachment.source {
            RecoveryOwnershipSource::InitialRootOwnership
            | RecoveryOwnershipSource::SuccessorRecoveryOwnership => {
                attachment.checkout_generation == 0
                    && attachment.candidate_generation == 0
                    && attachment.eligibility_generation == 0
            }
            RecoveryOwnershipSource::TakeoverOwnership => {
                attachment.checkout_generation > 0
                    && attachment.candidate_generation > 0
                    && attachment.eligibility_generation > 0
            }
        };
        if attachment.process_generation != self.ownership_context.claim_owner_token()
            || attachment.registry_slot_generation == 0
            || attachment.runtime_instance_id.is_empty()
            || !source_generation_valid
            || proof.recovery_claim_id() != recovery_claim_id
        {
            let _ = self
                .registry
                .quarantine_recovery_owned(recovery_claim_id, attachment.registry_slot_generation);
            return Err(RecoveryExecutionMaterializationResult::Quarantined);
        }
        let recovery_operation_id = proof.recovery_operation_id().to_string();
        let expected_owner_token = proof.recovery_claim_owner_token().to_string();
        let context = RecoveryExecutionTransitionContext::seal(
            proof,
            execution_operation_id.clone(),
            execution_claim_id.clone(),
            durable_plan,
            durable_steps,
            occurred_at,
        );
        let write_result = self
            .database_provider
            .open_ownership()
            .map_err(|_| RecoveryExecutionMaterializationResult::AuthorityUnavailable)
            .and_then(|mut connection| {
                transition_recovery_ownership_to_execution(
                    &mut connection,
                    &self.ownership_context,
                    context,
                )
                .map_err(|_| RecoveryExecutionMaterializationResult::KnownNotCommitted)
            });
        let execution_proof = match write_result {
            Ok(proof) => proof,
            Err(result) => {
                let fresh_execution =
                    self.database_provider
                        .open_read_only()
                        .ok()
                        .and_then(|connection| {
                            read_recovery_execution_ownership_proof(
                                &connection,
                                &recovery_operation_id,
                                &execution_operation_id,
                                &expected_owner_token,
                            )
                            .ok()
                        });
                if let Some(proof) = fresh_execution {
                    proof
                } else {
                    let fresh_recovery =
                        self.database_provider
                            .open_read_only()
                            .ok()
                            .and_then(|connection| {
                                read_recovery_ownership_proof(
                                    &connection,
                                    proof_predecessor_id_from_recovery(
                                        &connection,
                                        &recovery_operation_id,
                                    )?
                                    .as_str(),
                                    &recovery_operation_id,
                                    &expected_owner_token,
                                )
                                .ok()
                            });
                    if let Some(proof) = fresh_recovery {
                        self.state
                            .lock()
                            .expect("ownership supervisor state")
                            .recovery_guards
                            .insert(
                                recovery_claim_id.to_string(),
                                RecoveryGuard { proof, attachment },
                            );
                        return Err(result);
                    }
                    let _ = self.registry.quarantine_recovery_owned(
                        recovery_claim_id,
                        attachment.registry_slot_generation,
                    );
                    return Err(RecoveryExecutionMaterializationResult::Quarantined);
                }
            }
        };
        let fresh_claim = self
            .database_provider
            .open_read_only()
            .ok()
            .and_then(|connection| {
                read_active_claim_for_operation(&connection, &execution_operation_id)
                    .ok()
                    .flatten()
            })
            .ok_or(RecoveryExecutionMaterializationResult::Quarantined)?;
        let claim_proof = self
            .ownership_context
            .create_proof_from_fresh_claim(fresh_claim, attachment.registry_slot_generation)
            .map_err(|_| RecoveryExecutionMaterializationResult::Quarantined)?;
        let runtime_instance_id = Uuid::new_v4().to_string();
        let registry_attachment = self
            .registry
            .attach_recovery_execution(
                recovery_claim_id,
                attachment.registry_slot_generation,
                &execution_operation_id,
                &execution_claim_id,
                &runtime_instance_id,
                claim_proof,
            )
            .ok_or_else(|| {
                let _ = self.registry.quarantine_recovery_owned(
                    recovery_claim_id,
                    attachment.registry_slot_generation,
                );
                RecoveryExecutionMaterializationResult::Quarantined
            })?;
        Ok(MaterializedRecoveryExecution {
            proof: execution_proof,
            registry_attachment,
        })
    }

    #[cfg(test)]
    pub(crate) fn eligibility_count_for_test(&self) -> usize {
        self.state
            .lock()
            .expect("ownership supervisor state")
            .eligibility
            .len()
    }

    #[cfg(test)]
    pub(crate) fn recovery_guard_count_for_test(&self) -> usize {
        self.state
            .lock()
            .expect("ownership supervisor state")
            .recovery_guards
            .len()
    }

    fn clear_process_local_claim_state(&self, claim_id: &str) {
        let mut state = self.state.lock().expect("ownership supervisor state");
        state.candidates.remove(claim_id);
        state.eligibility.remove(claim_id);
        state.last_renew_attempt_at.remove(claim_id);
        state.consecutive_renew_failures.remove(claim_id);
    }

    #[cfg(test)]
    pub(crate) fn take_eligibility_for_test(
        &self,
        claim_id: &str,
    ) -> Option<RecoveryHandoffEligibility> {
        self.state
            .lock()
            .expect("ownership supervisor state")
            .eligibility
            .remove(claim_id)
    }
}

fn proof_predecessor_id_from_recovery(
    connection: &rusqlite::Connection,
    recovery_operation_id: &str,
) -> Option<String> {
    crate::db::manuscript_provisioning_operation_state::read_operation_attempt(
        connection,
        recovery_operation_id,
    )
    .ok()
    .flatten()
    .and_then(|attempt| attempt.previous_operation_id)
}

fn resource_for_claim(
    claim: &crate::db::manuscript_provisioning_operation_state::ProvisioningActiveClaim,
) -> RuntimeResource {
    if claim.owner_type == "literature" && claim.scope_kind == "literature-aggregate" {
        RuntimeResource::Literature {
            owner_id: claim.owner_id.clone(),
            scope: LiteratureScope::Aggregate,
        }
    } else if claim.owner_type == "literature" {
        RuntimeResource::Literature {
            owner_id: claim.owner_id.clone(),
            scope: match claim.manuscript_channel.as_deref() {
                Some("literature_outline") => LiteratureScope::Outline,
                Some("dedicated_notes") => LiteratureScope::Notes,
                _ => LiteratureScope::Aggregate,
            },
        }
    } else {
        RuntimeResource::Ordinary(ResourceKey::new(
            &claim.owner_type,
            &claim.owner_id,
            claim.manuscript_channel.as_deref().unwrap_or("primary"),
        ))
    }
}

fn event(
    operation_id: &str,
    claim_id: &str,
    result: OwnershipSupervisorTypedResult,
) -> OwnershipSupervisorEvent {
    OwnershipSupervisorEvent {
        operation_id: operation_id.to_string(),
        claim_id: claim_id.to_string(),
        result,
    }
}
