use super::core::RuntimeResource;
use super::feedback::{
    ActiveOperationSummary, FeedbackAuthority, RuntimeFeedback, RuntimeNextAction,
    RuntimeSafeErrorCode,
};
use super::literature_gate::{LiteratureGateRegistry, LiteratureScope};
use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
    ClaimOwnershipProof, ClaimOwnershipSnapshot,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceKey {
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
}

impl ResourceKey {
    pub(crate) fn new(owner_type: &str, owner_id: &str, manuscript_channel: &str) -> Self {
        Self {
            owner_type: owner_type.to_string(),
            owner_id: owner_id.to_string(),
            manuscript_channel: manuscript_channel.to_string(),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        !self.owner_type.trim().is_empty()
            && !self.owner_id.trim().is_empty()
            && !self.manuscript_channel.trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SlotLease {
    Ordinary(ResourceKey),
    Literature {
        owner_id: String,
        scope: LiteratureScope,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeSlotKind {
    Mutation,
    RecoveryDecision,
}

#[derive(Debug)]
enum SlotStage {
    LocalPending,
    Claimed {
        operation_id: String,
        phase: String,
        classification: String,
        abandoned: bool,
    },
    RuntimeOwned {
        operation_id: String,
        claim_id: String,
        runtime_instance_id: String,
        process_generation: String,
        ownership_proof: Option<ClaimOwnershipProof>,
        lifecycle: RuntimeRegistryLifecycle,
        checkout_generation: Option<u64>,
        checkout_previous_lifecycle: Option<RuntimeRegistryLifecycle>,
        quarantine_allows_live_restore: bool,
        cancellation_requested: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeRegistryLifecycle {
    Live,
    ExecutionOwned,
    StepExecutionInFlight,
    Exiting,
    Retained,
    Quarantined,
    DroppedUnclosed,
    OrphanedDurableClaim,
    RenewInFlight,
    InspectionInFlight,
    ClassificationInFlight,
    OwnershipExpiredCandidate,
    AbandonedEligible,
    TakeoverInFlight,
    RecoveryOwnershipCommittedButUnattached,
    RecoveryOwned,
    RecoveryTakeoverQuarantined,
    Closed,
}

/// Process-local attachment for one executable Recovery successor. It is
/// deliberately non-Clone and non-Serde.
#[derive(Debug)]
pub(crate) struct RecoveryExecutionRegistryAttachment {
    lease: SlotLease,
    registry_generation: u64,
    execution_generation: u64,
    runtime_instance_id: String,
    operation_id: String,
    claim_id: String,
}

impl RecoveryExecutionRegistryAttachment {
    pub(crate) fn registry_generation(&self) -> u64 {
        self.registry_generation
    }

    pub(crate) fn execution_generation(&self) -> u64 {
        self.execution_generation
    }

    pub(crate) fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn claim_id(&self) -> &str {
        &self.claim_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimOwnershipCheckoutAction {
    Renew,
    Inspect,
    Classify,
    Takeover,
}

/// One-use Registry checkout. The non-Clone proof is physically removed from
/// the slot while SQLite I/O runs, so the same proof cannot be consumed by two
/// concurrent supervisor ticks.
#[derive(Debug)]
pub(crate) struct ClaimOwnershipCheckout {
    lease: SlotLease,
    slot_generation: u64,
    checkout_generation: u64,
    runtime_instance_id: String,
    operation_id: String,
    claim_id: String,
    process_generation: String,
    previous_lifecycle: RuntimeRegistryLifecycle,
    action: ClaimOwnershipCheckoutAction,
    proof: Option<ClaimOwnershipProof>,
    quarantine_allows_live_restore: bool,
}

impl ClaimOwnershipCheckout {
    pub(crate) fn ownership_snapshot(&self) -> Option<ClaimOwnershipSnapshot> {
        self.proof
            .as_ref()
            .map(ClaimOwnershipProof::sealed_snapshot)
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn claim_id(&self) -> &str {
        &self.claim_id
    }

    pub(crate) fn process_generation(&self) -> &str {
        &self.process_generation
    }

    pub(crate) fn slot_generation(&self) -> u64 {
        self.slot_generation
    }

    pub(crate) fn checkout_generation(&self) -> u64 {
        self.checkout_generation
    }

    pub(crate) fn previous_lifecycle(&self) -> RuntimeRegistryLifecycle {
        self.previous_lifecycle
    }

    pub(crate) fn action(&self) -> ClaimOwnershipCheckoutAction {
        self.action
    }

    pub(crate) fn allows_live_restore(&self) -> bool {
        self.quarantine_allows_live_restore
    }

    pub(crate) fn is_discovered_sentinel(&self) -> bool {
        self.runtime_instance_id.starts_with("ownership-sentinel:")
    }

    pub(crate) fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }
}

#[derive(Debug, Clone)]
pub(super) struct RuntimeRegistration {
    pub operation_id: String,
    pub claim_id: String,
    pub runtime_instance_id: String,
    pub process_generation: String,
    pub intent: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeRegistrySnapshot {
    pub resource: ResourceKey,
    pub operation_id: String,
    pub claim_id: String,
    pub runtime_instance_id: String,
    pub process_generation: String,
    pub claim_revision: Option<i64>,
    pub generation: u64,
    pub lifecycle: RuntimeRegistryLifecycle,
    pub cancellation_requested: bool,
    pub subscription_count: usize,
}

#[derive(Debug)]
struct SlotEntry {
    resource: ResourceKey,
    slot_kind: RuntimeSlotKind,
    intent: String,
    generation: u64,
    started_at_ms: i64,
    stage: SlotStage,
}

impl SlotEntry {
    fn summary(&self) -> ActiveOperationSummary {
        match &self.stage {
            SlotStage::LocalPending => ActiveOperationSummary::LocalPending {
                authority: FeedbackAuthority::RuntimeLocal,
                resource: self.resource.clone(),
                intent: self.intent.clone(),
                generation: self.generation,
                started_at_ms: self.started_at_ms,
                operation_id: None,
            },
            SlotStage::Claimed {
                operation_id,
                phase,
                classification,
                ..
            } => ActiveOperationSummary::ClaimedActive {
                authority: FeedbackAuthority::DurableOperationState,
                resource: self.resource.clone(),
                intent: self.intent.clone(),
                generation: self.generation,
                started_at_ms: self.started_at_ms,
                operation_id: operation_id.clone(),
                phase: phase.clone(),
                classification: classification.clone(),
            },
            SlotStage::RuntimeOwned {
                operation_id,
                lifecycle,
                ..
            } => ActiveOperationSummary::ClaimedActive {
                authority: FeedbackAuthority::DurableOperationState,
                resource: self.resource.clone(),
                intent: self.intent.clone(),
                generation: self.generation,
                started_at_ms: self.started_at_ms,
                operation_id: operation_id.clone(),
                phase: "runtime-owned".to_string(),
                classification: format!("{lifecycle:?}").to_ascii_lowercase(),
            },
        }
    }
}

#[derive(Debug, Default)]
struct SlotState {
    shutting_down: bool,
    next_generation: u64,
    next_checkout_generation: u64,
    next_execution_generation: u64,
    ordinary: HashMap<ResourceKey, SlotEntry>,
    literature: LiteratureGateRegistry<SlotEntry>,
    runtime_subscriptions: HashMap<String, HashSet<String>>,
}

#[derive(Debug, Default)]
pub(super) struct SlotCoordinator {
    state: Mutex<SlotState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SlotSnapshot {
    pub ordinary_count: usize,
    pub literature_count: usize,
    pub abandoned_count: usize,
    pub shutting_down: bool,
}

impl SlotCoordinator {
    fn entry_mut<'a>(state: &'a mut SlotState, lease: &SlotLease) -> Option<&'a mut SlotEntry> {
        match lease {
            SlotLease::Ordinary(key) => state.ordinary.get_mut(key),
            SlotLease::Literature { owner_id, scope } => state.literature.get_mut(owner_id, *scope),
        }
    }

    fn entry_ref<'a>(state: &'a SlotState, lease: &SlotLease) -> Option<&'a SlotEntry> {
        match lease {
            SlotLease::Ordinary(key) => state.ordinary.get(key),
            SlotLease::Literature { owner_id, scope } => state.literature.get(owner_id, *scope),
        }
    }

    fn entry<'a>(state: &'a SlotState, lease: &SlotLease) -> Option<&'a SlotEntry> {
        match lease {
            SlotLease::Ordinary(key) => state.ordinary.get(key),
            SlotLease::Literature { owner_id, scope } => state.literature.get(owner_id, *scope),
        }
    }

    pub(super) fn register_runtime_handle(
        &self,
        resource: &RuntimeResource,
        registration: RuntimeRegistration,
        started_at_ms: i64,
    ) -> Result<(SlotLease, u64), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.shutting_down {
            return Err(());
        }
        let resource_conflict = match resource {
            RuntimeResource::Ordinary(key) => state.ordinary.get(key).is_some(),
            RuntimeResource::Literature { owner_id, scope } => {
                state.literature.conflict_ref(owner_id, *scope).is_some()
            }
        };
        let claim_conflict = state
            .ordinary
            .values()
            .chain(state.literature.entries())
            .any(|entry| {
                matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned { claim_id, .. }
                        if claim_id == registration.claim_id.as_str()
                )
            });
        if resource_conflict || claim_conflict {
            return Err(());
        }
        state.next_generation = state.next_generation.saturating_add(1);
        let generation = state.next_generation;
        let entry = SlotEntry {
            resource: resource.safe_resource_key(),
            slot_kind: RuntimeSlotKind::Mutation,
            intent: registration.intent,
            generation,
            started_at_ms,
            stage: SlotStage::RuntimeOwned {
                operation_id: registration.operation_id,
                claim_id: registration.claim_id,
                runtime_instance_id: registration.runtime_instance_id,
                process_generation: registration.process_generation,
                ownership_proof: None,
                lifecycle: RuntimeRegistryLifecycle::Live,
                checkout_generation: None,
                checkout_previous_lifecycle: None,
                quarantine_allows_live_restore: false,
                cancellation_requested: false,
            },
        };
        let lease = match resource {
            RuntimeResource::Ordinary(key) => {
                state.ordinary.insert(key.clone(), entry);
                SlotLease::Ordinary(key.clone())
            }
            RuntimeResource::Literature { owner_id, scope } => {
                state.literature.insert(owner_id, *scope, entry);
                SlotLease::Literature {
                    owner_id: owner_id.clone(),
                    scope: *scope,
                }
            }
        };
        Ok((lease, generation))
    }

    pub(super) fn validate_runtime_handle(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
        allowed: &[RuntimeRegistryLifecycle],
    ) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        Self::entry(&state, lease).is_some_and(|entry| {
            entry.generation == generation
                && matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned {
                        runtime_instance_id: current,
                        lifecycle,
                        ..
                    } if current == runtime_instance_id && allowed.contains(lifecycle)
                )
        })
    }

    pub(super) fn transition_runtime_handle(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
        expected: RuntimeRegistryLifecycle,
        target: RuntimeRegistryLifecycle,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, lease) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        let SlotStage::RuntimeOwned {
            runtime_instance_id: current,
            lifecycle,
            ownership_proof,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        if current != runtime_instance_id || *lifecycle != expected {
            return false;
        }
        *lifecycle = target;
        *checkout_generation = None;
        *checkout_previous_lifecycle = None;
        if matches!(
            target,
            RuntimeRegistryLifecycle::Quarantined
                | RuntimeRegistryLifecycle::DroppedUnclosed
                | RuntimeRegistryLifecycle::OrphanedDurableClaim
                | RuntimeRegistryLifecycle::OwnershipExpiredCandidate
                | RuntimeRegistryLifecycle::AbandonedEligible
                | RuntimeRegistryLifecycle::Closed
        ) {
            *ownership_proof = None;
        }
        *quarantine_allows_live_restore = false;
        true
    }

    pub(super) fn install_claim_ownership_proof(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
        proof: ClaimOwnershipProof,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, lease) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id: current,
            process_generation,
            ownership_proof,
            lifecycle,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        if current != runtime_instance_id
            || !matches!(
                lifecycle,
                RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Retained
            )
            || ownership_proof.is_some()
            || proof.operation_id() != operation_id
            || proof.claim_id() != claim_id
            || proof.process_generation() != process_generation
            || proof.registry_slot_generation() != generation
        {
            return false;
        }
        *ownership_proof = Some(proof);
        true
    }

    pub(super) fn claim_ownership_snapshot(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
    ) -> Option<ClaimOwnershipSnapshot> {
        let state = self.state.lock().ok()?;
        let entry = Self::entry(&state, lease)?;
        if entry.generation != generation {
            return None;
        }
        let SlotStage::RuntimeOwned {
            runtime_instance_id: current,
            ownership_proof: Some(proof),
            lifecycle,
            ..
        } = &entry.stage
        else {
            return None;
        };
        if current != runtime_instance_id
            || !matches!(
                lifecycle,
                RuntimeRegistryLifecycle::Live
                    | RuntimeRegistryLifecycle::Exiting
                    | RuntimeRegistryLifecycle::Retained
            )
        {
            return None;
        }
        Some(proof.sealed_snapshot())
    }

    pub(super) fn replace_claim_ownership_proof(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
        expected_claim_revision: i64,
        new_proof: ClaimOwnershipProof,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, lease) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id: current,
            process_generation,
            ownership_proof,
            lifecycle,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        let old_matches = ownership_proof.as_ref().is_some_and(|old| {
            old.claim_revision() == expected_claim_revision
                && old.operation_id() == operation_id
                && old.claim_id() == claim_id
        });
        if current != runtime_instance_id
            || !matches!(
                lifecycle,
                RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Retained
            )
            || !old_matches
            || new_proof.claim_revision() != expected_claim_revision + 1
            || new_proof.operation_id() != operation_id
            || new_proof.claim_id() != claim_id
            || new_proof.process_generation() != process_generation
            || new_proof.registry_slot_generation() != generation
        {
            return false;
        }
        *ownership_proof = Some(new_proof);
        true
    }

    pub(super) fn quarantine_and_invalidate_proof(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, lease) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        let SlotStage::RuntimeOwned {
            runtime_instance_id: current,
            ownership_proof,
            lifecycle,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        if current != runtime_instance_id {
            return false;
        }
        *ownership_proof = None;
        *lifecycle = RuntimeRegistryLifecycle::Quarantined;
        *checkout_generation = None;
        *checkout_previous_lifecycle = None;
        *quarantine_allows_live_restore = true;
        true
    }

    pub(super) fn mark_runtime_dropped_nonblocking(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
    ) {
        let Ok(mut state) = self.state.try_lock() else {
            return;
        };
        let Some(entry) = Self::entry_mut(&mut state, lease) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        if let SlotStage::RuntimeOwned {
            runtime_instance_id: current,
            lifecycle,
            ownership_proof,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        {
            if current == runtime_instance_id
                && matches!(
                    lifecycle,
                    RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Exiting
                )
            {
                *lifecycle = RuntimeRegistryLifecycle::DroppedUnclosed;
                *ownership_proof = None;
                *checkout_generation = None;
                *checkout_previous_lifecycle = None;
                *quarantine_allows_live_restore = false;
            }
        }
    }

    pub(super) fn remove_terminal_runtime_handle(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
    ) -> bool {
        if !self.validate_runtime_handle(
            lease,
            generation,
            runtime_instance_id,
            &[RuntimeRegistryLifecycle::Exiting],
        ) {
            return false;
        }
        self.release(lease, generation)
    }

    pub(super) fn attach_window(
        &self,
        operation_id: &str,
        window_id: &str,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let valid = Self::entry(&state, lease).is_some_and(|entry| {
            entry.generation == generation
                && matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned {
                        operation_id: current_operation,
                        runtime_instance_id: current_runtime,
                        ..
                    } if current_operation == operation_id && current_runtime == runtime_instance_id
                )
        });
        if !valid {
            return false;
        }
        state
            .runtime_subscriptions
            .entry(operation_id.to_string())
            .or_default()
            .insert(window_id.to_string())
    }

    pub(super) fn request_runtime_cancellation(
        &self,
        lease: &SlotLease,
        generation: u64,
        runtime_instance_id: &str,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, lease) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        let SlotStage::RuntimeOwned {
            runtime_instance_id: current,
            cancellation_requested,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        if current != runtime_instance_id {
            return false;
        }
        *cancellation_requested = true;
        true
    }

    pub(super) fn detach_window(&self, operation_id: &str, window_id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(subscriptions) = state.runtime_subscriptions.get_mut(operation_id) {
            subscriptions.remove(window_id);
            if subscriptions.is_empty() {
                state.runtime_subscriptions.remove(operation_id);
            }
        }
    }

    pub(super) fn runtime_registry_snapshot(
        &self,
        lease: &SlotLease,
    ) -> Option<RuntimeRegistrySnapshot> {
        let state = self.state.lock().ok()?;
        let entry = Self::entry(&state, lease)?;
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id,
            process_generation,
            lifecycle,
            cancellation_requested,
            ..
        } = &entry.stage
        else {
            return None;
        };
        Some(RuntimeRegistrySnapshot {
            resource: entry.resource.clone(),
            operation_id: operation_id.clone(),
            claim_id: claim_id.clone(),
            runtime_instance_id: runtime_instance_id.clone(),
            process_generation: process_generation.clone(),
            claim_revision: match &entry.stage {
                SlotStage::RuntimeOwned {
                    ownership_proof, ..
                } => ownership_proof
                    .as_ref()
                    .map(ClaimOwnershipProof::claim_revision),
                _ => None,
            },
            generation: entry.generation,
            lifecycle: *lifecycle,
            cancellation_requested: *cancellation_requested,
            subscription_count: state
                .runtime_subscriptions
                .get(operation_id)
                .map_or(0, HashSet::len),
        })
    }

    pub(super) fn runtime_registry_snapshot_by_operation(
        &self,
        operation_id: &str,
    ) -> Option<RuntimeRegistrySnapshot> {
        let state = self.state.lock().ok()?;
        let entry = state
            .ordinary
            .values()
            .chain(state.literature.entries())
            .find(|entry| {
                matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned {
                        operation_id: current,
                        ..
                    } if current == operation_id
                )
            })?;
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id,
            process_generation,
            lifecycle,
            cancellation_requested,
            ..
        } = &entry.stage
        else {
            return None;
        };
        Some(RuntimeRegistrySnapshot {
            resource: entry.resource.clone(),
            operation_id: operation_id.clone(),
            claim_id: claim_id.clone(),
            runtime_instance_id: runtime_instance_id.clone(),
            process_generation: process_generation.clone(),
            claim_revision: match &entry.stage {
                SlotStage::RuntimeOwned {
                    ownership_proof, ..
                } => ownership_proof
                    .as_ref()
                    .map(ClaimOwnershipProof::claim_revision),
                _ => None,
            },
            generation: entry.generation,
            lifecycle: *lifecycle,
            cancellation_requested: *cancellation_requested,
            subscription_count: state
                .runtime_subscriptions
                .get(operation_id)
                .map_or(0, HashSet::len),
        })
    }

    pub(super) fn runtime_registry_candidates(&self) -> Vec<RuntimeRegistrySnapshot> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        state
            .ordinary
            .values()
            .chain(state.literature.entries())
            .filter_map(|entry| {
                let SlotStage::RuntimeOwned {
                    operation_id,
                    claim_id,
                    runtime_instance_id,
                    process_generation,
                    lifecycle,
                    cancellation_requested,
                    ownership_proof,
                    ..
                } = &entry.stage
                else {
                    return None;
                };
                Some(RuntimeRegistrySnapshot {
                    resource: entry.resource.clone(),
                    operation_id: operation_id.clone(),
                    claim_id: claim_id.clone(),
                    runtime_instance_id: runtime_instance_id.clone(),
                    process_generation: process_generation.clone(),
                    claim_revision: ownership_proof
                        .as_ref()
                        .map(ClaimOwnershipProof::claim_revision),
                    generation: entry.generation,
                    lifecycle: *lifecycle,
                    cancellation_requested: *cancellation_requested,
                    subscription_count: state
                        .runtime_subscriptions
                        .get(operation_id)
                        .map_or(0, HashSet::len),
                })
            })
            .collect()
    }

    pub(super) fn register_durable_sentinel(
        &self,
        resource: &RuntimeResource,
        operation_id: &str,
        claim_id: &str,
        claim_owner_token: &str,
        lifecycle: RuntimeRegistryLifecycle,
        started_at_ms: i64,
    ) -> Result<(SlotLease, u64, String), ()> {
        if !matches!(
            lifecycle,
            RuntimeRegistryLifecycle::Retained
                | RuntimeRegistryLifecycle::Quarantined
                | RuntimeRegistryLifecycle::DroppedUnclosed
                | RuntimeRegistryLifecycle::OrphanedDurableClaim
                | RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached
        ) {
            return Err(());
        }
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.shutting_down {
            return Err(());
        }
        let resource_conflict = match resource {
            RuntimeResource::Ordinary(key) => state.ordinary.get(key).is_some(),
            RuntimeResource::Literature { owner_id, scope } => {
                state.literature.conflict_ref(owner_id, *scope).is_some()
            }
        };
        let claim_conflict = state
            .ordinary
            .values()
            .chain(state.literature.entries())
            .any(|entry| {
                matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned { claim_id: current, .. }
                        if current == claim_id
                )
            });
        if resource_conflict || claim_conflict {
            return Err(());
        }
        state.next_generation = state.next_generation.checked_add(1).ok_or(())?;
        let generation = state.next_generation;
        let runtime_instance_id = format!("ownership-sentinel:{claim_id}:{generation}");
        let entry = SlotEntry {
            resource: resource.safe_resource_key(),
            slot_kind: RuntimeSlotKind::Mutation,
            intent: "ownership-supervisor-sentinel".to_string(),
            generation,
            started_at_ms,
            stage: SlotStage::RuntimeOwned {
                operation_id: operation_id.to_string(),
                claim_id: claim_id.to_string(),
                runtime_instance_id: runtime_instance_id.clone(),
                process_generation: claim_owner_token.to_string(),
                ownership_proof: None,
                lifecycle,
                checkout_generation: None,
                checkout_previous_lifecycle: None,
                quarantine_allows_live_restore: false,
                cancellation_requested: false,
            },
        };
        let lease = match resource {
            RuntimeResource::Ordinary(key) => {
                state.ordinary.insert(key.clone(), entry);
                SlotLease::Ordinary(key.clone())
            }
            RuntimeResource::Literature { owner_id, scope } => {
                state.literature.insert(owner_id, *scope, entry);
                SlotLease::Literature {
                    owner_id: owner_id.clone(),
                    scope: *scope,
                }
            }
        };
        Ok((lease, generation, runtime_instance_id))
    }

    pub(super) fn committed_recovery_attachment_identity(
        &self,
        claim_id: &str,
        expected_process_generation: &str,
    ) -> Option<(u64, String, RuntimeRegistryLifecycle)> {
        let state = self.state.lock().ok()?;
        let lease = Self::runtime_lease_by_claim(&state, claim_id)?;
        let entry = Self::entry_ref(&state, &lease)?;
        let SlotStage::RuntimeOwned {
            process_generation,
            runtime_instance_id,
            lifecycle,
            ..
        } = &entry.stage
        else {
            return None;
        };
        (process_generation == expected_process_generation
            && matches!(
                lifecycle,
                RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached
                    | RuntimeRegistryLifecycle::RecoveryOwned
            ))
        .then(|| (entry.generation, runtime_instance_id.clone(), *lifecycle))
    }

    fn runtime_lease_by_claim(state: &SlotState, claim_id: &str) -> Option<SlotLease> {
        if let Some((key, _)) = state.ordinary.iter().find(|(_, entry)| {
            matches!(
                &entry.stage,
                SlotStage::RuntimeOwned { claim_id: current, .. } if current == claim_id
            )
        }) {
            return Some(SlotLease::Ordinary(key.clone()));
        }
        for owner_id in state.literature.owner_ids() {
            for scope in [
                LiteratureScope::Aggregate,
                LiteratureScope::Outline,
                LiteratureScope::Notes,
            ] {
                if state.literature.get(&owner_id, scope).is_some_and(|entry| {
                    matches!(
                        &entry.stage,
                        SlotStage::RuntimeOwned { claim_id: current, .. }
                            if current == claim_id
                    )
                }) {
                    return Some(SlotLease::Literature { owner_id, scope });
                }
            }
        }
        None
    }

    pub(super) fn checkout_claim_ownership(
        &self,
        claim_id: &str,
        action: ClaimOwnershipCheckoutAction,
    ) -> Result<ClaimOwnershipCheckout, RuntimeRegistryLifecycle> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| RuntimeRegistryLifecycle::Quarantined)?;
        let lease = Self::runtime_lease_by_claim(&state, claim_id)
            .ok_or(RuntimeRegistryLifecycle::Closed)?;
        state.next_checkout_generation = state
            .next_checkout_generation
            .checked_add(1)
            .ok_or(RuntimeRegistryLifecycle::Quarantined)?;
        let checkout_generation = state.next_checkout_generation;
        let entry = Self::entry_mut(&mut state, &lease).ok_or(RuntimeRegistryLifecycle::Closed)?;
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id,
            process_generation,
            ownership_proof,
            lifecycle,
            checkout_generation: current_checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return Err(RuntimeRegistryLifecycle::Quarantined);
        };
        let allowed = match action {
            ClaimOwnershipCheckoutAction::Renew => {
                matches!(
                    lifecycle,
                    RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Retained
                ) && ownership_proof.is_some()
            }
            ClaimOwnershipCheckoutAction::Inspect => matches!(
                lifecycle,
                RuntimeRegistryLifecycle::DroppedUnclosed
                    | RuntimeRegistryLifecycle::OrphanedDurableClaim
                    | RuntimeRegistryLifecycle::OwnershipExpiredCandidate
            ),
            ClaimOwnershipCheckoutAction::Classify => {
                *lifecycle == RuntimeRegistryLifecycle::Quarantined
            }
            ClaimOwnershipCheckoutAction::Takeover => {
                *lifecycle == RuntimeRegistryLifecycle::AbandonedEligible
                    && ownership_proof.is_none()
            }
        };
        if !allowed || current_checkout_generation.is_some() {
            return Err(*lifecycle);
        }
        let previous_lifecycle = *lifecycle;
        let in_flight = match action {
            ClaimOwnershipCheckoutAction::Renew => RuntimeRegistryLifecycle::RenewInFlight,
            ClaimOwnershipCheckoutAction::Inspect => RuntimeRegistryLifecycle::InspectionInFlight,
            ClaimOwnershipCheckoutAction::Classify => {
                RuntimeRegistryLifecycle::ClassificationInFlight
            }
            ClaimOwnershipCheckoutAction::Takeover => RuntimeRegistryLifecycle::TakeoverInFlight,
        };
        *lifecycle = in_flight;
        *current_checkout_generation = Some(checkout_generation);
        *checkout_previous_lifecycle = Some(previous_lifecycle);
        Ok(ClaimOwnershipCheckout {
            lease,
            slot_generation: entry.generation,
            checkout_generation,
            runtime_instance_id: runtime_instance_id.clone(),
            operation_id: operation_id.clone(),
            claim_id: claim_id.clone(),
            process_generation: process_generation.clone(),
            previous_lifecycle,
            action,
            proof: ownership_proof.take(),
            quarantine_allows_live_restore: *quarantine_allows_live_restore,
        })
    }

    fn checkout_matches(entry: &SlotEntry, checkout: &ClaimOwnershipCheckout) -> bool {
        if entry.generation != checkout.slot_generation {
            return false;
        }
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id,
            lifecycle,
            checkout_generation,
            checkout_previous_lifecycle,
            ..
        } = &entry.stage
        else {
            return false;
        };
        let expected_in_flight = match checkout.action {
            ClaimOwnershipCheckoutAction::Renew => RuntimeRegistryLifecycle::RenewInFlight,
            ClaimOwnershipCheckoutAction::Inspect => RuntimeRegistryLifecycle::InspectionInFlight,
            ClaimOwnershipCheckoutAction::Classify => {
                RuntimeRegistryLifecycle::ClassificationInFlight
            }
            ClaimOwnershipCheckoutAction::Takeover => RuntimeRegistryLifecycle::TakeoverInFlight,
        };
        operation_id == &checkout.operation_id
            && claim_id == &checkout.claim_id
            && runtime_instance_id == &checkout.runtime_instance_id
            && *lifecycle == expected_in_flight
            && *checkout_generation == Some(checkout.checkout_generation)
            && *checkout_previous_lifecycle == Some(checkout.previous_lifecycle)
    }

    pub(super) fn restore_claim_ownership_checkout(
        &self,
        checkout: ClaimOwnershipCheckout,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &checkout.lease) else {
            return false;
        };
        if !Self::checkout_matches(entry, &checkout) {
            return false;
        }
        let SlotStage::RuntimeOwned {
            ownership_proof,
            lifecycle,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        *ownership_proof = checkout.proof;
        *lifecycle = checkout.previous_lifecycle;
        *checkout_generation = None;
        *checkout_previous_lifecycle = None;
        *quarantine_allows_live_restore = checkout.quarantine_allows_live_restore;
        true
    }

    pub(super) fn complete_claim_ownership_checkout(
        &self,
        checkout: ClaimOwnershipCheckout,
        target: RuntimeRegistryLifecycle,
        new_proof: Option<ClaimOwnershipProof>,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &checkout.lease) else {
            return false;
        };
        if !Self::checkout_matches(entry, &checkout) {
            return false;
        }
        let proof_is_valid = match target {
            RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Retained => {
                new_proof.as_ref().is_some_and(|proof| {
                    proof.claim_id() == checkout.claim_id
                        && proof.operation_id() == checkout.operation_id
                        && proof.registry_slot_generation() == checkout.slot_generation
                })
            }
            _ => new_proof.is_none(),
        };
        if !proof_is_valid {
            return false;
        }
        let SlotStage::RuntimeOwned {
            ownership_proof,
            lifecycle,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        *ownership_proof = new_proof;
        *lifecycle = target;
        *checkout_generation = None;
        *checkout_previous_lifecycle = None;
        *quarantine_allows_live_restore = false;
        if target == RuntimeRegistryLifecycle::Closed {
            match &checkout.lease {
                SlotLease::Ordinary(key) => {
                    state.ordinary.remove(key);
                }
                SlotLease::Literature { owner_id, scope } => {
                    state.literature.remove_if(owner_id, *scope, |candidate| {
                        candidate.generation == checkout.slot_generation
                    });
                }
            }
        }
        true
    }

    pub(super) fn complete_recovery_takeover_checkout(
        &self,
        checkout: ClaimOwnershipCheckout,
        target: RuntimeRegistryLifecycle,
        recovery_operation_id: &str,
        recovery_claim_id: &str,
        current_process_generation: &str,
    ) -> bool {
        if !matches!(
            target,
            RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached
                | RuntimeRegistryLifecycle::RecoveryOwned
                | RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined
        ) {
            return false;
        }
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &checkout.lease) else {
            return false;
        };
        if !Self::checkout_matches(entry, &checkout) {
            return false;
        }
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            process_generation,
            ownership_proof,
            lifecycle,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        *operation_id = recovery_operation_id.to_string();
        *claim_id = recovery_claim_id.to_string();
        *process_generation = current_process_generation.to_string();
        *ownership_proof = None;
        *lifecycle = target;
        *checkout_generation = None;
        *checkout_previous_lifecycle = None;
        *quarantine_allows_live_restore = false;
        true
    }

    pub(super) fn attach_committed_recovery_ownership(
        &self,
        recovery_claim_id: &str,
        expected_slot_generation: u64,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(lease) = Self::runtime_lease_by_claim(&state, recovery_claim_id) else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &lease) else {
            return false;
        };
        if entry.generation != expected_slot_generation {
            return false;
        }
        let SlotStage::RuntimeOwned { lifecycle, .. } = &mut entry.stage else {
            return false;
        };
        if *lifecycle != RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached {
            return false;
        }
        *lifecycle = RuntimeRegistryLifecycle::RecoveryOwned;
        true
    }

    pub(super) fn attach_recovery_execution(
        &self,
        recovery_claim_id: &str,
        expected_slot_generation: u64,
        execution_operation_id: &str,
        execution_claim_id: &str,
        runtime_instance_id: &str,
        proof: ClaimOwnershipProof,
    ) -> Option<RecoveryExecutionRegistryAttachment> {
        let mut state = self.state.lock().ok()?;
        let lease = Self::runtime_lease_by_claim(&state, recovery_claim_id)?;
        state.next_execution_generation = state.next_execution_generation.checked_add(1)?;
        let execution_generation = state.next_execution_generation;
        let entry = Self::entry_mut(&mut state, &lease)?;
        if entry.generation != expected_slot_generation {
            return None;
        }
        let SlotStage::RuntimeOwned {
            operation_id,
            claim_id,
            runtime_instance_id: current_runtime_instance_id,
            process_generation,
            ownership_proof,
            lifecycle,
            checkout_generation,
            checkout_previous_lifecycle,
            quarantine_allows_live_restore,
            ..
        } = &mut entry.stage
        else {
            return None;
        };
        if *lifecycle != RuntimeRegistryLifecycle::RecoveryOwned
            || proof.operation_id() != execution_operation_id
            || proof.claim_id() != execution_claim_id
            || proof.registry_slot_generation() != expected_slot_generation
        {
            return None;
        }
        *operation_id = execution_operation_id.to_string();
        *claim_id = execution_claim_id.to_string();
        *current_runtime_instance_id = runtime_instance_id.to_string();
        *process_generation = proof.process_generation().to_string();
        *ownership_proof = Some(proof);
        *lifecycle = RuntimeRegistryLifecycle::ExecutionOwned;
        *checkout_generation = None;
        *checkout_previous_lifecycle = None;
        *quarantine_allows_live_restore = false;
        Some(RecoveryExecutionRegistryAttachment {
            lease,
            registry_generation: expected_slot_generation,
            execution_generation,
            runtime_instance_id: runtime_instance_id.to_string(),
            operation_id: execution_operation_id.to_string(),
            claim_id: execution_claim_id.to_string(),
        })
    }

    pub(crate) fn checkout_recovery_execution_step(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
    ) -> bool {
        self.transition_recovery_execution(
            attachment,
            RuntimeRegistryLifecycle::ExecutionOwned,
            RuntimeRegistryLifecycle::StepExecutionInFlight,
        )
    }

    pub(crate) fn replace_recovery_execution_claim_proof(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
        expected_claim_revision: i64,
        proof: ClaimOwnershipProof,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &attachment.lease) else {
            return false;
        };
        if !Self::recovery_execution_attachment_matches(entry, attachment) {
            return false;
        }
        let SlotStage::RuntimeOwned {
            ownership_proof,
            lifecycle,
            ..
        } = &mut entry.stage
        else {
            return false;
        };
        let current_revision = ownership_proof
            .as_ref()
            .map(ClaimOwnershipProof::claim_revision);
        if !matches!(
            *lifecycle,
            RuntimeRegistryLifecycle::ExecutionOwned
                | RuntimeRegistryLifecycle::StepExecutionInFlight
        ) || current_revision != Some(expected_claim_revision)
            || proof.operation_id() != attachment.operation_id
            || proof.claim_id() != attachment.claim_id
            || proof.registry_slot_generation() != attachment.registry_generation
        {
            return false;
        }
        *ownership_proof = Some(proof);
        true
    }

    pub(crate) fn restore_recovery_execution_step(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
    ) -> bool {
        self.transition_recovery_execution(
            attachment,
            RuntimeRegistryLifecycle::StepExecutionInFlight,
            RuntimeRegistryLifecycle::ExecutionOwned,
        )
    }

    pub(crate) fn retain_recovery_execution(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
    ) -> bool {
        self.transition_recovery_execution(
            attachment,
            RuntimeRegistryLifecycle::StepExecutionInFlight,
            RuntimeRegistryLifecycle::Retained,
        )
    }

    pub(crate) fn quarantine_recovery_execution(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
    ) -> bool {
        let current = self
            .runtime_registry_snapshot(&attachment.lease)
            .map(|snapshot| snapshot.lifecycle);
        match current {
            Some(RuntimeRegistryLifecycle::StepExecutionInFlight) => self
                .transition_recovery_execution(
                    attachment,
                    RuntimeRegistryLifecycle::StepExecutionInFlight,
                    RuntimeRegistryLifecycle::Quarantined,
                ),
            Some(RuntimeRegistryLifecycle::ExecutionOwned) => self.transition_recovery_execution(
                attachment,
                RuntimeRegistryLifecycle::ExecutionOwned,
                RuntimeRegistryLifecycle::Quarantined,
            ),
            _ => false,
        }
    }

    pub(crate) fn close_recovery_execution(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &attachment.lease) else {
            return false;
        };
        if !Self::recovery_execution_attachment_matches(entry, attachment)
            || !matches!(
                &entry.stage,
                SlotStage::RuntimeOwned {
                    lifecycle: RuntimeRegistryLifecycle::StepExecutionInFlight,
                    ..
                }
            )
        {
            return false;
        }
        match &attachment.lease {
            SlotLease::Ordinary(key) => {
                state.ordinary.remove(key);
            }
            SlotLease::Literature { owner_id, scope } => {
                state.literature.remove_if(owner_id, *scope, |candidate| {
                    candidate.generation == attachment.registry_generation
                });
            }
        }
        true
    }

    fn transition_recovery_execution(
        &self,
        attachment: &RecoveryExecutionRegistryAttachment,
        from: RuntimeRegistryLifecycle,
        to: RuntimeRegistryLifecycle,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &attachment.lease) else {
            return false;
        };
        if !Self::recovery_execution_attachment_matches(entry, attachment) {
            return false;
        }
        let SlotStage::RuntimeOwned { lifecycle, .. } = &mut entry.stage else {
            return false;
        };
        if *lifecycle != from {
            return false;
        }
        *lifecycle = to;
        true
    }

    fn recovery_execution_attachment_matches(
        entry: &SlotEntry,
        attachment: &RecoveryExecutionRegistryAttachment,
    ) -> bool {
        entry.generation == attachment.registry_generation
            && matches!(
                &entry.stage,
                SlotStage::RuntimeOwned {
                    operation_id,
                    claim_id,
                    runtime_instance_id,
                    ..
                } if operation_id == &attachment.operation_id
                    && claim_id == &attachment.claim_id
                    && runtime_instance_id == &attachment.runtime_instance_id
            )
    }

    pub(super) fn quarantine_committed_recovery_ownership(
        &self,
        recovery_claim_id: &str,
        expected_slot_generation: u64,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(lease) = Self::runtime_lease_by_claim(&state, recovery_claim_id) else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &lease) else {
            return false;
        };
        if entry.generation != expected_slot_generation {
            return false;
        }
        let SlotStage::RuntimeOwned { lifecycle, .. } = &mut entry.stage else {
            return false;
        };
        if *lifecycle != RuntimeRegistryLifecycle::RecoveryOwnershipCommittedButUnattached {
            return false;
        }
        *lifecycle = RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined;
        true
    }

    pub(super) fn quarantine_recovery_owned(
        &self,
        recovery_claim_id: &str,
        expected_slot_generation: u64,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(lease) = Self::runtime_lease_by_claim(&state, recovery_claim_id) else {
            return false;
        };
        let Some(entry) = Self::entry_mut(&mut state, &lease) else {
            return false;
        };
        if entry.generation != expected_slot_generation {
            return false;
        }
        let SlotStage::RuntimeOwned { lifecycle, .. } = &mut entry.stage else {
            return false;
        };
        if *lifecycle != RuntimeRegistryLifecycle::RecoveryOwned {
            return false;
        }
        *lifecycle = RuntimeRegistryLifecycle::RecoveryTakeoverQuarantined;
        true
    }

    pub(super) fn try_acquire(
        &self,
        resource: &RuntimeResource,
        intent: &str,
        started_at_ms: i64,
    ) -> Result<(SlotLease, u64), RuntimeFeedback> {
        self.try_acquire_kind(resource, RuntimeSlotKind::Mutation, intent, started_at_ms)
    }

    pub(super) fn try_acquire_recovery_decision(
        &self,
        resource: &RuntimeResource,
        started_at_ms: i64,
    ) -> Result<(SlotLease, u64), RuntimeFeedback> {
        self.try_acquire_kind(
            resource,
            RuntimeSlotKind::RecoveryDecision,
            "recovery-decision",
            started_at_ms,
        )
    }

    fn try_acquire_kind(
        &self,
        resource: &RuntimeResource,
        slot_kind: RuntimeSlotKind,
        intent: &str,
        started_at_ms: i64,
    ) -> Result<(SlotLease, u64), RuntimeFeedback> {
        let mut state = self.state.lock().expect("slot state lock");
        if state.shutting_down {
            return Err(RuntimeFeedback::ShuttingDown {
                authority: FeedbackAuthority::RuntimeLocal,
                next_action: RuntimeNextAction::Stop,
                safe_error_code: RuntimeSafeErrorCode::RuntimeShuttingDown,
            });
        }
        let conflict = match resource {
            RuntimeResource::Ordinary(key) => state.ordinary.get(key).map(SlotEntry::summary),
            RuntimeResource::Literature { owner_id, scope } => state
                .literature
                .conflict_ref(owner_id, *scope)
                .map(SlotEntry::summary),
        };
        if let Some(summary) = conflict {
            return Err(RuntimeFeedback::busy(summary));
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        let entry = SlotEntry {
            resource: resource.safe_resource_key(),
            slot_kind,
            intent: intent.to_string(),
            generation,
            started_at_ms,
            stage: SlotStage::LocalPending,
        };
        let lease = match resource {
            RuntimeResource::Ordinary(key) => {
                state.ordinary.insert(key.clone(), entry);
                SlotLease::Ordinary(key.clone())
            }
            RuntimeResource::Literature { owner_id, scope } => {
                state.literature.insert(owner_id, *scope, entry);
                SlotLease::Literature {
                    owner_id: owner_id.clone(),
                    scope: *scope,
                }
            }
        };
        Ok((lease, generation))
    }

    pub(super) fn promote_claimed(
        &self,
        lease: &SlotLease,
        generation: u64,
        operation_id: &str,
        phase: &str,
        classification: &str,
    ) -> Result<ActiveOperationSummary, RuntimeFeedback> {
        let mut state = self.state.lock().expect("slot state lock");
        let abandoned = state.shutting_down;
        let entry = match lease {
            SlotLease::Ordinary(key) => state.ordinary.get_mut(key),
            SlotLease::Literature { owner_id, scope } => state.literature.get_mut(owner_id, *scope),
        }
        .ok_or_else(RuntimeFeedback::invalid_lifecycle)?;
        if entry.generation != generation
            || entry.slot_kind != RuntimeSlotKind::Mutation
            || !matches!(entry.stage, SlotStage::LocalPending)
        {
            return Err(RuntimeFeedback::invalid_lifecycle());
        }
        entry.stage = SlotStage::Claimed {
            operation_id: operation_id.to_string(),
            phase: phase.to_string(),
            classification: classification.to_string(),
            abandoned,
        };
        Ok(entry.summary())
    }

    pub(super) fn release(&self, lease: &SlotLease, generation: u64) -> bool {
        let mut state = self.state.lock().expect("slot state lock");
        match lease {
            SlotLease::Ordinary(key) => {
                if state
                    .ordinary
                    .get(key)
                    .is_some_and(|entry| entry.generation == generation)
                {
                    state.ordinary.remove(key);
                    true
                } else {
                    false
                }
            }
            SlotLease::Literature { owner_id, scope } => {
                state
                    .literature
                    .remove_if(owner_id, *scope, |entry| entry.generation == generation)
            }
        }
    }

    pub(super) fn release_by_operation(&self, operation_id: &str, generation: u64) -> bool {
        let mut state = self.state.lock().expect("slot state lock");
        if let Some(key) = state.ordinary.iter().find_map(|(key, entry)| {
            matches!(
                &entry.stage,
                SlotStage::Claimed {
                    operation_id: current,
                    ..
                } if current == operation_id && entry.generation == generation
            )
            .then(|| key.clone())
        }) {
            state.ordinary.remove(&key);
            return true;
        }
        let owners = state.literature.owner_ids();
        for owner_id in owners {
            for scope in [
                LiteratureScope::Aggregate,
                LiteratureScope::Outline,
                LiteratureScope::Notes,
            ] {
                if state.literature.remove_if(&owner_id, scope, |entry| {
                    entry.generation == generation
                        && matches!(
                            &entry.stage,
                            SlotStage::Claimed {
                                operation_id: current,
                                ..
                            } if current == operation_id
                        )
                }) {
                    return true;
                }
            }
        }
        false
    }

    pub(super) fn begin_shutdown(&self) {
        let mut state = self.state.lock().expect("slot state lock");
        state.shutting_down = true;
        for entry in state.ordinary.values_mut() {
            match &mut entry.stage {
                SlotStage::Claimed { abandoned, .. } => *abandoned = true,
                SlotStage::RuntimeOwned {
                    lifecycle,
                    ownership_proof,
                    checkout_generation,
                    checkout_previous_lifecycle,
                    quarantine_allows_live_restore,
                    ..
                } if matches!(
                    lifecycle,
                    RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Exiting
                ) =>
                {
                    *lifecycle = RuntimeRegistryLifecycle::DroppedUnclosed;
                    *ownership_proof = None;
                    *checkout_generation = None;
                    *checkout_previous_lifecycle = None;
                    *quarantine_allows_live_restore = false;
                }
                _ => {}
            }
        }
        for entry in state.literature.entries_mut() {
            match &mut entry.stage {
                SlotStage::Claimed { abandoned, .. } => *abandoned = true,
                SlotStage::RuntimeOwned {
                    lifecycle,
                    ownership_proof,
                    checkout_generation,
                    checkout_previous_lifecycle,
                    quarantine_allows_live_restore,
                    ..
                } if matches!(
                    lifecycle,
                    RuntimeRegistryLifecycle::Live | RuntimeRegistryLifecycle::Exiting
                ) =>
                {
                    *lifecycle = RuntimeRegistryLifecycle::DroppedUnclosed;
                    *ownership_proof = None;
                    *checkout_generation = None;
                    *checkout_previous_lifecycle = None;
                    *quarantine_allows_live_restore = false;
                }
                _ => {}
            }
        }
    }

    pub(super) fn is_shutting_down(&self) -> bool {
        self.state.lock().expect("slot state lock").shutting_down
    }

    pub(super) fn snapshot(&self) -> SlotSnapshot {
        let state = self.state.lock().expect("slot state lock");
        let abandoned_ordinary = state
            .ordinary
            .values()
            .filter(|entry| {
                matches!(
                    &entry.stage,
                    SlotStage::Claimed {
                        abandoned: true,
                        ..
                    }
                ) || matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned {
                        lifecycle: RuntimeRegistryLifecycle::DroppedUnclosed
                            | RuntimeRegistryLifecycle::OrphanedDurableClaim
                            | RuntimeRegistryLifecycle::OwnershipExpiredCandidate
                            | RuntimeRegistryLifecycle::AbandonedEligible,
                        ..
                    }
                )
            })
            .count();
        let abandoned_literature = state
            .literature
            .entries()
            .filter(|entry| {
                matches!(
                    &entry.stage,
                    SlotStage::Claimed {
                        abandoned: true,
                        ..
                    }
                ) || matches!(
                    &entry.stage,
                    SlotStage::RuntimeOwned {
                        lifecycle: RuntimeRegistryLifecycle::DroppedUnclosed
                            | RuntimeRegistryLifecycle::OrphanedDurableClaim
                            | RuntimeRegistryLifecycle::OwnershipExpiredCandidate
                            | RuntimeRegistryLifecycle::AbandonedEligible,
                        ..
                    }
                )
            })
            .count();
        SlotSnapshot {
            ordinary_count: state.ordinary.len(),
            literature_count: state.literature.len(),
            abandoned_count: abandoned_ordinary + abandoned_literature,
            shutting_down: state.shutting_down,
        }
    }
}
