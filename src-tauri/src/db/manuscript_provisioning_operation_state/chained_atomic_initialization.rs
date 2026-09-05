#![allow(dead_code)]

use super::claim_ownership::ClaimOwnershipRepositoryContext;
use super::durable_precondition::{
    DurablePreconditionBuilder, DurablePreconditionRequest, DurablePreconditionToken,
    DurableRevalidationResult,
};
use super::step_progress::{
    is_lowercase_sha256, is_utc_timestamp, DurableStepPlanRow, DurableStepProgressRow,
    PlanFingerprintProfile,
};
use super::step_progress_repository::{read_attempt_plan, read_attempt_step_progress};
use super::{
    read_active_claim_for_operation, read_operation_attempt, ProvisioningOperationAttempt,
};
use crate::manuscript_provisioning_contract::{
    canonical_family_descriptor, CanonicalResourceIdentity, DescriptorKey, DurablePlanIntent,
    FamilyDescriptor, ProvisioningScopeIdentity, RequiredStep, StableErrorCode,
};
use rusqlite::{
    params, Connection, Error as SqliteError, ErrorCode, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const PLAN_VERSION: i64 = 1;
const STEP_VERSION: i64 = 1;
const PLANNER_VERSION: &str = "lp12-r1-r-v1";
const PLAN_FINGERPRINT_DOMAIN: &str = "labpod.provisioning-plan-identity";
const PLAN_ID_DOMAIN: &str = "labpod.provisioning-plan-id";
const STEP_ID_DOMAIN: &str = "labpod.provisioning-step-id";

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChainedInitializationFault {
    BeginImmediate,
    PredecessorRead,
    CurrentLeafRead,
    DurableBuilder,
    AttemptInsert,
    ClaimInsert,
    PlanInsert,
    PreconditionHashWrite,
    StepInsert(usize),
    InitialProgressInsert(usize),
    ProjectionSync,
    AuthoritativeReadback,
    CommitKnownNotCommitted,
    CommitOutcomeUnknown,
    PostCommitReadback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChainedInitializationIntent {
    ExplicitRetry,
    ExplicitRepair,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChainedAtomicInitializationRequest {
    pub operation_id: String,
    pub scope: ProvisioningScopeIdentity,
    pub intent: ChainedInitializationIntent,
    pub predecessor_operation_id: String,
    pub expected_predecessor_revision: i64,
    pub authorization_id: String,
    pub descriptor_key: DescriptorKey,
    pub canonical_resource: CanonicalResourceIdentity,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChainedInitializationAuthority {
    pub operation_id: String,
    pub predecessor_operation_id: String,
    pub root_operation_id: String,
    pub attempt_revision: i64,
    pub claim_id: Option<String>,
    pub plan_id: String,
    pub plan_identity_fingerprint: String,
    pub precondition_snapshot_hash: String,
    pub step_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChainedAtomicInitializationResult {
    Initialized(ChainedInitializationAuthority),
    AuthoritativeExisting(ChainedInitializationAuthority),
    TerminalExisting(ChainedInitializationAuthority),
    RecoveryRequiredExisting(ChainedInitializationAuthority),
    IdentityConflict,
    PredecessorNotFound,
    PredecessorRevisionMismatch,
    PredecessorNotCurrentLeaf,
    PredecessorActionMismatch,
    PredecessorRecoveryRequired,
    RetryNotAllowed,
    RepairNotAllowed,
    ActiveClaimConflict,
    DurableAuthorityStale,
    RepositoryBusy,
    RepositoryUnavailable,
    KnownNotCommitted,
    ProvisioningRecoveryRequired,
    InternalInvariantFailure,
}

pub(crate) fn initialize_chained_operation_with_ownership_context(
    database_path: &Path,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: &ChainedAtomicInitializationRequest,
) -> ChainedAtomicInitializationResult {
    initialize_inner(
        database_path,
        ownership_context,
        request,
        #[cfg(test)]
        None,
    )
}

pub(crate) fn initialize_chained_operation_in_connection(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: &ChainedAtomicInitializationRequest,
) -> ChainedAtomicInitializationResult {
    initialize_inner_with_connection(
        connection,
        ownership_context,
        request,
        None,
        #[cfg(test)]
        None,
    )
}

#[cfg(not(test))]
pub(crate) fn initialize_chained_operation_atomically(
    database_path: &Path,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: &ChainedAtomicInitializationRequest,
) -> ChainedAtomicInitializationResult {
    initialize_chained_operation_with_ownership_context(database_path, ownership_context, request)
}

#[cfg(test)]
pub(crate) fn initialize_chained_operation_atomically(
    database_path: &Path,
    request: &ChainedAtomicInitializationRequest,
) -> ChainedAtomicInitializationResult {
    let ownership_context = super::claim_ownership::fixed_repository_context_for_test(
        "00000000-0000-4000-8000-00000000p102",
        1_700_000_000_000,
    );
    initialize_chained_operation_with_ownership_context(database_path, &ownership_context, request)
}

#[cfg(test)]
pub(super) fn initialize_chained_operation_with_fault(
    database_path: &Path,
    request: &ChainedAtomicInitializationRequest,
    fault: ChainedInitializationFault,
) -> ChainedAtomicInitializationResult {
    let ownership_context = super::claim_ownership::fixed_repository_context_for_test(
        "00000000-0000-4000-8000-00000000p102",
        1_700_000_000_000,
    );
    initialize_inner(database_path, &ownership_context, request, Some(fault))
}

#[derive(Debug, Clone)]
struct CanonicalPlan {
    descriptor: FamilyDescriptor,
    plan_id: String,
    fingerprint: String,
    steps: Vec<CanonicalStep>,
}

#[derive(Debug, Clone)]
struct CanonicalStep {
    step_id: String,
    ordinal: i64,
    definition: RequiredStep,
}

fn durable_intent(intent: ChainedInitializationIntent) -> DurablePlanIntent {
    match intent {
        ChainedInitializationIntent::ExplicitRetry => DurablePlanIntent::Retry,
        ChainedInitializationIntent::ExplicitRepair => DurablePlanIntent::Repair,
    }
}

fn trigger(intent: ChainedInitializationIntent) -> &'static str {
    match intent {
        ChainedInitializationIntent::ExplicitRetry => "explicit-retry",
        ChainedInitializationIntent::ExplicitRepair => "explicit-repair",
    }
}

fn expected_action(intent: ChainedInitializationIntent) -> &'static str {
    match intent {
        ChainedInitializationIntent::ExplicitRetry => "retry",
        ChainedInitializationIntent::ExplicitRepair => "repair",
    }
}

fn sha256(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn bounded_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.'))
}

fn request_shape_is_valid(request: &ChainedAtomicInitializationRequest) -> bool {
    request.scope.validate().is_ok()
        && bounded_identifier(&request.operation_id)
        && bounded_identifier(&request.predecessor_operation_id)
        && request.operation_id != request.predecessor_operation_id
        && request.expected_predecessor_revision >= 0
        && bounded_identifier(&request.authorization_id)
        && is_utc_timestamp(&request.occurred_at)
        && is_lowercase_sha256(&request.canonical_resource.resource_identity_hash)
        && is_lowercase_sha256(&request.canonical_resource.placement_identity_hash)
        && request
            .canonical_resource
            .parent_shared_identity_hash
            .as_deref()
            .is_none_or(is_lowercase_sha256)
}

fn canonical_plan(
    request: &ChainedAtomicInitializationRequest,
) -> Result<CanonicalPlan, ChainedAtomicInitializationResult> {
    let descriptor = canonical_family_descriptor(&request.scope, &request.descriptor_key)
        .map_err(|_| ChainedAtomicInitializationResult::IdentityConflict)?;
    let intent = durable_intent(request.intent);
    if !descriptor.legal_intents.contains(&intent) {
        return Err(match request.intent {
            ChainedInitializationIntent::ExplicitRetry => {
                ChainedAtomicInitializationResult::RetryNotAllowed
            }
            ChainedInitializationIntent::ExplicitRepair => {
                ChainedAtomicInitializationResult::RepairNotAllowed
            }
        });
    }
    let steps_json = descriptor
        .canonical_steps
        .iter()
        .enumerate()
        .map(|(ordinal, step)| {
            json!({
                "kind": step.kind.as_str(),
                "ordinal": ordinal,
                "scope": step.scope.as_str(),
                "version": STEP_VERSION,
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "authorizationId": request.authorization_id,
        "canonicalPlacementIdentityHash": request.canonical_resource.placement_identity_hash,
        "canonicalResourceIdentityHash": request.canonical_resource.resource_identity_hash,
        "descriptorKey": request.descriptor_key.0,
        "domain": PLAN_FINGERPRINT_DOMAIN,
        "intent": intent.as_str(),
        "manuscriptChannel": request.scope.manuscript_channel.map(|value| value.as_str()),
        "operationId": request.operation_id,
        "ownerId": request.scope.owner_id,
        "ownerType": request.scope.owner_type.as_str(),
        "parentSharedIdentityHash": request.canonical_resource.parent_shared_identity_hash,
        "planTemplateKind": descriptor.plan_template.as_str(),
        "planVersion": PLAN_VERSION,
        "plannerVersion": PLANNER_VERSION,
        "predecessorExpectedRevision": request.expected_predecessor_revision,
        "predecessorOperationId": request.predecessor_operation_id,
        "scopeKind": request.scope.scope_kind.as_str(),
        "steps": steps_json,
    });
    let canonical = serde_json::to_string(&payload)
        .map_err(|_| ChainedAtomicInitializationResult::InternalInvariantFailure)?;
    let fingerprint = sha256(canonical);
    let plan_id = sha256(format!(
        "{PLAN_ID_DOMAIN}\n{}\n{}",
        request.operation_id, fingerprint
    ));
    let steps = descriptor
        .canonical_steps
        .iter()
        .cloned()
        .enumerate()
        .map(|(ordinal, definition)| CanonicalStep {
            step_id: sha256(format!(
                "{STEP_ID_DOMAIN}\n{plan_id}\n{ordinal}\n{}\n{}",
                definition.kind.as_str(),
                definition.scope.as_str()
            )),
            ordinal: ordinal as i64,
            definition,
        })
        .collect();
    Ok(CanonicalPlan {
        descriptor,
        plan_id,
        fingerprint,
        steps,
    })
}

fn open_read_write(path: &Path) -> Result<Connection, ChainedAtomicInitializationResult> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?;
    if crate::db::schema::validate_global_schema_current(&connection).is_err() {
        return Err(ChainedAtomicInitializationResult::RepositoryUnavailable);
    }
    match super::step_progress_schema::validate_provisioning_contract(&connection) {
        Ok(true) => Ok(connection),
        Ok(false) | Err(_) => Err(ChainedAtomicInitializationResult::RepositoryUnavailable),
    }
}

fn begin_immediate(
    connection: &mut Connection,
) -> Result<Transaction<'_>, ChainedAtomicInitializationResult> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(classify_begin_error)
}

fn classify_begin_error(error: SqliteError) -> ChainedAtomicInitializationResult {
    match error {
        SqliteError::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            ) =>
        {
            ChainedAtomicInitializationResult::RepositoryBusy
        }
        _ => ChainedAtomicInitializationResult::RepositoryUnavailable,
    }
}

fn initialize_inner(
    database_path: &Path,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: &ChainedAtomicInitializationRequest,
    #[cfg(test)] fault: Option<ChainedInitializationFault>,
) -> ChainedAtomicInitializationResult {
    if !request_shape_is_valid(request) {
        return ChainedAtomicInitializationResult::IdentityConflict;
    }
    let mut connection = match open_read_write(database_path) {
        Ok(connection) => connection,
        Err(result) => return result,
    };
    initialize_inner_with_connection(
        &mut connection,
        ownership_context,
        request,
        Some(database_path),
        #[cfg(test)]
        fault,
    )
}

fn initialize_inner_with_connection(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: &ChainedAtomicInitializationRequest,
    recovery_database_path: Option<&Path>,
    #[cfg(test)] fault: Option<ChainedInitializationFault>,
) -> ChainedAtomicInitializationResult {
    if !request_shape_is_valid(request) {
        return ChainedAtomicInitializationResult::IdentityConflict;
    }
    #[cfg(test)]
    let _commit_abort_scope = if fault == Some(ChainedInitializationFault::CommitKnownNotCommitted)
    {
        Some(
                crate::db::manuscript_provisioning_commit_failure_test_support::arm_native_commit_hook_abort(
                    &connection,
                )
                .0,
            )
    } else {
        None
    };
    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::BeginImmediate) {
        return ChainedAtomicInitializationResult::RepositoryUnavailable;
    }
    let transaction = match begin_immediate(connection) {
        Ok(transaction) => transaction,
        Err(result) => return result,
    };

    // Existing-first is deliberately before every predecessor/new-child gate.
    let existing = match read_operation_attempt(&transaction, &request.operation_id) {
        Ok(existing) => existing,
        Err(_) => return ChainedAtomicInitializationResult::RepositoryUnavailable,
    };
    let plan = match canonical_plan(request) {
        Ok(plan) => plan,
        Err(result) => return result,
    };
    if let Some(existing) = existing {
        return classify_existing(&transaction, request, &plan, existing);
    }

    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::PredecessorRead) {
        return ChainedAtomicInitializationResult::RepositoryUnavailable;
    }
    let predecessor = match read_operation_attempt(&transaction, &request.predecessor_operation_id)
    {
        Ok(Some(predecessor)) => predecessor,
        Ok(None) => return ChainedAtomicInitializationResult::PredecessorNotFound,
        Err(_) => return ChainedAtomicInitializationResult::RepositoryUnavailable,
    };
    if !predecessor_scope_matches(&predecessor, request) {
        return ChainedAtomicInitializationResult::IdentityConflict;
    }
    if predecessor.revision != request.expected_predecessor_revision {
        return ChainedAtomicInitializationResult::PredecessorRevisionMismatch;
    }
    if predecessor.operation_status == "terminal-recovery-required"
        || predecessor.next_action.as_deref() == Some("recover")
    {
        return ChainedAtomicInitializationResult::PredecessorRecoveryRequired;
    }
    if predecessor.next_action.as_deref() != Some(expected_action(request.intent)) {
        return ChainedAtomicInitializationResult::PredecessorActionMismatch;
    }
    if !terminal_tuple_allows(&predecessor, request.intent) {
        return match request.intent {
            ChainedInitializationIntent::ExplicitRetry => {
                ChainedAtomicInitializationResult::RetryNotAllowed
            }
            ChainedInitializationIntent::ExplicitRepair => {
                ChainedAtomicInitializationResult::RepairNotAllowed
            }
        };
    }
    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::CurrentLeafRead) {
        return ChainedAtomicInitializationResult::RepositoryUnavailable;
    }
    match predecessor_has_other_child(
        &transaction,
        &request.predecessor_operation_id,
        &request.operation_id,
    ) {
        Ok(true) => return ChainedAtomicInitializationResult::PredecessorNotCurrentLeaf,
        Ok(false) => {}
        Err(_) => return ChainedAtomicInitializationResult::RepositoryUnavailable,
    }
    match active_claim_conflicts(&transaction, request) {
        Ok(true) => return ChainedAtomicInitializationResult::ActiveClaimConflict,
        Ok(false) => {}
        Err(_) => return ChainedAtomicInitializationResult::RepositoryUnavailable,
    }

    let durable_request = DurablePreconditionRequest {
        operation_id: request.operation_id.clone(),
        scope: request.scope.clone(),
        intent: durable_intent(request.intent),
        predecessor_operation_id: Some(request.predecessor_operation_id.clone()),
    };
    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::DurableBuilder) {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    let facts_result = match request.intent {
        ChainedInitializationIntent::ExplicitRetry => {
            DurablePreconditionBuilder::read_retry_facts_in_transaction(
                &transaction,
                &durable_request,
            )
            .map(|_| ())
        }
        ChainedInitializationIntent::ExplicitRepair => {
            DurablePreconditionBuilder::read_repair_facts_in_transaction(
                &transaction,
                &durable_request,
            )
            .map(|_| ())
        }
    };
    if let Err(error) = facts_result {
        return map_builder_error(error, request.intent);
    }
    let token =
        match DurablePreconditionBuilder::build_in_transaction(&transaction, &durable_request) {
            Ok(token) => token,
            Err(error) => return map_builder_error(error, request.intent),
        };
    let expected_precondition_hash = match token.canonical_hash_for_plan_insert(
        &request.operation_id,
        &request.scope,
        durable_intent(request.intent),
    ) {
        Ok(hash) => hash.to_string(),
        Err(_) => return ChainedAtomicInitializationResult::InternalInvariantFailure,
    };
    let root_operation_id = predecessor
        .root_operation_id
        .clone()
        .unwrap_or_else(|| predecessor.operation_id.clone());
    let claim_id = format!("claim-{}", Uuid::new_v4());
    let sealed_heartbeat = match ownership_context.sample_sealed_heartbeat() {
        Ok(sample) => sample,
        Err(_) => return ChainedAtomicInitializationResult::RepositoryUnavailable,
    };

    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::AttemptInsert) {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    if insert_attempt(
        &transaction,
        request,
        &root_operation_id,
        &request.predecessor_operation_id,
    )
    .is_err()
    {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::ClaimInsert) {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    if insert_claim(
        &transaction,
        request,
        &claim_id,
        ownership_context.claim_owner_token(),
        &sealed_heartbeat.persisted_value(),
    )
    .is_err()
    {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    #[cfg(test)]
    if matches!(
        fault,
        Some(
            ChainedInitializationFault::PlanInsert
                | ChainedInitializationFault::PreconditionHashWrite
        )
    ) {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    if insert_plan(&transaction, request, &plan, &token).is_err() {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    for (_index, step) in plan.steps.iter().enumerate() {
        #[cfg(test)]
        if matches!(
            fault,
            Some(ChainedInitializationFault::StepInsert(fault_index))
                | Some(ChainedInitializationFault::InitialProgressInsert(fault_index))
                if fault_index == _index
        ) {
            return ChainedAtomicInitializationResult::InternalInvariantFailure;
        }
        if insert_step(&transaction, request, &plan, step).is_err() {
            return ChainedAtomicInitializationResult::InternalInvariantFailure;
        }
    }
    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::ProjectionSync) {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    if initialize_projection(&transaction, request).is_err() {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }

    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::AuthoritativeReadback) {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }
    let precommit = match read_complete_authority(&transaction, request, &plan) {
        Ok(authority) => authority,
        Err(result) => return result,
    };
    if precommit.root_operation_id != root_operation_id
        || precommit.precondition_snapshot_hash != expected_precondition_hash
        || !initial_progress_is_complete(&transaction, request, &plan).unwrap_or(false)
        || !initial_projection_is_complete(&transaction, request).unwrap_or(false)
    {
        return ChainedAtomicInitializationResult::InternalInvariantFailure;
    }

    match transaction.commit() {
        Ok(()) => {}
        Err(error) if commit_is_known_not_committed(&error) => {
            return ChainedAtomicInitializationResult::KnownNotCommitted;
        }
        Err(_) => {
            if let Some(database_path) = recovery_database_path {
                authoritative_unknown_reopen(database_path, &request.operation_id);
            }
            return ChainedAtomicInitializationResult::ProvisioningRecoveryRequired;
        }
    }

    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::CommitOutcomeUnknown) {
        if let Some(database_path) = recovery_database_path {
            authoritative_unknown_reopen(database_path, &request.operation_id);
        }
        return ChainedAtomicInitializationResult::ProvisioningRecoveryRequired;
    }
    #[cfg(test)]
    if fault == Some(ChainedInitializationFault::PostCommitReadback) {
        return ChainedAtomicInitializationResult::ProvisioningRecoveryRequired;
    }

    let read_transaction = match connection.transaction_with_behavior(TransactionBehavior::Deferred)
    {
        Ok(transaction) => transaction,
        Err(_) => return ChainedAtomicInitializationResult::ProvisioningRecoveryRequired,
    };
    match read_complete_authority(&read_transaction, request, &plan) {
        Ok(authority)
            if initial_progress_is_complete(&read_transaction, request, &plan).unwrap_or(false)
                && initial_projection_is_complete(&read_transaction, request).unwrap_or(false) =>
        {
            ChainedAtomicInitializationResult::Initialized(authority)
        }
        Ok(_) => ChainedAtomicInitializationResult::ProvisioningRecoveryRequired,
        Err(_) => ChainedAtomicInitializationResult::ProvisioningRecoveryRequired,
    }
}

fn predecessor_scope_matches(
    predecessor: &ProvisioningOperationAttempt,
    request: &ChainedAtomicInitializationRequest,
) -> bool {
    predecessor.owner_type == request.scope.owner_type.as_str()
        && predecessor.owner_id == request.scope.owner_id
        && predecessor.scope_kind == request.scope.scope_kind.as_str()
        && predecessor.manuscript_channel.as_deref()
            == request.scope.manuscript_channel.map(|value| value.as_str())
}

fn terminal_tuple_allows(
    predecessor: &ProvisioningOperationAttempt,
    intent: ChainedInitializationIntent,
) -> bool {
    match intent {
        ChainedInitializationIntent::ExplicitRetry => {
            matches!(
                predecessor.operation_status.as_str(),
                "terminal-failed" | "terminal-partial"
            ) && predecessor.result_classification.as_deref() == Some("retryable")
                && predecessor.next_action.as_deref() == Some("retry")
        }
        ChainedInitializationIntent::ExplicitRepair => {
            matches!(
                predecessor.operation_status.as_str(),
                "terminal-failed" | "terminal-partial" | "terminal-blocked"
            ) && predecessor.result_classification.as_deref() == Some("repair-required")
                && predecessor.next_action.as_deref() == Some("repair")
        }
    }
}

fn predecessor_has_other_child(
    transaction: &Transaction<'_>,
    predecessor_id: &str,
    operation_id: &str,
) -> rusqlite::Result<bool> {
    transaction
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?1 AND operation_id<>?2",
            (predecessor_id, operation_id),
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count != 0)
}

fn active_claim_conflicts(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
) -> rusqlite::Result<bool> {
    let count = if request.scope.owner_type.as_str() == "literature" {
        match request.scope.scope_kind.as_str() {
            "literature-aggregate" => transaction.query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
                 WHERE owner_type='literature' AND owner_id=?1",
                [&request.scope.owner_id],
                |row| row.get::<_, i64>(0),
            )?,
            _ => transaction.query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
                 WHERE owner_type='literature' AND owner_id=?1
                   AND (scope_kind='literature-aggregate' OR manuscript_channel=?2)",
                params![
                    request.scope.owner_id,
                    request.scope.manuscript_channel.map(|value| value.as_str())
                ],
                |row| row.get::<_, i64>(0),
            )?,
        }
    } else {
        transaction.query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_active_claims
             WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel=?3",
            params![
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.manuscript_channel.map(|value| value.as_str())
            ],
            |row| row.get::<_, i64>(0),
        )?
    };
    Ok(count != 0)
}

fn insert_attempt(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    root_operation_id: &str,
    predecessor_operation_id: &str,
) -> rusqlite::Result<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               aggregate_operation_id,intent,trigger_kind,phase,operation_status,
               revision,previous_operation_id,root_operation_id,
               final_verification_outcome,facts_schema_version,started_at,updated_at
             ) VALUES (
               ?1,?2,?3,?4,?5,NULL,?6,?7,'preflight','active',
               0,?8,?9,'not-run',1,?10,?10
             )",
            params![
                request.operation_id,
                request.scope.scope_kind.as_str(),
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.manuscript_channel.map(|value| value.as_str()),
                durable_intent(request.intent).as_str(),
                trigger(request.intent),
                predecessor_operation_id,
                root_operation_id,
                request.occurred_at,
            ],
        )
        .map(|_| ())
}

fn insert_claim(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    claim_id: &str,
    claim_owner_token: &str,
    sealed_heartbeat_at: &str,
) -> rusqlite::Result<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_active_claims (
               claim_id,scope_kind,owner_type,owner_id,manuscript_channel,
               operation_id,claim_owner_token,claim_revision,
               claimed_at,last_heartbeat_at,last_progress_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?8)",
            params![
                claim_id,
                request.scope.scope_kind.as_str(),
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.manuscript_channel.map(|value| value.as_str()),
                request.operation_id,
                claim_owner_token,
                request.occurred_at,
                sealed_heartbeat_at,
            ],
        )
        .map(|_| ())
}

fn insert_plan(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    plan: &CanonicalPlan,
    token: &DurablePreconditionToken,
) -> rusqlite::Result<()> {
    let precondition_hash = token
        .canonical_hash_for_plan_insert(
            &request.operation_id,
            &request.scope,
            durable_intent(request.intent),
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id,operation_id,plan_version,plan_template_kind,
               plan_identity_fingerprint,precondition_snapshot_hash,fingerprint_profile,
               owner_type,owner_id,scope_kind,manuscript_channel,intent,
               canonical_resource_identity_hash,canonical_placement_identity_hash,
               parent_shared_identity_hash,step_count,planner_version,created_at
             ) VALUES (
               ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18
             )",
            params![
                plan.plan_id,
                request.operation_id,
                PLAN_VERSION,
                plan.descriptor.plan_template.as_str(),
                plan.fingerprint,
                precondition_hash,
                PlanFingerprintProfile::RestrictedJcsSha256V1.as_str(),
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.scope_kind.as_str(),
                request.scope.manuscript_channel.map(|value| value.as_str()),
                durable_intent(request.intent).as_str(),
                request.canonical_resource.resource_identity_hash,
                request.canonical_resource.placement_identity_hash,
                request.canonical_resource.parent_shared_identity_hash,
                plan.steps.len() as i64,
                PLANNER_VERSION,
                request.occurred_at,
            ],
        )
        .map(|_| ())
}

fn insert_step(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    plan: &CanonicalPlan,
    step: &CanonicalStep,
) -> rusqlite::Result<()> {
    transaction
        .execute(
            "INSERT INTO manuscript_provisioning_step_progress (
               step_id,plan_id,operation_id,step_ordinal,step_kind,step_scope,
               step_version,is_required,boundary,effect_outcome,readback_outcome,
               effect_facts_schema_version,progress_revision,created_at,updated_at
             ) VALUES (
               ?1,?2,?3,?4,?5,?6,1,1,'intended','unobserved','not-run',1,0,?7,?7
             )",
            params![
                step.step_id,
                plan.plan_id,
                request.operation_id,
                step.ordinal,
                step.definition.kind.as_str(),
                step.definition.scope.as_str(),
                request.occurred_at,
            ],
        )
        .map(|_| ())
}

fn initialize_projection(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
) -> rusqlite::Result<()> {
    if request.scope.scope_kind.as_str() != "literature-aggregate" {
        return Ok(());
    }
    for channel in ["literature_outline", "dedicated_notes"] {
        transaction.execute(
            "INSERT INTO manuscript_provisioning_literature_child_states (
               aggregate_operation_id,owner_type,owner_id,manuscript_channel,
               current_operation_id,current_operation_scope_kind,revision,
               child_summary_status,default_readiness,final_verification_outcome,updated_at
             ) VALUES (
               ?1,'literature',?2,?3,?1,'literature-aggregate',0,
               'assigned','not-verified','not-run',?4
             )",
            params![
                request.operation_id,
                request.scope.owner_id,
                channel,
                request.occurred_at
            ],
        )?;
    }
    Ok(())
}

fn immutable_attempt_plan_matches(
    attempt: &ProvisioningOperationAttempt,
    persisted: &DurableStepPlanRow,
    request: &ChainedAtomicInitializationRequest,
    plan: &CanonicalPlan,
) -> bool {
    predecessor_scope_matches(attempt, request)
        && attempt.intent == durable_intent(request.intent).as_str()
        && attempt.trigger_kind == trigger(request.intent)
        && attempt.previous_operation_id.as_deref()
            == Some(request.predecessor_operation_id.as_str())
        && attempt.started_at == request.occurred_at
        && persisted.operation_id == request.operation_id
        && persisted.plan_id == plan.plan_id
        && persisted.plan_version == PLAN_VERSION
        && persisted.plan_template_kind == plan.descriptor.plan_template
        && persisted.owner_type == request.scope.owner_type
        && persisted.owner_id == request.scope.owner_id
        && persisted.scope_kind == request.scope.scope_kind
        && persisted.manuscript_channel == request.scope.manuscript_channel
        && persisted.intent == durable_intent(request.intent)
        && persisted.canonical_resource_identity_hash
            == request.canonical_resource.resource_identity_hash
        && persisted.canonical_placement_identity_hash
            == request.canonical_resource.placement_identity_hash
        && persisted.parent_shared_identity_hash
            == request.canonical_resource.parent_shared_identity_hash
        && persisted.planner_version == PLANNER_VERSION
}

fn steps_are_complete(rows: &[DurableStepProgressRow], plan: &CanonicalPlan) -> bool {
    rows.len() == plan.steps.len()
        && rows.iter().zip(&plan.steps).all(|(row, expected)| {
            row.step_id == expected.step_id
                && row.plan_id == plan.plan_id
                && row.step_ordinal == expected.ordinal
                && row.step_kind == expected.definition.kind
                && row.step_scope == expected.definition.scope
                && row.step_version == STEP_VERSION
                && row.is_required
        })
}

fn initial_progress_is_complete(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    plan: &CanonicalPlan,
) -> Result<bool, ChainedAtomicInitializationResult> {
    let rows = read_attempt_step_progress(transaction, &request.operation_id)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?;
    Ok(steps_are_complete(&rows, plan)
        && rows.iter().all(|row| {
            row.boundary.as_str() == "intended"
                && row.effect_outcome.as_str() == "unobserved"
                && row.readback_outcome.as_str() == "not-run"
                && row.progress_revision == 0
        }))
}

fn projection_is_complete(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
) -> rusqlite::Result<bool> {
    if request.scope.scope_kind.as_str() != "literature-aggregate" {
        return Ok(true);
    }
    transaction
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
         WHERE aggregate_operation_id=?1 AND owner_type='literature' AND owner_id=?2
           AND current_operation_id=?1
           AND current_operation_scope_kind='literature-aggregate'",
            params![request.operation_id, request.scope.owner_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count == 2)
}

fn initial_projection_is_complete(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
) -> rusqlite::Result<bool> {
    if request.scope.scope_kind.as_str() != "literature-aggregate" {
        return Ok(true);
    }
    transaction
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
             WHERE aggregate_operation_id=?1 AND owner_type='literature' AND owner_id=?2
               AND current_operation_id=?1
               AND current_operation_scope_kind='literature-aggregate'
               AND revision=0 AND child_summary_status='assigned'
               AND result_classification IS NULL AND next_action IS NULL
               AND default_readiness='not-verified' AND final_verification_outcome='not-run'",
            params![request.operation_id, request.scope.owner_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count == 2)
}

fn derived_root(transaction: &Transaction<'_>, predecessor_id: &str) -> Result<Option<String>, ()> {
    read_operation_attempt(transaction, predecessor_id)
        .map(|predecessor| predecessor.map(|row| row.root_operation_id.unwrap_or(row.operation_id)))
        .map_err(|_| ())
}

fn read_complete_authority(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    plan: &CanonicalPlan,
) -> Result<ChainedInitializationAuthority, ChainedAtomicInitializationResult> {
    let attempt = read_operation_attempt(transaction, &request.operation_id)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?
        .ok_or(ChainedAtomicInitializationResult::ProvisioningRecoveryRequired)?;
    let persisted = read_attempt_plan(transaction, &request.operation_id)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?
        .ok_or(ChainedAtomicInitializationResult::ProvisioningRecoveryRequired)?;
    if !immutable_attempt_plan_matches(&attempt, &persisted, request, plan)
        || persisted.plan_identity_fingerprint != plan.fingerprint
        || persisted.step_count != plan.steps.len() as i64
    {
        return Err(ChainedAtomicInitializationResult::InternalInvariantFailure);
    }
    let root = derived_root(transaction, &request.predecessor_operation_id)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?
        .ok_or(ChainedAtomicInitializationResult::ProvisioningRecoveryRequired)?;
    if attempt.root_operation_id.as_deref() != Some(root.as_str()) {
        return Err(ChainedAtomicInitializationResult::InternalInvariantFailure);
    }
    let steps = read_attempt_step_progress(transaction, &request.operation_id)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?;
    if !steps_are_complete(&steps, plan)
        || !projection_is_complete(transaction, request)
            .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?
    {
        return Err(ChainedAtomicInitializationResult::ProvisioningRecoveryRequired);
    }
    let claim = read_active_claim_for_operation(transaction, &request.operation_id)
        .map_err(|_| ChainedAtomicInitializationResult::RepositoryUnavailable)?;
    if attempt.operation_status == "active" && claim.is_none() {
        return Err(ChainedAtomicInitializationResult::ProvisioningRecoveryRequired);
    }
    if attempt.operation_status != "active" && claim.is_some() {
        return Err(ChainedAtomicInitializationResult::ProvisioningRecoveryRequired);
    }
    Ok(ChainedInitializationAuthority {
        operation_id: attempt.operation_id,
        predecessor_operation_id: request.predecessor_operation_id.clone(),
        root_operation_id: root,
        attempt_revision: attempt.revision,
        claim_id: claim.map(|value| value.claim_id),
        plan_id: persisted.plan_id,
        plan_identity_fingerprint: persisted.plan_identity_fingerprint,
        precondition_snapshot_hash: persisted.precondition_snapshot_hash,
        step_count: persisted.step_count,
    })
}

fn classify_existing(
    transaction: &Transaction<'_>,
    request: &ChainedAtomicInitializationRequest,
    plan: &CanonicalPlan,
    attempt: ProvisioningOperationAttempt,
) -> ChainedAtomicInitializationResult {
    let persisted = match read_attempt_plan(transaction, &request.operation_id) {
        Ok(Some(plan)) => plan,
        Ok(None) => return ChainedAtomicInitializationResult::ProvisioningRecoveryRequired,
        Err(_) => return ChainedAtomicInitializationResult::RepositoryUnavailable,
    };
    if !immutable_attempt_plan_matches(&attempt, &persisted, request, plan) {
        return ChainedAtomicInitializationResult::IdentityConflict;
    }
    if persisted.plan_identity_fingerprint != plan.fingerprint {
        return ChainedAtomicInitializationResult::IdentityConflict;
    }
    match DurablePreconditionBuilder::short_revalidate_in_transaction(
        transaction,
        &request.operation_id,
    ) {
        DurableRevalidationResult::Matched(_) => {}
        DurableRevalidationResult::DurableAuthorityStale => {
            return ChainedAtomicInitializationResult::DurableAuthorityStale
        }
        DurableRevalidationResult::RepositoryUnavailable => {
            return ChainedAtomicInitializationResult::RepositoryUnavailable
        }
        DurableRevalidationResult::IdentityConflict
        | DurableRevalidationResult::InvalidOperationState
        | DurableRevalidationResult::NotFound
        | DurableRevalidationResult::InternalFailure => {
            return ChainedAtomicInitializationResult::ProvisioningRecoveryRequired
        }
    }
    let authority = match read_complete_authority(transaction, request, plan) {
        Ok(authority) => authority,
        Err(result) => return result,
    };
    match attempt.operation_status.as_str() {
        "active" => ChainedAtomicInitializationResult::AuthoritativeExisting(authority),
        "terminal-recovery-required" => {
            ChainedAtomicInitializationResult::RecoveryRequiredExisting(authority)
        }
        status if status.starts_with("terminal-") => {
            ChainedAtomicInitializationResult::TerminalExisting(authority)
        }
        _ => ChainedAtomicInitializationResult::ProvisioningRecoveryRequired,
    }
}

fn map_builder_error(
    error: StableErrorCode,
    intent: ChainedInitializationIntent,
) -> ChainedAtomicInitializationResult {
    match error {
        StableErrorCode::DurableNotFound => ChainedAtomicInitializationResult::PredecessorNotFound,
        StableErrorCode::DurableIdentityConflict => {
            ChainedAtomicInitializationResult::PredecessorNotCurrentLeaf
        }
        StableErrorCode::DurableRepositoryUnavailable => {
            ChainedAtomicInitializationResult::RepositoryUnavailable
        }
        StableErrorCode::DurableAuthorityStale => {
            ChainedAtomicInitializationResult::DurableAuthorityStale
        }
        StableErrorCode::DurableInvalidOperationState => match intent {
            ChainedInitializationIntent::ExplicitRetry => {
                ChainedAtomicInitializationResult::RetryNotAllowed
            }
            ChainedInitializationIntent::ExplicitRepair => {
                ChainedAtomicInitializationResult::RepairNotAllowed
            }
        },
        _ => ChainedAtomicInitializationResult::InternalInvariantFailure,
    }
}

fn commit_is_known_not_committed(error: &SqliteError) -> bool {
    match error {
        SqliteError::SqliteFailure(failure, _) => {
            matches!(
                failure.code,
                ErrorCode::DatabaseBusy
                    | ErrorCode::DatabaseLocked
                    | ErrorCode::ConstraintViolation
            )
        }
        _ => false,
    }
}

fn authoritative_unknown_reopen(path: &Path, operation_id: &str) {
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return;
    };
    let _ = connection
        .query_row(
            "SELECT operation_id FROM manuscript_provisioning_operation_attempts
             WHERE operation_id=?1",
            [operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional();
}
