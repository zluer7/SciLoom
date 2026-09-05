use super::step_progress::{
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
};
use super::*;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const HEARTBEAT_CADENCE_MS: i64 = 30_000;
pub(crate) const STALE_CANDIDATE_THRESHOLD_MS: i64 = 300_000;

pub(crate) const PROVISIONING_STALE_CLAIM_NOT_RECOVERABLE: &str =
    "PROVISIONING_STALE_CLAIM_NOT_RECOVERABLE";
pub(crate) const PROVISIONING_RECOVERY_PRECONDITION_CHANGED: &str =
    "PROVISIONING_RECOVERY_PRECONDITION_CHANGED";
pub(crate) const PROVISIONING_ATTEMPT_CHAIN_INVALID: &str = "PROVISIONING_ATTEMPT_CHAIN_INVALID";
pub(crate) const PROVISIONING_OUTBOX_DELIVERY_CONFLICT: &str =
    "PROVISIONING_OUTBOX_DELIVERY_CONFLICT";
pub(crate) const PROVISIONING_CLAIM_OWNER_MISMATCH: &str = "PROVISIONING_CLAIM_OWNER_MISMATCH";
pub(crate) const PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE: &str =
    "PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE";
pub(crate) const PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED: &str =
    "PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED";
pub(crate) const PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN: &str =
    "PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimCasInput {
    pub claim_id: String,
    pub holder_operation_id: String,
    pub claim_owner_token: String,
    pub expected_claim_revision: i64,
    pub scope_kind: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: Option<String>,
}

fn claim_cas_matches(claim: &ProvisioningActiveClaim, expected: &ClaimCasInput) -> bool {
    claim.claim_id == expected.claim_id
        && claim.operation_id == expected.holder_operation_id
        && claim.claim_owner_token == expected.claim_owner_token
        && claim.claim_revision == expected.expected_claim_revision
        && claim.scope_kind == expected.scope_kind
        && claim.owner_type == expected.owner_type
        && claim.owner_id == expected.owner_id
        && claim.manuscript_channel == expected.manuscript_channel
}

fn claim_conflict(
    attempt: Option<ProvisioningOperationAttempt>,
    claim: Option<ProvisioningActiveClaim>,
    expected: &ClaimCasInput,
) -> ProvisioningOperationRepositoryError {
    let code = if claim
        .as_ref()
        .is_some_and(|value| value.claim_owner_token != expected.claim_owner_token)
    {
        PROVISIONING_CLAIM_OWNER_MISMATCH
    } else {
        PROVISIONING_OPERATION_CAS_CONFLICT
    };
    let mut error = repository_error(code, "claim CAS authority no longer matches");
    error.authoritative_attempt = attempt;
    error.authoritative_claim = claim;
    error
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnershipRenewalKind {
    Live,
    Retained,
}

pub(crate) fn record_claim_heartbeat_with_repository_clock(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    snapshot: &claim_ownership::ClaimOwnershipSnapshot,
) -> RepositoryResult<ProvisioningActiveClaim> {
    record_claim_heartbeat_with_repository_clock_for_kind(
        connection,
        ownership_context,
        snapshot,
        OwnershipRenewalKind::Live,
    )
}

pub(crate) fn record_retained_claim_heartbeat_with_repository_clock(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    snapshot: &claim_ownership::ClaimOwnershipSnapshot,
) -> RepositoryResult<ProvisioningActiveClaim> {
    record_claim_heartbeat_with_repository_clock_for_kind(
        connection,
        ownership_context,
        snapshot,
        OwnershipRenewalKind::Retained,
    )
}

fn record_claim_heartbeat_with_repository_clock_for_kind(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    snapshot: &claim_ownership::ClaimOwnershipSnapshot,
    renewal_kind: OwnershipRenewalKind,
) -> RepositoryResult<ProvisioningActiveClaim> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            if matches!(
                error,
                rusqlite::Error::SqliteFailure(failure, _)
                    if matches!(
                        failure.code,
                        rusqlite::ErrorCode::DatabaseBusy
                            | rusqlite::ErrorCode::DatabaseLocked
                    )
            ) {
                repository_error(
                    PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED,
                    "heartbeat transaction was not started",
                )
            } else {
                database_error("begin heartbeat", error)
            }
        })?;
    let sealed_now = ownership_context
        .validate_heartbeat_advance(snapshot.last_heartbeat_at())
        .map_err(|_| {
            repository_error(
                PROVISIONING_CLAIM_CLOCK_AUTHORITY_UNAVAILABLE,
                "repository ownership clock unavailable or rolled back",
            )
        })?;
    let attempt = read_operation_attempt(&transaction, snapshot.operation_id())?;
    let claim = read_active_claim_for_operation(&transaction, snapshot.operation_id())?;
    if snapshot.process_generation() != ownership_context.claim_owner_token() {
        return Err(repository_error(
            PROVISIONING_CLAIM_OWNER_MISMATCH,
            "proof belongs to a different process generation",
        ));
    }
    let attempt_matches = attempt.as_ref().is_some_and(|value| match renewal_kind {
        OwnershipRenewalKind::Live => value.operation_status == "active",
        OwnershipRenewalKind::Retained => {
            value.operation_status == "terminal-recovery-required"
                && value.next_action.as_deref() == Some("recover")
        }
    });
    if !attempt_matches
        || !claim
            .as_ref()
            .is_some_and(|value| snapshot.matches_claim(value))
    {
        let mut error = repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "sealed claim ownership proof no longer matches",
        );
        error.authoritative_attempt = attempt;
        error.authoritative_claim = claim;
        return Err(error);
    }
    let affected = transaction
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET last_heartbeat_at=?1, claim_revision=claim_revision+1
             WHERE claim_id=?2 AND operation_id=?3 AND claim_owner_token=?4
               AND claim_revision=?5 AND scope_kind=?6 AND owner_type=?7
               AND owner_id=?8 AND manuscript_channel IS ?9",
            params![
                sealed_now.persisted_value(),
                snapshot.claim_id(),
                snapshot.operation_id(),
                snapshot.claim_owner_token(),
                snapshot.claim_revision(),
                snapshot.scope_kind(),
                snapshot.owner_type(),
                snapshot.owner_id(),
                snapshot.manuscript_channel(),
            ],
        )
        .map_err(|error| database_error("CAS heartbeat", error))?;
    if affected != 1 {
        let mut error = repository_error(
            PROVISIONING_OPERATION_CAS_CONFLICT,
            "sealed claim ownership proof became stale",
        );
        error.authoritative_attempt =
            read_operation_attempt(&transaction, snapshot.operation_id())?;
        error.authoritative_claim =
            read_active_claim_for_operation(&transaction, snapshot.operation_id())?;
        return Err(error);
    }
    let readback = read_active_claim_for_operation(&transaction, snapshot.operation_id())?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "claim vanished"))?;
    if let Err(error) = transaction.commit() {
        return Err(
            if matches!(
                error,
                rusqlite::Error::SqliteFailure(failure, _)
                    if matches!(
                        failure.code,
                        rusqlite::ErrorCode::DatabaseBusy
                            | rusqlite::ErrorCode::DatabaseLocked
                            | rusqlite::ErrorCode::ConstraintViolation
                    )
            ) {
                repository_error(
                    PROVISIONING_CLAIM_HEARTBEAT_KNOWN_NOT_COMMITTED,
                    "heartbeat commit is known not committed",
                )
            } else {
                repository_error(
                    PROVISIONING_CLAIM_HEARTBEAT_COMMIT_OUTCOME_UNKNOWN,
                    "heartbeat commit outcome is unknown",
                )
            },
        );
    }
    Ok(readback)
}

#[cfg(test)]
pub(crate) fn record_claim_heartbeat(
    connection: &mut Connection,
    input: &ClaimCasInput,
    occurred_at: &str,
) -> RepositoryResult<ProvisioningActiveClaim> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin legacy test heartbeat", error))?;
    let claim = read_active_claim_for_operation(&transaction, &input.holder_operation_id)?;
    if !claim
        .as_ref()
        .is_some_and(|value| claim_cas_matches(value, input))
    {
        return Err(claim_conflict(
            read_operation_attempt(&transaction, &input.holder_operation_id)?,
            claim,
            input,
        ));
    }
    let affected = transaction
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET last_heartbeat_at=?1, claim_revision=claim_revision+1
             WHERE claim_id=?2 AND operation_id=?3 AND claim_owner_token=?4
               AND claim_revision=?5 AND scope_kind=?6 AND owner_type=?7
               AND owner_id=?8 AND manuscript_channel IS ?9",
            params![
                occurred_at,
                input.claim_id,
                input.holder_operation_id,
                input.claim_owner_token,
                input.expected_claim_revision,
                input.scope_kind,
                input.owner_type,
                input.owner_id,
                input.manuscript_channel,
            ],
        )
        .map_err(|error| database_error("legacy test CAS heartbeat", error))?;
    if affected != 1 {
        return Err(claim_conflict(
            read_operation_attempt(&transaction, &input.holder_operation_id)?,
            read_active_claim_for_operation(&transaction, &input.holder_operation_id)?,
            input,
        ));
    }
    let readback = read_active_claim_for_operation(&transaction, &input.holder_operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "claim vanished"))?;
    transaction
        .commit()
        .map_err(|error| database_error("commit legacy test heartbeat", error))?;
    Ok(readback)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StaleClaimCandidate {
    pub kind: String,
    pub claim: ProvisioningActiveClaim,
    pub attempt: ProvisioningOperationAttempt,
}

fn claim_is_stale(
    connection: &Connection,
    claim: &ProvisioningActiveClaim,
    observed_at: &str,
) -> RepositoryResult<bool> {
    connection
        .query_row(
            "SELECT COALESCE(
               CASE
                 WHEN instr(?3, 'T') > 0 THEN
                   (julianday(?1) - julianday(
                     CASE WHEN ?2 > ?3 THEN ?2 ELSE ?3 END
                   )) * 86400000.0 >= ?4
                 ELSE
                   ((julianday(?1) - 2440587.5) * 86400000.0) -
                     CASE
                       WHEN ((julianday(?2) - 2440587.5) * 86400000.0)
                              > CAST(?3 AS INTEGER)
                         THEN ((julianday(?2) - 2440587.5) * 86400000.0)
                       ELSE CAST(?3 AS INTEGER)
                     END >= ?4
               END,
               0
             )",
            params![
                observed_at,
                claim.last_progress_at,
                claim.last_heartbeat_at,
                STALE_CANDIDATE_THRESHOLD_MS,
            ],
            |row| row.get(0),
        )
        .map_err(|error| database_error("evaluate stale threshold", error))
}

pub(crate) fn list_stale_or_crash_claim_candidates(
    connection: &Connection,
    current_app_instance_token: &str,
    observed_at: &str,
) -> RepositoryResult<Vec<StaleClaimCandidate>> {
    let mut statement = connection
        .prepare(&format!(
            "{CLAIM_SELECT} WHERE operation_id IN (
               SELECT operation_id FROM manuscript_provisioning_operation_attempts
               WHERE operation_status='active'
             ) ORDER BY claimed_at, claim_id"
        ))
        .map_err(|error| database_error("prepare claim candidates", error))?;
    let claims = statement
        .query_map([], claim_from_row)
        .map_err(|error| database_error("query claim candidates", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("collect claim candidates", error))?;
    let mut candidates = Vec::new();
    for claim in claims {
        let kind = if claim.claim_owner_token != current_app_instance_token {
            Some("crash")
        } else if claim_is_stale(connection, &claim, observed_at)? {
            Some("stale")
        } else {
            None
        };
        if let Some(kind) = kind {
            if let Some(attempt) = read_operation_attempt(connection, &claim.operation_id)? {
                candidates.push(StaleClaimCandidate {
                    kind: kind.to_string(),
                    claim,
                    attempt,
                });
            }
        }
    }
    Ok(candidates)
}

pub(crate) fn mark_stale_claim_candidate(
    connection: &mut Connection,
    input: &ClaimCasInput,
    observer_app_instance_token: &str,
    observed_at: &str,
) -> RepositoryResult<ProvisioningActiveClaim> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin stale observation", error))?;
    let claim = read_active_claim_for_operation(&transaction, &input.holder_operation_id)?;
    let Some(claim) = claim else {
        return Err(repository_error(
            PROVISIONING_OPERATION_NOT_FOUND,
            "active claim not found",
        ));
    };
    if !claim_cas_matches(&claim, input) {
        return Err(claim_conflict(
            read_operation_attempt(&transaction, &input.holder_operation_id)?,
            Some(claim),
            input,
        ));
    }
    let is_crash = claim.claim_owner_token != observer_app_instance_token;
    if !is_crash && !claim_is_stale(&transaction, &claim, observed_at)? {
        return Err(repository_error(
            PROVISIONING_STALE_CLAIM_NOT_RECOVERABLE,
            "claim has not crossed the stale candidate threshold",
        ));
    }
    let affected = transaction
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET stale_observed_at=?1, stale_observed_by_token=?2,
                 claim_revision=claim_revision+1
             WHERE claim_id=?3 AND operation_id=?4 AND claim_owner_token=?5
               AND claim_revision=?6 AND scope_kind=?7 AND owner_type=?8
               AND owner_id=?9 AND manuscript_channel IS ?10",
            params![
                observed_at,
                observer_app_instance_token,
                input.claim_id,
                input.holder_operation_id,
                input.claim_owner_token,
                input.expected_claim_revision,
                input.scope_kind,
                input.owner_type,
                input.owner_id,
                input.manuscript_channel,
            ],
        )
        .map_err(|error| database_error("CAS stale observation", error))?;
    if affected != 1 {
        return Err(claim_conflict(
            read_operation_attempt(&transaction, &input.holder_operation_id)?,
            read_active_claim_for_operation(&transaction, &input.holder_operation_id)?,
            input,
        ));
    }
    let readback = read_active_claim_for_operation(&transaction, &input.holder_operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "claim vanished"))?;
    transaction
        .commit()
        .map_err(|error| database_error("commit stale observation", error))?;
    Ok(readback)
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryReplacementInput {
    pub snapshot_id: String,
    pub inspected_at: String,
    pub inspected_owner_type: String,
    pub inspected_owner_id: String,
    pub inspected_manuscript_channel: Option<String>,
    pub observed_old_operation_id: String,
    pub observed_operation_revision: i64,
    pub observed_claim_id: String,
    pub observed_claim_revision: i64,
    pub old_claim_owner_token: String,
    pub explicit_authorization_id: String,
    pub new_operation_id: String,
    pub new_claim_id: String,
    #[cfg(test)]
    pub new_claim_owner_token: String,
    pub durable_plan: Option<DurableStepPlanInput>,
    pub durable_steps: Vec<DurableStepSkeletonInput>,
    pub occurred_at: String,
}

#[derive(Debug)]
struct RecoveryReplacementWriteInput {
    snapshot_id: String,
    inspected_at: String,
    inspected_owner_type: String,
    inspected_owner_id: String,
    inspected_manuscript_channel: Option<String>,
    observed_old_operation_id: String,
    observed_operation_revision: i64,
    observed_claim_id: String,
    observed_claim_revision: i64,
    old_claim_owner_token: String,
    explicit_authorization_id: String,
    new_operation_id: String,
    new_claim_id: String,
    durable_plan: Option<DurableStepPlanInput>,
    durable_steps: Vec<DurableStepSkeletonInput>,
    occurred_at: String,
}

#[cfg(test)]
impl From<&RecoveryReplacementInput> for RecoveryReplacementWriteInput {
    fn from(input: &RecoveryReplacementInput) -> Self {
        Self {
            snapshot_id: input.snapshot_id.clone(),
            inspected_at: input.inspected_at.clone(),
            inspected_owner_type: input.inspected_owner_type.clone(),
            inspected_owner_id: input.inspected_owner_id.clone(),
            inspected_manuscript_channel: input.inspected_manuscript_channel.clone(),
            observed_old_operation_id: input.observed_old_operation_id.clone(),
            observed_operation_revision: input.observed_operation_revision,
            observed_claim_id: input.observed_claim_id.clone(),
            observed_claim_revision: input.observed_claim_revision,
            old_claim_owner_token: input.old_claim_owner_token.clone(),
            explicit_authorization_id: input.explicit_authorization_id.clone(),
            new_operation_id: input.new_operation_id.clone(),
            new_claim_id: input.new_claim_id.clone(),
            durable_plan: input.durable_plan.clone(),
            durable_steps: input.durable_steps.clone(),
            occurred_at: input.occurred_at.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryReplacementResult {
    pub old_attempt: ProvisioningOperationAttempt,
    pub new_attempt: ProvisioningOperationAttempt,
    pub new_claim: ProvisioningActiveClaim,
}

/// Sealed P1-04 repository input. Ordinary callers cannot set Claim ownership
/// facts, revisions, operation identities, or a recovery Plan.
#[derive(Debug)]
pub(crate) struct RecoveryOwnershipContext {
    evidence: RecoveryEligibilityDurableEvidence,
    new_operation_id: String,
    new_claim_id: String,
    occurred_at: String,
}

/// Post-COMMIT, SQLite-only Recovery ownership evidence. Deliberately
/// non-Clone and non-Serde.
#[derive(Debug)]
pub(crate) struct RecoveryOwnershipProof {
    predecessor_operation_id: String,
    recovery_operation_id: String,
    recovery_attempt_revision: i64,
    recovery_claim_id: String,
    recovery_claim_owner_token: String,
    recovery_claim_revision: i64,
    recovery_last_heartbeat_at: String,
    recovery_plan_id: String,
    recovery_plan_identity_fingerprint: String,
    predecessor_outbox_revision: i64,
}

impl RecoveryOwnershipProof {
    pub(crate) fn predecessor_operation_id(&self) -> &str {
        &self.predecessor_operation_id
    }

    pub(crate) fn recovery_operation_id(&self) -> &str {
        &self.recovery_operation_id
    }

    pub(crate) fn recovery_claim_id(&self) -> &str {
        &self.recovery_claim_id
    }

    pub(crate) fn recovery_claim_owner_token(&self) -> &str {
        &self.recovery_claim_owner_token
    }

    pub(crate) fn recovery_claim_revision(&self) -> i64 {
        self.recovery_claim_revision
    }

    pub(crate) fn recovery_attempt_revision(&self) -> i64 {
        self.recovery_attempt_revision
    }

    pub(crate) fn recovery_last_heartbeat_at(&self) -> &str {
        &self.recovery_last_heartbeat_at
    }

    pub(crate) fn recovery_plan_id(&self) -> &str {
        &self.recovery_plan_id
    }

    pub(crate) fn recovery_plan_identity_fingerprint(&self) -> &str {
        &self.recovery_plan_identity_fingerprint
    }

    pub(crate) fn predecessor_outbox_revision(&self) -> i64 {
        self.predecessor_outbox_revision
    }
}

/// Sealed, single-use Recovery -> executable ownership authority. The
/// P1-04 zero-Step Plan remains immutable; this context creates a successor
/// Attempt/Claim/Plan/Steps tuple through the existing unique replacement
/// writer.
#[derive(Debug)]
pub(crate) struct RecoveryExecutionTransitionContext {
    recovery_proof: RecoveryOwnershipProof,
    new_operation_id: String,
    new_claim_id: String,
    durable_plan: DurableStepPlanInput,
    durable_steps: Vec<DurableStepSkeletonInput>,
    occurred_at: String,
}

impl RecoveryExecutionTransitionContext {
    pub(crate) fn seal(
        recovery_proof: RecoveryOwnershipProof,
        new_operation_id: String,
        new_claim_id: String,
        durable_plan: DurableStepPlanInput,
        durable_steps: Vec<DurableStepSkeletonInput>,
        occurred_at: String,
    ) -> Self {
        Self {
            recovery_proof,
            new_operation_id,
            new_claim_id,
            durable_plan,
            durable_steps,
            occurred_at,
        }
    }

    pub(crate) fn recovery_claim_id(&self) -> &str {
        self.recovery_proof.recovery_claim_id()
    }
}

/// Post-COMMIT, SQLite-only executable ownership evidence. Deliberately
/// non-Clone and non-Serde.
#[derive(Debug)]
pub(crate) struct RecoveryExecutionOwnershipProof {
    recovery_operation_id: String,
    execution_operation_id: String,
    execution_attempt_revision: i64,
    execution_claim_id: String,
    execution_claim_owner_token: String,
    execution_claim_revision: i64,
    execution_last_heartbeat_at: String,
    execution_plan_id: String,
    execution_plan_identity_fingerprint: String,
    execution_precondition_snapshot_hash: String,
    execution_adapter_manifest_hash: String,
    execution_step_count: i64,
}

impl RecoveryExecutionOwnershipProof {
    pub(crate) fn recovery_operation_id(&self) -> &str {
        &self.recovery_operation_id
    }

    pub(crate) fn execution_operation_id(&self) -> &str {
        &self.execution_operation_id
    }

    pub(crate) fn execution_attempt_revision(&self) -> i64 {
        self.execution_attempt_revision
    }

    pub(crate) fn execution_claim_id(&self) -> &str {
        &self.execution_claim_id
    }

    pub(crate) fn execution_claim_owner_token(&self) -> &str {
        &self.execution_claim_owner_token
    }

    pub(crate) fn execution_claim_revision(&self) -> i64 {
        self.execution_claim_revision
    }

    pub(crate) fn execution_last_heartbeat_at(&self) -> &str {
        &self.execution_last_heartbeat_at
    }

    pub(crate) fn execution_plan_id(&self) -> &str {
        &self.execution_plan_id
    }

    pub(crate) fn execution_plan_identity_fingerprint(&self) -> &str {
        &self.execution_plan_identity_fingerprint
    }

    pub(crate) fn execution_precondition_snapshot_hash(&self) -> &str {
        &self.execution_precondition_snapshot_hash
    }

    pub(crate) fn execution_adapter_manifest_hash(&self) -> &str {
        &self.execution_adapter_manifest_hash
    }

    pub(crate) fn execution_step_count(&self) -> i64 {
        self.execution_step_count
    }
}

enum RecoveryReplacementAuthority<'a> {
    Abandonment(Option<&'a AbandonmentObservationFingerprint>),
    RecoveryExecution(&'a RecoveryOwnershipProof),
}

impl RecoveryOwnershipContext {
    pub(crate) fn seal(
        evidence: RecoveryEligibilityDurableEvidence,
        new_operation_id: String,
        new_claim_id: String,
        occurred_at: String,
    ) -> Self {
        Self {
            evidence,
            new_operation_id,
            new_claim_id,
            occurred_at,
        }
    }

    pub(crate) fn into_evidence(self) -> RecoveryEligibilityDurableEvidence {
        self.evidence
    }

    pub(crate) fn evidence(&self) -> &RecoveryEligibilityDurableEvidence {
        &self.evidence
    }
}

fn recovery_hash(domain: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn replace_abandoned_claim_for_recovery(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    context: &RecoveryOwnershipContext,
) -> RepositoryResult<RecoveryReplacementResult> {
    let old_plan =
        read_attempt_plan(connection, context.evidence.operation_id())?.ok_or_else(|| {
            repository_error(
                PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
                "eligible predecessor Plan no longer exists",
            )
        })?;
    let plan_id = recovery_hash(
        "labpod.recovery-ownership-plan-id@1",
        &[
            context.evidence.operation_id(),
            &context.new_operation_id,
            context.evidence.fingerprint().as_sha256(),
        ],
    );
    let plan_fingerprint = recovery_hash(
        "labpod.recovery-ownership-plan-identity@1",
        &[
            &context.new_operation_id,
            context.evidence.owner_type(),
            context.evidence.owner_id(),
            context.evidence.scope_kind(),
            context.evidence.manuscript_channel().unwrap_or(""),
            context.evidence.operation_id(),
        ],
    );
    let precondition_hash = recovery_hash(
        "labpod.recovery-ownership-precondition@1",
        &[
            context.evidence.fingerprint().as_sha256(),
            context.evidence.claim_id(),
            context.evidence.claim_owner_token(),
            &context.evidence.claim_revision().to_string(),
            &context.evidence.last_heartbeat_at().to_string(),
            &context.evidence.derived_expiry().to_string(),
            &context
                .evidence
                .first_repository_utc_observation()
                .to_string(),
            &context
                .evidence
                .second_repository_utc_observation()
                .to_string(),
        ],
    );
    let input = RecoveryReplacementWriteInput {
        snapshot_id: context.evidence.fingerprint().as_sha256().to_string(),
        inspected_at: context
            .evidence
            .second_repository_utc_observation()
            .to_string(),
        inspected_owner_type: context.evidence.owner_type().to_string(),
        inspected_owner_id: context.evidence.owner_id().to_string(),
        inspected_manuscript_channel: context.evidence.manuscript_channel().map(str::to_string),
        observed_old_operation_id: context.evidence.operation_id().to_string(),
        observed_operation_revision: 0,
        observed_claim_id: context.evidence.claim_id().to_string(),
        observed_claim_revision: context.evidence.claim_revision(),
        old_claim_owner_token: context.evidence.claim_owner_token().to_string(),
        explicit_authorization_id: "sealed-p1-04-eligibility".to_string(),
        new_operation_id: context.new_operation_id.clone(),
        new_claim_id: context.new_claim_id.clone(),
        durable_plan: Some(DurableStepPlanInput {
            plan_id,
            plan_version: 1,
            plan_template_kind: old_plan.plan_template_kind,
            plan_identity_fingerprint: plan_fingerprint,
            precondition_snapshot_hash: precondition_hash,
            fingerprint_profile: old_plan.fingerprint_profile,
            canonical_resource_identity_hash: old_plan.canonical_resource_identity_hash,
            canonical_placement_identity_hash: old_plan.canonical_placement_identity_hash,
            parent_shared_identity_hash: old_plan.parent_shared_identity_hash,
            declared_step_count: 0,
            planner_version: "p1-04-recovery-ownership@1".to_string(),
        }),
        durable_steps: Vec::new(),
        occurred_at: context.occurred_at.clone(),
    };
    replace_claim_for_recovery_with_context(
        connection,
        ownership_context,
        &input,
        RecoveryReplacementAuthority::Abandonment(Some(context.evidence.fingerprint())),
    )
}

pub(crate) fn read_recovery_ownership_proof(
    connection: &Connection,
    predecessor_operation_id: &str,
    recovery_operation_id: &str,
    expected_owner_token: &str,
) -> RepositoryResult<RecoveryOwnershipProof> {
    let predecessor = read_operation_attempt(connection, predecessor_operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "predecessor missing"))?;
    let recovery = read_operation_attempt(connection, recovery_operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Recovery Attempt missing")
    })?;
    let claim =
        read_active_claim_for_operation(connection, recovery_operation_id)?.ok_or_else(|| {
            repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Recovery Claim missing")
        })?;
    let plan = read_attempt_plan(connection, recovery_operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Recovery Plan missing")
    })?;
    let steps = read_attempt_step_progress(connection, recovery_operation_id)?;
    let predecessor_claim = read_active_claim_for_operation(connection, predecessor_operation_id)?;
    let predecessor_outbox =
        read_audit_state(connection, predecessor_operation_id)?.ok_or_else(|| {
            repository_error(
                PROVISIONING_OPERATION_NOT_FOUND,
                "predecessor Outbox missing",
            )
        })?;
    let chain_valid = recovery.intent == "recover"
        && recovery.trigger_kind == "explicit-recovery"
        && recovery.previous_operation_id.as_deref() == Some(predecessor_operation_id)
        && recovery.root_operation_id.as_deref()
            == Some(
                predecessor
                    .root_operation_id
                    .as_deref()
                    .unwrap_or(predecessor_operation_id),
            )
        && predecessor.operation_status == "terminal-recovery-required"
        && predecessor.next_action.as_deref() == Some("recover")
        && predecessor_claim.is_none()
        && recovery.operation_status == "active"
        && recovery.phase == "preflight"
        && claim.operation_id == recovery_operation_id
        && claim.claim_owner_token == expected_owner_token
        && claim.owner_type == recovery.owner_type
        && claim.owner_id == recovery.owner_id
        && claim.scope_kind == recovery.scope_kind
        && claim.manuscript_channel == recovery.manuscript_channel
        && plan.operation_id == recovery_operation_id
        && plan.intent == DurablePlanIntent::Recover
        && plan.step_count == 0
        && steps.is_empty()
        && predecessor_outbox.operation_id == predecessor_operation_id;
    let literature_projection_valid = if recovery.owner_type == "literature"
        && recovery.scope_kind == "literature-aggregate"
    {
        let projections = read_literature_child_projections(connection, predecessor_operation_id)?;
        projections.len() == 2
            && projections
                .iter()
                .all(|projection| projection.current_operation_id == recovery_operation_id)
    } else {
        true
    };
    if !chain_valid || !literature_projection_valid {
        return Err(repository_error(
            PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
            "post-COMMIT Recovery ownership tuple is incomplete",
        ));
    }
    Ok(RecoveryOwnershipProof {
        predecessor_operation_id: predecessor_operation_id.to_string(),
        recovery_operation_id: recovery_operation_id.to_string(),
        recovery_attempt_revision: recovery.revision,
        recovery_claim_id: claim.claim_id,
        recovery_claim_owner_token: claim.claim_owner_token,
        recovery_claim_revision: claim.claim_revision,
        recovery_last_heartbeat_at: claim.last_heartbeat_at,
        recovery_plan_id: plan.plan_id,
        recovery_plan_identity_fingerprint: plan.plan_identity_fingerprint,
        predecessor_outbox_revision: predecessor_outbox.revision,
    })
}

pub(crate) fn read_initial_recovery_ownership_proof(
    connection: &Connection,
    kind: super::RecoveryInitializationKind,
    predecessor_operation_id: Option<&str>,
    recovery_operation_id: &str,
    expected_owner_token: &str,
) -> RepositoryResult<RecoveryOwnershipProof> {
    let recovery = read_operation_attempt(connection, recovery_operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Recovery Attempt missing")
    })?;
    let claim =
        read_active_claim_for_operation(connection, recovery_operation_id)?.ok_or_else(|| {
            repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Recovery Claim missing")
        })?;
    let plan = read_attempt_plan(connection, recovery_operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Recovery Plan missing")
    })?;
    let steps = read_attempt_step_progress(connection, recovery_operation_id)?;
    let (predecessor_marker, predecessor_outbox_revision, chain_valid) = match kind {
        super::RecoveryInitializationKind::InitialRoot => (
            recovery_operation_id.to_string(),
            0,
            recovery.previous_operation_id.is_none() && recovery.root_operation_id.is_none(),
        ),
        super::RecoveryInitializationKind::CompletedSuccessor => {
            let predecessor_id = predecessor_operation_id.ok_or_else(|| {
                repository_error(
                    PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
                    "completed predecessor identity missing",
                )
            })?;
            let predecessor =
                read_operation_attempt(connection, predecessor_id)?.ok_or_else(|| {
                    repository_error(PROVISIONING_OPERATION_NOT_FOUND, "predecessor missing")
                })?;
            let outbox_revision = read_audit_state(connection, predecessor_id)?
                .map(|outbox| outbox.revision)
                .unwrap_or(0);
            (
                predecessor_id.to_string(),
                outbox_revision,
                predecessor.operation_status == "terminal-completed"
                    && predecessor.result_classification.as_deref() == Some("completed")
                    && predecessor.next_action.as_deref() == Some("none")
                    && recovery.previous_operation_id.as_deref() == Some(predecessor_id)
                    && recovery.root_operation_id.as_deref()
                        == Some(
                            predecessor
                                .root_operation_id
                                .as_deref()
                                .unwrap_or(predecessor_id),
                        ),
            )
        }
    };
    let valid = chain_valid
        && recovery.intent == "recover"
        && recovery.trigger_kind == "explicit-recovery"
        && recovery.operation_status == "active"
        && recovery.phase == "preflight"
        && claim.operation_id == recovery_operation_id
        && claim.claim_owner_token == expected_owner_token
        && claim.owner_type == recovery.owner_type
        && claim.owner_id == recovery.owner_id
        && claim.scope_kind == recovery.scope_kind
        && claim.manuscript_channel == recovery.manuscript_channel
        && plan.operation_id == recovery_operation_id
        && plan.intent == DurablePlanIntent::Recover
        && plan.step_count == 0
        && steps.is_empty();
    if !valid {
        return Err(repository_error(
            PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
            "initial Recovery ownership tuple is incomplete",
        ));
    }
    Ok(RecoveryOwnershipProof {
        predecessor_operation_id: predecessor_marker,
        recovery_operation_id: recovery_operation_id.to_string(),
        recovery_attempt_revision: recovery.revision,
        recovery_claim_id: claim.claim_id,
        recovery_claim_owner_token: claim.claim_owner_token,
        recovery_claim_revision: claim.claim_revision,
        recovery_last_heartbeat_at: claim.last_heartbeat_at,
        recovery_plan_id: plan.plan_id,
        recovery_plan_identity_fingerprint: plan.plan_identity_fingerprint,
        predecessor_outbox_revision,
    })
}

fn read_fresh_sealed_recovery_ownership_proof(
    connection: &Connection,
    proof: &RecoveryOwnershipProof,
) -> RepositoryResult<RecoveryOwnershipProof> {
    if proof.predecessor_operation_id == proof.recovery_operation_id {
        return read_initial_recovery_ownership_proof(
            connection,
            super::RecoveryInitializationKind::InitialRoot,
            None,
            &proof.recovery_operation_id,
            &proof.recovery_claim_owner_token,
        );
    }

    read_initial_recovery_ownership_proof(
        connection,
        super::RecoveryInitializationKind::CompletedSuccessor,
        Some(&proof.predecessor_operation_id),
        &proof.recovery_operation_id,
        &proof.recovery_claim_owner_token,
    )
    .or_else(|_| {
        read_recovery_ownership_proof(
            connection,
            &proof.predecessor_operation_id,
            &proof.recovery_operation_id,
            &proof.recovery_claim_owner_token,
        )
    })
}

pub(crate) fn transition_recovery_ownership_to_execution(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    context: RecoveryExecutionTransitionContext,
) -> RepositoryResult<RecoveryExecutionOwnershipProof> {
    if context.durable_steps.is_empty()
        || context.durable_plan.declared_step_count != context.durable_steps.len() as i64
        || !step_progress::is_lowercase_sha256(&context.durable_plan.planner_version)
    {
        return Err(repository_error(
            PLAN_STRUCTURE_INVALID,
            "Recovery execution requires a non-empty executable Plan and canonical Adapter manifest",
        ));
    }
    let recovery_attempt =
        read_operation_attempt(connection, context.recovery_proof.recovery_operation_id())?
            .ok_or_else(|| {
                repository_error(
                    PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
                    "Recovery ownership Attempt no longer exists",
                )
            })?;
    let input = RecoveryReplacementWriteInput {
        snapshot_id: context
            .recovery_proof
            .recovery_plan_identity_fingerprint()
            .to_string(),
        inspected_at: context
            .recovery_proof
            .recovery_last_heartbeat_at()
            .to_string(),
        inspected_owner_type: recovery_attempt.owner_type,
        inspected_owner_id: recovery_attempt.owner_id,
        inspected_manuscript_channel: recovery_attempt.manuscript_channel,
        observed_old_operation_id: context.recovery_proof.recovery_operation_id().to_string(),
        observed_operation_revision: context.recovery_proof.recovery_attempt_revision(),
        observed_claim_id: context.recovery_proof.recovery_claim_id().to_string(),
        observed_claim_revision: context.recovery_proof.recovery_claim_revision(),
        old_claim_owner_token: context
            .recovery_proof
            .recovery_claim_owner_token()
            .to_string(),
        explicit_authorization_id: "sealed-se1-recovery-execution".to_string(),
        new_operation_id: context.new_operation_id.clone(),
        new_claim_id: context.new_claim_id.clone(),
        durable_plan: Some(context.durable_plan),
        durable_steps: context.durable_steps,
        occurred_at: context.occurred_at,
    };
    let recovery_operation_id = input.observed_old_operation_id.clone();
    let execution_operation_id = input.new_operation_id.clone();
    let expected_owner_token = ownership_context.claim_owner_token().to_string();
    replace_claim_for_recovery_with_context(
        connection,
        ownership_context,
        &input,
        RecoveryReplacementAuthority::RecoveryExecution(&context.recovery_proof),
    )?;
    read_recovery_execution_ownership_proof(
        connection,
        &recovery_operation_id,
        &execution_operation_id,
        &expected_owner_token,
    )
}

pub(crate) fn read_recovery_execution_ownership_proof(
    connection: &Connection,
    recovery_operation_id: &str,
    execution_operation_id: &str,
    expected_owner_token: &str,
) -> RepositoryResult<RecoveryExecutionOwnershipProof> {
    let recovery = read_operation_attempt(connection, recovery_operation_id)?.ok_or_else(|| {
        repository_error(
            PROVISIONING_OPERATION_NOT_FOUND,
            "Recovery predecessor Attempt missing",
        )
    })?;
    let execution =
        read_operation_attempt(connection, execution_operation_id)?.ok_or_else(|| {
            repository_error(
                PROVISIONING_OPERATION_NOT_FOUND,
                "Recovery execution Attempt missing",
            )
        })?;
    let claim =
        read_active_claim_for_operation(connection, execution_operation_id)?.ok_or_else(|| {
            repository_error(
                PROVISIONING_OPERATION_NOT_FOUND,
                "Recovery execution Claim missing",
            )
        })?;
    let plan = read_attempt_plan(connection, execution_operation_id)?.ok_or_else(|| {
        repository_error(
            PROVISIONING_OPERATION_NOT_FOUND,
            "Recovery execution Plan missing",
        )
    })?;
    let steps = read_attempt_step_progress(connection, execution_operation_id)?;
    let recovery_claim = read_active_claim_for_operation(connection, recovery_operation_id)?;
    let recovery_outbox = read_audit_state(connection, recovery_operation_id)?;
    let tuple_valid = recovery.operation_status == "terminal-recovery-required"
        && recovery.next_action.as_deref() == Some("recover")
        && recovery_claim.is_none()
        && recovery_outbox.is_some()
        && execution.operation_status == "active"
        && execution.phase == "preflight"
        && execution.intent == "recover"
        && execution.trigger_kind == "explicit-recovery"
        && execution.previous_operation_id.as_deref() == Some(recovery_operation_id)
        && claim.operation_id == execution_operation_id
        && claim.claim_owner_token == expected_owner_token
        && claim.owner_type == execution.owner_type
        && claim.owner_id == execution.owner_id
        && claim.scope_kind == execution.scope_kind
        && claim.manuscript_channel == execution.manuscript_channel
        && plan.operation_id == execution_operation_id
        && plan.intent == DurablePlanIntent::Recover
        && plan.step_count > 0
        && plan.step_count == steps.len() as i64
        && step_progress::is_lowercase_sha256(&plan.planner_version)
        && steps.iter().enumerate().all(|(index, step)| {
            step.operation_id == execution_operation_id
                && step.plan_id == plan.plan_id
                && step.step_ordinal == index as i64
                && step.step_version == 1
                && step.effect_facts_schema_version == 1
                && step.boundary.as_str() == "intended"
                && step.effect_outcome.as_str() == "unobserved"
                && step.readback_outcome.as_str() == "not-run"
        });
    if !tuple_valid {
        return Err(repository_error(
            PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
            "post-COMMIT Recovery execution ownership tuple is incomplete",
        ));
    }
    Ok(RecoveryExecutionOwnershipProof {
        recovery_operation_id: recovery_operation_id.to_string(),
        execution_operation_id: execution_operation_id.to_string(),
        execution_attempt_revision: execution.revision,
        execution_claim_id: claim.claim_id,
        execution_claim_owner_token: claim.claim_owner_token,
        execution_claim_revision: claim.claim_revision,
        execution_last_heartbeat_at: claim.last_heartbeat_at,
        execution_plan_id: plan.plan_id,
        execution_plan_identity_fingerprint: plan.plan_identity_fingerprint,
        execution_precondition_snapshot_hash: plan.precondition_snapshot_hash,
        execution_adapter_manifest_hash: plan.planner_version,
        execution_step_count: plan.step_count,
    })
}

fn replace_claim_for_recovery_with_context(
    connection: &mut Connection,
    ownership_context: &claim_ownership::ClaimOwnershipRepositoryContext,
    input: &RecoveryReplacementWriteInput,
    authority: RecoveryReplacementAuthority<'_>,
) -> RepositoryResult<RecoveryReplacementResult> {
    if input.snapshot_id.is_empty()
        || input.inspected_at.is_empty()
        || input.explicit_authorization_id.is_empty()
        || input.new_operation_id == input.observed_old_operation_id
    {
        return Err(repository_error(
            PROVISIONING_OPERATION_INVALID_INPUT,
            "recovery requires immutable inspection and authorization context",
        ));
    }
    crate::db::schema::validate_global_schema_current(connection).map_err(|_| {
        repository_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "recovery requires the current global schema contract",
        )
    })?;
    let provisioning_contract_current =
        super::step_progress_schema::validate_provisioning_contract(connection)
            .map_err(|error| database_error("validate recovery provisioning contract", error))?;
    if !provisioning_contract_current {
        return Err(repository_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "recovery requires the embedded provisioning contract",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin recovery replacement", error))?;
    let old_attempt = read_operation_attempt(&transaction, &input.observed_old_operation_id)?
        .ok_or_else(|| {
            repository_error(
                PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
                "observed attempt no longer exists",
            )
        })?;
    let old_claim =
        read_active_claim_for_operation(&transaction, &input.observed_old_operation_id)?
            .ok_or_else(|| {
                repository_error(
                    PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
                    "observed active claim no longer exists",
                )
            })?;
    let retained_predecessor = old_attempt.operation_status == "terminal-recovery-required"
        && old_attempt.phase == "failed"
        && old_attempt.next_action.as_deref() == Some("recover");
    let (
        fresh_authority_matches,
        expected_operation_revision,
        sealed_replacement_authority,
        recovery_execution,
    ) = match authority {
        RecoveryReplacementAuthority::Abandonment(expected_fingerprint) => {
            let fingerprint_matches = expected_fingerprint.is_none_or(|expected| {
                inspect_durable_claim(&transaction, &input.observed_old_operation_id)
                    .ok()
                    .and_then(|observation| observation.create_abandonment_fingerprint())
                    .is_some_and(|fresh| expected.matches(&fresh))
            });
            (
                fingerprint_matches,
                if expected_fingerprint.is_some() {
                    old_attempt.revision
                } else {
                    input.observed_operation_revision
                },
                expected_fingerprint.is_some(),
                false,
            )
        }
        RecoveryReplacementAuthority::RecoveryExecution(proof) => {
            let proof_matches = read_fresh_sealed_recovery_ownership_proof(&transaction, proof)
                .ok()
                .is_some_and(|fresh| {
                    fresh.recovery_attempt_revision == proof.recovery_attempt_revision
                        && fresh.recovery_claim_id == proof.recovery_claim_id
                        && fresh.recovery_claim_revision == proof.recovery_claim_revision
                        && fresh.recovery_last_heartbeat_at == proof.recovery_last_heartbeat_at
                        && fresh.recovery_plan_id == proof.recovery_plan_id
                        && fresh.recovery_plan_identity_fingerprint
                            == proof.recovery_plan_identity_fingerprint
                        && fresh.predecessor_outbox_revision == proof.predecessor_outbox_revision
                });
            (proof_matches, proof.recovery_attempt_revision, true, true)
        }
    };
    let context_matches = (old_attempt.operation_status == "active" || retained_predecessor)
        && old_attempt.revision == expected_operation_revision
        && old_attempt.owner_type == input.inspected_owner_type
        && old_attempt.owner_id == input.inspected_owner_id
        && old_attempt.manuscript_channel == input.inspected_manuscript_channel
        && old_claim.claim_id == input.observed_claim_id
        && old_claim.claim_revision == input.observed_claim_revision
        && old_claim.claim_owner_token == input.old_claim_owner_token
        && old_claim.operation_id == input.observed_old_operation_id
        && fresh_authority_matches
        && (sealed_replacement_authority
            || old_claim.stale_observed_at.is_some()
            || old_claim.claim_owner_token != ownership_context.claim_owner_token());
    if !context_matches {
        let mut error = repository_error(
            PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
            "recovery inspection or claim precondition changed",
        );
        error.authoritative_attempt = Some(old_attempt);
        error.authoritative_claim = Some(old_claim);
        return Err(error);
    }
    let sealed_heartbeat = ownership_context.sample_sealed_heartbeat().map_err(|_| {
        repository_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "repository ownership clock unavailable",
        )
    })?;
    if find_resource_claim(
        &transaction,
        &old_attempt.owner_type,
        &old_attempt.owner_id,
        old_attempt.manuscript_channel.as_deref(),
    )?
    .as_ref()
    .is_some_and(|claim| claim.claim_id != old_claim.claim_id)
    {
        return Err(repository_error(
            PROVISIONING_ACTIVE_CLAIM_CONFLICT,
            "another resource claim became active",
        ));
    }
    if !retained_predecessor {
        let terminalized = transaction
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
             SET phase='failed', operation_status='terminal-recovery-required',
                 result_classification='provisioning-recovery-required',
                 next_action='recover', partial_kind=COALESCE(partial_kind, 'physical-only'),
                 original_cause_code=COALESCE(original_cause_code, ?4),
                 final_verification_outcome=CASE
                   WHEN final_verification_outcome='passed' THEN 'not-verified'
                   ELSE final_verification_outcome END,
                 revision=revision+1, updated_at=?1, terminal_at=?1
             WHERE operation_id=?2 AND revision=?3 AND operation_status='active'",
                params![
                    input.occurred_at,
                    input.observed_old_operation_id,
                    expected_operation_revision,
                    if recovery_execution {
                        "RECOVERY_EXECUTION_MATERIALIZED"
                    } else {
                        "STALE_OR_CRASH_CLAIM"
                    },
                ],
            )
            .map_err(|error| database_error("CAS terminalize stale attempt", error))?;
        if terminalized != 1 {
            return Err(repository_error(
                PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
                "stale attempt CAS no longer matches",
            ));
        }
    }
    let released = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_active_claims
             WHERE claim_id=?1 AND operation_id=?2 AND claim_owner_token=?3
               AND claim_revision=?4",
            params![
                input.observed_claim_id,
                input.observed_old_operation_id,
                input.old_claim_owner_token,
                input.observed_claim_revision,
            ],
        )
        .map_err(|error| database_error("CAS replace old claim", error))?;
    if released != 1 {
        return Err(repository_error(
            PROVISIONING_RECOVERY_PRECONDITION_CHANGED,
            "old claim CAS no longer matches",
        ));
    }
    let root_operation_id = old_attempt
        .root_operation_id
        .as_deref()
        .unwrap_or(&old_attempt.operation_id);
    insert_attempt(
        &transaction,
        &input.new_operation_id,
        &old_attempt.scope_kind,
        &old_attempt.owner_type,
        &old_attempt.owner_id,
        old_attempt.manuscript_channel.as_deref(),
        old_attempt.aggregate_operation_id.as_deref(),
        "recover",
        "explicit-recovery",
        &input.occurred_at,
    )?;
    transaction
        .execute(
            "UPDATE manuscript_provisioning_operation_attempts
             SET previous_operation_id=?1, root_operation_id=?2
             WHERE operation_id=?3 AND revision=0 AND operation_status='active'",
            params![
                old_attempt.operation_id,
                root_operation_id,
                input.new_operation_id,
            ],
        )
        .map_err(|error| database_error("link recovery attempt chain", error))?;
    insert_claim(
        &transaction,
        &input.new_claim_id,
        &old_claim.scope_kind,
        &old_claim.owner_type,
        &old_claim.owner_id,
        old_claim.manuscript_channel.as_deref(),
        &input.new_operation_id,
        ownership_context.claim_owner_token(),
        &input.occurred_at,
        &sealed_heartbeat.persisted_value(),
    )?;
    let durable_plan = input.durable_plan.clone().ok_or_else(|| {
        repository_error(
            PLAN_STRUCTURE_INVALID,
            "durable recovery requires an immutable Plan",
        )
    })?;
    let owner_type = old_attempt
        .owner_type
        .parse::<DurablePlanOwnerType>()
        .map_err(|_| repository_error(PLAN_IDENTITY_MISMATCH, "recovery owner is invalid"))?;
    let scope_kind = old_attempt
        .scope_kind
        .parse::<DurablePlanScopeKind>()
        .map_err(|_| repository_error(PLAN_IDENTITY_MISMATCH, "recovery scope is invalid"))?;
    let manuscript_channel = old_attempt
        .manuscript_channel
        .as_deref()
        .map(str::parse::<DurableManuscriptChannel>)
        .transpose()
        .map_err(|_| repository_error(PLAN_IDENTITY_MISMATCH, "recovery channel is invalid"))?;
    let durable_input = AtomicDurableAttemptInput {
        operation_id: input.new_operation_id.clone(),
        claim_id: input.new_claim_id.clone(),
        #[cfg(test)]
        claim_owner_token: ownership_context.claim_owner_token().to_string(),
        owner_type,
        owner_id: old_attempt.owner_id.clone(),
        scope_kind,
        manuscript_channel,
        aggregate_operation_id: old_attempt.aggregate_operation_id.clone(),
        intent: DurablePlanIntent::Recover,
        trigger_kind: "explicit-recovery".to_string(),
        occurred_at: input.occurred_at.clone(),
        plan: durable_plan,
        steps: input.durable_steps.clone(),
    };
    insert_plan_steps_for_existing_attempt(&transaction, ownership_context, &durable_input, false)?;
    if old_attempt.owner_type == "literature" {
        let (aggregate_id, channel) = match old_attempt.scope_kind.as_str() {
            "literature-aggregate" => (
                if recovery_execution {
                    old_attempt
                        .previous_operation_id
                        .as_deref()
                        .unwrap_or(old_attempt.operation_id.as_str())
                } else {
                    old_attempt.operation_id.as_str()
                },
                None,
            ),
            "literature-child" => (
                old_attempt
                    .aggregate_operation_id
                    .as_deref()
                    .unwrap_or_default(),
                old_attempt.manuscript_channel.as_deref(),
            ),
            _ => ("", None),
        };
        if !aggregate_id.is_empty() {
            let updated = transaction
                .execute(
                    "UPDATE manuscript_provisioning_literature_child_states
                         SET current_operation_id=?1,
                             current_operation_scope_kind=?2,
                             revision=revision+1, child_summary_status='assigned',
                             result_classification=NULL, next_action=NULL,
                             default_readiness='not-verified',
                             final_verification_outcome='not-run',
                             original_cause_code=NULL, updated_at=?3
                         WHERE aggregate_operation_id=?4
                           AND (?5 IS NULL OR manuscript_channel=?5)",
                    params![
                        input.new_operation_id,
                        old_attempt.scope_kind,
                        input.occurred_at,
                        aggregate_id,
                        channel,
                    ],
                )
                .map_err(|error| database_error("sync recovery Literature projection", error))?;
            let expected = if channel.is_some() { 1 } else { 2 };
            if updated != expected {
                return Err(repository_error(
                    LITERATURE_PROJECTION_CONFLICT,
                    "recovery Literature projection assignment changed",
                ));
            }
        }
    }
    if !retained_predecessor {
        transaction
            .execute(
                "INSERT INTO manuscript_provisioning_audit_outbox (
               operation_id, delivery_status, revision, delivery_attempt_count,
               created_at, updated_at
             ) VALUES (?1, 'pending', 0, 0, ?2, ?2)",
                params![input.observed_old_operation_id, input.occurred_at],
            )
            .map_err(|error| database_error("enqueue recovery audit", error))?;
    }
    let result = RecoveryReplacementResult {
        old_attempt: read_operation_attempt(&transaction, &input.observed_old_operation_id)?
            .ok_or_else(|| {
                repository_error(PROVISIONING_OPERATION_NOT_FOUND, "old attempt vanished")
            })?,
        new_attempt: read_operation_attempt(&transaction, &input.new_operation_id)?.ok_or_else(
            || repository_error(PROVISIONING_OPERATION_NOT_FOUND, "new attempt vanished"),
        )?,
        new_claim: read_active_claim_for_operation(&transaction, &input.new_operation_id)?
            .ok_or_else(|| {
                repository_error(PROVISIONING_OPERATION_NOT_FOUND, "new claim vanished")
            })?,
    };
    transaction
        .commit()
        .map_err(|error| database_error("commit recovery replacement", error))?;
    Ok(result)
}

#[cfg(test)]
pub(crate) fn replace_claim_for_recovery(
    connection: &mut Connection,
    input: &RecoveryReplacementInput,
) -> RepositoryResult<RecoveryReplacementResult> {
    let ownership_context = claim_ownership::fixed_repository_context_for_test(
        &input.new_claim_owner_token,
        1_700_000_000_000,
    );
    let write_input = RecoveryReplacementWriteInput::from(input);
    replace_claim_for_recovery_with_context(
        connection,
        &ownership_context,
        &write_input,
        RecoveryReplacementAuthority::Abandonment(None),
    )
}

pub(crate) fn read_attempt_chain(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Vec<ProvisioningOperationAttempt>> {
    let mut chain = Vec::new();
    let mut next = Some(operation_id.to_string());
    let mut seen = std::collections::HashSet::new();
    while let Some(current_id) = next {
        if !seen.insert(current_id.clone()) {
            return Err(repository_error(
                PROVISIONING_ATTEMPT_CHAIN_INVALID,
                "attempt chain contains a cycle",
            ));
        }
        let attempt = read_operation_attempt(connection, &current_id)?.ok_or_else(|| {
            repository_error(
                PROVISIONING_ATTEMPT_CHAIN_INVALID,
                "attempt chain contains a missing predecessor",
            )
        })?;
        next = attempt.previous_operation_id.clone();
        chain.push(attempt);
    }
    chain.reverse();
    if let Some(root) = chain.first() {
        if root.previous_operation_id.is_some() || root.root_operation_id.is_some() {
            return Err(repository_error(
                PROVISIONING_ATTEMPT_CHAIN_INVALID,
                "attempt chain root is not canonical",
            ));
        }
        for attempt in chain.iter().skip(1) {
            if attempt.root_operation_id.as_deref() != Some(root.operation_id.as_str())
                || attempt.owner_type != root.owner_type
                || attempt.owner_id != root.owner_id
                || attempt.scope_kind != root.scope_kind
                || attempt.manuscript_channel != root.manuscript_channel
            {
                return Err(repository_error(
                    PROVISIONING_ATTEMPT_CHAIN_INVALID,
                    "attempt chain scope or root is inconsistent",
                ));
            }
        }
    }
    Ok(chain)
}

pub(crate) fn read_audit_state(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Option<ProvisioningAuditOutbox>> {
    connection
        .query_row(
            "SELECT operation_id, delivery_status, revision, delivery_attempt_count,
                    operation_log_id, error_code, created_at, updated_at, delivered_at
             FROM manuscript_provisioning_audit_outbox WHERE operation_id=?1",
            [operation_id],
            outbox_from_row,
        )
        .optional()
        .map_err(|error| database_error("read audit outbox", error))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditDeliveryInput {
    pub operation_id: String,
    pub expected_revision: i64,
    pub expected_status: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditDeliveryResult {
    pub outbox: ProvisioningAuditOutbox,
    pub delivered: bool,
}

fn deliver_audit(
    connection: &mut Connection,
    input: &AuditDeliveryInput,
    required_status: &str,
) -> RepositoryResult<AuditDeliveryResult> {
    if input.expected_status != required_status || !matches!(required_status, "pending" | "failed")
    {
        return Err(repository_error(
            PROVISIONING_OUTBOX_DELIVERY_CONFLICT,
            "outbox delivery action does not match expected status",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin audit delivery", error))?;
    let outbox = read_audit_state(&transaction, &input.operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "audit outbox not found")
    })?;
    if outbox.revision != input.expected_revision || outbox.delivery_status != input.expected_status
    {
        return Err(repository_error(
            PROVISIONING_OUTBOX_DELIVERY_CONFLICT,
            "outbox revision or status changed",
        ));
    }
    let attempt = read_operation_attempt(&transaction, &input.operation_id)?.ok_or_else(|| {
        repository_error(
            PROVISIONING_OPERATION_NOT_FOUND,
            "terminal attempt not found",
        )
    })?;
    if attempt.operation_status == "active" || attempt.scope_kind == "literature-child" {
        return Err(repository_error(
            PROVISIONING_OUTBOX_DELIVERY_CONFLICT,
            "only terminal root or aggregate attempts produce user audit",
        ));
    }
    let target = serde_json::json!({
        "entityType": attempt.owner_type,
        "entityId": attempt.owner_id,
        "manuscriptChannel": attempt.manuscript_channel,
        "operationId": attempt.operation_id
    })
    .to_string();
    let feedback = serde_json::json!({
        "status": attempt.operation_status,
        "classification": attempt.result_classification,
        "nextAction": attempt.next_action,
        "partialKind": attempt.partial_kind,
        "originalCauseCode": attempt.original_cause_code
    })
    .to_string();
    let summary = format!(
        "Manuscript provisioning {} for {}.",
        attempt.operation_status, attempt.owner_type
    );
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO operation_logs (
           id, operation_type, source, module, status, risk_level, target, summary,
           related_entities, feedback, warnings, errors, skipped, is_recoverable,
           actor_id, actor_label, refresh_keys, schema_version, created_at, updated_at,
           deleted_at
         ) VALUES (
           ?1, 'provisioning', 'system', 'provisioning', ?2, 'medium', ?3, ?4,
           '[]', ?5, '[]', '[]', '[]', ?6, 'local-user', 'Local user',
           '[\"operationLog.changed\"]', 1, ?7, ?7, NULL
         )",
        params![
            input.operation_id,
            if attempt.operation_status == "terminal-completed" {
                "success"
            } else {
                "partial"
            },
            target,
            summary,
            feedback,
            i64::from(matches!(
                attempt.operation_status.as_str(),
                "terminal-recovery-required" | "terminal-lifecycle-required"
            )),
            input.occurred_at,
        ],
    );
    let delivered = match inserted {
        Ok(_) => {
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT id FROM operation_logs
                     WHERE id=?1 AND module='provisioning' AND deleted_at IS NULL",
                    [&input.operation_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| database_error("verify idempotent OperationLog", error))?;
            existing.is_some()
        }
        Err(_) => false,
    };
    let (status, error_code, delivered_at) = if delivered {
        ("delivered", None, Some(input.occurred_at.as_str()))
    } else {
        ("failed", Some(PROVISIONING_OPERATION_DATABASE_ERROR), None)
    };
    let affected = transaction
        .execute(
            "UPDATE manuscript_provisioning_audit_outbox
             SET delivery_status=?1, revision=revision+1,
                 delivery_attempt_count=delivery_attempt_count+1,
                 operation_log_id=?2, error_code=?3, updated_at=?4, delivered_at=?5
             WHERE operation_id=?6 AND revision=?7 AND delivery_status=?8
               AND delivery_attempt_count=?9",
            params![
                status,
                if delivered {
                    Some(input.operation_id.as_str())
                } else {
                    None
                },
                error_code,
                input.occurred_at,
                delivered_at,
                input.operation_id,
                input.expected_revision,
                input.expected_status,
                outbox.delivery_attempt_count,
            ],
        )
        .map_err(|error| database_error("CAS audit outbox", error))?;
    if affected != 1 {
        return Err(repository_error(
            PROVISIONING_OUTBOX_DELIVERY_CONFLICT,
            "outbox CAS affected no row",
        ));
    }
    let readback = read_audit_state(&transaction, &input.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "outbox vanished"))?;
    transaction
        .commit()
        .map_err(|error| database_error("commit audit delivery", error))?;
    Ok(AuditDeliveryResult {
        outbox: readback,
        delivered,
    })
}

pub(crate) fn deliver_audit_outbox_once(
    connection: &mut Connection,
    input: &AuditDeliveryInput,
) -> RepositoryResult<AuditDeliveryResult> {
    deliver_audit(connection, input, "pending")
}

pub(crate) fn retry_audit_outbox_once(
    connection: &mut Connection,
    input: &AuditDeliveryInput,
) -> RepositoryResult<AuditDeliveryResult> {
    deliver_audit(connection, input, "failed")
}

pub(crate) fn deliver_audit_batch_once(
    connection: &mut Connection,
    batch_limit: usize,
    occurred_at: &str,
) -> RepositoryResult<Vec<AuditDeliveryResult>> {
    let candidates = list_audit_delivery_candidates(connection, batch_limit)?;
    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let input = AuditDeliveryInput {
            operation_id: candidate.operation_id,
            expected_revision: candidate.revision,
            expected_status: candidate.delivery_status.clone(),
            occurred_at: occurred_at.to_string(),
        };
        let result = if candidate.delivery_status == "pending" {
            deliver_audit_outbox_once(connection, &input)?
        } else {
            retry_audit_outbox_once(connection, &input)?
        };
        results.push(result);
    }
    Ok(results)
}

pub(crate) fn list_audit_delivery_candidates(
    connection: &Connection,
    batch_limit: usize,
) -> RepositoryResult<Vec<ProvisioningAuditOutbox>> {
    if batch_limit == 0 {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT operation_id, delivery_status, revision, delivery_attempt_count,
                    operation_log_id, error_code, created_at, updated_at, delivered_at
             FROM manuscript_provisioning_audit_outbox
             WHERE delivery_status IN ('pending','failed')
             ORDER BY updated_at, operation_id LIMIT ?1",
        )
        .map_err(|error| database_error("prepare audit candidates", error))?;
    let rows = statement
        .query_map([batch_limit as i64], outbox_from_row)
        .map_err(|error| database_error("query audit candidates", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("collect audit candidates", error))?;
    Ok(rows)
}

pub(crate) fn count_audit_delivery_candidates(connection: &Connection) -> RepositoryResult<usize> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_audit_outbox
             WHERE delivery_status IN ('pending','failed')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .map_err(|error| database_error("count audit candidates", error))
}
