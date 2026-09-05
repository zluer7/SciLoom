use crate::provisioning_runtime::heartbeat_scheduler::MonotonicClock;
use crate::provisioning_runtime_foundation::ProcessGeneration;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::sync::oneshot;
use uuid::{Uuid, Version};

const PRODUCER_WINDOW_LABEL: &str = "main";
const CHALLENGE_TTL: Duration = Duration::from_secs(15);
const CHALLENGE_TTL_MS: i64 = 15_000;
const MAX_PENDING_GLOBAL: usize = 64;
const MAX_PENDING_PER_REVIEW: usize = 4;
const MAX_PENDING_PER_REVIEW_PURPOSE: usize = 1;
const MAX_TERMINAL_TOMBSTONES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum PlanningAuthorityPurpose {
    PreparePreflight,
    PlanMaterialization,
    MutationPoint,
    NextStepAdmission,
    RecoveryRuntimeEntry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum PlanningAuthorityOwner {
    Review,
    Experiment,
}

impl PlanningAuthorityOwner {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Experiment => "experiment",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PlanningAuthorityScope {
    Channel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PlanningAuthorityChannel {
    Primary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PlanningAttestationAuthorityStatus {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PlanningAttestationLifecycle {
    Active,
    Archived,
    Deleted,
    MissingForCreate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlanningReviewType {
    Stage,
    Periodic,
    ExperimentComparison,
    LiteratureComparison,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanningFreshnessExpectation {
    AnyFresh,
    Exact,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningAuthorityChallenge {
    challenge_id: String,
    nonce: String,
    owner_id: String,
    project_id: String,
    owner: PlanningAuthorityOwner,
    scope: PlanningAuthorityScope,
    channel: PlanningAuthorityChannel,
    purpose: PlanningAuthorityPurpose,
    process_generation: String,
    producer_session_generation: u64,
    transport_generation: u64,
    freshness_kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_repository_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_repository_revision: Option<String>,
    ttl_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningAuthorityAttestation {
    challenge_id: String,
    nonce: String,
    owner_id: String,
    project_id: String,
    owner: PlanningAuthorityOwner,
    scope: PlanningAuthorityScope,
    channel: PlanningAuthorityChannel,
    purpose: PlanningAuthorityPurpose,
    process_generation: String,
    producer_session_generation: u64,
    transport_generation: u64,
    repository_epoch: Option<String>,
    repository_revision: Option<String>,
    review_type: Option<PlanningReviewType>,
    project_lifecycle: Option<PlanningAttestationLifecycle>,
    owner_lifecycle: Option<PlanningAttestationLifecycle>,
    authority_status: PlanningAttestationAuthorityStatus,
    rejection_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningProducerRegistration {
    process_generation: String,
    producer_session_generation: u64,
    transport_generation: u64,
    producer_capability: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningTransportCommandResult {
    status: PlanningTransportStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum PlanningTransportStatus {
    PlanningChallengeIssued,
    PlanningChallengeCancelled,
    PlanningSessionRevoked,
    PlanningEvidenceIssued,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningAuthorityTransportError {
    status: PlanningAuthorityTransportFailureStatus,
    code: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum PlanningAuthorityTransportFailureStatus {
    PlanningProducerNotRegistered,
    PlanningProducerConflict,
    PlanningSessionRevoked,
    PlanningSessionDisconnected,
    PlanningChallengeExpired,
    PlanningChallengeCancelled,
    PlanningChallengeAlreadyConsumed,
    PlanningAttestationSourceMismatch,
    PlanningAttestationSessionMismatch,
    PlanningAttestationRevisionMismatch,
    PlanningAuthorityRejected,
    PlanningAuthorityUnavailable,
    PlanningRepositoryUnavailable,
    RegistryCapacityExceeded,
    InternalInvariantFailure,
}

impl PlanningAuthorityTransportError {
    fn new(status: PlanningAuthorityTransportFailureStatus, code: &'static str) -> Self {
        Self { status, code }
    }

    fn producer_not_registered() -> Self {
        Self::new(
            PlanningAuthorityTransportFailureStatus::PlanningProducerNotRegistered,
            "PLANNING_PRODUCER_NOT_REGISTERED",
        )
    }

    fn session_revoked() -> Self {
        Self::new(
            PlanningAuthorityTransportFailureStatus::PlanningSessionRevoked,
            "PLANNING_SESSION_REVOKED",
        )
    }

    fn challenge_cancelled() -> Self {
        Self::new(
            PlanningAuthorityTransportFailureStatus::PlanningChallengeCancelled,
            "PLANNING_CHALLENGE_CANCELLED",
        )
    }
}

#[derive(Debug)]
pub(crate) struct PlanningAuthorityEvidence {
    challenge_id: String,
    owner: PlanningAuthorityOwner,
    owner_id: String,
    project_id: String,
    scope: PlanningAuthorityScope,
    purpose: PlanningAuthorityPurpose,
    process_generation: String,
    producer_session_generation: u64,
    transport_generation: u64,
    repository_epoch: String,
    repository_revision: String,
    review_type: Option<PlanningReviewType>,
    issued_at_monotonic_ms: i64,
    deadline_monotonic_ms: i64,
}

#[derive(Debug)]
pub(crate) struct PlanningRecoveryEntryEvidence {
    pub(crate) challenge_id: String,
    pub(crate) owner_id: String,
    pub(crate) owner_type: String,
    pub(crate) project_id: String,
    pub(crate) process_generation: String,
    pub(crate) repository_epoch: String,
    pub(crate) repository_revision: String,
    pub(crate) deadline_monotonic_ms: i64,
}

#[derive(Debug)]
pub(crate) struct PlanningPhaseEvidence {
    pub(crate) challenge_id: String,
    pub(crate) owner_id: String,
    pub(crate) owner_type: String,
    pub(crate) project_id: String,
    pub(crate) process_generation: String,
    pub(crate) repository_epoch: String,
    pub(crate) repository_revision: String,
    pub(crate) deadline_monotonic_ms: i64,
}

impl PlanningAuthorityEvidence {
    fn mint(
        challenge: &PlanningAuthorityChallenge,
        repository_epoch: String,
        repository_revision: String,
        review_type: Option<PlanningReviewType>,
        issued_at_monotonic_ms: i64,
        deadline_monotonic_ms: i64,
    ) -> Self {
        Self {
            challenge_id: challenge.challenge_id.clone(),
            owner: challenge.owner,
            owner_id: challenge.owner_id.clone(),
            project_id: challenge.project_id.clone(),
            scope: challenge.scope,
            purpose: challenge.purpose,
            process_generation: challenge.process_generation.clone(),
            producer_session_generation: challenge.producer_session_generation,
            transport_generation: challenge.transport_generation,
            repository_epoch,
            repository_revision,
            review_type,
            issued_at_monotonic_ms,
            deadline_monotonic_ms,
        }
    }

    #[cfg(test)]
    pub(crate) fn mint_for_test(
        review_id: &str,
        project_id: &str,
        purpose: PlanningAuthorityPurpose,
        process_generation: &str,
        repository_epoch: &str,
        repository_revision: &str,
        now_monotonic_ms: i64,
    ) -> Self {
        Self::mint_for_owner_test(
            PlanningAuthorityOwner::Review,
            review_id,
            project_id,
            purpose,
            process_generation,
            repository_epoch,
            repository_revision,
            now_monotonic_ms,
        )
    }

    #[cfg(test)]
    pub(crate) fn mint_for_owner_test(
        owner: PlanningAuthorityOwner,
        owner_id: &str,
        project_id: &str,
        purpose: PlanningAuthorityPurpose,
        process_generation: &str,
        repository_epoch: &str,
        repository_revision: &str,
        now_monotonic_ms: i64,
    ) -> Self {
        Self {
            challenge_id: uuid::Uuid::new_v4().to_string(),
            owner,
            owner_id: owner_id.to_string(),
            project_id: project_id.to_string(),
            scope: PlanningAuthorityScope::Channel,
            purpose,
            process_generation: process_generation.to_string(),
            producer_session_generation: 1,
            transport_generation: 1,
            repository_epoch: repository_epoch.to_string(),
            repository_revision: repository_revision.to_string(),
            review_type: (owner == PlanningAuthorityOwner::Review)
                .then_some(PlanningReviewType::Stage),
            issued_at_monotonic_ms: now_monotonic_ms,
            deadline_monotonic_ms: now_monotonic_ms.saturating_add(CHALLENGE_TTL_MS as i64),
        }
    }

    pub(crate) fn consume_for_recovery_runtime_entry(
        self,
        expected_owner_type: &str,
        expected_owner_id: &str,
        expected_project_id: &str,
        expected_process_generation: &str,
        now_monotonic_ms: i64,
    ) -> Result<PlanningRecoveryEntryEvidence, PlanningAuthorityTransportFailureStatus> {
        let identity_matches = self.purpose == PlanningAuthorityPurpose::RecoveryRuntimeEntry
            && self.scope == PlanningAuthorityScope::Channel
            && self.owner.as_str() == expected_owner_type
            && self.owner_id == expected_owner_id
            && self.project_id == expected_project_id
            && self.process_generation == expected_process_generation
            && self.producer_session_generation > 0
            && self.transport_generation > 0
            && !self.repository_epoch.is_empty()
            && !self.repository_revision.is_empty()
            && self.issued_at_monotonic_ms <= now_monotonic_ms
            && self.deadline_monotonic_ms > self.issued_at_monotonic_ms;
        if !identity_matches {
            return Err(PlanningAuthorityTransportFailureStatus::PlanningAttestationSourceMismatch);
        }
        if now_monotonic_ms >= self.deadline_monotonic_ms {
            return Err(PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired);
        }
        let _review_type = self.review_type;
        Ok(PlanningRecoveryEntryEvidence {
            challenge_id: self.challenge_id,
            owner_id: self.owner_id,
            owner_type: self.owner.as_str().to_string(),
            project_id: self.project_id,
            process_generation: self.process_generation,
            repository_epoch: self.repository_epoch,
            repository_revision: self.repository_revision,
            deadline_monotonic_ms: self.deadline_monotonic_ms,
        })
    }

    pub(crate) fn consume_for_phase(
        self,
        expected_owner_type: &str,
        expected_owner_id: &str,
        expected_project_id: &str,
        expected_process_generation: &str,
        expected_purpose: PlanningAuthorityPurpose,
        now_monotonic_ms: i64,
    ) -> Result<PlanningPhaseEvidence, PlanningAuthorityTransportFailureStatus> {
        let identity_matches = self.purpose == expected_purpose
            && self.scope == PlanningAuthorityScope::Channel
            && self.owner.as_str() == expected_owner_type
            && self.owner_id == expected_owner_id
            && self.project_id == expected_project_id
            && self.process_generation == expected_process_generation
            && self.producer_session_generation > 0
            && self.transport_generation > 0
            && !self.repository_epoch.is_empty()
            && !self.repository_revision.is_empty()
            && self.issued_at_monotonic_ms <= now_monotonic_ms
            && self.deadline_monotonic_ms > self.issued_at_monotonic_ms;
        if !identity_matches {
            return Err(PlanningAuthorityTransportFailureStatus::PlanningAttestationSourceMismatch);
        }
        if now_monotonic_ms >= self.deadline_monotonic_ms {
            return Err(PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired);
        }
        let _review_type = self.review_type;
        Ok(PlanningPhaseEvidence {
            challenge_id: self.challenge_id,
            owner_id: self.owner_id,
            owner_type: self.owner.as_str().to_string(),
            project_id: self.project_id,
            process_generation: self.process_generation,
            repository_epoch: self.repository_epoch,
            repository_revision: self.repository_revision,
            deadline_monotonic_ms: self.deadline_monotonic_ms,
        })
    }
}

pub(crate) struct PlanningAuthorityChallengeRequest {
    pub(crate) owner: PlanningAuthorityOwner,
    pub(crate) owner_id: String,
    pub(crate) project_id: String,
    pub(crate) purpose: PlanningAuthorityPurpose,
    pub(crate) freshness: PlanningFreshnessExpectation,
    pub(crate) expected_repository_epoch: Option<String>,
    pub(crate) expected_repository_revision: Option<String>,
}

trait ChallengeSender: Send + Sync {
    fn send(
        &self,
        challenge: PlanningAuthorityChallenge,
    ) -> Result<(), PlanningAuthorityTransportError>;
}

struct TauriChallengeSender {
    channel: Channel<PlanningAuthorityChallenge>,
}

impl ChallengeSender for TauriChallengeSender {
    fn send(
        &self,
        challenge: PlanningAuthorityChallenge,
    ) -> Result<(), PlanningAuthorityTransportError> {
        self.channel.send(challenge).map_err(|_| {
            PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningSessionDisconnected,
                "PLANNING_CHALLENGE_CHANNEL_CLOSED",
            )
        })
    }
}

struct ProducerSession {
    window_label: String,
    capability: String,
    producer_session_generation: u64,
    transport_generation: u64,
    sender: Arc<dyn ChallengeSender>,
}

struct PendingChallenge {
    challenge: PlanningAuthorityChallenge,
    issued_at_monotonic_ms: i64,
    deadline: i64,
    response: oneshot::Sender<Result<PlanningAuthorityEvidence, PlanningAuthorityTransportError>>,
}

#[derive(Debug, Clone, Copy)]
enum TerminalChallengeState {
    Consumed,
    Expired,
    Cancelled,
    SessionRevoked,
}

struct RegistryState {
    producer: Option<ProducerSession>,
    next_generation: u64,
    pending: HashMap<String, PendingChallenge>,
    terminal: HashMap<String, TerminalChallengeState>,
    terminal_order: VecDeque<String>,
}

impl RegistryState {
    fn new() -> Self {
        Self {
            producer: None,
            next_generation: 0,
            pending: HashMap::new(),
            terminal: HashMap::new(),
            terminal_order: VecDeque::new(),
        }
    }

    fn record_terminal(&mut self, id: String, state: TerminalChallengeState) {
        self.terminal.insert(id.clone(), state);
        self.terminal_order.push_back(id);
        while self.terminal_order.len() > MAX_TERMINAL_TOMBSTONES {
            if let Some(oldest) = self.terminal_order.pop_front() {
                self.terminal.remove(&oldest);
            }
        }
    }

    fn drain_pending(
        &mut self,
        terminal: TerminalChallengeState,
        error: PlanningAuthorityTransportError,
    ) -> Vec<(
        oneshot::Sender<Result<PlanningAuthorityEvidence, PlanningAuthorityTransportError>>,
        PlanningAuthorityTransportError,
    )> {
        let drained = self.pending.drain().collect::<Vec<_>>();
        drained
            .into_iter()
            .map(|(id, pending)| {
                self.record_terminal(id, terminal);
                (pending.response, error.clone())
            })
            .collect()
    }

    fn cleanup_expired(
        &mut self,
        now: i64,
    ) -> Vec<(
        oneshot::Sender<Result<PlanningAuthorityEvidence, PlanningAuthorityTransportError>>,
        PlanningAuthorityTransportError,
    )> {
        let expired_ids = self
            .pending
            .iter()
            .filter_map(|(id, pending)| (now >= pending.deadline).then(|| id.clone()))
            .collect::<Vec<_>>();
        expired_ids
            .into_iter()
            .filter_map(|id| {
                let pending = self.pending.remove(&id)?;
                self.record_terminal(id, TerminalChallengeState::Expired);
                Some((
                    pending.response,
                    PlanningAuthorityTransportError::new(
                        PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired,
                        "PLANNING_CHALLENGE_EXPIRED",
                    ),
                ))
            })
            .collect()
    }
}

fn complete_waiters(
    completions: Vec<(
        oneshot::Sender<Result<PlanningAuthorityEvidence, PlanningAuthorityTransportError>>,
        PlanningAuthorityTransportError,
    )>,
) {
    for (sender, error) in completions {
        let _ = sender.send(Err(error));
    }
}

fn is_valid_repository_epoch(value: &str) -> bool {
    Uuid::parse_str(value)
        .ok()
        .is_some_and(|epoch| epoch.get_version() == Some(Version::Random))
}

fn is_valid_repository_revision(value: &str) -> bool {
    !value.is_empty()
        && !(value.len() > 1 && value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u128>().is_ok()
}

pub(crate) struct PlanningAuthorityTransportFoundation {
    process_generation: Arc<ProcessGeneration>,
    clock: Arc<dyn MonotonicClock>,
    state: Mutex<RegistryState>,
}

impl PlanningAuthorityTransportFoundation {
    pub(crate) fn new(
        process_generation: Arc<ProcessGeneration>,
        clock: Arc<dyn MonotonicClock>,
    ) -> Self {
        Self {
            process_generation,
            clock,
            state: Mutex::new(RegistryState::new()),
        }
    }

    #[cfg(test)]
    fn new_with_clock(
        process_generation: Arc<ProcessGeneration>,
        clock: Arc<dyn MonotonicClock>,
    ) -> Self {
        Self::new(process_generation, clock)
    }

    fn register_sender(
        &self,
        actual_window_label: &str,
        sender: Arc<dyn ChallengeSender>,
    ) -> Result<PlanningProducerRegistration, PlanningAuthorityTransportError> {
        if actual_window_label != PRODUCER_WINDOW_LABEL {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningProducerConflict,
                "PLANNING_PRODUCER_WINDOW_CONFLICT",
            ));
        }
        let capability = Uuid::new_v4().to_string();
        let (registration, completions) = {
            let mut state = self.state.lock().map_err(|_| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_REGISTRY_LOCK_POISONED",
                )
            })?;
            let mut completions = state.cleanup_expired(self.clock.now_ms());
            completions.extend(state.drain_pending(
                TerminalChallengeState::SessionRevoked,
                PlanningAuthorityTransportError::session_revoked(),
            ));
            state.next_generation = state.next_generation.checked_add(1).ok_or_else(|| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_SESSION_GENERATION_EXHAUSTED",
                )
            })?;
            let generation = state.next_generation;
            let registration = PlanningProducerRegistration {
                process_generation: self.process_generation.canonical().to_string(),
                producer_session_generation: generation,
                transport_generation: generation,
                producer_capability: capability.clone(),
            };
            state.producer = Some(ProducerSession {
                window_label: actual_window_label.to_string(),
                capability,
                producer_session_generation: generation,
                transport_generation: generation,
                sender,
            });
            (registration, completions)
        };
        complete_waiters(completions);
        Ok(registration)
    }

    #[cfg(test)]
    pub(crate) fn process_generation_for_test(&self) -> &str {
        self.process_generation.canonical()
    }

    pub(crate) fn begin_challenge(
        &self,
        request: PlanningAuthorityChallengeRequest,
    ) -> Result<
        (
            PlanningTransportCommandResult,
            oneshot::Receiver<Result<PlanningAuthorityEvidence, PlanningAuthorityTransportError>>,
        ),
        PlanningAuthorityTransportError,
    > {
        if request.freshness == PlanningFreshnessExpectation::Exact {
            let valid = request
                .expected_repository_epoch
                .as_deref()
                .is_some_and(is_valid_repository_epoch)
                && request
                    .expected_repository_revision
                    .as_deref()
                    .is_some_and(is_valid_repository_revision);
            if !valid {
                return Err(PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_EXACT_FRESHNESS_EXPECTATION_INCOMPLETE",
                ));
            }
        }
        self.cleanup_expired();
        let challenge_id = Uuid::new_v4().to_string();
        let nonce = Uuid::new_v4().to_string();
        let (response_sender, response_receiver) = oneshot::channel();
        let (challenge, challenge_sender) = {
            let mut state = self.state.lock().map_err(|_| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_REGISTRY_LOCK_POISONED",
                )
            })?;
            let producer = state
                .producer
                .as_ref()
                .ok_or_else(PlanningAuthorityTransportError::producer_not_registered)?;
            let per_review = state
                .pending
                .values()
                .filter(|entry| {
                    entry.challenge.owner == request.owner
                        && entry.challenge.owner_id == request.owner_id
                })
                .count();
            let per_purpose = state
                .pending
                .values()
                .filter(|entry| {
                    entry.challenge.owner == request.owner
                        && entry.challenge.owner_id == request.owner_id
                        && entry.challenge.purpose == request.purpose
                })
                .count();
            if state.pending.len() >= MAX_PENDING_GLOBAL
                || per_review >= MAX_PENDING_PER_REVIEW
                || per_purpose >= MAX_PENDING_PER_REVIEW_PURPOSE
            {
                return Err(PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::RegistryCapacityExceeded,
                    "PLANNING_CHALLENGE_REGISTRY_CAPACITY_EXCEEDED",
                ));
            }
            let challenge = PlanningAuthorityChallenge {
                challenge_id: challenge_id.clone(),
                nonce,
                owner_id: request.owner_id,
                project_id: request.project_id,
                owner: request.owner,
                scope: PlanningAuthorityScope::Channel,
                channel: PlanningAuthorityChannel::Primary,
                purpose: request.purpose,
                process_generation: self.process_generation.canonical().to_string(),
                producer_session_generation: producer.producer_session_generation,
                transport_generation: producer.transport_generation,
                freshness_kind: match request.freshness {
                    PlanningFreshnessExpectation::AnyFresh => "anyFresh",
                    PlanningFreshnessExpectation::Exact => "exact",
                },
                expected_repository_epoch: request.expected_repository_epoch,
                expected_repository_revision: request.expected_repository_revision,
                ttl_ms: CHALLENGE_TTL.as_millis() as u64,
            };
            let issued_at_monotonic_ms = self.clock.now_ms();
            let deadline = issued_at_monotonic_ms.saturating_add(CHALLENGE_TTL_MS);
            let challenge_sender = producer.sender.clone();
            state.pending.insert(
                challenge_id.clone(),
                PendingChallenge {
                    challenge: challenge.clone(),
                    issued_at_monotonic_ms,
                    deadline,
                    response: response_sender,
                },
            );
            (challenge, challenge_sender)
        };
        if let Err(error) = challenge_sender.send(challenge) {
            let _ = self.cancel_challenge(&challenge_id);
            return Err(error);
        }
        Ok((
            PlanningTransportCommandResult {
                status: PlanningTransportStatus::PlanningChallengeIssued,
            },
            response_receiver,
        ))
    }

    pub(crate) async fn request_evidence(
        &self,
        request: PlanningAuthorityChallengeRequest,
    ) -> Result<PlanningAuthorityEvidence, PlanningAuthorityTransportError> {
        let (_, receiver) = self.begin_challenge(request)?;
        match tokio::time::timeout(CHALLENGE_TTL, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                "PLANNING_EVIDENCE_RESPONSE_CHANNEL_DROPPED",
            )),
            Err(_) => {
                self.cleanup_expired();
                Err(PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired,
                    "PLANNING_CHALLENGE_EXPIRED",
                ))
            }
        }
    }

    fn validate_producer<'a>(
        state: &'a RegistryState,
        actual_window_label: &str,
        capability: &str,
        producer_session_generation: u64,
        transport_generation: u64,
    ) -> Result<&'a ProducerSession, PlanningAuthorityTransportError> {
        let producer = state
            .producer
            .as_ref()
            .ok_or_else(PlanningAuthorityTransportError::producer_not_registered)?;
        if producer.window_label != actual_window_label {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAttestationSourceMismatch,
                "PLANNING_ATTESTATION_WINDOW_MISMATCH",
            ));
        }
        if producer.capability != capability
            || producer.producer_session_generation != producer_session_generation
            || producer.transport_generation != transport_generation
        {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAttestationSessionMismatch,
                "PLANNING_ATTESTATION_SESSION_MISMATCH",
            ));
        }
        Ok(producer)
    }

    fn terminal_error(state: TerminalChallengeState) -> PlanningAuthorityTransportError {
        match state {
            TerminalChallengeState::Consumed => PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningChallengeAlreadyConsumed,
                "PLANNING_CHALLENGE_ALREADY_CONSUMED",
            ),
            TerminalChallengeState::Expired => PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired,
                "PLANNING_CHALLENGE_EXPIRED",
            ),
            TerminalChallengeState::Cancelled => {
                PlanningAuthorityTransportError::challenge_cancelled()
            }
            TerminalChallengeState::SessionRevoked => {
                PlanningAuthorityTransportError::session_revoked()
            }
        }
    }

    fn validate_attestation(
        challenge: &PlanningAuthorityChallenge,
        attestation: &PlanningAuthorityAttestation,
    ) -> Result<(String, String, Option<PlanningReviewType>), PlanningAuthorityTransportError> {
        if attestation.challenge_id != challenge.challenge_id
            || attestation.nonce != challenge.nonce
            || attestation.owner_id != challenge.owner_id
            || attestation.project_id != challenge.project_id
            || attestation.owner != challenge.owner
            || attestation.scope != challenge.scope
            || attestation.channel != challenge.channel
            || attestation.purpose != challenge.purpose
            || attestation.process_generation != challenge.process_generation
        {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAttestationSourceMismatch,
                "PLANNING_ATTESTATION_CHALLENGE_MISMATCH",
            ));
        }
        if attestation.producer_session_generation != challenge.producer_session_generation
            || attestation.transport_generation != challenge.transport_generation
        {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAttestationSessionMismatch,
                "PLANNING_ATTESTATION_SESSION_MISMATCH",
            ));
        }
        if attestation.authority_status != PlanningAttestationAuthorityStatus::Accepted {
            let _ = &attestation.rejection_reason;
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAuthorityRejected,
                "PLANNING_AUTHORITY_REJECTED",
            ));
        }
        if attestation.project_lifecycle != Some(PlanningAttestationLifecycle::Active)
            || attestation.owner_lifecycle != Some(PlanningAttestationLifecycle::Active)
        {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAuthorityRejected,
                "PLANNING_AUTHORITY_LIFECYCLE_REJECTED",
            ));
        }
        let epoch = attestation.repository_epoch.clone().ok_or_else(|| {
            PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningRepositoryUnavailable,
                "PLANNING_REPOSITORY_EPOCH_MISSING",
            )
        })?;
        if !is_valid_repository_epoch(&epoch) {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningRepositoryUnavailable,
                "PLANNING_REPOSITORY_EPOCH_MALFORMED",
            ));
        }
        let revision = attestation.repository_revision.clone().ok_or_else(|| {
            PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningRepositoryUnavailable,
                "PLANNING_REPOSITORY_REVISION_MISSING",
            )
        })?;
        if !is_valid_repository_revision(&revision) {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningRepositoryUnavailable,
                "PLANNING_REPOSITORY_REVISION_MALFORMED",
            ));
        }
        if challenge.freshness_kind == "exact"
            && (challenge.expected_repository_epoch.as_deref() != Some(&epoch)
                || challenge.expected_repository_revision.as_deref() != Some(&revision))
        {
            return Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningAttestationRevisionMismatch,
                "PLANNING_ATTESTATION_REVISION_MISMATCH",
            ));
        }
        let review_type = match challenge.owner {
            PlanningAuthorityOwner::Review => Some(attestation.review_type.ok_or_else(|| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::PlanningAuthorityUnavailable,
                    "PLANNING_REVIEW_TYPE_MISSING",
                )
            })?),
            PlanningAuthorityOwner::Experiment => None,
        };
        Ok((epoch, revision, review_type))
    }

    pub(crate) fn submit_attestation(
        &self,
        actual_window_label: &str,
        capability: &str,
        producer_session_generation: u64,
        transport_generation: u64,
        attestation: PlanningAuthorityAttestation,
    ) -> Result<PlanningTransportCommandResult, PlanningAuthorityTransportError> {
        self.cleanup_expired();
        let now = self.clock.now_ms();
        let (response, evidence) = {
            let mut state = self.state.lock().map_err(|_| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_REGISTRY_LOCK_POISONED",
                )
            })?;
            Self::validate_producer(
                &state,
                actual_window_label,
                capability,
                producer_session_generation,
                transport_generation,
            )?;
            if let Some(terminal) = state.terminal.get(&attestation.challenge_id) {
                return Err(Self::terminal_error(*terminal));
            }
            let pending = state
                .pending
                .remove(&attestation.challenge_id)
                .ok_or_else(|| {
                    PlanningAuthorityTransportError::new(
                        PlanningAuthorityTransportFailureStatus::PlanningChallengeCancelled,
                        "PLANNING_CHALLENGE_UNKNOWN",
                    )
                })?;
            if now >= pending.deadline {
                state.record_terminal(attestation.challenge_id, TerminalChallengeState::Expired);
                let error = PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired,
                    "PLANNING_CHALLENGE_EXPIRED",
                );
                (pending.response, Err(error))
            } else {
                let validated = Self::validate_attestation(&pending.challenge, &attestation);
                match validated {
                    Ok((epoch, revision, review_type)) => {
                        state.record_terminal(
                            attestation.challenge_id,
                            TerminalChallengeState::Consumed,
                        );
                        (
                            pending.response,
                            Ok((
                                pending.challenge,
                                epoch,
                                revision,
                                review_type,
                                pending.issued_at_monotonic_ms,
                                pending.deadline,
                            )),
                        )
                    }
                    Err(error) => {
                        state.record_terminal(
                            attestation.challenge_id,
                            TerminalChallengeState::Cancelled,
                        );
                        (pending.response, Err(error.clone()))
                    }
                }
            }
        };
        match evidence {
            Ok((
                challenge,
                epoch,
                revision,
                review_type,
                issued_at_monotonic_ms,
                deadline_monotonic_ms,
            )) => {
                let evidence = PlanningAuthorityEvidence::mint(
                    &challenge,
                    epoch,
                    revision,
                    review_type,
                    issued_at_monotonic_ms,
                    deadline_monotonic_ms,
                );
                let _ = response.send(Ok(evidence));
                Ok(PlanningTransportCommandResult {
                    status: PlanningTransportStatus::PlanningEvidenceIssued,
                })
            }
            Err(error) => {
                let _ = response.send(Err(error.clone()));
                Err(error)
            }
        }
    }

    pub(crate) fn cancel_challenge(
        &self,
        challenge_id: &str,
    ) -> Result<PlanningTransportCommandResult, PlanningAuthorityTransportError> {
        self.cleanup_expired();
        let pending = {
            let mut state = self.state.lock().map_err(|_| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_REGISTRY_LOCK_POISONED",
                )
            })?;
            if let Some(terminal) = state.terminal.get(challenge_id) {
                return Err(Self::terminal_error(*terminal));
            }
            let pending = state
                .pending
                .remove(challenge_id)
                .ok_or_else(|| PlanningAuthorityTransportError::challenge_cancelled())?;
            state.record_terminal(challenge_id.to_string(), TerminalChallengeState::Cancelled);
            pending
        };
        let _ = pending
            .response
            .send(Err(PlanningAuthorityTransportError::challenge_cancelled()));
        Ok(PlanningTransportCommandResult {
            status: PlanningTransportStatus::PlanningChallengeCancelled,
        })
    }

    fn cleanup_expired(&self) {
        if let Ok(mut state) = self.state.lock() {
            let completions = state.cleanup_expired(self.clock.now_ms());
            drop(state);
            complete_waiters(completions);
        }
    }

    pub(crate) fn revoke_producer(
        &self,
        actual_window_label: &str,
        capability: &str,
        producer_session_generation: u64,
        transport_generation: u64,
    ) -> Result<PlanningTransportCommandResult, PlanningAuthorityTransportError> {
        let completions = {
            let mut state = self.state.lock().map_err(|_| {
                PlanningAuthorityTransportError::new(
                    PlanningAuthorityTransportFailureStatus::InternalInvariantFailure,
                    "PLANNING_REGISTRY_LOCK_POISONED",
                )
            })?;
            Self::validate_producer(
                &state,
                actual_window_label,
                capability,
                producer_session_generation,
                transport_generation,
            )?;
            state.producer = None;
            state.drain_pending(
                TerminalChallengeState::SessionRevoked,
                PlanningAuthorityTransportError::session_revoked(),
            )
        };
        complete_waiters(completions);
        Ok(PlanningTransportCommandResult {
            status: PlanningTransportStatus::PlanningSessionRevoked,
        })
    }

    pub(crate) fn revoke_window(&self, actual_window_label: &str) {
        let completions = match self.state.lock() {
            Ok(mut state)
                if state
                    .producer
                    .as_ref()
                    .is_some_and(|producer| producer.window_label == actual_window_label) =>
            {
                state.producer = None;
                state.drain_pending(
                    TerminalChallengeState::SessionRevoked,
                    PlanningAuthorityTransportError::session_revoked(),
                )
            }
            _ => Vec::new(),
        };
        complete_waiters(completions);
    }

    pub(crate) fn shutdown(&self) {
        let completions = match self.state.lock() {
            Ok(mut state) => {
                state.producer = None;
                state.drain_pending(
                    TerminalChallengeState::SessionRevoked,
                    PlanningAuthorityTransportError::session_revoked(),
                )
            }
            Err(_) => Vec::new(),
        };
        complete_waiters(completions);
    }
}

#[tauri::command]
pub(crate) fn planning_authority_register_producer(
    window: WebviewWindow,
    state: State<'_, Arc<PlanningAuthorityTransportFoundation>>,
    challenge_channel: Channel<PlanningAuthorityChallenge>,
) -> Result<PlanningProducerRegistration, PlanningAuthorityTransportError> {
    state.register_sender(
        window.label(),
        Arc::new(TauriChallengeSender {
            channel: challenge_channel,
        }),
    )
}

#[tauri::command]
pub(crate) fn planning_authority_submit_attestation(
    window: WebviewWindow,
    state: State<'_, Arc<PlanningAuthorityTransportFoundation>>,
    producer_capability: String,
    producer_session_generation: u64,
    transport_generation: u64,
    attestation: PlanningAuthorityAttestation,
) -> Result<PlanningTransportCommandResult, PlanningAuthorityTransportError> {
    state.submit_attestation(
        window.label(),
        &producer_capability,
        producer_session_generation,
        transport_generation,
        attestation,
    )
}

#[tauri::command]
pub(crate) fn planning_authority_revoke_producer(
    window: WebviewWindow,
    state: State<'_, Arc<PlanningAuthorityTransportFoundation>>,
    producer_capability: String,
    producer_session_generation: u64,
    transport_generation: u64,
) -> Result<PlanningTransportCommandResult, PlanningAuthorityTransportError> {
    state.revoke_producer(
        window.label(),
        &producer_capability,
        producer_session_generation,
        transport_generation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const TEST_EPOCH: &str = "11111111-1111-4111-8111-111111111111";

    #[derive(Default)]
    struct TestClock {
        milliseconds: AtomicU64,
    }

    impl TestClock {
        fn advance(&self, milliseconds: u64) {
            self.milliseconds.fetch_add(milliseconds, Ordering::SeqCst);
        }
    }

    impl MonotonicClock for TestClock {
        fn now_ms(&self) -> i64 {
            self.milliseconds
                .load(Ordering::SeqCst)
                .min(i64::MAX as u64) as i64
        }
    }

    #[derive(Default)]
    struct CapturingSender {
        challenges: Mutex<Vec<PlanningAuthorityChallenge>>,
    }

    impl CapturingSender {
        fn latest(&self) -> PlanningAuthorityChallenge {
            self.challenges
                .lock()
                .expect("capture lock")
                .last()
                .expect("challenge")
                .clone()
        }
    }

    impl ChallengeSender for CapturingSender {
        fn send(
            &self,
            challenge: PlanningAuthorityChallenge,
        ) -> Result<(), PlanningAuthorityTransportError> {
            self.challenges
                .lock()
                .expect("capture lock")
                .push(challenge);
            Ok(())
        }
    }

    struct FailingSender;

    impl ChallengeSender for FailingSender {
        fn send(
            &self,
            _challenge: PlanningAuthorityChallenge,
        ) -> Result<(), PlanningAuthorityTransportError> {
            Err(PlanningAuthorityTransportError::new(
                PlanningAuthorityTransportFailureStatus::PlanningSessionDisconnected,
                "PLANNING_CHALLENGE_CHANNEL_CLOSED",
            ))
        }
    }

    fn foundation(clock: Arc<TestClock>) -> PlanningAuthorityTransportFoundation {
        PlanningAuthorityTransportFoundation::new_with_clock(
            Arc::new(ProcessGeneration::fixed_for_test("process-test")),
            clock,
        )
    }

    fn register(
        foundation: &PlanningAuthorityTransportFoundation,
        sender: Arc<CapturingSender>,
    ) -> PlanningProducerRegistration {
        foundation
            .register_sender(PRODUCER_WINDOW_LABEL, sender)
            .expect("register producer")
    }

    fn request(
        review_id: &str,
        purpose: PlanningAuthorityPurpose,
        freshness: PlanningFreshnessExpectation,
    ) -> PlanningAuthorityChallengeRequest {
        PlanningAuthorityChallengeRequest {
            owner: PlanningAuthorityOwner::Review,
            owner_id: review_id.to_string(),
            project_id: "project-1".to_string(),
            purpose,
            freshness,
            expected_repository_epoch: (freshness == PlanningFreshnessExpectation::Exact)
                .then(|| TEST_EPOCH.to_string()),
            expected_repository_revision: (freshness == PlanningFreshnessExpectation::Exact)
                .then(|| "7".to_string()),
        }
    }

    fn accepted_attestation(
        challenge: &PlanningAuthorityChallenge,
    ) -> PlanningAuthorityAttestation {
        PlanningAuthorityAttestation {
            challenge_id: challenge.challenge_id.clone(),
            nonce: challenge.nonce.clone(),
            owner_id: challenge.owner_id.clone(),
            project_id: challenge.project_id.clone(),
            owner: challenge.owner,
            scope: challenge.scope,
            channel: challenge.channel,
            purpose: challenge.purpose,
            process_generation: challenge.process_generation.clone(),
            producer_session_generation: challenge.producer_session_generation,
            transport_generation: challenge.transport_generation,
            repository_epoch: Some(TEST_EPOCH.to_string()),
            repository_revision: Some("7".to_string()),
            review_type: Some(PlanningReviewType::Stage),
            project_lifecycle: Some(PlanningAttestationLifecycle::Active),
            owner_lifecycle: Some(PlanningAttestationLifecycle::Active),
            authority_status: PlanningAttestationAuthorityStatus::Accepted,
            rejection_reason: None,
        }
    }

    #[test]
    fn binds_registration_to_actual_main_window_and_replaces_same_label() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        let wrong = foundation.register_sender("secondary", Arc::new(CapturingSender::default()));
        assert_eq!(
            wrong.expect_err("wrong window must fail").status,
            PlanningAuthorityTransportFailureStatus::PlanningProducerConflict
        );

        let first = register(&foundation, Arc::new(CapturingSender::default()));
        let second = register(&foundation, Arc::new(CapturingSender::default()));
        assert_eq!(second.producer_session_generation, 2);
        assert_ne!(first.producer_capability, second.producer_capability);
        assert_eq!(
            Uuid::parse_str(&second.producer_capability)
                .expect("capability UUID")
                .get_version(),
            Some(Version::Random)
        );
    }

    #[test]
    fn enforces_per_review_purpose_and_global_pending_bounds() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        let sender = Arc::new(CapturingSender::default());
        register(&foundation, sender);

        let _first = foundation
            .begin_challenge(request(
                "review-1",
                PlanningAuthorityPurpose::PreparePreflight,
                PlanningFreshnessExpectation::AnyFresh,
            ))
            .expect("first challenge");
        let duplicate = foundation.begin_challenge(request(
            "review-1",
            PlanningAuthorityPurpose::PreparePreflight,
            PlanningFreshnessExpectation::AnyFresh,
        ));
        assert_eq!(
            duplicate.expect_err("duplicate purpose must fail").status,
            PlanningAuthorityTransportFailureStatus::RegistryCapacityExceeded
        );

        for index in 2..=64 {
            let _issued = foundation
                .begin_challenge(request(
                    &format!("review-{index}"),
                    PlanningAuthorityPurpose::PreparePreflight,
                    PlanningFreshnessExpectation::AnyFresh,
                ))
                .expect("within global bound");
        }
        let overflow = foundation.begin_challenge(request(
            "review-65",
            PlanningAuthorityPurpose::PreparePreflight,
            PlanningFreshnessExpectation::AnyFresh,
        ));
        assert_eq!(
            overflow.expect_err("global bound must fail").status,
            PlanningAuthorityTransportFailureStatus::RegistryCapacityExceeded
        );
    }

    #[test]
    fn consumes_exact_attestation_once_and_mints_non_transport_evidence() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        let sender = Arc::new(CapturingSender::default());
        let registration = register(&foundation, sender.clone());
        let (_, mut receiver) = foundation
            .begin_challenge(request(
                "review-1",
                PlanningAuthorityPurpose::MutationPoint,
                PlanningFreshnessExpectation::Exact,
            ))
            .expect("challenge");
        let challenge = sender.latest();
        let result = foundation
            .submit_attestation(
                PRODUCER_WINDOW_LABEL,
                &registration.producer_capability,
                registration.producer_session_generation,
                registration.transport_generation,
                accepted_attestation(&challenge),
            )
            .expect("accepted");
        assert_eq!(
            result.status,
            PlanningTransportStatus::PlanningEvidenceIssued
        );
        let evidence = receiver
            .try_recv()
            .expect("evidence response")
            .expect("sealed evidence");
        assert_eq!(evidence.challenge_id, challenge.challenge_id);
        assert_eq!(evidence.owner_id, "review-1");
        assert_eq!(evidence.project_id, "project-1");
        assert_eq!(evidence.scope, PlanningAuthorityScope::Channel);
        assert_eq!(evidence.purpose, PlanningAuthorityPurpose::MutationPoint);
        assert_eq!(evidence.process_generation, "process-test");
        assert_eq!(evidence.producer_session_generation, 1);
        assert_eq!(evidence.transport_generation, 1);
        assert_eq!(evidence.repository_epoch, TEST_EPOCH);
        assert_eq!(evidence.repository_revision, "7");
        assert_eq!(evidence.review_type, Some(PlanningReviewType::Stage));

        let duplicate = foundation.submit_attestation(
            PRODUCER_WINDOW_LABEL,
            &registration.producer_capability,
            registration.producer_session_generation,
            registration.transport_generation,
            accepted_attestation(&challenge),
        );
        assert_eq!(
            duplicate.expect_err("duplicate must fail").status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeAlreadyConsumed
        );
    }

    #[test]
    fn recovery_runtime_entry_evidence_is_purpose_bound_and_monotonic_ttl_bound() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock.clone());
        let sender = Arc::new(CapturingSender::default());
        let registration = register(&foundation, sender.clone());
        let (_, mut receiver) = foundation
            .begin_challenge(request(
                "review-1",
                PlanningAuthorityPurpose::RecoveryRuntimeEntry,
                PlanningFreshnessExpectation::Exact,
            ))
            .expect("challenge");
        let challenge = sender.latest();
        foundation
            .submit_attestation(
                PRODUCER_WINDOW_LABEL,
                &registration.producer_capability,
                registration.producer_session_generation,
                registration.transport_generation,
                accepted_attestation(&challenge),
            )
            .expect("accepted");
        let evidence = receiver.try_recv().expect("response").expect("evidence");
        let binding = evidence
            .consume_for_recovery_runtime_entry(
                "review",
                "review-1",
                "project-1",
                "process-test",
                1,
            )
            .expect("fresh");
        assert_eq!(binding.challenge_id, challenge.challenge_id);

        let (_, mut receiver) = foundation
            .begin_challenge(request(
                "review-2",
                PlanningAuthorityPurpose::RecoveryRuntimeEntry,
                PlanningFreshnessExpectation::Exact,
            ))
            .expect("second challenge");
        let challenge = sender.latest();
        foundation
            .submit_attestation(
                PRODUCER_WINDOW_LABEL,
                &registration.producer_capability,
                registration.producer_session_generation,
                registration.transport_generation,
                accepted_attestation(&challenge),
            )
            .expect("accepted");
        let evidence = receiver.try_recv().expect("response").expect("evidence");
        clock.advance(15_001);
        assert_eq!(
            evidence
                .consume_for_recovery_runtime_entry(
                    "review",
                    "review-2",
                    "project-1",
                    "process-test",
                    clock.now_ms(),
                )
                .expect_err("expired"),
            PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired
        );
    }

    #[test]
    fn rejects_wrong_revision_and_keeps_challenge_terminal() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        let sender = Arc::new(CapturingSender::default());
        let registration = register(&foundation, sender.clone());
        let (_, mut receiver) = foundation
            .begin_challenge(request(
                "review-1",
                PlanningAuthorityPurpose::NextStepAdmission,
                PlanningFreshnessExpectation::Exact,
            ))
            .expect("challenge");
        let challenge = sender.latest();
        let mut attestation = accepted_attestation(&challenge);
        attestation.repository_revision = Some("8".to_string());
        let rejected = foundation.submit_attestation(
            PRODUCER_WINDOW_LABEL,
            &registration.producer_capability,
            registration.producer_session_generation,
            registration.transport_generation,
            attestation,
        );
        assert_eq!(
            rejected.expect_err("revision mismatch").status,
            PlanningAuthorityTransportFailureStatus::PlanningAttestationRevisionMismatch
        );
        assert_eq!(
            receiver
                .try_recv()
                .expect("rejection response")
                .expect_err("must reject")
                .status,
            PlanningAuthorityTransportFailureStatus::PlanningAttestationRevisionMismatch
        );
        let replay = foundation.submit_attestation(
            PRODUCER_WINDOW_LABEL,
            &registration.producer_capability,
            registration.producer_session_generation,
            registration.transport_generation,
            accepted_attestation(&challenge),
        );
        assert_eq!(
            replay.expect_err("cancelled replay").status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeCancelled
        );
    }

    #[test]
    fn monotonic_expiry_and_session_replacement_revoke_waiters() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock.clone());
        let sender = Arc::new(CapturingSender::default());
        let registration = register(&foundation, sender.clone());
        let (_, mut expired_receiver) = foundation
            .begin_challenge(request(
                "review-expired",
                PlanningAuthorityPurpose::PreparePreflight,
                PlanningFreshnessExpectation::AnyFresh,
            ))
            .expect("challenge");
        let expired_challenge = sender.latest();
        clock.advance(15_001);
        let expired = foundation.submit_attestation(
            PRODUCER_WINDOW_LABEL,
            &registration.producer_capability,
            registration.producer_session_generation,
            registration.transport_generation,
            accepted_attestation(&expired_challenge),
        );
        assert_eq!(
            expired.expect_err("expired").status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired
        );
        assert_eq!(
            expired_receiver
                .try_recv()
                .expect("expired response")
                .expect_err("must expire")
                .status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeExpired
        );

        let (_, mut revoked_receiver) = foundation
            .begin_challenge(request(
                "review-reload",
                PlanningAuthorityPurpose::PlanMaterialization,
                PlanningFreshnessExpectation::AnyFresh,
            ))
            .expect("challenge before reload");
        let replacement = register(&foundation, Arc::new(CapturingSender::default()));
        assert_eq!(replacement.producer_session_generation, 2);
        assert_eq!(
            revoked_receiver
                .try_recv()
                .expect("revoked response")
                .expect_err("must revoke")
                .status,
            PlanningAuthorityTransportFailureStatus::PlanningSessionRevoked
        );
    }

    #[test]
    fn response_loss_does_not_reopen_consumed_challenge() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        let sender = Arc::new(CapturingSender::default());
        let registration = register(&foundation, sender.clone());
        let (_, receiver) = foundation
            .begin_challenge(request(
                "review-loss",
                PlanningAuthorityPurpose::MutationPoint,
                PlanningFreshnessExpectation::AnyFresh,
            ))
            .expect("challenge");
        let challenge = sender.latest();
        drop(receiver);
        foundation
            .submit_attestation(
                PRODUCER_WINDOW_LABEL,
                &registration.producer_capability,
                registration.producer_session_generation,
                registration.transport_generation,
                accepted_attestation(&challenge),
            )
            .expect("response loss still consumes");
        assert_eq!(
            foundation
                .submit_attestation(
                    PRODUCER_WINDOW_LABEL,
                    &registration.producer_capability,
                    registration.producer_session_generation,
                    registration.transport_generation,
                    accepted_attestation(&challenge),
                )
                .expect_err("replay")
                .status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeAlreadyConsumed
        );
    }

    #[test]
    fn wrong_window_and_wrong_session_cannot_consume_a_live_challenge() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        let sender = Arc::new(CapturingSender::default());
        let registration = register(&foundation, sender.clone());
        let (_, mut receiver) = foundation
            .begin_challenge(request(
                "review-source",
                PlanningAuthorityPurpose::PreparePreflight,
                PlanningFreshnessExpectation::AnyFresh,
            ))
            .expect("challenge");
        let challenge = sender.latest();
        let wrong_window = foundation.submit_attestation(
            "secondary",
            &registration.producer_capability,
            registration.producer_session_generation,
            registration.transport_generation,
            accepted_attestation(&challenge),
        );
        assert_eq!(
            wrong_window.expect_err("wrong window").status,
            PlanningAuthorityTransportFailureStatus::PlanningAttestationSourceMismatch
        );
        let wrong_session = foundation.submit_attestation(
            PRODUCER_WINDOW_LABEL,
            "00000000-0000-4000-8000-000000000000",
            registration.producer_session_generation,
            registration.transport_generation,
            accepted_attestation(&challenge),
        );
        assert_eq!(
            wrong_session.expect_err("wrong session").status,
            PlanningAuthorityTransportFailureStatus::PlanningAttestationSessionMismatch
        );
        foundation
            .submit_attestation(
                PRODUCER_WINDOW_LABEL,
                &registration.producer_capability,
                registration.producer_session_generation,
                registration.transport_generation,
                accepted_attestation(&challenge),
            )
            .expect("correct source remains admissible");
        assert!(receiver.try_recv().expect("evidence").is_ok());
    }

    #[test]
    fn send_failure_and_explicit_cancel_leave_no_reopenable_pending_entry() {
        let clock = Arc::new(TestClock::default());
        let foundation = foundation(clock);
        foundation
            .register_sender(PRODUCER_WINDOW_LABEL, Arc::new(FailingSender))
            .expect("register failing channel");
        let failed = foundation.begin_challenge(request(
            "review-failed-send",
            PlanningAuthorityPurpose::PreparePreflight,
            PlanningFreshnessExpectation::AnyFresh,
        ));
        assert_eq!(
            failed.expect_err("send failure").status,
            PlanningAuthorityTransportFailureStatus::PlanningSessionDisconnected
        );
        assert_eq!(foundation.state.lock().expect("registry").pending.len(), 0);

        let sender = Arc::new(CapturingSender::default());
        register(&foundation, sender.clone());
        let (_, mut receiver) = foundation
            .begin_challenge(request(
                "review-cancel",
                PlanningAuthorityPurpose::PlanMaterialization,
                PlanningFreshnessExpectation::AnyFresh,
            ))
            .expect("challenge");
        let challenge = sender.latest();
        foundation
            .cancel_challenge(&challenge.challenge_id)
            .expect("cancel");
        assert_eq!(
            receiver
                .try_recv()
                .expect("cancel response")
                .expect_err("cancelled")
                .status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeCancelled
        );
        assert_eq!(
            foundation
                .cancel_challenge(&challenge.challenge_id)
                .expect_err("cancel replay")
                .status,
            PlanningAuthorityTransportFailureStatus::PlanningChallengeCancelled
        );
    }
}
