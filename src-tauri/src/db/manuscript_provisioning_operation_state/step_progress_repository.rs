#![allow(dead_code)]

use super::claim_ownership::ClaimOwnershipRepositoryContext;
use super::step_progress::{
    durable_step_is_fully_converged, durable_step_plan_from_row, durable_step_progress_from_row,
    is_lowercase_sha256, is_utc_timestamp, literature_child_projection_from_row,
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
    DurableStepBoundary, DurableStepEffectOutcome, DurableStepKind, DurableStepPlanRow,
    DurableStepProgressRow, DurableStepReadbackOutcome, DurableStepScope,
    LiteratureChildProgressProjection, PlanFingerprintProfile, PlanTemplateKind,
};
use crate::manuscript_provisioning_contract::PROVISIONING_OWNER_ID_MAX_BYTES;
use super::PROVISIONING_OPERATION_DATABASE_ERROR;
use super::{
    apply_terminal_attempt_cas, database_error, insert_attempt, insert_claim,
    insert_pending_audit_outbox, read_active_claim_for_operation, read_operation_attempt,
    release_active_claim_cas, repository_error, ProvisioningActiveClaim, ProvisioningAuditOutbox,
    ProvisioningOperationAttempt, ProvisioningOperationRepositoryError, RepositoryResult,
    TerminalAttemptInput, PROVISIONING_OPERATION_CAS_CONFLICT, PROVISIONING_OPERATION_NOT_FOUND,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::BTreeSet;

pub(crate) const ACTIVE_CLAIM_CONFLICT: &str = "active-claim-conflict";
pub(crate) const PLAN_IDENTITY_MISMATCH: &str = "plan-identity-mismatch";
pub(crate) const PLAN_STRUCTURE_INVALID: &str = "plan-structure-invalid";
pub(crate) const STEP_IDENTITY_MISMATCH: &str = "step-identity-mismatch";
pub(crate) const PROGRESS_TRANSITION_INVALID: &str = "progress-transition-invalid";
pub(crate) const PROGRESS_REVISION_CONFLICT: &str = "progress-revision-conflict";
pub(crate) const PROGRESS_PAYLOAD_CONFLICT: &str = "progress-payload-conflict";
pub(crate) const CLAIM_HOLDER_MISMATCH: &str = "claim-holder-mismatch";
pub(crate) const ATTEMPT_NOT_ACTIVE: &str = "attempt-not-active";
pub(crate) const TERMINAL_PROGRESS_INCOMPLETE: &str = "terminal-progress-incomplete";
pub(crate) const RECOVERY_EVIDENCE_INVALID: &str = "recovery-evidence-invalid";
pub(crate) const LITERATURE_PROJECTION_CONFLICT: &str = "literature-projection-conflict";
pub(crate) const CLEANUP_PROGRESS_RETAINED: &str = "cleanup-progress-retained";
pub(crate) const STRUCTURAL_PROGRESS_CORRUPTION: &str = "structural-progress-corruption";
pub(crate) const MAX_RECOVERY_CHAIN_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableStepPlanInput {
    pub plan_id: String,
    pub plan_version: i64,
    pub plan_template_kind: PlanTemplateKind,
    pub plan_identity_fingerprint: String,
    pub precondition_snapshot_hash: String,
    pub fingerprint_profile: PlanFingerprintProfile,
    pub canonical_resource_identity_hash: String,
    pub canonical_placement_identity_hash: String,
    pub parent_shared_identity_hash: Option<String>,
    pub declared_step_count: i64,
    pub planner_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableStepSkeletonInput {
    pub step_id: String,
    pub step_ordinal: i64,
    pub step_kind: DurableStepKind,
    pub step_scope: DurableStepScope,
    pub step_version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AtomicDurableAttemptInput {
    pub operation_id: String,
    pub claim_id: String,
    #[cfg(test)]
    pub claim_owner_token: String,
    pub owner_type: DurablePlanOwnerType,
    pub owner_id: String,
    pub scope_kind: DurablePlanScopeKind,
    pub manuscript_channel: Option<DurableManuscriptChannel>,
    pub aggregate_operation_id: Option<String>,
    pub intent: DurablePlanIntent,
    pub trigger_kind: String,
    pub occurred_at: String,
    pub plan: DurableStepPlanInput,
    pub steps: Vec<DurableStepSkeletonInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AtomicDurableAttemptResult {
    pub attempt: ProvisioningOperationAttempt,
    pub claim: ProvisioningActiveClaim,
    pub plan: DurableStepPlanRow,
    pub steps: Vec<DurableStepProgressRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiteratureChildDurableAttemptInput {
    pub operation_id: String,
    pub aggregate_operation_id: String,
    pub aggregate_claim_id: String,
    #[cfg(test)]
    pub aggregate_claim_owner_token: String,
    pub expected_aggregate_claim_revision: i64,
    pub owner_id: String,
    pub manuscript_channel: DurableManuscriptChannel,
    pub intent: DurablePlanIntent,
    pub trigger_kind: String,
    pub occurred_at: String,
    pub expected_projection_revision: i64,
    pub expected_current_operation_id: String,
    pub expected_current_operation_scope_kind: DurablePlanScopeKind,
    pub plan: DurableStepPlanInput,
    pub steps: Vec<DurableStepSkeletonInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiteratureChildDurableAttemptResult {
    pub attempt: ProvisioningOperationAttempt,
    pub aggregate_claim: ProvisioningActiveClaim,
    pub plan: DurableStepPlanRow,
    pub steps: Vec<DurableStepProgressRow>,
    pub projection: LiteratureChildProgressProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiteratureChildTerminalResult {
    pub child: ProvisioningOperationAttempt,
    pub aggregate: ProvisioningOperationAttempt,
    pub projection: LiteratureChildProgressProjection,
    pub aggregate_claim: Option<ProvisioningActiveClaim>,
    pub aggregate_outbox: Option<ProvisioningAuditOutbox>,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AtomicInitFault {
    Attempt,
    Claim,
    Plan,
    Step(usize),
    LiteratureProjection,
    Readback,
}

fn safe_error(code: &'static str, message: &'static str) -> ProvisioningOperationRepositoryError {
    repository_error(code, message)
}

fn validate_scope(input: &AtomicDurableAttemptInput) -> RepositoryResult<()> {
    let identity_valid = match (
        input.scope_kind,
        input.owner_type,
        input.manuscript_channel,
        input.aggregate_operation_id.as_deref(),
    ) {
        (
            DurablePlanScopeKind::Channel,
            DurablePlanOwnerType::Literature,
            Some(
                DurableManuscriptChannel::LiteratureOutline
                | DurableManuscriptChannel::DedicatedNotes,
            ),
            None,
        )
        | (
            DurablePlanScopeKind::Channel,
            DurablePlanOwnerType::Experiment
            | DurablePlanOwnerType::ExperimentRun
            | DurablePlanOwnerType::Review
            | DurablePlanOwnerType::ResultItem
            | DurablePlanOwnerType::Finding
            | DurablePlanOwnerType::OutputCandidate
            | DurablePlanOwnerType::OutputGap
            | DurablePlanOwnerType::ResearchOutput,
            Some(DurableManuscriptChannel::Primary),
            None,
        )
        | (
            DurablePlanScopeKind::LiteratureAggregate,
            DurablePlanOwnerType::Literature,
            None,
            None,
        ) => true,
        // Literature child Attempts share aggregate authority and therefore are
        // not valid inputs to this Attempt+Claim atomic primitive.
        _ => false,
    };
    let trigger_valid = matches!(
        (input.intent, input.trigger_kind.as_str()),
        (DurablePlanIntent::CreateDefault, "owner-create")
            | (DurablePlanIntent::Retry, "explicit-retry")
            | (DurablePlanIntent::Repair, "explicit-repair")
            | (DurablePlanIntent::Recover, "explicit-recovery")
    );
    if !identity_valid
        || !trigger_valid
        || input.operation_id.is_empty()
        || input.claim_id.is_empty()
        || input.owner_id.is_empty()
        || input.owner_id.len() > PROVISIONING_OWNER_ID_MAX_BYTES
        || !is_utc_timestamp(&input.occurred_at)
    {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "attempt, owner, scope, channel or intent identity is invalid",
        ));
    }
    Ok(())
}

fn validate_plan_and_steps(input: &AtomicDurableAttemptInput) -> RepositoryResult<()> {
    let plan = &input.plan;
    let hashes_valid = [
        plan.plan_id.as_str(),
        plan.plan_identity_fingerprint.as_str(),
        plan.precondition_snapshot_hash.as_str(),
        plan.canonical_resource_identity_hash.as_str(),
        plan.canonical_placement_identity_hash.as_str(),
    ]
    .into_iter()
    .all(is_lowercase_sha256)
        && plan
            .parent_shared_identity_hash
            .as_deref()
            .is_none_or(is_lowercase_sha256);
    if !hashes_valid
        || plan.plan_version != 1
        || plan.fingerprint_profile != PlanFingerprintProfile::RestrictedJcsSha256V1
        || plan.declared_step_count != input.steps.len() as i64
        || !(0..=32).contains(&plan.declared_step_count)
        || (input.steps.is_empty() && input.intent != DurablePlanIntent::Recover)
        || plan.planner_version.is_empty()
        || plan.planner_version.len() > 64
    {
        return Err(safe_error(
            PLAN_STRUCTURE_INVALID,
            "immutable Plan identity, version, hash or step count is invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut scope_kinds = BTreeSet::new();
    for (index, step) in input.steps.iter().enumerate() {
        if step.step_ordinal != index as i64
            || step.step_version != 1
            || !is_lowercase_sha256(&step.step_id)
            || !ids.insert(step.step_id.as_str())
            || !scope_kinds.insert((step.step_scope.as_str(), step.step_kind.as_str()))
        {
            return Err(safe_error(
                PLAN_STRUCTURE_INVALID,
                "Step skeleton identity, ordinal, version or uniqueness is invalid",
            ));
        }
    }
    Ok(())
}

fn claim_conflicts(
    transaction: &Transaction<'_>,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<bool> {
    let count: i64 = if input.owner_type == DurablePlanOwnerType::Literature {
        match input.scope_kind {
            DurablePlanScopeKind::LiteratureAggregate => transaction.query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
                 WHERE owner_type='literature' AND owner_id=?1",
                [&input.owner_id],
                |row| row.get(0),
            ),
            DurablePlanScopeKind::Channel | DurablePlanScopeKind::LiteratureChild => transaction
                .query_row(
                    "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
                 WHERE owner_type='literature' AND owner_id=?1
                   AND (scope_kind='literature-aggregate' OR manuscript_channel=?2)",
                    params![
                        input.owner_id,
                        input.manuscript_channel.map(|value| value.as_str())
                    ],
                    |row| row.get(0),
                ),
        }
    } else {
        transaction.query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
             WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel=?3",
            params![
                input.owner_type.as_str(),
                input.owner_id,
                input.manuscript_channel.map(|value| value.as_str())
            ],
            |row| row.get(0),
        )
    }
    .map_err(|error| database_error("read active claim conflict", error))?;
    Ok(count != 0)
}

fn insert_plan(
    transaction: &Transaction<'_>,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id, operation_id, plan_version, plan_template_kind,
               plan_identity_fingerprint, precondition_snapshot_hash,
               fingerprint_profile, owner_type, owner_id, scope_kind,
               manuscript_channel, intent, canonical_resource_identity_hash,
               canonical_placement_identity_hash, parent_shared_identity_hash,
               step_count, planner_version, created_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18
             )",
            params![
                input.plan.plan_id,
                input.operation_id,
                input.plan.plan_version,
                input.plan.plan_template_kind.as_str(),
                input.plan.plan_identity_fingerprint,
                input.plan.precondition_snapshot_hash,
                input.plan.fingerprint_profile.as_str(),
                input.owner_type.as_str(),
                input.owner_id,
                input.scope_kind.as_str(),
                input.manuscript_channel.map(|value| value.as_str()),
                input.intent.as_str(),
                input.plan.canonical_resource_identity_hash,
                input.plan.canonical_placement_identity_hash,
                input.plan.parent_shared_identity_hash,
                input.plan.declared_step_count,
                input.plan.planner_version,
                input.occurred_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| database_error("insert immutable Plan Header", error))
}

fn insert_step(
    transaction: &Transaction<'_>,
    operation_id: &str,
    plan_id: &str,
    step: &DurableStepSkeletonInput,
    occurred_at: &str,
) -> RepositoryResult<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
               step_version, is_required, boundary, effect_outcome, readback_outcome,
               effect_facts_schema_version, progress_revision, created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 'intended', 'unobserved',
               'not-run', 1, 0, ?8, ?8
             )",
            params![
                step.step_id,
                plan_id,
                operation_id,
                step.step_ordinal,
                step.step_kind.as_str(),
                step.step_scope.as_str(),
                step.step_version,
                occurred_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| database_error("insert intended Step skeleton", error))
}

fn initialize_literature_projection(
    transaction: &Transaction<'_>,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<()> {
    if input.scope_kind != DurablePlanScopeKind::LiteratureAggregate {
        return Ok(());
    }
    for channel in ["literature_outline", "dedicated_notes"] {
        transaction
            .execute(
                "INSERT INTO manuscript_provisioning_literature_child_states (
                   aggregate_operation_id, owner_type, owner_id, manuscript_channel,
                   current_operation_id, current_operation_scope_kind, revision,
                   child_summary_status, default_readiness,
                   final_verification_outcome, updated_at
                 ) VALUES (
                   ?1, 'literature', ?2, ?3, ?1, 'literature-aggregate', 0,
                   'assigned', 'not-verified', 'not-run', ?4
                 )",
                params![
                    input.operation_id,
                    input.owner_id,
                    channel,
                    input.occurred_at
                ],
            )
            .map_err(|error| database_error("insert Literature assignment projection", error))?;
    }
    Ok(())
}

pub(crate) fn insert_plan_steps_for_existing_attempt(
    transaction: &Transaction<'_>,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &AtomicDurableAttemptInput,
    initialize_projection: bool,
) -> RepositoryResult<()> {
    if input.intent != DurablePlanIntent::Recover {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "legacy existing-Attempt Plan writer is restricted to explicit recovery",
        ));
    }
    validate_scope(input)?;
    validate_plan_and_steps(input)?;
    let attempt = read_operation_attempt(transaction, &input.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Attempt missing"))?;
    let claim = read_active_claim_for_operation(transaction, &input.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Claim missing"))?;
    if attempt.operation_status != "active"
        || attempt.owner_type != input.owner_type.as_str()
        || attempt.owner_id != input.owner_id
        || attempt.scope_kind != input.scope_kind.as_str()
        || attempt.manuscript_channel.as_deref()
            != input.manuscript_channel.map(|value| value.as_str())
        || claim.claim_id != input.claim_id
        || claim.claim_owner_token != ownership_context.claim_owner_token()
    {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "existing Attempt/Claim identity does not match Plan",
        ));
    }
    insert_plan(transaction, input)?;
    for step in &input.steps {
        insert_step(
            transaction,
            &input.operation_id,
            &input.plan.plan_id,
            step,
            &input.occurred_at,
        )?;
    }
    if initialize_projection {
        initialize_literature_projection(transaction, input)?;
    }
    let plan = read_attempt_plan(transaction, &input.operation_id)?;
    let steps = read_attempt_step_progress(transaction, &input.operation_id)?;
    if plan.as_ref().map(|value| value.step_count) != Some(steps.len() as i64) {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "existing Attempt Plan/Steps readback is incomplete",
        ));
    }
    Ok(())
}

fn create_atomic_inner(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &AtomicDurableAttemptInput,
    #[cfg(test)] fault: Option<AtomicInitFault>,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    validate_scope(input)?;
    validate_plan_and_steps(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin atomic durable attempt", error))?;
    let sealed_heartbeat = ownership_context.sample_sealed_heartbeat().map_err(|_| {
        safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "repository ownership clock unavailable",
        )
    })?;
    if claim_conflicts(&transaction, input)? {
        return Err(safe_error(
            ACTIVE_CLAIM_CONFLICT,
            "resource already has an active durable claim",
        ));
    }
    #[cfg(test)]
    if fault == Some(AtomicInitFault::Attempt) {
        return Err(safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "atomic init fault",
        ));
    }
    insert_attempt(
        &transaction,
        &input.operation_id,
        input.scope_kind.as_str(),
        input.owner_type.as_str(),
        &input.owner_id,
        input.manuscript_channel.map(|value| value.as_str()),
        input.aggregate_operation_id.as_deref(),
        input.intent.as_str(),
        &input.trigger_kind,
        &input.occurred_at,
    )?;
    #[cfg(test)]
    if fault == Some(AtomicInitFault::Claim) {
        return Err(safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "atomic init fault",
        ));
    }
    insert_claim(
        &transaction,
        &input.claim_id,
        input.scope_kind.as_str(),
        input.owner_type.as_str(),
        &input.owner_id,
        input.manuscript_channel.map(|value| value.as_str()),
        &input.operation_id,
        ownership_context.claim_owner_token(),
        &input.occurred_at,
        &sealed_heartbeat.persisted_value(),
    )?;
    #[cfg(test)]
    if fault == Some(AtomicInitFault::Plan) {
        return Err(safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "atomic init fault",
        ));
    }
    insert_plan(&transaction, input)?;
    for (_index, step) in input.steps.iter().enumerate() {
        #[cfg(test)]
        if fault == Some(AtomicInitFault::Step(_index)) {
            return Err(safe_error(
                PROVISIONING_OPERATION_DATABASE_ERROR,
                "atomic init fault",
            ));
        }
        insert_step(
            &transaction,
            &input.operation_id,
            &input.plan.plan_id,
            step,
            &input.occurred_at,
        )?;
    }
    #[cfg(test)]
    if fault == Some(AtomicInitFault::LiteratureProjection) {
        return Err(safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "atomic init fault",
        ));
    }
    initialize_literature_projection(&transaction, input)?;
    #[cfg(test)]
    if fault == Some(AtomicInitFault::Readback) {
        return Err(safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "atomic init fault",
        ));
    }
    let result = read_atomic_attempt(&transaction, &input.operation_id)?;
    if result.plan.plan_id != input.plan.plan_id
        || result.steps.len() != input.steps.len()
        || result.plan.step_count != result.steps.len() as i64
        || result
            .steps
            .iter()
            .enumerate()
            .any(|(index, step)| step.step_ordinal != index as i64 || !step.is_required)
    {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "atomic durable attempt readback is incomplete",
        ));
    }
    transaction
        .commit()
        .map_err(|error| database_error("commit atomic durable attempt", error))?;
    Ok(result)
}

/// Repository-internal entry used by the production mainline root initializer.
/// Its caller owns the IMMEDIATE transaction so the sealed durable
/// precondition can be minted and consumed without crossing a transaction
/// boundary.
pub(super) fn create_attempt_claim_plan_and_steps_in_transaction(
    transaction: &Transaction<'_>,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    if !matches!(
        input.intent,
        DurablePlanIntent::CreateDefault | DurablePlanIntent::Recover
    ) {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "ordinary Retry/Repair must use the sealed-token chained initializer",
        ));
    }
    validate_scope(input)?;
    validate_plan_and_steps(input)?;
    let sealed_heartbeat = ownership_context.sample_sealed_heartbeat().map_err(|_| {
        safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "repository ownership clock unavailable",
        )
    })?;
    if claim_conflicts(transaction, input)? {
        return Err(safe_error(
            ACTIVE_CLAIM_CONFLICT,
            "resource already has an active durable claim",
        ));
    }
    insert_attempt(
        transaction,
        &input.operation_id,
        input.scope_kind.as_str(),
        input.owner_type.as_str(),
        &input.owner_id,
        input.manuscript_channel.map(|value| value.as_str()),
        input.aggregate_operation_id.as_deref(),
        input.intent.as_str(),
        &input.trigger_kind,
        &input.occurred_at,
    )?;
    insert_claim(
        transaction,
        &input.claim_id,
        input.scope_kind.as_str(),
        input.owner_type.as_str(),
        &input.owner_id,
        input.manuscript_channel.map(|value| value.as_str()),
        &input.operation_id,
        ownership_context.claim_owner_token(),
        &input.occurred_at,
        &sealed_heartbeat.persisted_value(),
    )?;
    insert_plan(transaction, input)?;
    for step in &input.steps {
        insert_step(
            transaction,
            &input.operation_id,
            &input.plan.plan_id,
            step,
            &input.occurred_at,
        )?;
    }
    initialize_literature_projection(transaction, input)?;
    let result = read_atomic_attempt(transaction, &input.operation_id)?;
    if result.plan.plan_id != input.plan.plan_id
        || result.steps.len() != input.steps.len()
        || result.plan.step_count != result.steps.len() as i64
        || result
            .steps
            .iter()
            .enumerate()
            .any(|(index, step)| step.step_ordinal != index as i64 || !step.is_required)
    {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "atomic durable attempt readback is incomplete",
        ));
    }
    Ok(result)
}

fn create_attempt_claim_plan_and_steps_with_context(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    if !matches!(
        input.intent,
        DurablePlanIntent::CreateDefault | DurablePlanIntent::Recover
    ) {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "ordinary Retry/Repair must use the sealed-token chained initializer",
        ));
    }
    create_atomic_inner(
        connection,
        ownership_context,
        input,
        #[cfg(test)]
        None,
    )
}

#[cfg(not(test))]
pub(crate) fn create_attempt_claim_plan_and_steps(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    create_attempt_claim_plan_and_steps_with_context(connection, ownership_context, input)
}

#[cfg(test)]
pub(crate) fn create_attempt_claim_plan_and_steps(
    connection: &mut Connection,
    input: &AtomicDurableAttemptInput,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    let ownership_context = super::claim_ownership::fixed_repository_context_for_test(
        &input.claim_owner_token,
        1_700_000_000_000,
    );
    create_attempt_claim_plan_and_steps_with_context(connection, &ownership_context, input)
}

fn child_as_atomic_input(input: &LiteratureChildDurableAttemptInput) -> AtomicDurableAttemptInput {
    AtomicDurableAttemptInput {
        operation_id: input.operation_id.clone(),
        claim_id: input.aggregate_claim_id.clone(),
        #[cfg(test)]
        claim_owner_token: input.aggregate_claim_owner_token.clone(),
        owner_type: DurablePlanOwnerType::Literature,
        owner_id: input.owner_id.clone(),
        scope_kind: DurablePlanScopeKind::LiteratureChild,
        manuscript_channel: Some(input.manuscript_channel),
        aggregate_operation_id: Some(input.aggregate_operation_id.clone()),
        intent: input.intent,
        trigger_kind: input.trigger_kind.clone(),
        occurred_at: input.occurred_at.clone(),
        plan: input.plan.clone(),
        steps: input.steps.clone(),
    }
}

fn validate_literature_child_input(
    input: &LiteratureChildDurableAttemptInput,
) -> RepositoryResult<AtomicDurableAttemptInput> {
    let atomic = child_as_atomic_input(input);
    validate_plan_and_steps(&atomic)?;
    let expected_scope = match input.manuscript_channel {
        DurableManuscriptChannel::LiteratureOutline => DurableStepScope::LiteratureOutline,
        DurableManuscriptChannel::DedicatedNotes => DurableStepScope::DedicatedNotes,
        DurableManuscriptChannel::Primary => {
            return Err(safe_error(
                PLAN_IDENTITY_MISMATCH,
                "Literature child cannot use the primary channel",
            ))
        }
    };
    if input.operation_id.is_empty()
        || input.aggregate_operation_id.is_empty()
        || input.owner_id.is_empty()
        || input.plan.plan_template_kind != PlanTemplateKind::LiteratureChannel
        || input
            .steps
            .iter()
            .any(|step| step.step_scope != expected_scope)
        || !matches!(
            input.expected_current_operation_scope_kind,
            DurablePlanScopeKind::LiteratureAggregate | DurablePlanScopeKind::LiteratureChild
        )
        || !matches!(
            (input.intent, input.trigger_kind.as_str()),
            (DurablePlanIntent::Retry, "explicit-retry")
                | (DurablePlanIntent::Repair, "explicit-repair")
                | (DurablePlanIntent::Recover, "explicit-recovery")
        )
        || !is_utc_timestamp(&input.occurred_at)
    {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "Literature child identity, Plan scope or intent is invalid",
        ));
    }
    Ok(atomic)
}

fn read_literature_projection(
    connection: &Connection,
    aggregate_operation_id: &str,
    manuscript_channel: DurableManuscriptChannel,
) -> RepositoryResult<LiteratureChildProgressProjection> {
    read_literature_child_projections(connection, aggregate_operation_id)?
        .into_iter()
        .find(|row| row.manuscript_channel == manuscript_channel)
        .ok_or_else(|| {
            safe_error(
                LITERATURE_PROJECTION_CONFLICT,
                "required Literature projection is missing",
            )
        })
}

fn create_literature_child_durable_attempt_with_context(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &LiteratureChildDurableAttemptInput,
) -> RepositoryResult<LiteratureChildDurableAttemptResult> {
    let atomic = validate_literature_child_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin Literature child durable init", error))?;
    let aggregate = read_operation_attempt(&transaction, &input.aggregate_operation_id)?
        .ok_or_else(|| {
            repository_error(
                PROVISIONING_OPERATION_NOT_FOUND,
                "Literature aggregate Attempt missing",
            )
        })?;
    let aggregate_claim =
        read_active_claim_for_operation(&transaction, &input.aggregate_operation_id)?
            .ok_or_else(|| safe_error(CLAIM_HOLDER_MISMATCH, "aggregate Claim missing"))?;
    if aggregate.scope_kind != "literature-aggregate"
        || aggregate.owner_type != "literature"
        || aggregate.owner_id != input.owner_id
        || aggregate.operation_status != "active"
        || aggregate_claim.claim_id != input.aggregate_claim_id
        || aggregate_claim.claim_owner_token != ownership_context.claim_owner_token()
        || aggregate_claim.claim_revision != input.expected_aggregate_claim_revision
    {
        return Err(safe_error(
            CLAIM_HOLDER_MISMATCH,
            "aggregate Attempt or shared Claim authority changed",
        ));
    }
    let projection = read_literature_projection(
        &transaction,
        &input.aggregate_operation_id,
        input.manuscript_channel,
    )?;
    if projection.revision != input.expected_projection_revision
        || projection.current_operation_id != input.expected_current_operation_id
        || projection.current_operation_scope_kind.as_str()
            != input.expected_current_operation_scope_kind.as_str()
        || projection.owner_id != input.owner_id
    {
        return Err(safe_error(
            LITERATURE_PROJECTION_CONFLICT,
            "Literature assignment projection CAS changed",
        ));
    }
    let previous = if input.expected_current_operation_scope_kind
        == DurablePlanScopeKind::LiteratureChild
    {
        let previous = read_operation_attempt(&transaction, &input.expected_current_operation_id)?
            .ok_or_else(|| {
                safe_error(
                    RECOVERY_EVIDENCE_INVALID,
                    "previous Literature child Attempt is missing",
                )
            })?;
        if previous.operation_status == "active"
            || previous.owner_id != input.owner_id
            || previous.aggregate_operation_id.as_deref()
                != Some(input.aggregate_operation_id.as_str())
            || previous.manuscript_channel.as_deref() != Some(input.manuscript_channel.as_str())
        {
            return Err(safe_error(
                RECOVERY_EVIDENCE_INVALID,
                "previous Literature child Attempt is not a compatible terminal predecessor",
            ));
        }
        Some(previous)
    } else {
        None
    };
    insert_attempt(
        &transaction,
        &input.operation_id,
        "literature-child",
        "literature",
        &input.owner_id,
        Some(input.manuscript_channel.as_str()),
        Some(&input.aggregate_operation_id),
        input.intent.as_str(),
        &input.trigger_kind,
        &input.occurred_at,
    )?;
    if let Some(previous) = previous {
        let root = previous
            .root_operation_id
            .clone()
            .unwrap_or_else(|| previous.operation_id.clone());
        transaction
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET previous_operation_id=?1, root_operation_id=?2
                 WHERE operation_id=?3 AND revision=0 AND operation_status='active'",
                params![previous.operation_id, root, input.operation_id],
            )
            .map_err(|error| database_error("link Literature child Attempt", error))?;
    }
    insert_plan(&transaction, &atomic)?;
    for step in &atomic.steps {
        insert_step(
            &transaction,
            &atomic.operation_id,
            &atomic.plan.plan_id,
            step,
            &atomic.occurred_at,
        )?;
    }
    let assigned = transaction
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET current_operation_id=?1,
                 current_operation_scope_kind='literature-child',
                 revision=revision+1, child_summary_status='assigned',
                 result_classification=NULL, next_action=NULL,
                 default_readiness='not-verified',
                 final_verification_outcome='not-run',
                 original_cause_code=NULL, updated_at=?2
             WHERE aggregate_operation_id=?3 AND manuscript_channel=?4
               AND revision=?5 AND current_operation_id=?6
               AND current_operation_scope_kind=?7",
            params![
                input.operation_id,
                input.occurred_at,
                input.aggregate_operation_id,
                input.manuscript_channel.as_str(),
                input.expected_projection_revision,
                input.expected_current_operation_id,
                input.expected_current_operation_scope_kind.as_str(),
            ],
        )
        .map_err(|error| database_error("CAS assign Literature child projection", error))?;
    if assigned != 1 {
        return Err(safe_error(
            LITERATURE_PROJECTION_CONFLICT,
            "Literature assignment projection CAS affected no row",
        ));
    }
    let progressed = transaction
        .execute(
            "UPDATE manuscript_provisioning_active_claims
             SET claim_revision=claim_revision+1, last_progress_at=?1
             WHERE claim_id=?2 AND operation_id=?3 AND claim_owner_token=?4
               AND claim_revision=?5",
            params![
                input.occurred_at,
                input.aggregate_claim_id,
                input.aggregate_operation_id,
                ownership_context.claim_owner_token(),
                input.expected_aggregate_claim_revision,
            ],
        )
        .map_err(|error| database_error("CAS progress aggregate Claim", error))?;
    if progressed != 1 {
        return Err(safe_error(
            CLAIM_HOLDER_MISMATCH,
            "aggregate Claim CAS affected no row",
        ));
    }
    let result = LiteratureChildDurableAttemptResult {
        attempt: read_operation_attempt(&transaction, &input.operation_id)?.ok_or_else(|| {
            safe_error(
                STRUCTURAL_PROGRESS_CORRUPTION,
                "Literature child Attempt readback missing",
            )
        })?,
        aggregate_claim: read_active_claim_for_operation(
            &transaction,
            &input.aggregate_operation_id,
        )?
        .ok_or_else(|| safe_error(CLAIM_HOLDER_MISMATCH, "aggregate Claim readback missing"))?,
        plan: read_attempt_plan(&transaction, &input.operation_id)?.ok_or_else(|| {
            safe_error(
                STRUCTURAL_PROGRESS_CORRUPTION,
                "Literature child Plan readback missing",
            )
        })?,
        steps: read_attempt_step_progress(&transaction, &input.operation_id)?,
        projection: read_literature_projection(
            &transaction,
            &input.aggregate_operation_id,
            input.manuscript_channel,
        )?,
    };
    if result.steps.len() != input.steps.len()
        || result.plan.step_count != result.steps.len() as i64
    {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Literature child Plan/Step readback is incomplete",
        ));
    }
    transaction
        .commit()
        .map_err(|error| database_error("commit Literature child durable init", error))?;
    Ok(result)
}

#[cfg(not(test))]
pub(crate) fn create_literature_child_durable_attempt(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    input: &LiteratureChildDurableAttemptInput,
) -> RepositoryResult<LiteratureChildDurableAttemptResult> {
    create_literature_child_durable_attempt_with_context(connection, ownership_context, input)
}

#[cfg(test)]
pub(crate) fn create_literature_child_durable_attempt(
    connection: &mut Connection,
    input: &LiteratureChildDurableAttemptInput,
) -> RepositoryResult<LiteratureChildDurableAttemptResult> {
    let ownership_context = super::claim_ownership::fixed_repository_context_for_test(
        &input.aggregate_claim_owner_token,
        1_700_000_000_000,
    );
    create_literature_child_durable_attempt_with_context(connection, &ownership_context, input)
}

#[cfg(test)]
pub(crate) fn create_attempt_claim_plan_and_steps_with_fault(
    connection: &mut Connection,
    input: &AtomicDurableAttemptInput,
    fault: AtomicInitFault,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    if !matches!(
        input.intent,
        DurablePlanIntent::CreateDefault | DurablePlanIntent::Recover
    ) {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "ordinary Retry/Repair must use the sealed-token chained initializer",
        ));
    }
    let ownership_context = super::claim_ownership::fixed_repository_context_for_test(
        &input.claim_owner_token,
        1_700_000_000_000,
    );
    create_atomic_inner(connection, &ownership_context, input, Some(fault))
}

const PLAN_SELECT: &str = "SELECT
  plan_id, operation_id, plan_version, plan_template_kind,
  plan_identity_fingerprint, precondition_snapshot_hash, fingerprint_profile,
  owner_type, owner_id, scope_kind, manuscript_channel, intent,
  canonical_resource_identity_hash, canonical_placement_identity_hash,
  parent_shared_identity_hash, step_count, planner_version, created_at
 FROM manuscript_provisioning_step_plans";

const STEP_SELECT: &str = "SELECT
  step_id, plan_id, operation_id, step_ordinal, step_kind, step_scope,
  step_version, is_required, boundary, effect_outcome, readback_outcome,
  observed_identity_hash, resource_record_id, effect_facts_schema_version,
  progress_revision, created_at, updated_at, started_at, effect_observed_at,
  readback_verified_at, converged_at
 FROM manuscript_provisioning_step_progress";

pub(crate) fn read_attempt_plan(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Option<DurableStepPlanRow>> {
    connection
        .query_row(
            &format!("{PLAN_SELECT} WHERE operation_id=?1"),
            [operation_id],
            durable_step_plan_from_row,
        )
        .optional()
        .map_err(|error| database_error("read Attempt Plan", error))
}

pub(crate) fn read_attempt_step_progress(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Vec<DurableStepProgressRow>> {
    let mut statement = connection
        .prepare(&format!(
            "{STEP_SELECT} WHERE operation_id=?1 ORDER BY step_ordinal, step_id"
        ))
        .map_err(|error| database_error("prepare Attempt Step query", error))?;
    let rows = statement
        .query_map([operation_id], durable_step_progress_from_row)
        .map_err(|error| database_error("query Attempt Steps", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("decode Attempt Steps", error))?;
    Ok(rows)
}

pub(crate) fn read_step_progress(
    connection: &Connection,
    operation_id: &str,
    plan_id: &str,
    step_id: &str,
) -> RepositoryResult<Option<DurableStepProgressRow>> {
    connection
        .query_row(
            &format!("{STEP_SELECT} WHERE operation_id=?1 AND plan_id=?2 AND step_id=?3"),
            params![operation_id, plan_id, step_id],
            durable_step_progress_from_row,
        )
        .optional()
        .map_err(|error| database_error("read scoped Step Progress", error))
}

pub(crate) fn read_current_unconverged_steps(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<Vec<DurableStepProgressRow>> {
    Ok(read_attempt_step_progress(connection, operation_id)?
        .into_iter()
        .filter(|step| step.boundary != DurableStepBoundary::Converged)
        .collect())
}

pub(crate) fn read_literature_child_projections(
    connection: &Connection,
    aggregate_operation_id: &str,
) -> RepositoryResult<Vec<LiteratureChildProgressProjection>> {
    let mut statement = connection
        .prepare(
            "SELECT
               aggregate_operation_id, owner_type, owner_id, manuscript_channel,
               current_operation_id, current_operation_scope_kind, revision,
               child_summary_status, result_classification, next_action,
               default_readiness, final_verification_outcome, original_cause_code,
               updated_at
             FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1
             ORDER BY manuscript_channel",
        )
        .map_err(|error| database_error("prepare Literature projection query", error))?;
    let projections = statement
        .query_map(
            [aggregate_operation_id],
            literature_child_projection_from_row,
        )
        .map_err(|error| database_error("query Literature projections", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("decode Literature projections", error))?;
    Ok(projections)
}

pub(crate) fn sync_literature_terminal_projection(
    transaction: &Transaction<'_>,
    attempt: &ProvisioningOperationAttempt,
    terminal: &TerminalAttemptInput,
) -> RepositoryResult<()> {
    if attempt.owner_type != "literature" {
        return Ok(());
    }
    if attempt.scope_kind == "literature-aggregate" {
        for channel in [
            ("literature_outline", DurableStepScope::LiteratureOutline),
            ("dedicated_notes", DurableStepScope::DedicatedNotes),
        ] {
            let (actual, converged): (i64, i64) = transaction
                .query_row(
                    "SELECT COUNT(*), SUM(CASE WHEN boundary='converged' THEN 1 ELSE 0 END)
                     FROM manuscript_provisioning_step_progress
                     WHERE operation_id=?1 AND step_scope=?2",
                    params![attempt.operation_id, channel.1.as_str()],
                    |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
                )
                .map_err(|error| database_error("read aggregate Literature progress", error))?;
            let ready = actual == 4 && converged == actual;
            let summary = if ready {
                "terminal-completed"
            } else {
                "terminal-unresolved"
            };
            let updated = transaction
                .execute(
                    "UPDATE manuscript_provisioning_literature_child_states
                     SET revision=revision+1, child_summary_status=?1,
                         result_classification=?2, next_action=?3,
                         default_readiness=?4, final_verification_outcome=?5,
                         original_cause_code=?6, updated_at=?7
                     WHERE aggregate_operation_id=?8 AND manuscript_channel=?9
                       AND current_operation_id=?8
                       AND current_operation_scope_kind='literature-aggregate'",
                    params![
                        summary,
                        if ready {
                            "completed"
                        } else {
                            terminal.result_classification.as_str()
                        },
                        if ready {
                            "none"
                        } else {
                            terminal.next_action.as_str()
                        },
                        if ready { "ready" } else { "not-ready" },
                        if ready { "passed" } else { "not-passed" },
                        if ready {
                            None::<&str>
                        } else {
                            terminal.original_cause_code.as_deref()
                        },
                        terminal.occurred_at,
                        attempt.operation_id,
                        channel.0,
                    ],
                )
                .map_err(|error| database_error("sync aggregate Literature projection", error))?;
            if updated != 1 {
                return Err(safe_error(
                    LITERATURE_PROJECTION_CONFLICT,
                    "aggregate terminal Literature projection authority changed",
                ));
            }
        }
        return Ok(());
    }
    if attempt.scope_kind != "literature-child" {
        return Ok(());
    }
    let summary = if terminal.operation_status == "terminal-completed" {
        "terminal-completed"
    } else {
        "terminal-unresolved"
    };
    let readiness = if terminal.operation_status == "terminal-completed"
        && terminal.final_verification_outcome == "passed"
    {
        "ready"
    } else if terminal.final_verification_outcome == "not-run" {
        "not-verified"
    } else {
        "not-ready"
    };
    let updated = transaction
        .execute(
            "UPDATE manuscript_provisioning_literature_child_states
             SET revision=revision+1, child_summary_status=?1,
                 result_classification=?2, next_action=?3, default_readiness=?4,
                 final_verification_outcome=?5, original_cause_code=?6,
                 updated_at=?7
             WHERE aggregate_operation_id=?8 AND manuscript_channel=?9
               AND current_operation_id=?10
               AND current_operation_scope_kind='literature-child'",
            params![
                summary,
                terminal.result_classification,
                terminal.next_action,
                readiness,
                terminal.final_verification_outcome,
                terminal.original_cause_code,
                terminal.occurred_at,
                attempt.aggregate_operation_id,
                attempt.manuscript_channel,
                attempt.operation_id,
            ],
        )
        .map_err(|error| database_error("sync terminal Literature projection", error))?;
    if updated != 1 {
        return Err(safe_error(
            LITERATURE_PROJECTION_CONFLICT,
            "terminal Literature projection authority changed",
        ));
    }
    Ok(())
}

fn aggregate_terminal_from_child(
    aggregate: &ProvisioningOperationAttempt,
    claim: &ProvisioningActiveClaim,
    child_terminal: &TerminalAttemptInput,
    completed: bool,
) -> TerminalAttemptInput {
    TerminalAttemptInput {
        operation_id: aggregate.operation_id.clone(),
        claim_id: claim.claim_id.clone(),
        claim_owner_token: claim.claim_owner_token.clone(),
        expected_operation_revision: aggregate.revision,
        expected_claim_revision: claim.claim_revision,
        expected_phase: aggregate.phase.clone(),
        expected_operation_status: aggregate.operation_status.clone(),
        phase: if completed { "completed" } else { "failed" }.to_string(),
        operation_status: if completed {
            "terminal-completed"
        } else {
            "terminal-recovery-required"
        }
        .to_string(),
        result_classification: if completed {
            "completed"
        } else {
            "provisioning-recovery-required"
        }
        .to_string(),
        next_action: if completed { "none" } else { "recover" }.to_string(),
        partial_kind: (!completed).then(|| "multi-channel".to_string()),
        original_cause_code: (!completed).then(|| {
            child_terminal
                .original_cause_code
                .clone()
                .unwrap_or_else(|| "LITERATURE_CHILD_UNRESOLVED".to_string())
        }),
        folder_effect: aggregate.folder_effect.clone(),
        manuscript_effect: aggregate.manuscript_effect.clone(),
        file_ref_effect: aggregate.file_ref_effect.clone(),
        binding_effect: aggregate.binding_effect.clone(),
        default_folder_file_ref_id: aggregate.default_folder_file_ref_id.clone(),
        default_manuscript_file_ref_id: aggregate.default_manuscript_file_ref_id.clone(),
        binding_id: aggregate.binding_id.clone(),
        final_verification_outcome: if completed { "passed" } else { "not-passed" }.to_string(),
        inspector_version: aggregate.inspector_version.clone(),
        verifier_version: aggregate.verifier_version.clone(),
        occurred_at: child_terminal.occurred_at.clone(),
    }
}

pub(crate) fn terminalize_literature_child_attempt(
    connection: &mut Connection,
    input: &TerminalAttemptInput,
) -> RepositoryResult<LiteratureChildTerminalResult> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin shared Literature terminal authority", error))?;
    let child = read_operation_attempt(&transaction, &input.operation_id)?.ok_or_else(|| {
        repository_error(PROVISIONING_OPERATION_NOT_FOUND, "child Attempt missing")
    })?;
    if child.scope_kind != "literature-child" || child.owner_type != "literature" {
        return Err(safe_error(
            PLAN_IDENTITY_MISMATCH,
            "terminal target is not a Literature child Attempt",
        ));
    }
    let aggregate_operation_id = child.aggregate_operation_id.clone().ok_or_else(|| {
        safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Literature child aggregate identity is missing",
        )
    })?;
    let aggregate =
        read_operation_attempt(&transaction, &aggregate_operation_id)?.ok_or_else(|| {
            safe_error(
                STRUCTURAL_PROGRESS_CORRUPTION,
                "Literature aggregate Attempt is missing",
            )
        })?;
    let claim = read_active_claim_for_operation(&transaction, &aggregate_operation_id)?
        .ok_or_else(|| safe_error(CLAIM_HOLDER_MISMATCH, "aggregate Claim missing"))?;
    if aggregate.scope_kind != "literature-aggregate"
        || aggregate.owner_id != child.owner_id
        || aggregate.operation_status != "active"
        || claim.claim_id != input.claim_id
        || claim.claim_owner_token != input.claim_owner_token
        || claim.claim_revision != input.expected_claim_revision
    {
        return Err(safe_error(
            CLAIM_HOLDER_MISMATCH,
            "Literature terminal aggregate Claim authority changed",
        ));
    }
    let projection = read_literature_projection(
        &transaction,
        &aggregate_operation_id,
        child
            .manuscript_channel
            .as_deref()
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| {
                safe_error(
                    STRUCTURAL_PROGRESS_CORRUPTION,
                    "Literature child channel is invalid",
                )
            })?,
    )?;
    if projection.current_operation_id != child.operation_id
        || projection.current_operation_scope_kind.as_str() != "literature-child"
    {
        return Err(safe_error(
            LITERATURE_PROJECTION_CONFLICT,
            "Literature terminal projection does not point at child",
        ));
    }
    let terminal_child = apply_terminal_attempt_cas(&transaction, input)?;
    sync_literature_terminal_projection(&transaction, &child, input)?;
    let projections = read_literature_child_projections(&transaction, &aggregate_operation_id)?;
    if projections.len() != 2 {
        return Err(safe_error(
            LITERATURE_PROJECTION_CONFLICT,
            "Literature aggregate requires exactly two channel projections",
        ));
    }
    let child_unresolved = input.operation_status != "terminal-completed";
    let all_children_completed = projections
        .iter()
        .all(|row| row.child_summary_status.as_str() == "terminal-completed");
    let (terminal_aggregate, aggregate_claim, aggregate_outbox) = if child_unresolved
        || all_children_completed
    {
        let aggregate_terminal =
            aggregate_terminal_from_child(&aggregate, &claim, input, all_children_completed);
        let terminal_aggregate = apply_terminal_attempt_cas(&transaction, &aggregate_terminal)?;
        release_active_claim_cas(&transaction, &claim)?;
        let outbox =
            insert_pending_audit_outbox(&transaction, &aggregate_operation_id, &input.occurred_at)?;
        (terminal_aggregate, None, Some(outbox))
    } else {
        let changed = transaction
            .execute(
                "UPDATE manuscript_provisioning_active_claims
                     SET claim_revision=claim_revision+1, last_progress_at=?1
                     WHERE claim_id=?2 AND operation_id=?3 AND claim_owner_token=?4
                       AND claim_revision=?5",
                params![
                    input.occurred_at,
                    claim.claim_id,
                    claim.operation_id,
                    claim.claim_owner_token,
                    claim.claim_revision,
                ],
            )
            .map_err(|error| {
                database_error("retain aggregate Claim after child terminal", error)
            })?;
        if changed != 1 {
            return Err(safe_error(
                PROVISIONING_OPERATION_CAS_CONFLICT,
                "aggregate Claim retain CAS affected no row",
            ));
        }
        let retained = read_active_claim_for_operation(&transaction, &aggregate_operation_id)?
            .ok_or_else(|| safe_error(CLAIM_HOLDER_MISMATCH, "retained Claim missing"))?;
        (aggregate, Some(retained), None)
    };
    let terminal_projection = read_literature_projection(
        &transaction,
        &aggregate_operation_id,
        projection.manuscript_channel,
    )?;
    transaction
        .commit()
        .map_err(|error| database_error("commit shared Literature terminal authority", error))?;
    Ok(LiteratureChildTerminalResult {
        child: terminal_child,
        aggregate: terminal_aggregate,
        projection: terminal_projection,
        aggregate_claim,
        aggregate_outbox,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RequiredStepSummary {
    pub operation_id: String,
    pub declared_count: i64,
    pub actual_count: usize,
    pub converged_count: usize,
    pub structurally_complete: bool,
}

pub(crate) fn read_required_step_summary(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<RequiredStepSummary> {
    let plan = read_attempt_plan(connection, operation_id)?.ok_or_else(|| {
        safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Attempt has no immutable Plan",
        )
    })?;
    let steps = read_attempt_step_progress(connection, operation_id)?;
    let structurally_complete = plan.step_count == steps.len() as i64
        && steps
            .iter()
            .enumerate()
            .all(|(index, step)| step.is_required && step.step_ordinal == index as i64);
    Ok(RequiredStepSummary {
        operation_id: operation_id.to_string(),
        declared_count: plan.step_count,
        actual_count: steps.len(),
        converged_count: steps
            .iter()
            .filter(|step| durable_step_is_fully_converged(step))
            .count(),
        structurally_complete,
    })
}

fn read_atomic_attempt(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<AtomicDurableAttemptResult> {
    Ok(AtomicDurableAttemptResult {
        attempt: read_operation_attempt(connection, operation_id)?.ok_or_else(|| {
            repository_error(PROVISIONING_OPERATION_NOT_FOUND, "atomic Attempt missing")
        })?,
        claim: read_active_claim_for_operation(connection, operation_id)?.ok_or_else(|| {
            repository_error(PROVISIONING_OPERATION_NOT_FOUND, "atomic Claim missing")
        })?,
        plan: read_attempt_plan(connection, operation_id)?
            .ok_or_else(|| safe_error(STRUCTURAL_PROGRESS_CORRUPTION, "atomic Plan missing"))?,
        steps: read_attempt_step_progress(connection, operation_id)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgressAuthorityInput {
    pub operation_id: String,
    pub plan_id: String,
    pub step_id: String,
    pub claim_id: String,
    pub claim_owner_token: String,
    pub expected_progress_revision: i64,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressMutationStatus {
    Applied,
    AlreadyApplied,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgressMutationResult {
    pub status: ProgressMutationStatus,
    pub step: DurableStepProgressRow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgressCommand {
    Started,
    NoEffect,
    EffectObserved,
    ReadbackVerified,
    Converged,
}

#[derive(Debug, Clone)]
struct ProgressTarget {
    boundary: DurableStepBoundary,
    effect: DurableStepEffectOutcome,
    readback: DurableStepReadbackOutcome,
    identity: Option<String>,
    resource_record_id: Option<String>,
    started_at: Option<String>,
    effect_observed_at: Option<String>,
    readback_verified_at: Option<String>,
    converged_at: Option<String>,
}

fn target_matches(row: &DurableStepProgressRow, target: &ProgressTarget) -> bool {
    row.boundary == target.boundary
        && row.effect_outcome == target.effect
        && row.readback_outcome == target.readback
        && row.observed_identity_hash == target.identity
        && row.resource_record_id == target.resource_record_id
        && row.started_at == target.started_at
        && row.effect_observed_at == target.effect_observed_at
        && row.readback_verified_at == target.readback_verified_at
        && row.converged_at == target.converged_at
}

fn transition_allowed(command: ProgressCommand, row: &DurableStepProgressRow) -> bool {
    matches!(
        (
            command,
            row.boundary,
            row.effect_outcome,
            row.readback_outcome
        ),
        (
            ProgressCommand::Started,
            DurableStepBoundary::Intended,
            DurableStepEffectOutcome::Unobserved,
            DurableStepReadbackOutcome::NotRun
        ) | (
            ProgressCommand::NoEffect,
            DurableStepBoundary::Started,
            DurableStepEffectOutcome::Unobserved,
            DurableStepReadbackOutcome::NotRun
                | DurableStepReadbackOutcome::WrongType
                | DurableStepReadbackOutcome::IdentityMismatch
                | DurableStepReadbackOutcome::ContainmentFailed
                | DurableStepReadbackOutcome::Conflict
                | DurableStepReadbackOutcome::Unavailable
        ) | (
            ProgressCommand::EffectObserved,
            DurableStepBoundary::Started,
            DurableStepEffectOutcome::Unobserved,
            _
        ) | (
            ProgressCommand::ReadbackVerified,
            DurableStepBoundary::EffectObserved,
            _,
            DurableStepReadbackOutcome::EffectObserved
        ) | (
            ProgressCommand::Converged,
            DurableStepBoundary::ReadbackVerified,
            _,
            DurableStepReadbackOutcome::Verified
        )
    )
}

fn mutate_progress(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
    expected_claim_revision: Option<i64>,
    command: ProgressCommand,
    effect: Option<DurableStepEffectOutcome>,
    identity: Option<&str>,
    resource_record_id: Option<&str>,
) -> RepositoryResult<ProgressMutationResult> {
    if !is_utc_timestamp(&authority.occurred_at) {
        return Err(safe_error(
            PROGRESS_PAYLOAD_CONFLICT,
            "Progress timestamp is invalid",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin Progress CAS", error))?;
    let attempt = read_operation_attempt(&transaction, &authority.operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Attempt missing"))?;
    if attempt.operation_status != "active" {
        return Err(safe_error(
            ATTEMPT_NOT_ACTIVE,
            "Progress requires an active Attempt",
        ));
    }
    let claim_operation_id = if attempt.scope_kind == "literature-child" {
        attempt.aggregate_operation_id.as_deref().ok_or_else(|| {
            safe_error(
                STRUCTURAL_PROGRESS_CORRUPTION,
                "Literature child has no aggregate Claim authority",
            )
        })?
    } else {
        authority.operation_id.as_str()
    };
    let claim = read_active_claim_for_operation(&transaction, claim_operation_id)?
        .ok_or_else(|| safe_error(CLAIM_HOLDER_MISMATCH, "active Claim missing"))?;
    if claim.claim_id != authority.claim_id
        || claim.claim_owner_token != authority.claim_owner_token
        || expected_claim_revision.is_some_and(|revision| claim.claim_revision != revision)
    {
        return Err(safe_error(
            CLAIM_HOLDER_MISMATCH,
            "active Claim identity or holder does not match",
        ));
    }
    let current = read_step_progress(
        &transaction,
        &authority.operation_id,
        &authority.plan_id,
        &authority.step_id,
    )?
    .ok_or_else(|| safe_error(STEP_IDENTITY_MISMATCH, "scoped Step identity not found"))?;
    let target = match command {
        ProgressCommand::Started => ProgressTarget {
            boundary: DurableStepBoundary::Started,
            effect: DurableStepEffectOutcome::Unobserved,
            readback: DurableStepReadbackOutcome::NotRun,
            identity: None,
            resource_record_id: None,
            started_at: Some(authority.occurred_at.clone()),
            effect_observed_at: None,
            readback_verified_at: None,
            converged_at: None,
        },
        ProgressCommand::NoEffect => ProgressTarget {
            boundary: DurableStepBoundary::Started,
            effect: DurableStepEffectOutcome::NoEffectProven,
            readback: DurableStepReadbackOutcome::VerifiedAbsent,
            identity: None,
            resource_record_id: None,
            started_at: current.started_at.clone(),
            effect_observed_at: None,
            readback_verified_at: None,
            converged_at: None,
        },
        ProgressCommand::EffectObserved => {
            let effect = effect.filter(|value| {
                matches!(
                    value,
                    DurableStepEffectOutcome::Created
                        | DurableStepEffectOutcome::Reused
                        | DurableStepEffectOutcome::Updated
                        | DurableStepEffectOutcome::Preserved
                )
            });
            if effect.is_none()
                || identity.is_none_or(|value| !is_lowercase_sha256(value))
                || resource_record_id.is_some_and(|value| value.is_empty() || value.len() > 128)
            {
                return Err(safe_error(
                    PROGRESS_PAYLOAD_CONFLICT,
                    "observed effect facts are invalid",
                ));
            }
            ProgressTarget {
                boundary: DurableStepBoundary::EffectObserved,
                effect: effect.expect("checked effect"),
                readback: DurableStepReadbackOutcome::EffectObserved,
                identity: identity.map(str::to_string),
                resource_record_id: resource_record_id.map(str::to_string),
                started_at: current.started_at.clone(),
                effect_observed_at: Some(authority.occurred_at.clone()),
                readback_verified_at: None,
                converged_at: None,
            }
        }
        ProgressCommand::ReadbackVerified => ProgressTarget {
            boundary: DurableStepBoundary::ReadbackVerified,
            effect: current.effect_outcome,
            readback: DurableStepReadbackOutcome::Verified,
            identity: current.observed_identity_hash.clone(),
            resource_record_id: current.resource_record_id.clone(),
            started_at: current.started_at.clone(),
            effect_observed_at: current.effect_observed_at.clone(),
            readback_verified_at: Some(authority.occurred_at.clone()),
            converged_at: None,
        },
        ProgressCommand::Converged => ProgressTarget {
            boundary: DurableStepBoundary::Converged,
            effect: current.effect_outcome,
            readback: DurableStepReadbackOutcome::Verified,
            identity: current.observed_identity_hash.clone(),
            resource_record_id: current.resource_record_id.clone(),
            started_at: current.started_at.clone(),
            effect_observed_at: current.effect_observed_at.clone(),
            readback_verified_at: current.readback_verified_at.clone(),
            converged_at: Some(authority.occurred_at.clone()),
        },
    };
    if target_matches(&current, &target) {
        transaction
            .commit()
            .map_err(|error| database_error("commit idempotent Progress read", error))?;
        return Ok(ProgressMutationResult {
            status: ProgressMutationStatus::AlreadyApplied,
            step: current,
        });
    }
    if current.progress_revision != authority.expected_progress_revision {
        return Err(safe_error(
            PROGRESS_REVISION_CONFLICT,
            "Progress revision no longer matches",
        ));
    }
    if current.boundary == target.boundary && command != ProgressCommand::NoEffect {
        return Err(safe_error(
            PROGRESS_PAYLOAD_CONFLICT,
            "same boundary already contains different structured facts",
        ));
    }
    if !transition_allowed(command, &current) {
        return Err(safe_error(
            PROGRESS_TRANSITION_INVALID,
            "Progress boundary transition is not legal",
        ));
    }
    let changed = transaction
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary=?1, effect_outcome=?2, readback_outcome=?3,
                 observed_identity_hash=?4, resource_record_id=?5,
                 started_at=?6, effect_observed_at=?7, readback_verified_at=?8,
                 converged_at=?9, progress_revision=progress_revision+1, updated_at=?10
             WHERE operation_id=?11 AND plan_id=?12 AND step_id=?13
               AND progress_revision=?14 AND boundary=?15",
            params![
                target.boundary.as_str(),
                target.effect.as_str(),
                target.readback.as_str(),
                target.identity,
                target.resource_record_id,
                target.started_at,
                target.effect_observed_at,
                target.readback_verified_at,
                target.converged_at,
                authority.occurred_at,
                authority.operation_id,
                authority.plan_id,
                authority.step_id,
                authority.expected_progress_revision,
                current.boundary.as_str(),
            ],
        )
        .map_err(|error| database_error("apply narrow Progress CAS", error))?;
    if changed != 1 {
        return Err(safe_error(
            PROGRESS_REVISION_CONFLICT,
            "Progress CAS affected no row",
        ));
    }
    let step = read_step_progress(
        &transaction,
        &authority.operation_id,
        &authority.plan_id,
        &authority.step_id,
    )?
    .ok_or_else(|| safe_error(STRUCTURAL_PROGRESS_CORRUPTION, "Step vanished after CAS"))?;
    transaction
        .commit()
        .map_err(|error| database_error("commit Progress CAS", error))?;
    Ok(ProgressMutationResult {
        status: ProgressMutationStatus::Applied,
        step,
    })
}

pub(crate) fn mark_step_started(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
) -> RepositoryResult<ProgressMutationResult> {
    mutate_progress(
        connection,
        authority,
        None,
        ProgressCommand::Started,
        None,
        None,
        None,
    )
}

pub(crate) fn mark_shared_execution_step_started(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
    expected_claim_revision: i64,
) -> RepositoryResult<ProgressMutationResult> {
    mutate_progress(
        connection,
        authority,
        Some(expected_claim_revision),
        ProgressCommand::Started,
        None,
        None,
        None,
    )
}

pub(crate) fn record_step_no_effect(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
) -> RepositoryResult<ProgressMutationResult> {
    mutate_progress(
        connection,
        authority,
        None,
        ProgressCommand::NoEffect,
        None,
        None,
        None,
    )
}

pub(crate) fn record_step_effect_observed(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
    effect: DurableStepEffectOutcome,
    observed_identity_hash: &str,
    resource_record_id: Option<&str>,
) -> RepositoryResult<ProgressMutationResult> {
    mutate_progress(
        connection,
        authority,
        None,
        ProgressCommand::EffectObserved,
        Some(effect),
        Some(observed_identity_hash),
        resource_record_id,
    )
}

pub(crate) fn record_step_readback_verified(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
) -> RepositoryResult<ProgressMutationResult> {
    mutate_progress(
        connection,
        authority,
        None,
        ProgressCommand::ReadbackVerified,
        None,
        None,
        None,
    )
}

pub(crate) fn converge_step(
    connection: &mut Connection,
    authority: &ProgressAuthorityInput,
) -> RepositoryResult<ProgressMutationResult> {
    mutate_progress(
        connection,
        authority,
        None,
        ProgressCommand::Converged,
        None,
        None,
        None,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionInvocationExposure {
    NotInvoked,
    InvocationReturned,
    InvocationInterrupted,
    InvocationOutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionReadbackClassification {
    VerifiedComplete,
    VerifiedAbsent,
    VerifiedPartial,
    Conflict,
    Unavailable,
    IdentityMismatch,
    ContainmentFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionEffectClassification {
    Created,
    Reused,
    Updated,
    Preserved,
}

#[derive(Debug)]
pub(crate) struct SharedExecutionStepResultInput {
    pub operation_id: String,
    pub expected_attempt_revision: i64,
    pub claim_id: String,
    pub claim_owner_token: String,
    pub expected_claim_revision: i64,
    pub plan_id: String,
    pub plan_identity_fingerprint: String,
    pub adapter_manifest_hash: String,
    pub step_id: String,
    pub expected_progress_revision: i64,
    pub invocation_exposure: ExecutionInvocationExposure,
    pub readback: ExecutionReadbackClassification,
    pub effect: Option<ExecutionEffectClassification>,
    pub observed_identity_hash: Option<String>,
    pub resource_record_id: Option<String>,
    pub occurred_at: String,
    #[cfg(test)]
    pub simulate_response_lost_after_commit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SharedExecutionStepDisposition {
    ExecutionContinues,
    CompletedAndReleased,
    RecoveryRequiredAndRetained,
}

#[derive(Debug)]
pub(crate) struct SharedExecutionStepResult {
    pub disposition: SharedExecutionStepDisposition,
    pub step: DurableStepProgressRow,
    pub attempt: ProvisioningOperationAttempt,
    pub claim: Option<ProvisioningActiveClaim>,
}

/// Unique SE1 result writer. Claim disposition and Attempt terminal decision
/// are frozen before any Step UPDATE and committed in the same transaction.
pub(crate) fn commit_shared_execution_step_result(
    connection: &mut Connection,
    input: &SharedExecutionStepResultInput,
) -> RepositoryResult<SharedExecutionStepResult> {
    if !is_utc_timestamp(&input.occurred_at)
        || !is_lowercase_sha256(&input.plan_identity_fingerprint)
        || !is_lowercase_sha256(&input.adapter_manifest_hash)
        || input
            .observed_identity_hash
            .as_deref()
            .is_some_and(|value| !is_lowercase_sha256(value))
    {
        return Err(safe_error(
            PROGRESS_PAYLOAD_CONFLICT,
            "Shared execution result identity is invalid",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin shared execution result", error))?;
    let attempt = read_operation_attempt(&transaction, &input.operation_id)?
        .ok_or_else(|| safe_error(ATTEMPT_NOT_ACTIVE, "execution Attempt missing"))?;
    let claim = read_active_claim_for_operation(&transaction, &input.operation_id)?
        .ok_or_else(|| safe_error(CLAIM_HOLDER_MISMATCH, "execution Claim missing"))?;
    let plan = read_attempt_plan(&transaction, &input.operation_id)?
        .ok_or_else(|| safe_error(STRUCTURAL_PROGRESS_CORRUPTION, "execution Plan missing"))?;
    let current = read_step_progress(
        &transaction,
        &input.operation_id,
        &input.plan_id,
        &input.step_id,
    )?
    .ok_or_else(|| safe_error(STEP_IDENTITY_MISMATCH, "execution Step missing"))?;
    if attempt.operation_status != "active"
        || attempt.revision != input.expected_attempt_revision
        || claim.claim_id != input.claim_id
        || claim.claim_owner_token != input.claim_owner_token
        || claim.claim_revision != input.expected_claim_revision
        || plan.plan_id != input.plan_id
        || plan.plan_identity_fingerprint != input.plan_identity_fingerprint
        || plan.planner_version != input.adapter_manifest_hash
        || current.progress_revision != input.expected_progress_revision
        || current.boundary != DurableStepBoundary::Started
        || current.effect_outcome != DurableStepEffectOutcome::Unobserved
    {
        return Err(safe_error(
            PROGRESS_REVISION_CONFLICT,
            "Shared execution authority or Step progress changed",
        ));
    }
    let complete = input.invocation_exposure == ExecutionInvocationExposure::InvocationReturned
        && input.readback == ExecutionReadbackClassification::VerifiedComplete
        && input.effect.is_some()
        && input
            .observed_identity_hash
            .as_deref()
            .is_some_and(is_lowercase_sha256);
    let steps = read_attempt_step_progress(&transaction, &input.operation_id)?;
    let other_steps_converged = steps
        .iter()
        .filter(|step| step.step_id != input.step_id)
        .all(durable_step_is_fully_converged);
    let disposition = if complete && other_steps_converged {
        SharedExecutionStepDisposition::CompletedAndReleased
    } else if complete {
        SharedExecutionStepDisposition::ExecutionContinues
    } else {
        SharedExecutionStepDisposition::RecoveryRequiredAndRetained
    };

    // The disposition is decided above. Terminal Claim/Attempt/Outbox writes
    // intentionally precede the Step UPDATE in this transaction.
    match disposition {
        SharedExecutionStepDisposition::CompletedAndReleased => {
            let changed = transaction
                .execute(
                    "UPDATE manuscript_provisioning_operation_attempts
                     SET phase='completed',operation_status='terminal-completed',
                         result_classification='completed',next_action='none',
                         final_verification_outcome='passed',
                         verifier_version='se1-shared-executor@1',
                         revision=revision+1,updated_at=?1,terminal_at=?1
                     WHERE operation_id=?2 AND revision=?3
                       AND operation_status='active'",
                    params![
                        input.occurred_at,
                        input.operation_id,
                        input.expected_attempt_revision
                    ],
                )
                .map_err(|error| database_error("terminalize shared execution", error))?;
            if changed != 1 {
                return Err(safe_error(
                    PROVISIONING_OPERATION_CAS_CONFLICT,
                    "shared completion Attempt CAS changed",
                ));
            }
            release_active_claim_cas(&transaction, &claim)?;
            insert_pending_audit_outbox(&transaction, &input.operation_id, &input.occurred_at)?;
        }
        SharedExecutionStepDisposition::RecoveryRequiredAndRetained => {
            let changed = transaction
                .execute(
                    "UPDATE manuscript_provisioning_operation_attempts
                     SET phase='failed',operation_status='terminal-recovery-required',
                         result_classification='provisioning-recovery-required',
                         next_action='recover',partial_kind='physical-only',
                         original_cause_code='SHARED_EXECUTION_NON_COMPLETED',
                         final_verification_outcome='not-verified',
                         verifier_version='se1-shared-executor@1',
                         revision=revision+1,updated_at=?1,terminal_at=?1
                     WHERE operation_id=?2 AND revision=?3
                       AND operation_status='active'",
                    params![
                        input.occurred_at,
                        input.operation_id,
                        input.expected_attempt_revision
                    ],
                )
                .map_err(|error| database_error("retain shared execution", error))?;
            if changed != 1 {
                return Err(safe_error(
                    PROVISIONING_OPERATION_CAS_CONFLICT,
                    "shared non-completed Attempt CAS changed",
                ));
            }
            insert_pending_audit_outbox(&transaction, &input.operation_id, &input.occurred_at)?;
        }
        SharedExecutionStepDisposition::ExecutionContinues => {}
    }

    let (boundary, effect, readback, identity, resource_id, effect_at, verified_at, converged_at) =
        if complete {
            let effect = match input.effect.expect("complete effect") {
                ExecutionEffectClassification::Created => DurableStepEffectOutcome::Created,
                ExecutionEffectClassification::Reused => DurableStepEffectOutcome::Reused,
                ExecutionEffectClassification::Updated => DurableStepEffectOutcome::Updated,
                ExecutionEffectClassification::Preserved => DurableStepEffectOutcome::Preserved,
            };
            (
                DurableStepBoundary::Converged,
                effect,
                DurableStepReadbackOutcome::Verified,
                input.observed_identity_hash.clone(),
                input.resource_record_id.clone(),
                Some(input.occurred_at.clone()),
                Some(input.occurred_at.clone()),
                Some(input.occurred_at.clone()),
            )
        } else {
            let readback = match input.readback {
                ExecutionReadbackClassification::VerifiedAbsent
                    if input.invocation_exposure == ExecutionInvocationExposure::NotInvoked =>
                {
                    DurableStepReadbackOutcome::VerifiedAbsent
                }
                ExecutionReadbackClassification::Conflict => DurableStepReadbackOutcome::Conflict,
                ExecutionReadbackClassification::IdentityMismatch => {
                    DurableStepReadbackOutcome::IdentityMismatch
                }
                ExecutionReadbackClassification::ContainmentFailed => {
                    DurableStepReadbackOutcome::ContainmentFailed
                }
                ExecutionReadbackClassification::VerifiedPartial
                | ExecutionReadbackClassification::Unavailable
                | ExecutionReadbackClassification::VerifiedComplete
                | ExecutionReadbackClassification::VerifiedAbsent => {
                    DurableStepReadbackOutcome::Unavailable
                }
            };
            (
                DurableStepBoundary::Started,
                if readback == DurableStepReadbackOutcome::VerifiedAbsent {
                    DurableStepEffectOutcome::NoEffectProven
                } else {
                    DurableStepEffectOutcome::Unobserved
                },
                readback,
                None,
                None,
                None,
                None,
                None,
            )
        };
    let changed = transaction
        .execute(
            "UPDATE manuscript_provisioning_step_progress
             SET boundary=?1,effect_outcome=?2,readback_outcome=?3,
                 observed_identity_hash=?4,resource_record_id=?5,
                 effect_observed_at=?6,readback_verified_at=?7,converged_at=?8,
                 progress_revision=progress_revision+1,updated_at=?9
             WHERE operation_id=?10 AND plan_id=?11 AND step_id=?12
               AND progress_revision=?13 AND boundary='started'
               AND effect_outcome='unobserved'",
            params![
                boundary.as_str(),
                effect.as_str(),
                readback.as_str(),
                identity,
                resource_id,
                effect_at,
                verified_at,
                converged_at,
                input.occurred_at,
                input.operation_id,
                input.plan_id,
                input.step_id,
                input.expected_progress_revision,
            ],
        )
        .map_err(|error| database_error("write shared execution Step result", error))?;
    if changed != 1 {
        return Err(safe_error(
            PROGRESS_REVISION_CONFLICT,
            "shared execution Step result CAS changed",
        ));
    }
    let step = read_step_progress(
        &transaction,
        &input.operation_id,
        &input.plan_id,
        &input.step_id,
    )?
    .ok_or_else(|| safe_error(STRUCTURAL_PROGRESS_CORRUPTION, "result Step vanished"))?;
    let terminal_attempt = read_operation_attempt(&transaction, &input.operation_id)?
        .ok_or_else(|| safe_error(ATTEMPT_NOT_ACTIVE, "result Attempt vanished"))?;
    let remaining_claim = read_active_claim_for_operation(&transaction, &input.operation_id)?;
    transaction
        .commit()
        .map_err(|error| database_error("commit shared execution result", error))?;
    #[cfg(test)]
    if input.simulate_response_lost_after_commit {
        return Err(safe_error(
            PROVISIONING_OPERATION_DATABASE_ERROR,
            "synthetic shared execution result response loss",
        ));
    }
    Ok(SharedExecutionStepResult {
        disposition,
        step,
        attempt: terminal_attempt,
        claim: remaining_claim,
    })
}

pub(crate) fn validate_terminal_progress(
    connection: &Connection,
    operation_id: &str,
    terminal_status: &str,
) -> RepositoryResult<RequiredStepSummary> {
    let summary = read_required_step_summary(connection, operation_id)?;
    if !summary.structurally_complete {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Plan and required Step structure is inconsistent",
        ));
    }
    if terminal_status == "terminal-completed" && summary.converged_count != summary.actual_count {
        return Err(safe_error(
            TERMINAL_PROGRESS_INCOMPLETE,
            "completed terminal requires every required Step converged",
        ));
    }
    Ok(summary)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryStepEvidence {
    pub attempt: ProvisioningOperationAttempt,
    pub plan: DurableStepPlanRow,
    pub steps: Vec<DurableStepProgressRow>,
    pub chain: Vec<String>,
}

fn validate_recovery_progress_structure(
    connection: &Connection,
    attempt: &ProvisioningOperationAttempt,
) -> RepositoryResult<(DurableStepPlanRow, Vec<DurableStepProgressRow>)> {
    let plan = read_attempt_plan(connection, &attempt.operation_id)?.ok_or_else(|| {
        safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Recovery Attempt Plan is missing",
        )
    })?;
    let steps = read_attempt_step_progress(connection, &attempt.operation_id)?;
    let mut step_ids = BTreeSet::new();
    let plan_identity_matches = plan.operation_id == attempt.operation_id
        && plan.owner_type.as_str() == attempt.owner_type
        && plan.owner_id == attempt.owner_id
        && plan.scope_kind.as_str() == attempt.scope_kind
        && plan.manuscript_channel.map(|value| value.as_str())
            == attempt.manuscript_channel.as_deref()
        && plan.intent.as_str() == attempt.intent
        && plan.plan_version == 1
        && plan.fingerprint_profile == PlanFingerprintProfile::RestrictedJcsSha256V1
        && plan.step_count == steps.len() as i64
        && (0..=32).contains(&plan.step_count)
        && (plan.step_count != 0 || plan.intent == DurablePlanIntent::Recover);
    let steps_match = steps.iter().enumerate().all(|(index, step)| {
        step.operation_id == attempt.operation_id
            && step.plan_id == plan.plan_id
            && step.step_ordinal == index as i64
            && step.step_version == 1
            && step.is_required
            && step.effect_facts_schema_version == 1
            && step_ids.insert(step.step_id.as_str())
    });
    if !plan_identity_matches || !steps_match {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Recovery Plan/Step structure or composite identity is invalid",
        ));
    }
    if attempt.operation_status == "terminal-completed"
        && !steps.iter().all(durable_step_is_fully_converged)
    {
        return Err(safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "terminal-completed Recovery Attempt has unconverged required Step evidence",
        ));
    }
    Ok((plan, steps))
}

fn recovery_relation_matches(
    predecessor: &ProvisioningOperationAttempt,
    successor: &ProvisioningOperationAttempt,
) -> bool {
    predecessor.operation_status != "active"
        && predecessor.terminal_at.is_some()
        && matches!(
            (
                successor.intent.as_str(),
                predecessor.next_action.as_deref()
            ),
            ("retry", Some("retry")) | ("repair", Some("repair")) | ("recover", Some("recover"))
        )
}

fn recovery_current_has_persisted_successor(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<bool> {
    connection
        .query_row(
            "SELECT 1
             FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?1
             LIMIT 1",
            [operation_id],
            |_| Ok(()),
        )
        .optional()
        .map(|successor| successor.is_some())
        .map_err(|error| database_error("check Recovery current leaf eligibility", error))
}

fn recovery_predecessor_has_active_claim(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<bool> {
    connection
        .query_row(
            "SELECT 1
             FROM manuscript_provisioning_active_claims
             WHERE operation_id=?1
             LIMIT 1",
            [operation_id],
            |_| Ok(()),
        )
        .optional()
        .map(|claim| claim.is_some())
        .map_err(|error| database_error("check Recovery predecessor active Claim", error))
}

pub(crate) fn list_recovery_step_progress(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<RecoveryStepEvidence> {
    let attempt = read_operation_attempt(connection, operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Attempt missing"))?;
    if recovery_current_has_persisted_successor(connection, operation_id)? {
        return Err(safe_error(
            RECOVERY_EVIDENCE_INVALID,
            "Recovery evidence current Attempt is not a chain leaf",
        ));
    }
    let (plan, steps) = validate_recovery_progress_structure(connection, &attempt)?;
    let identity = (
        attempt.owner_type.clone(),
        attempt.owner_id.clone(),
        attempt.scope_kind.clone(),
        attempt.manuscript_channel.clone(),
        attempt.aggregate_operation_id.clone(),
    );
    let expected_root = attempt.root_operation_id.clone();
    let mut chain = Vec::new();
    let mut current = Some(attempt.clone());
    let mut seen = BTreeSet::new();
    while let Some(value) = current {
        if chain.len() == MAX_RECOVERY_CHAIN_DEPTH {
            return Err(safe_error(
                RECOVERY_EVIDENCE_INVALID,
                "Recovery Attempt chain exceeds the bounded depth",
            ));
        }
        if !seen.insert(value.operation_id.clone()) {
            return Err(safe_error(
                RECOVERY_EVIDENCE_INVALID,
                "Recovery Attempt chain contains a cycle",
            ));
        }
        if (
            value.owner_type.clone(),
            value.owner_id.clone(),
            value.scope_kind.clone(),
            value.manuscript_channel.clone(),
            value.aggregate_operation_id.clone(),
        ) != identity
        {
            return Err(safe_error(
                RECOVERY_EVIDENCE_INVALID,
                "Recovery Attempt chain crosses owner, scope or channel",
            ));
        }
        validate_recovery_progress_structure(connection, &value)?;
        chain.push(value.operation_id.clone());
        current = match value.previous_operation_id.as_deref() {
            Some(previous_id) => {
                if value.root_operation_id != expected_root || expected_root.is_none() {
                    return Err(safe_error(
                        RECOVERY_EVIDENCE_INVALID,
                        "Recovery Attempt root identity is inconsistent",
                    ));
                }
                let previous =
                    read_operation_attempt(connection, previous_id)?.ok_or_else(|| {
                        safe_error(
                            RECOVERY_EVIDENCE_INVALID,
                            "Recovery Attempt predecessor is missing",
                        )
                    })?;
                if !recovery_relation_matches(&previous, &value) {
                    return Err(safe_error(
                        RECOVERY_EVIDENCE_INVALID,
                        "Recovery Attempt predecessor terminal relationship is invalid",
                    ));
                }
                if recovery_predecessor_has_active_claim(connection, &previous.operation_id)? {
                    return Err(safe_error(
                        RECOVERY_EVIDENCE_INVALID,
                        "Recovery Attempt terminal predecessor retains an active Claim",
                    ));
                }
                Some(previous)
            }
            None => {
                if let Some(root) = expected_root.as_deref() {
                    if value.operation_id != root || value.root_operation_id.is_some() {
                        return Err(safe_error(
                            RECOVERY_EVIDENCE_INVALID,
                            "Recovery Attempt chain does not terminate at its declared root",
                        ));
                    }
                } else if chain.len() != 1 || value.root_operation_id.is_some() {
                    return Err(safe_error(
                        RECOVERY_EVIDENCE_INVALID,
                        "unrooted Recovery Attempt chain is invalid",
                    ));
                }
                None
            }
        };
    }
    validate_literature_projection_structure(connection, &attempt)?;
    chain.reverse();
    Ok(RecoveryStepEvidence {
        attempt,
        plan,
        steps,
        chain,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupProgressProjection {
    pub operation_id: String,
    pub boundary: Option<DurableStepBoundary>,
    pub structural_error: Option<&'static str>,
    pub required_count: usize,
    pub converged_count: usize,
}

pub(crate) fn read_startup_progress_projection(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<StartupProgressProjection> {
    let plan = read_attempt_plan(connection, operation_id)?;
    let steps = read_attempt_step_progress(connection, operation_id)?;
    let Some(plan) = plan else {
        return Ok(StartupProgressProjection {
            operation_id: operation_id.to_string(),
            boundary: None,
            structural_error: Some("active-attempt-plan-missing"),
            required_count: 0,
            converged_count: 0,
        });
    };
    let structurally_valid = plan.step_count == steps.len() as i64
        && steps
            .iter()
            .enumerate()
            .all(|(index, step)| step.is_required && step.step_ordinal == index as i64);
    let boundary = steps
        .iter()
        .filter(|step| step.boundary != DurableStepBoundary::Converged)
        .map(|step| step.boundary)
        .max_by_key(|boundary| match boundary {
            DurableStepBoundary::Intended => 0,
            DurableStepBoundary::Started => 1,
            DurableStepBoundary::EffectObserved => 2,
            DurableStepBoundary::ReadbackVerified => 3,
            DurableStepBoundary::Converged => 4,
        })
        .or(Some(DurableStepBoundary::Converged));
    Ok(StartupProgressProjection {
        operation_id: operation_id.to_string(),
        boundary,
        structural_error: (!structurally_valid).then_some("plan-step-structure-invalid"),
        required_count: steps.len(),
        converged_count: steps
            .iter()
            .filter(|step| step.boundary == DurableStepBoundary::Converged)
            .count(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableProgressCleanupDecision {
    pub operation_id: String,
    pub eligible: bool,
    pub reasons: Vec<&'static str>,
    pub planned_steps: usize,
    pub planned_plans: usize,
    pub planned_projections: usize,
    pub planned_outboxes: usize,
    pub planned_attempts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProgressCleanupExecutionPlan {
    operation_id: String,
    plan_id: String,
    owner_type: String,
    owner_id: String,
    scope_kind: String,
    manuscript_channel: Option<String>,
    expected_step_rows: usize,
    expected_plan_rows: usize,
    expected_projection_rows: usize,
    expected_outbox_rows: usize,
    expected_attempt_rows: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProgressCleanupInspection {
    decision: DurableProgressCleanupDecision,
    execution_plan: Option<ProgressCleanupExecutionPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressCleanupRowKind {
    Step,
    Plan,
    Projection,
    Outbox,
    Attempt,
}

pub(crate) fn verify_progress_cleanup_deleted_rows(
    row_kind: ProgressCleanupRowKind,
    expected: usize,
    actual: usize,
) -> RepositoryResult<()> {
    if actual == expected {
        return Ok(());
    }
    let message = match row_kind {
        ProgressCleanupRowKind::Step => "cleanup Step delete count differs from the execution plan",
        ProgressCleanupRowKind::Plan => "cleanup Plan delete count differs from the execution plan",
        ProgressCleanupRowKind::Projection => {
            "cleanup Projection delete count differs from the execution plan"
        }
        ProgressCleanupRowKind::Outbox => {
            "cleanup Outbox delete count differs from the execution plan"
        }
        ProgressCleanupRowKind::Attempt => {
            "cleanup Attempt delete count differs from the execution plan"
        }
    };
    Err(safe_error(STRUCTURAL_PROGRESS_CORRUPTION, message))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgressCleanupFinalReadback {
    pub step_rows: usize,
    pub plan_rows: usize,
    pub projection_rows: usize,
    pub outbox_rows: usize,
    pub attempt_rows: usize,
    pub active_claim_rows: usize,
    pub blocking_reference_rows: usize,
}

pub(crate) fn verify_progress_cleanup_final_readback(
    readback: &ProgressCleanupFinalReadback,
) -> RepositoryResult<()> {
    if readback.step_rows == 0
        && readback.plan_rows == 0
        && readback.projection_rows == 0
        && readback.outbox_rows == 0
        && readback.attempt_rows == 0
        && readback.active_claim_rows == 0
        && readback.blocking_reference_rows == 0
    {
        return Ok(());
    }
    Err(safe_error(
        STRUCTURAL_PROGRESS_CORRUPTION,
        "final cleanup readback found residual authority or a blocking reference",
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CleanupProgressReferences {
    pub operation_id: String,
    pub plan_count: usize,
    pub step_count: usize,
    pub unconverged_step_count: usize,
    pub attempt_reference_count: usize,
    pub literature_projection_reference_count: usize,
    pub active_claim_count: usize,
    pub pending_or_failed_outbox_count: usize,
}

pub(crate) fn read_cleanup_progress_references(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<CleanupProgressReferences> {
    let plan_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_step_plans
             WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Plan references", error))?;
    let (step_count, unconverged_step_count): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN boundary<>'converged' THEN 1 ELSE 0 END)
             FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )
        .map_err(|error| database_error("read cleanup Step references", error))?;
    let attempt_reference_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?1 OR root_operation_id=?1
                OR aggregate_operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Attempt references", error))?;
    let literature_projection_reference_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
             WHERE current_operation_id=?1 AND aggregate_operation_id<>?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Literature references", error))?;
    let active_claim_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
             WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Claim references", error))?;
    let pending_or_failed_outbox_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_audit_outbox
             WHERE operation_id=?1 AND delivery_status<>'delivered'",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Outbox references", error))?;
    Ok(CleanupProgressReferences {
        operation_id: operation_id.to_string(),
        plan_count: plan_count as usize,
        step_count: step_count as usize,
        unconverged_step_count: unconverged_step_count as usize,
        attempt_reference_count: attempt_reference_count as usize,
        literature_projection_reference_count: literature_projection_reference_count as usize,
        active_claim_count: active_claim_count as usize,
        pending_or_failed_outbox_count: pending_or_failed_outbox_count as usize,
    })
}

fn projection_matches_child_attempt(
    projection: &LiteratureChildProgressProjection,
    attempt: &ProvisioningOperationAttempt,
) -> bool {
    let expected_summary = if attempt.operation_status == "active" {
        "assigned"
    } else if attempt.operation_status == "terminal-completed" {
        "terminal-completed"
    } else {
        "terminal-unresolved"
    };
    let expected_readiness = if attempt.operation_status == "terminal-completed"
        && attempt.final_verification_outcome == "passed"
    {
        "ready"
    } else if attempt.final_verification_outcome == "not-run" {
        "not-verified"
    } else {
        "not-ready"
    };
    projection.owner_type == DurablePlanOwnerType::Literature
        && projection.owner_id == attempt.owner_id
        && projection.current_operation_id == attempt.operation_id
        && projection.current_operation_scope_kind.as_str() == "literature-child"
        && projection.manuscript_channel.as_str()
            == attempt.manuscript_channel.as_deref().unwrap_or("")
        && projection.child_summary_status.as_str() == expected_summary
        && projection.result_classification.map(|value| value.as_str())
            == attempt.result_classification.as_deref()
        && projection.next_action.map(|value| value.as_str()) == attempt.next_action.as_deref()
        && projection.default_readiness.as_str() == expected_readiness
        && projection.final_verification_outcome.as_str() == attempt.final_verification_outcome
        && projection.original_cause_code == attempt.original_cause_code
        && projection.revision >= 1
}

fn validate_literature_projection_structure(
    connection: &Connection,
    attempt: &ProvisioningOperationAttempt,
) -> RepositoryResult<()> {
    let corruption = || {
        safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "Literature projection scope or derived summary is inconsistent",
        )
    };
    if attempt.owner_type != "literature" {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
                 WHERE aggregate_operation_id=?1 OR current_operation_id=?1",
                [&attempt.operation_id],
                |row| row.get(0),
            )
            .map_err(|error| database_error("read unexpected Literature projection", error))?;
        return if count == 0 {
            Ok(())
        } else {
            Err(corruption())
        };
    }
    match attempt.scope_kind.as_str() {
        "literature-aggregate" => {
            let aggregate_operation_id = attempt
                .root_operation_id
                .as_deref()
                .unwrap_or(&attempt.operation_id);
            let projections =
                read_literature_child_projections(connection, aggregate_operation_id)?;
            let channels = projections
                .iter()
                .map(|projection| projection.manuscript_channel.as_str())
                .collect::<BTreeSet<_>>();
            if projections.len() != 2
                || channels != BTreeSet::from(["dedicated_notes", "literature_outline"])
            {
                return Err(corruption());
            }
            for projection in projections {
                if projection.owner_type != DurablePlanOwnerType::Literature
                    || projection.owner_id != attempt.owner_id
                    || projection.aggregate_operation_id != aggregate_operation_id
                {
                    return Err(corruption());
                }
                match projection.current_operation_scope_kind.as_str() {
                    "literature-aggregate"
                        if projection.current_operation_id == attempt.operation_id
                            && projection.child_summary_status.as_str() == "assigned"
                            && projection.result_classification.is_none()
                            && projection.next_action.is_none()
                            && projection.default_readiness.as_str() == "not-verified"
                            && projection.final_verification_outcome.as_str() == "not-run"
                            && projection.original_cause_code.is_none() => {}
                    "literature-child" => {
                        let child =
                            read_operation_attempt(connection, &projection.current_operation_id)?
                                .ok_or_else(|| corruption())?;
                        if child.aggregate_operation_id.as_deref() != Some(aggregate_operation_id)
                            || !projection_matches_child_attempt(&projection, &child)
                        {
                            return Err(corruption());
                        }
                    }
                    _ => return Err(corruption()),
                }
            }
            Ok(())
        }
        "literature-child" => {
            let aggregate_id = attempt
                .aggregate_operation_id
                .as_deref()
                .ok_or_else(|| corruption())?;
            let projections = read_literature_child_projections(connection, aggregate_id)?;
            let matching = projections
                .iter()
                .filter(|projection| projection.current_operation_id == attempt.operation_id)
                .collect::<Vec<_>>();
            if matching.len() != 1
                || matching[0].aggregate_operation_id != aggregate_id
                || !projection_matches_child_attempt(matching[0], attempt)
            {
                return Err(corruption());
            }
            Ok(())
        }
        _ => Err(corruption()),
    }
}

fn inspect_progress_cleanup(
    connection: &Connection,
    operation_id: &str,
    terminal_before: &str,
) -> RepositoryResult<ProgressCleanupInspection> {
    let attempt = read_operation_attempt(connection, operation_id)?
        .ok_or_else(|| repository_error(PROVISIONING_OPERATION_NOT_FOUND, "Attempt missing"))?;
    validate_literature_projection_structure(connection, &attempt)?;
    let mut reasons = Vec::new();
    if attempt.operation_status != "terminal-completed" {
        reasons.push("unresolved-durable-condition");
    }
    if attempt
        .terminal_at
        .as_deref()
        .is_none_or(|value| value >= terminal_before)
    {
        reasons.push("retention-not-satisfied");
    }
    if read_active_claim_for_operation(connection, operation_id)?.is_some() {
        reasons.push("active-claim");
    }
    let (outbox_count, delivered_outbox_count): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN delivery_status='delivered' THEN 1 ELSE 0 END)
             FROM manuscript_provisioning_audit_outbox
             WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )
        .map_err(|error| database_error("read cleanup Audit Outbox", error))?;
    let expected_outbox_rows = 1;
    if outbox_count as usize != expected_outbox_rows
        || delivered_outbox_count as usize != expected_outbox_rows
    {
        reasons.push("audit-not-delivered");
    }
    let refs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?1 OR root_operation_id=?1
                OR aggregate_operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Attempt references", error))?;
    if refs != 0 {
        reasons.push("attempt-or-recovery-reference");
    }
    let mut validated_plan = None;
    let mut expected_step_rows = 0;
    match read_required_step_summary(connection, operation_id) {
        Ok(summary)
            if summary.structurally_complete && summary.actual_count == summary.converged_count =>
        {
            expected_step_rows = summary.actual_count;
            validated_plan = read_attempt_plan(connection, operation_id)?;
        }
        Ok(_) => reasons.push("progress-not-converged"),
        Err(error) if error.code == STRUCTURAL_PROGRESS_CORRUPTION => {
            reasons.push("structural-progress-corruption")
        }
        Err(error) => return Err(error),
    }
    let projection_refs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
             WHERE current_operation_id=?1 AND aggregate_operation_id<>?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup Literature references", error))?;
    if projection_refs != 0 {
        reasons.push("literature-projection-reference");
    }
    let expected_projection_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("read cleanup target Literature projections", error))?;
    reasons.sort_unstable();
    reasons.dedup();
    let decision = DurableProgressCleanupDecision {
        operation_id: operation_id.to_string(),
        eligible: reasons.is_empty(),
        reasons,
        planned_steps: expected_step_rows,
        planned_plans: usize::from(validated_plan.is_some()),
        planned_projections: expected_projection_rows as usize,
        planned_outboxes: expected_outbox_rows,
        planned_attempts: 1,
    };
    let execution_plan = if decision.eligible {
        let plan = validated_plan.ok_or_else(|| {
            safe_error(
                STRUCTURAL_PROGRESS_CORRUPTION,
                "eligible cleanup inspection has no validated Plan",
            )
        })?;
        Some(ProgressCleanupExecutionPlan {
            operation_id: attempt.operation_id,
            plan_id: plan.plan_id,
            owner_type: attempt.owner_type,
            owner_id: attempt.owner_id,
            scope_kind: attempt.scope_kind,
            manuscript_channel: attempt.manuscript_channel,
            expected_step_rows: decision.planned_steps,
            expected_plan_rows: decision.planned_plans,
            expected_projection_rows: decision.planned_projections,
            expected_outbox_rows: decision.planned_outboxes,
            expected_attempt_rows: decision.planned_attempts,
        })
    } else {
        None
    };
    Ok(ProgressCleanupInspection {
        decision,
        execution_plan,
    })
}

pub(crate) fn dry_run_progress_cleanup(
    connection: &Connection,
    operation_id: &str,
    terminal_before: &str,
) -> RepositoryResult<DurableProgressCleanupDecision> {
    Ok(inspect_progress_cleanup(connection, operation_id, terminal_before)?.decision)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableProgressCleanupResult {
    pub operation_id: String,
    pub deleted_steps: usize,
    pub deleted_plans: usize,
    pub deleted_projections: usize,
    pub deleted_outboxes: usize,
    pub deleted_attempts: usize,
}

pub(crate) fn execute_progress_cleanup(
    connection: &mut Connection,
    operation_id: &str,
    terminal_before: &str,
) -> RepositoryResult<DurableProgressCleanupResult> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin Progress cleanup", error))?;
    let inspection = inspect_progress_cleanup(&transaction, operation_id, terminal_before)?;
    if !inspection.decision.eligible {
        return Err(safe_error(
            CLEANUP_PROGRESS_RETAINED,
            "durable Progress cleanup remains blocked",
        ));
    }
    let execution_plan = inspection.execution_plan.ok_or_else(|| {
        safe_error(
            STRUCTURAL_PROGRESS_CORRUPTION,
            "eligible cleanup inspection did not produce an execution plan",
        )
    })?;
    let deleted_steps = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_step_progress WHERE operation_id=?1",
            [operation_id],
        )
        .map_err(|error| database_error("delete Step leaves", error))?;
    if deleted_steps != execution_plan.expected_step_rows {
        verify_progress_cleanup_deleted_rows(
            ProgressCleanupRowKind::Step,
            execution_plan.expected_step_rows,
            deleted_steps,
        )?;
    }
    let deleted_plans = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_step_plans WHERE operation_id=?1",
            [operation_id],
        )
        .map_err(|error| database_error("delete Plan Header", error))?;
    if deleted_plans != execution_plan.expected_plan_rows {
        verify_progress_cleanup_deleted_rows(
            ProgressCleanupRowKind::Plan,
            execution_plan.expected_plan_rows,
            deleted_plans,
        )?;
    }
    let deleted_projections = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1",
            [operation_id],
        )
        .map_err(|error| database_error("delete Literature projections", error))?;
    if deleted_projections != execution_plan.expected_projection_rows {
        verify_progress_cleanup_deleted_rows(
            ProgressCleanupRowKind::Projection,
            execution_plan.expected_projection_rows,
            deleted_projections,
        )?;
    }
    let deleted_outboxes = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_audit_outbox
             WHERE operation_id=?1 AND delivery_status='delivered'",
            [operation_id],
        )
        .map_err(|error| database_error("delete delivered Audit Outbox", error))?;
    if deleted_outboxes != execution_plan.expected_outbox_rows {
        verify_progress_cleanup_deleted_rows(
            ProgressCleanupRowKind::Outbox,
            execution_plan.expected_outbox_rows,
            deleted_outboxes,
        )?;
    }
    let deleted_attempts = transaction
        .execute(
            "DELETE FROM manuscript_provisioning_operation_attempts
             WHERE operation_id=?1 AND operation_status='terminal-completed'",
            [operation_id],
        )
        .map_err(|error| database_error("delete terminal Attempt last", error))?;
    if deleted_attempts != execution_plan.expected_attempt_rows {
        verify_progress_cleanup_deleted_rows(
            ProgressCleanupRowKind::Attempt,
            execution_plan.expected_attempt_rows,
            deleted_attempts,
        )?;
    }
    let final_readback = transaction
        .query_row(
            "SELECT
               (SELECT COUNT(*)
                FROM manuscript_provisioning_operation_attempts
                WHERE operation_id=?1),
               (SELECT COUNT(*)
                FROM manuscript_provisioning_step_progress
                WHERE operation_id=?1),
               (SELECT COUNT(*)
                FROM manuscript_provisioning_step_plans
                WHERE operation_id=?1 AND plan_id=?2),
               (SELECT COUNT(*)
                FROM manuscript_provisioning_literature_child_states
                WHERE aggregate_operation_id=?1),
               (SELECT COUNT(*)
                FROM manuscript_provisioning_audit_outbox
                WHERE operation_id=?1),
               (SELECT COUNT(*)
                FROM manuscript_provisioning_active_claims
                WHERE operation_id=?1),
               (SELECT COUNT(*)
                FROM manuscript_provisioning_operation_attempts
                WHERE previous_operation_id=?1 OR root_operation_id=?1
                   OR aggregate_operation_id=?1)
               +
               (SELECT COUNT(*)
                FROM manuscript_provisioning_literature_child_states
                WHERE current_operation_id=?1 AND aggregate_operation_id<>?1)",
            params![execution_plan.operation_id, execution_plan.plan_id],
            |row| {
                Ok(ProgressCleanupFinalReadback {
                    attempt_rows: row.get::<_, i64>(0)? as usize,
                    step_rows: row.get::<_, i64>(1)? as usize,
                    plan_rows: row.get::<_, i64>(2)? as usize,
                    projection_rows: row.get::<_, i64>(3)? as usize,
                    outbox_rows: row.get::<_, i64>(4)? as usize,
                    active_claim_rows: row.get::<_, i64>(5)? as usize,
                    blocking_reference_rows: row.get::<_, i64>(6)? as usize,
                })
            },
        )
        .map_err(|error| database_error("final cleanup readback", error))?;
    verify_progress_cleanup_final_readback(&final_readback)?;
    transaction
        .commit()
        .map_err(|error| database_error("commit Progress cleanup", error))?;
    Ok(DurableProgressCleanupResult {
        operation_id: operation_id.to_string(),
        deleted_steps,
        deleted_plans,
        deleted_projections,
        deleted_outboxes,
        deleted_attempts,
    })
}
