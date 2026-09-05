use super::ProvisioningActiveClaim;
use crate::provisioning_runtime_foundation::ProcessGeneration;
#[cfg(test)]
use std::sync::atomic::AtomicI64;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const LEASE_DURATION_MS: i64 = 300_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimOwnershipError {
    ClaimRevisionStale,
    ClaimOwnerMismatch,
    ProcessGenerationMismatch,
    RegistryProofStale,
    RegistryReplacementConflict,
    ClockAuthorityUnavailable,
    HeartbeatTimestampInvariantFailure,
    RepositoryBusy,
    RepositoryUnavailable,
    KnownNotCommitted,
    CommitOutcomeUnknown,
    InternalInvariantFailure,
}

pub(crate) trait RepositoryUtcClock: Send + Sync {
    fn sample_epoch_ms(&self) -> Result<i64, ClaimOwnershipError>;
}

#[derive(Debug)]
pub(crate) struct SystemRepositoryUtcClock;

impl RepositoryUtcClock for SystemRepositoryUtcClock {
    fn sample_epoch_ms(&self) -> Result<i64, ClaimOwnershipError> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ClaimOwnershipError::ClockAuthorityUnavailable)?;
        i64::try_from(elapsed.as_millis())
            .map_err(|_| ClaimOwnershipError::ClockAuthorityUnavailable)
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(crate) struct FixedRepositoryUtcClock {
    epoch_ms: AtomicI64,
}

#[cfg(test)]
impl FixedRepositoryUtcClock {
    pub(crate) fn new(epoch_ms: i64) -> Self {
        Self {
            epoch_ms: AtomicI64::new(epoch_ms),
        }
    }

    pub(crate) fn set_epoch_ms(&self, epoch_ms: i64) {
        self.epoch_ms.store(epoch_ms, Ordering::Release);
    }
}

#[cfg(test)]
impl RepositoryUtcClock for FixedRepositoryUtcClock {
    fn sample_epoch_ms(&self) -> Result<i64, ClaimOwnershipError> {
        Ok(self.epoch_ms.load(Ordering::Acquire))
    }
}

pub(crate) struct ClaimOwnershipRepositoryContext {
    process_generation: Arc<ProcessGeneration>,
    clock: Arc<dyn RepositoryUtcClock>,
    next_observation_generation: AtomicU64,
}

impl ClaimOwnershipRepositoryContext {
    pub(crate) fn new(
        process_generation: Arc<ProcessGeneration>,
        clock: Arc<dyn RepositoryUtcClock>,
    ) -> Self {
        Self {
            process_generation,
            clock,
            next_observation_generation: AtomicU64::new(0),
        }
    }

    pub(crate) fn process_generation(&self) -> &ProcessGeneration {
        &self.process_generation
    }

    pub(crate) fn claim_owner_token(&self) -> &str {
        self.process_generation.canonical()
    }

    pub(crate) fn sample_sealed_epoch_ms(&self) -> Result<i64, ClaimOwnershipError> {
        self.clock.sample_epoch_ms()
    }

    pub(crate) fn sample_sealed_heartbeat(
        &self,
    ) -> Result<SealedUtcEpochSample, ClaimOwnershipError> {
        Ok(SealedUtcEpochSample {
            epoch_ms: self.sample_sealed_epoch_ms()?,
        })
    }

    pub(crate) fn validate_heartbeat_advance(
        &self,
        last_heartbeat_at: i64,
    ) -> Result<SealedUtcEpochSample, ClaimOwnershipError> {
        let sample = self.sample_sealed_heartbeat()?;
        if sample.epoch_ms < last_heartbeat_at {
            return Err(ClaimOwnershipError::ClockAuthorityUnavailable);
        }
        Ok(sample)
    }

    pub(crate) fn create_proof_from_fresh_claim(
        &self,
        claim: ProvisioningActiveClaim,
        registry_slot_generation: u64,
    ) -> Result<ClaimOwnershipProof, ClaimOwnershipError> {
        if claim.claim_owner_token != self.claim_owner_token() {
            return Err(ClaimOwnershipError::ProcessGenerationMismatch);
        }
        let last_heartbeat_at = claim
            .last_heartbeat_at
            .parse::<i64>()
            .map_err(|_| ClaimOwnershipError::HeartbeatTimestampInvariantFailure)?;
        let observation_generation = self
            .next_observation_generation
            .fetch_add(1, Ordering::AcqRel)
            .checked_add(1)
            .ok_or(ClaimOwnershipError::InternalInvariantFailure)?;
        Ok(ClaimOwnershipProof {
            claim_id: claim.claim_id,
            operation_id: claim.operation_id,
            owner_type: claim.owner_type,
            owner_id: claim.owner_id,
            scope_kind: claim.scope_kind,
            manuscript_channel: claim.manuscript_channel,
            claim_owner_token: claim.claim_owner_token,
            claim_revision: claim.claim_revision,
            last_heartbeat_at,
            process_generation: self.process_generation.canonical().to_string(),
            repository_observation_generation: observation_generation,
            registry_slot_generation,
        })
    }
}

#[cfg(test)]
pub(crate) fn fixed_repository_context_for_test(
    process_generation: &str,
    epoch_ms: i64,
) -> ClaimOwnershipRepositoryContext {
    ClaimOwnershipRepositoryContext::new(
        Arc::new(ProcessGeneration::fixed_for_test(process_generation)),
        Arc::new(FixedRepositoryUtcClock::new(epoch_ms)),
    )
}

#[derive(Debug)]
pub(crate) struct SealedUtcEpochSample {
    epoch_ms: i64,
}

impl SealedUtcEpochSample {
    pub(crate) fn epoch_ms(&self) -> i64 {
        self.epoch_ms
    }

    pub(crate) fn persisted_value(&self) -> String {
        self.epoch_ms.to_string()
    }
}

/// Repository-derived process-local mirror. Deliberately not `Clone`, serde, or
/// externally constructible.
#[derive(Debug)]
pub(crate) struct ClaimOwnershipProof {
    claim_id: String,
    operation_id: String,
    owner_type: String,
    owner_id: String,
    scope_kind: String,
    manuscript_channel: Option<String>,
    claim_owner_token: String,
    claim_revision: i64,
    last_heartbeat_at: i64,
    process_generation: String,
    repository_observation_generation: u64,
    registry_slot_generation: u64,
}

impl ClaimOwnershipProof {
    pub(crate) fn sealed_snapshot(&self) -> ClaimOwnershipSnapshot {
        ClaimOwnershipSnapshot {
            claim_id: self.claim_id.clone(),
            operation_id: self.operation_id.clone(),
            owner_type: self.owner_type.clone(),
            owner_id: self.owner_id.clone(),
            scope_kind: self.scope_kind.clone(),
            manuscript_channel: self.manuscript_channel.clone(),
            claim_owner_token: self.claim_owner_token.clone(),
            claim_revision: self.claim_revision,
            last_heartbeat_at: self.last_heartbeat_at,
            process_generation: self.process_generation.clone(),
            repository_observation_generation: self.repository_observation_generation,
            registry_slot_generation: self.registry_slot_generation,
        }
    }

    pub(crate) fn claim_id(&self) -> &str {
        &self.claim_id
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn claim_revision(&self) -> i64 {
        self.claim_revision
    }

    pub(crate) fn process_generation(&self) -> &str {
        &self.process_generation
    }

    pub(crate) fn registry_slot_generation(&self) -> u64 {
        self.registry_slot_generation
    }
}

/// One-use value copy of the Registry's latest proof. Deliberately not Clone.
#[derive(Debug)]
pub(crate) struct ClaimOwnershipSnapshot {
    claim_id: String,
    operation_id: String,
    owner_type: String,
    owner_id: String,
    scope_kind: String,
    manuscript_channel: Option<String>,
    claim_owner_token: String,
    claim_revision: i64,
    last_heartbeat_at: i64,
    process_generation: String,
    repository_observation_generation: u64,
    registry_slot_generation: u64,
}

impl ClaimOwnershipSnapshot {
    pub(crate) fn matches_claim(&self, claim: &ProvisioningActiveClaim) -> bool {
        claim.claim_id == self.claim_id
            && claim.operation_id == self.operation_id
            && claim.owner_type == self.owner_type
            && claim.owner_id == self.owner_id
            && claim.scope_kind == self.scope_kind
            && claim.manuscript_channel == self.manuscript_channel
            && claim.claim_owner_token == self.claim_owner_token
            && claim.claim_revision == self.claim_revision
            && claim.last_heartbeat_at.parse::<i64>().ok() == Some(self.last_heartbeat_at)
    }

    pub(crate) fn claim_id(&self) -> &str {
        &self.claim_id
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn owner_type(&self) -> &str {
        &self.owner_type
    }

    pub(crate) fn owner_id(&self) -> &str {
        &self.owner_id
    }

    pub(crate) fn scope_kind(&self) -> &str {
        &self.scope_kind
    }

    pub(crate) fn manuscript_channel(&self) -> Option<&str> {
        self.manuscript_channel.as_deref()
    }

    pub(crate) fn claim_owner_token(&self) -> &str {
        &self.claim_owner_token
    }

    pub(crate) fn claim_revision(&self) -> i64 {
        self.claim_revision
    }

    pub(crate) fn last_heartbeat_at(&self) -> i64 {
        self.last_heartbeat_at
    }

    pub(crate) fn process_generation(&self) -> &str {
        &self.process_generation
    }

    pub(crate) fn repository_observation_generation(&self) -> u64 {
        self.repository_observation_generation
    }

    pub(crate) fn registry_slot_generation(&self) -> u64 {
        self.registry_slot_generation
    }
}

pub(crate) fn derive_claim_expiry_epoch_ms(
    last_heartbeat_at: i64,
) -> Result<i64, ClaimOwnershipError> {
    last_heartbeat_at
        .checked_add(LEASE_DURATION_MS)
        .ok_or(ClaimOwnershipError::HeartbeatTimestampInvariantFailure)
}
