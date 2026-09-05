use super::claim_ownership::ClaimOwnershipRepositoryContext;
use super::durable_precondition::{
    DurablePreconditionBuilder, DurablePreconditionRequest, RecoveryDurablePreconditionBinding,
};
use super::step_progress::DurableStepPlanRow;
use super::step_progress_repository::read_attempt_plan;
use super::{
    read_active_claim_for_operation, read_audit_state, read_operation_attempt,
    ProvisioningActiveClaim, ProvisioningOperationAttempt,
};
use crate::manuscript_provisioning_contract::{
    DurablePlanIntent, PlanTemplateKind, ProvisioningScopeIdentity,
};
use rusqlite::{
    params, Connection, Error as SqliteError, ErrorCode, Transaction, TransactionBehavior,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PLANNER_VERSION: &str = "cra-2-c-recovery-entry@1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryInitializationKind {
    InitialRoot,
    CompletedSuccessor,
}

impl RecoveryInitializationKind {
    fn action(self) -> &'static str {
        match self {
            Self::InitialRoot => "InitializeRootRecovery",
            Self::CompletedSuccessor => "CreateSuccessorRecovery",
        }
    }
}

#[derive(Debug)]
pub(crate) struct RecoveryInitializationRequest {
    pub(crate) scope: ProvisioningScopeIdentity,
    pub(crate) predecessor_operation_id: Option<String>,
    pub(crate) process_generation: String,
    pub(crate) planning_challenge_id: String,
    pub(crate) planning_repository_epoch: String,
    pub(crate) planning_repository_revision: String,
    pub(crate) planning_deadline_monotonic_ms: i64,
    pub(crate) authorization_deadline_monotonic_ms: i64,
    pub(crate) metadata: RecoveryMetadataPrecondition,
    pub(crate) completed_predecessor: Option<CompletedRecoveryPredecessorPrecondition>,
    pub(crate) occurred_at: String,
}

#[derive(Debug)]
pub(crate) struct RecoveryMetadataPrecondition {
    pub(crate) project_id: String,
    pub(crate) planning_authority_revision: String,
    pub(crate) owner_updated_at: Option<String>,
    pub(crate) owner_deleted_at: Option<String>,
    pub(crate) binding_id: String,
    pub(crate) binding_updated_at: String,
    pub(crate) default_folder_file_ref_id: String,
    pub(crate) default_folder_updated_at: String,
    pub(crate) default_folder_path_identity_key: String,
    pub(crate) default_manuscript_file_ref_id: String,
    pub(crate) default_manuscript_updated_at: String,
    pub(crate) default_manuscript_path_identity_key: String,
    pub(crate) current_file_ref_id: String,
    pub(crate) current_updated_at: String,
    pub(crate) current_path_identity_key: String,
    pub(crate) managed_root_updated_at: String,
    pub(crate) canonical_resource_identity_hash: String,
    pub(crate) canonical_placement_identity_hash: String,
    pub(crate) parent_shared_identity_hash: String,
    pub(crate) initial_bytes_hash: Option<String>,
    pub(crate) metadata_fingerprint: String,
}

#[derive(Debug)]
pub(crate) struct CompletedRecoveryPredecessorPrecondition {
    pub(crate) operation_id: String,
    pub(crate) root_operation_id: String,
    pub(crate) attempt_revision: i64,
    pub(crate) plan_id: String,
    pub(crate) plan_identity_fingerprint: String,
    pub(crate) outbox_revision: i64,
    pub(crate) durable_fingerprint: String,
}

#[derive(Debug)]
pub(crate) struct RecoveryInitializationAuthority {
    pub(crate) kind: RecoveryInitializationKind,
    pub(crate) predecessor_operation_id: Option<String>,
    pub(crate) operation: ProvisioningOperationAttempt,
    pub(crate) claim: ProvisioningActiveClaim,
    pub(crate) plan: DurableStepPlanRow,
}

#[derive(Debug)]
pub(crate) enum RecoveryInitializationResult {
    KnownCommitted(RecoveryInitializationAuthority),
    AuthoritativeExisting(RecoveryInitializationAuthority),
    KnownNotCommitted,
    CommitOutcomeUnknown,
    AdmissionStale,
    MetadataPreconditionStale,
    IdentityConflict,
    DurableConflict,
    RepositoryBusy,
    RepositoryUnavailable,
    InternalInvariantFailure,
}

pub(crate) fn initialize_canonical_root_recovery_atomically(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: RecoveryInitializationRequest,
    monotonic_now: &dyn Fn() -> i64,
) -> RecoveryInitializationResult {
    initialize(
        connection,
        ownership_context,
        RecoveryInitializationKind::InitialRoot,
        request,
        monotonic_now,
    )
}

pub(crate) fn create_successor_recovery_after_completed_atomically(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: RecoveryInitializationRequest,
    monotonic_now: &dyn Fn() -> i64,
) -> RecoveryInitializationResult {
    initialize(
        connection,
        ownership_context,
        RecoveryInitializationKind::CompletedSuccessor,
        request,
        monotonic_now,
    )
}

fn initialize(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    kind: RecoveryInitializationKind,
    request: RecoveryInitializationRequest,
    monotonic_now: &dyn Fn() -> i64,
) -> RecoveryInitializationResult {
    if request.scope.validate().is_err()
        || request.process_generation != ownership_context.claim_owner_token()
        || request.planning_challenge_id.is_empty()
        || request.planning_repository_epoch.is_empty()
        || request.planning_repository_revision.is_empty()
        || request.metadata.project_id.is_empty()
        || request.metadata.planning_authority_revision.is_empty()
        || request.metadata.metadata_fingerprint.len() != 64
        || (request.scope.owner_type.as_str() == "experiment"
            && (request
                .metadata
                .owner_updated_at
                .as_deref()
                .is_none_or(str::is_empty)
                || request
                    .metadata
                    .initial_bytes_hash
                    .as_deref()
                    .is_none_or(|value| value.len() != 64)))
        || request.occurred_at.is_empty()
        || matches!(kind, RecoveryInitializationKind::InitialRoot)
            != request.predecessor_operation_id.is_none()
        || matches!(kind, RecoveryInitializationKind::InitialRoot)
            != request.completed_predecessor.is_none()
    {
        return RecoveryInitializationResult::IdentityConflict;
    }
    if monotonic_now() >= request.planning_deadline_monotonic_ms
        || monotonic_now() >= request.authorization_deadline_monotonic_ms
    {
        return RecoveryInitializationResult::AdmissionStale;
    }
    if connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .is_err()
    {
        return RecoveryInitializationResult::RepositoryUnavailable;
    }
    let transaction = match connection.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(transaction) => transaction,
        Err(error) => return classify_begin(error),
    };
    if monotonic_now() >= request.planning_deadline_monotonic_ms
        || monotonic_now() >= request.authorization_deadline_monotonic_ms
    {
        return RecoveryInitializationResult::AdmissionStale;
    }
    if !metadata_matches_in_transaction(&transaction, &request.scope, &request.metadata) {
        return RecoveryInitializationResult::MetadataPreconditionStale;
    }

    let existing = match read_existing_child(&transaction, kind, &request) {
        Ok(existing) => existing,
        Err(result) => return result,
    };
    if let Some(operation_id) = existing {
        return match read_authority(
            &transaction,
            kind,
            request.predecessor_operation_id.as_deref(),
            &operation_id,
            &request.process_generation,
        ) {
            Ok(authority) => RecoveryInitializationResult::AuthoritativeExisting(authority),
            Err(result) => result,
        };
    }

    let predecessor = match validate_predecessor(&transaction, kind, &request) {
        Ok(predecessor) => predecessor,
        Err(result) => return result,
    };
    if active_claim_conflicts(&transaction, &request.scope).unwrap_or(true) {
        return RecoveryInitializationResult::DurableConflict;
    }

    let operation_id = Uuid::new_v4().to_string();
    let claim_id = Uuid::new_v4().to_string();
    let durable_request = DurablePreconditionRequest {
        operation_id: operation_id.clone(),
        scope: request.scope.clone(),
        intent: DurablePlanIntent::Recover,
        predecessor_operation_id: request.predecessor_operation_id.clone(),
    };
    let binding = RecoveryDurablePreconditionBinding {
        entry_action: kind.action(),
        process_generation: request.process_generation.clone(),
        planning_challenge_id: request.planning_challenge_id.clone(),
        planning_repository_epoch: request.planning_repository_epoch.clone(),
        planning_repository_revision: request.planning_repository_revision.clone(),
    };
    let token = match DurablePreconditionBuilder::build_recovery_in_transaction(
        &transaction,
        &durable_request,
        binding.clone(),
    ) {
        Ok(token) => token,
        Err(_) => return RecoveryInitializationResult::DurableConflict,
    };
    let precondition_hash =
        match token.canonical_hash_for_recovery_insert(&operation_id, &request.scope, &binding) {
            Ok(hash) => hash.to_string(),
            Err(_) => return RecoveryInitializationResult::InternalInvariantFailure,
        };
    let root_operation_id = predecessor.as_ref().map(|attempt| {
        attempt
            .root_operation_id
            .clone()
            .unwrap_or_else(|| attempt.operation_id.clone())
    });
    let sealed_heartbeat = match ownership_context.sample_sealed_heartbeat() {
        Ok(value) => value.persisted_value().to_string(),
        Err(_) => return RecoveryInitializationResult::RepositoryUnavailable,
    };
    let plan_id = hash(&[
        "labpod.recovery-entry-plan-id@1",
        &operation_id,
        kind.action(),
        &precondition_hash,
    ]);
    let plan_fingerprint = hash(&[
        "labpod.recovery-entry-plan-identity@1",
        &operation_id,
        request.scope.owner_type.as_str(),
        &request.scope.owner_id,
        request.scope.scope_kind.as_str(),
        request
            .scope
            .manuscript_channel
            .map(|value| value.as_str())
            .unwrap_or(""),
        request.predecessor_operation_id.as_deref().unwrap_or(""),
    ]);
    let resource_hash = request.metadata.canonical_resource_identity_hash.clone();
    let placement_hash = request.metadata.canonical_placement_identity_hash.clone();
    let parent_hash = request.metadata.parent_shared_identity_hash.clone();
    let template = plan_template(&request.scope);

    if transaction
        .execute(
            "INSERT INTO manuscript_provisioning_operation_attempts (
               operation_id,scope_kind,owner_type,owner_id,manuscript_channel,
               aggregate_operation_id,intent,trigger_kind,phase,operation_status,
               revision,previous_operation_id,root_operation_id,
               final_verification_outcome,facts_schema_version,started_at,updated_at
             ) VALUES (
               ?1,?2,?3,?4,?5,NULL,'recover','explicit-recovery','preflight','active',
               0,?6,?7,'not-run',1,?8,?8
             )",
            params![
                operation_id,
                request.scope.scope_kind.as_str(),
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.manuscript_channel.map(|value| value.as_str()),
                request.predecessor_operation_id,
                root_operation_id,
                request.occurred_at,
            ],
        )
        .is_err()
    {
        return RecoveryInitializationResult::InternalInvariantFailure;
    }
    if transaction
        .execute(
            "INSERT INTO manuscript_provisioning_active_claims (
               claim_id,scope_kind,owner_type,owner_id,manuscript_channel,
               operation_id,claim_owner_token,claim_revision,claimed_at,
               last_heartbeat_at,last_progress_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?8,?8)",
            params![
                claim_id,
                request.scope.scope_kind.as_str(),
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.manuscript_channel.map(|value| value.as_str()),
                operation_id,
                request.process_generation,
                sealed_heartbeat,
            ],
        )
        .is_err()
    {
        return RecoveryInitializationResult::InternalInvariantFailure;
    }
    if transaction
        .execute(
            "INSERT INTO manuscript_provisioning_step_plans (
               plan_id,operation_id,plan_version,plan_template_kind,
               plan_identity_fingerprint,precondition_snapshot_hash,
               fingerprint_profile,owner_type,owner_id,scope_kind,
               manuscript_channel,intent,canonical_resource_identity_hash,
               canonical_placement_identity_hash,parent_shared_identity_hash,
               step_count,planner_version,created_at
             ) VALUES (
               ?1,?2,1,?3,?4,?5,'restricted-jcs-sha256-v1',?6,?7,?8,?9,
               'recover',?10,?11,?12,0,?13,?14
             )",
            params![
                plan_id,
                operation_id,
                template.as_str(),
                plan_fingerprint,
                precondition_hash,
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.scope_kind.as_str(),
                request.scope.manuscript_channel.map(|value| value.as_str()),
                resource_hash,
                placement_hash,
                parent_hash,
                PLANNER_VERSION,
                request.occurred_at,
            ],
        )
        .is_err()
    {
        return RecoveryInitializationResult::InternalInvariantFailure;
    }
    if !projection_is_safe(
        &transaction,
        kind,
        &request.scope,
        &operation_id,
        &request.occurred_at,
    ) {
        return RecoveryInitializationResult::InternalInvariantFailure;
    }
    if read_authority(
        &transaction,
        kind,
        request.predecessor_operation_id.as_deref(),
        &operation_id,
        &request.process_generation,
    )
    .is_err()
    {
        return RecoveryInitializationResult::InternalInvariantFailure;
    }
    match transaction.commit() {
        Ok(()) => {}
        Err(error) if commit_is_known_not_committed(&error) => {
            return RecoveryInitializationResult::KnownNotCommitted
        }
        Err(_) => {
            return authoritative_reopen(
                connection,
                kind,
                request.predecessor_operation_id.as_deref(),
                &operation_id,
                &request.process_generation,
            )
            .map(RecoveryInitializationResult::KnownCommitted)
            .unwrap_or(RecoveryInitializationResult::CommitOutcomeUnknown)
        }
    }
    match read_authority(
        connection,
        kind,
        request.predecessor_operation_id.as_deref(),
        &operation_id,
        &request.process_generation,
    ) {
        Ok(authority) => RecoveryInitializationResult::KnownCommitted(authority),
        Err(_) => RecoveryInitializationResult::CommitOutcomeUnknown,
    }
}

fn commit_is_known_not_committed(error: &SqliteError) -> bool {
    match error {
        SqliteError::SqliteFailure(failure, _) => matches!(
            failure.code,
            ErrorCode::DatabaseBusy
                | ErrorCode::DatabaseLocked
                | ErrorCode::ConstraintViolation
                | ErrorCode::ReadOnly
        ),
        _ => false,
    }
}

fn authoritative_reopen(
    connection: &Connection,
    kind: RecoveryInitializationKind,
    predecessor_operation_id: Option<&str>,
    operation_id: &str,
    expected_process_generation: &str,
) -> Result<RecoveryInitializationAuthority, RecoveryInitializationResult> {
    if let Some(path) = connection.path() {
        let reopened =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| RecoveryInitializationResult::CommitOutcomeUnknown)?;
        return read_authority(
            &reopened,
            kind,
            predecessor_operation_id,
            operation_id,
            expected_process_generation,
        );
    }
    read_authority(
        connection,
        kind,
        predecessor_operation_id,
        operation_id,
        expected_process_generation,
    )
}

fn classify_begin(error: SqliteError) -> RecoveryInitializationResult {
    match error {
        SqliteError::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            ) =>
        {
            RecoveryInitializationResult::RepositoryBusy
        }
        _ => RecoveryInitializationResult::RepositoryUnavailable,
    }
}

fn read_existing_child(
    transaction: &Transaction<'_>,
    kind: RecoveryInitializationKind,
    request: &RecoveryInitializationRequest,
) -> Result<Option<String>, RecoveryInitializationResult> {
    let sql = match kind {
        RecoveryInitializationKind::InitialRoot => {
            "SELECT operation_id FROM manuscript_provisioning_operation_attempts
             WHERE owner_type=?1 AND owner_id=?2 AND scope_kind=?3
               AND ((?4 IS NULL AND manuscript_channel IS NULL) OR manuscript_channel=?4)
             ORDER BY started_at,operation_id LIMIT 2"
        }
        RecoveryInitializationKind::CompletedSuccessor => {
            "SELECT operation_id FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?5 ORDER BY started_at,operation_id LIMIT 2"
        }
    };
    let mut statement = transaction
        .prepare(sql)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?;
    let rows = match kind {
        RecoveryInitializationKind::InitialRoot => statement
            .query_map(
                params![
                    request.scope.owner_type.as_str(),
                    request.scope.owner_id,
                    request.scope.scope_kind.as_str(),
                    request.scope.manuscript_channel.map(|value| value.as_str()),
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
            .collect::<rusqlite::Result<Vec<_>>>(),
        RecoveryInitializationKind::CompletedSuccessor => statement
            .query_map(
                params![
                    request.scope.owner_type.as_str(),
                    request.scope.owner_id,
                    request.scope.scope_kind.as_str(),
                    request.scope.manuscript_channel.map(|value| value.as_str()),
                    request.predecessor_operation_id,
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
            .collect::<rusqlite::Result<Vec<_>>>(),
    }
    .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?;
    if rows.len() > 1 {
        return Err(RecoveryInitializationResult::DurableConflict);
    }
    Ok(rows.into_iter().next())
}

fn validate_predecessor(
    transaction: &Transaction<'_>,
    kind: RecoveryInitializationKind,
    request: &RecoveryInitializationRequest,
) -> Result<Option<ProvisioningOperationAttempt>, RecoveryInitializationResult> {
    if kind == RecoveryInitializationKind::InitialRoot {
        return Ok(None);
    }
    let predecessor_id = request
        .predecessor_operation_id
        .as_deref()
        .ok_or(RecoveryInitializationResult::IdentityConflict)?;
    let predecessor = read_operation_attempt(transaction, predecessor_id)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
        .ok_or(RecoveryInitializationResult::IdentityConflict)?;
    let expected = request
        .completed_predecessor
        .as_ref()
        .ok_or(RecoveryInitializationResult::IdentityConflict)?;
    let plan = read_attempt_plan(transaction, predecessor_id)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
        .ok_or(RecoveryInitializationResult::IdentityConflict)?;
    let outbox = read_audit_state(transaction, predecessor_id)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
        .ok_or(RecoveryInitializationResult::IdentityConflict)?;
    let root_operation_id = predecessor
        .root_operation_id
        .clone()
        .unwrap_or_else(|| predecessor.operation_id.clone());
    let durable_fingerprint = completed_predecessor_fingerprint(
        &predecessor.operation_id,
        &root_operation_id,
        predecessor.revision,
        &plan.plan_id,
        &plan.plan_identity_fingerprint,
        outbox.revision,
    );
    let valid = predecessor.owner_type == request.scope.owner_type.as_str()
        && predecessor.owner_id == request.scope.owner_id
        && predecessor.scope_kind == request.scope.scope_kind.as_str()
        && predecessor.manuscript_channel.as_deref()
            == request.scope.manuscript_channel.map(|value| value.as_str())
        && predecessor.operation_status == "terminal-completed"
        && predecessor.phase == "completed"
        && predecessor.result_classification.as_deref() == Some("completed")
        && predecessor.next_action.as_deref() == Some("none")
        && predecessor.final_verification_outcome == "passed"
        && expected.operation_id == predecessor.operation_id
        && expected.root_operation_id == root_operation_id
        && expected.attempt_revision == predecessor.revision
        && expected.plan_id == plan.plan_id
        && expected.plan_identity_fingerprint == plan.plan_identity_fingerprint
        && expected.outbox_revision == outbox.revision
        && expected.durable_fingerprint == durable_fingerprint
        && read_active_claim_for_operation(transaction, predecessor_id)
            .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
            .is_none();
    valid
        .then_some(Some(predecessor))
        .ok_or(RecoveryInitializationResult::IdentityConflict)
}

pub(crate) fn completed_predecessor_fingerprint(
    operation_id: &str,
    root_operation_id: &str,
    attempt_revision: i64,
    plan_id: &str,
    plan_identity_fingerprint: &str,
    outbox_revision: i64,
) -> String {
    hash(&[
        "labpod.review-recovery-completed-predecessor@1",
        operation_id,
        root_operation_id,
        &attempt_revision.to_string(),
        plan_id,
        plan_identity_fingerprint,
        &outbox_revision.to_string(),
    ])
}

fn metadata_matches_in_transaction(
    transaction: &Transaction<'_>,
    scope: &ProvisioningScopeIdentity,
    expected: &RecoveryMetadataPrecondition,
) -> bool {
    let owner_type = scope.owner_type.as_str();
    if !matches!(owner_type, "review" | "experiment")
        || scope.scope_kind.as_str() != "channel"
        || scope.manuscript_channel.map(|value| value.as_str()) != Some("primary")
    {
        return false;
    }
    let binding = transaction.query_row(
        "SELECT id,default_folder_file_ref_id,default_manuscript_file_ref_id,
                current_file_ref_id,updated_at
         FROM manuscript_bindings
         WHERE owner_type=?1 AND owner_id=?2
           AND manuscript_channel='primary' AND deleted_at IS NULL",
        params![owner_type, scope.owner_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    );
    let Ok((binding_id, Some(folder_id), Some(manuscript_id), Some(current_id), binding_updated)) =
        binding
    else {
        return false;
    };
    let read_file_ref = |id: &str| {
        transaction.query_row(
            "SELECT updated_at,path_identity_key,custom_fields FROM file_refs
             WHERE id=?1 AND owner_type=?2 AND owner_id=?3
               AND manuscript_channel='primary' AND deleted_at IS NULL",
            params![id, owner_type, scope.owner_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
    };
    let Ok((folder_updated, folder_path_key, _folder_custom_fields)) = read_file_ref(&folder_id)
    else {
        return false;
    };
    let Ok((manuscript_updated, manuscript_path_key, manuscript_custom_fields)) =
        read_file_ref(&manuscript_id)
    else {
        return false;
    };
    let Ok((current_updated, current_path_key, _current_custom_fields)) =
        read_file_ref(&current_id)
    else {
        return false;
    };
    let owner_revision = if owner_type == "experiment" {
        let row = transaction.query_row(
            "SELECT project_id,updated_at,deleted_at FROM experiments WHERE id=?1",
            [&scope.owner_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        );
        let Ok((project_id, updated_at, deleted_at)) = row else {
            return false;
        };
        if project_id != expected.project_id
            || Some(updated_at.clone()) != expected.owner_updated_at
            || deleted_at != expected.owner_deleted_at
        {
            return false;
        }
        Some((updated_at, deleted_at))
    } else {
        if expected.owner_updated_at.is_some()
            || expected.owner_deleted_at.is_some()
            || expected.initial_bytes_hash.is_some()
        {
            return false;
        }
        None
    };
    let initial_bytes_hash = if owner_type == "experiment" {
        let Some(bytes) = experiment_initial_bytes(&manuscript_custom_fields) else {
            return false;
        };
        let actual = format!("{:x}", Sha256::digest(bytes));
        if expected.initial_bytes_hash.as_deref() != Some(actual.as_str()) {
            return false;
        }
        Some(actual)
    } else {
        None
    };
    let root = transaction.query_row(
        "SELECT configured_root,updated_at FROM managed_root_settings
         WHERE id='managed-root' AND deleted_at IS NULL",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let Ok((managed_root, managed_root_updated)) = root else {
        return false;
    };
    let resource_hash = identity_hash(
        &format!("labpod.{owner_type}.primary.resource-identity.v1"),
        &[
            &scope.owner_id,
            &binding_id,
            &folder_id,
            &manuscript_id,
            &current_id,
            &manuscript_path_key,
        ],
    );
    let placement_hash = identity_hash(
        &format!("labpod.{owner_type}.primary.placement-identity.v1"),
        &[
            &managed_root,
            &folder_id,
            &folder_path_key,
            &manuscript_path_key,
        ],
    );
    let (owner_updated, owner_deleted) = owner_revision
        .as_ref()
        .map(|(updated, deleted)| (updated.as_str(), deleted.as_deref().unwrap_or("")))
        .unwrap_or(("", ""));
    let parent_values = if owner_type == "experiment" {
        vec![
            expected.project_id.as_str(),
            expected.planning_authority_revision.as_str(),
            owner_updated,
            owner_deleted,
            managed_root.as_str(),
            managed_root_updated.as_str(),
        ]
    } else {
        vec![
            expected.project_id.as_str(),
            expected.planning_authority_revision.as_str(),
            managed_root.as_str(),
            managed_root_updated.as_str(),
        ]
    };
    let parent_hash = identity_hash(
        &format!("labpod.{owner_type}.primary.parent-identity.v1"),
        &parent_values,
    );
    let mut metadata_values = vec![
        scope.owner_id.as_str(),
        expected.project_id.as_str(),
        expected.planning_authority_revision.as_str(),
    ];
    if owner_type == "experiment" {
        metadata_values.extend([owner_updated, owner_deleted]);
    }
    metadata_values.extend([
        binding_id.as_str(),
        binding_updated.as_str(),
        folder_id.as_str(),
        folder_updated.as_str(),
        manuscript_id.as_str(),
        manuscript_updated.as_str(),
        current_id.as_str(),
        current_updated.as_str(),
        managed_root_updated.as_str(),
    ]);
    if let Some(value) = initial_bytes_hash.as_deref() {
        metadata_values.push(value);
    }
    let metadata_fingerprint = identity_hash(
        &format!("labpod.{owner_type}.primary.metadata-authority.v1"),
        &metadata_values,
    );
    binding_id == expected.binding_id
        && binding_updated == expected.binding_updated_at
        && folder_id == expected.default_folder_file_ref_id
        && folder_updated == expected.default_folder_updated_at
        && folder_path_key == expected.default_folder_path_identity_key
        && manuscript_id == expected.default_manuscript_file_ref_id
        && manuscript_updated == expected.default_manuscript_updated_at
        && manuscript_path_key == expected.default_manuscript_path_identity_key
        && current_id == expected.current_file_ref_id
        && current_updated == expected.current_updated_at
        && current_path_key == expected.current_path_identity_key
        && managed_root_updated == expected.managed_root_updated_at
        && resource_hash == expected.canonical_resource_identity_hash
        && placement_hash == expected.canonical_placement_identity_hash
        && parent_hash == expected.parent_shared_identity_hash
        && metadata_fingerprint == expected.metadata_fingerprint
}

fn experiment_initial_bytes(custom_fields: &str) -> Option<Vec<u8>> {
    let fields: serde_json::Value = serde_json::from_str(custom_fields).ok()?;
    let matches = fields
        .as_array()?
        .iter()
        .filter(|field| {
            field.get("id").and_then(serde_json::Value::as_str)
                == Some("labpod.experiment.canonical-initial-content.v1")
                && field.get("name").and_then(serde_json::Value::as_str)
                    == Some("labpod.experiment.canonical-initial-content.v1")
        })
        .collect::<Vec<_>>();
    (matches.len() == 1)
        .then(|| {
            matches[0]
                .get("value")
                .and_then(serde_json::Value::as_str)
                .map(|value| value.as_bytes().to_vec())
        })
        .flatten()
}

fn identity_hash(domain: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn active_claim_conflicts(
    transaction: &Transaction<'_>,
    scope: &ProvisioningScopeIdentity,
) -> rusqlite::Result<bool> {
    let count = transaction.query_row(
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
    )?;
    Ok(count != 0)
}

fn read_authority(
    connection: &Connection,
    kind: RecoveryInitializationKind,
    predecessor_operation_id: Option<&str>,
    operation_id: &str,
    expected_process_generation: &str,
) -> Result<RecoveryInitializationAuthority, RecoveryInitializationResult> {
    let operation = read_operation_attempt(connection, operation_id)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
        .ok_or(RecoveryInitializationResult::InternalInvariantFailure)?;
    let claim = read_active_claim_for_operation(connection, operation_id)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
        .ok_or(RecoveryInitializationResult::InternalInvariantFailure)?;
    let plan = read_attempt_plan(connection, operation_id)
        .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
        .ok_or(RecoveryInitializationResult::InternalInvariantFailure)?;
    let root_matches = match kind {
        RecoveryInitializationKind::InitialRoot => {
            operation.previous_operation_id.is_none() && operation.root_operation_id.is_none()
        }
        RecoveryInitializationKind::CompletedSuccessor => {
            let predecessor_id =
                predecessor_operation_id.ok_or(RecoveryInitializationResult::IdentityConflict)?;
            let predecessor = read_operation_attempt(connection, predecessor_id)
                .map_err(|_| RecoveryInitializationResult::RepositoryUnavailable)?
                .ok_or(RecoveryInitializationResult::InternalInvariantFailure)?;
            operation.previous_operation_id.as_deref() == Some(predecessor_id)
                && operation.root_operation_id.as_deref()
                    == Some(
                        predecessor
                            .root_operation_id
                            .as_deref()
                            .unwrap_or(predecessor_id),
                    )
        }
    };
    let valid = root_matches
        && operation.intent == "recover"
        && operation.trigger_kind == "explicit-recovery"
        && operation.phase == "preflight"
        && operation.operation_status == "active"
        && operation.result_classification.is_none()
        && operation.next_action.is_none()
        && claim.operation_id == operation_id
        && claim.claim_owner_token == expected_process_generation
        && claim.owner_type == operation.owner_type
        && claim.owner_id == operation.owner_id
        && claim.scope_kind == operation.scope_kind
        && claim.manuscript_channel == operation.manuscript_channel
        && plan.operation_id == operation_id
        && plan.intent == DurablePlanIntent::Recover
        && plan.step_count == 0;
    let projection_valid = if operation.scope_kind == "literature-aggregate" {
        connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
                 WHERE owner_id=?1 AND current_operation_id=?2
                   AND current_operation_scope_kind='literature-aggregate'",
                params![operation.owner_id, operation_id],
                |row| row.get::<_, i64>(0),
            )
            .is_ok_and(|count| count == 2)
    } else {
        true
    };
    if !valid || !projection_valid {
        return Err(RecoveryInitializationResult::InternalInvariantFailure);
    }
    Ok(RecoveryInitializationAuthority {
        kind,
        predecessor_operation_id: predecessor_operation_id.map(str::to_string),
        operation,
        claim,
        plan,
    })
}

fn plan_template(scope: &ProvisioningScopeIdentity) -> PlanTemplateKind {
    match scope.scope_kind.as_str() {
        "literature-aggregate" => PlanTemplateKind::LiteratureAggregate,
        "literature-child" => PlanTemplateKind::LiteratureChannel,
        _ => match scope.owner_type.as_str() {
            "experiment" => PlanTemplateKind::ExperimentPrimary,
            "experimentRun" => PlanTemplateKind::ExperimentRunPrimary,
            _ => PlanTemplateKind::ManagedPrimary,
        },
    }
}

fn projection_is_safe(
    transaction: &Transaction<'_>,
    kind: RecoveryInitializationKind,
    scope: &ProvisioningScopeIdentity,
    operation_id: &str,
    occurred_at: &str,
) -> bool {
    if scope.scope_kind.as_str() != "literature-aggregate" {
        return true;
    }
    match kind {
        RecoveryInitializationKind::InitialRoot => {
            for channel in ["literature_outline", "dedicated_notes"] {
                if transaction
                    .execute(
                        "INSERT INTO manuscript_provisioning_literature_child_states (
                           aggregate_operation_id,owner_type,owner_id,manuscript_channel,
                           current_operation_id,current_operation_scope_kind,revision,
                           child_summary_status,default_readiness,
                           final_verification_outcome,updated_at
                         ) VALUES (
                           ?1,'literature',?2,?3,?1,'literature-aggregate',0,
                           'assigned','not-verified','not-run',?4
                         )",
                        params![operation_id, scope.owner_id, channel, occurred_at],
                    )
                    .is_err()
                {
                    return false;
                }
            }
            true
        }
        RecoveryInitializationKind::CompletedSuccessor => transaction
            .execute(
                "UPDATE manuscript_provisioning_literature_child_states
                 SET current_operation_id=?1,current_operation_scope_kind='literature-aggregate',
                     revision=revision+1,child_summary_status='assigned',
                     result_classification=NULL,next_action=NULL,
                     default_readiness='not-verified',
                     final_verification_outcome='not-run',
                     original_cause_code=NULL,updated_at=?2
                 WHERE owner_id=?3",
                params![operation_id, occurred_at, scope.owner_id],
            )
            .is_ok_and(|count| count == 2),
    }
}

fn hash(values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::manuscript_provisioning_operation_state::claim_ownership::{
        ClaimOwnershipRepositoryContext, FixedRepositoryUtcClock,
    };
    use crate::manuscript_provisioning_contract::{
        DurableManuscriptChannel, DurablePlanOwnerType, DurablePlanScopeKind,
    };
    use crate::owner_authority_lease::OwnerAuthorityLeaseRegistry;
    use crate::provisioning_runtime::core::ProvisioningRuntime;
    use crate::provisioning_runtime::database_provider::SqliteRuntimeDatabaseProvider;
    use crate::provisioning_runtime::heartbeat_scheduler::{FixedMonotonicClock, RecordingTicker};
    use crate::provisioning_runtime::lifecycle::{InlineRuntimeTaskSpawner, NoopRuntimeEventSink};
    use crate::provisioning_runtime::ownership_supervisor::{
        InitialRecoveryOwnershipAttachmentResult, RecoveryOwnershipSource,
    };
    use crate::provisioning_runtime::shared_executor::{
        SharedExecutorFoundation, SharedExecutorFoundationProvider,
    };
    use crate::provisioning_runtime::slot::RuntimeRegistryLifecycle;
    use crate::provisioning_runtime_foundation::ProcessGeneration;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn context() -> ClaimOwnershipRepositoryContext {
        ClaimOwnershipRepositoryContext::new(
            Arc::new(ProcessGeneration::fixed_for_test("process-cra-2-c")),
            Arc::new(FixedRepositoryUtcClock::new(1_800_000_000_000)),
        )
    }

    fn request(
        connection: &Connection,
        predecessor: Option<String>,
    ) -> RecoveryInitializationRequest {
        let completed_predecessor = predecessor.as_ref().map(|operation_id| {
            let attempt = read_operation_attempt(connection, operation_id)
                .expect("predecessor read")
                .expect("predecessor");
            let plan = read_attempt_plan(connection, operation_id)
                .expect("predecessor plan read")
                .expect("predecessor plan");
            let outbox = read_audit_state(connection, operation_id)
                .expect("predecessor outbox read")
                .expect("predecessor outbox");
            let root_operation_id = attempt
                .root_operation_id
                .clone()
                .unwrap_or_else(|| attempt.operation_id.clone());
            CompletedRecoveryPredecessorPrecondition {
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
            }
        });
        let authority_revision = "epoch-1:1";
        let resource_hash = identity_hash(
            "labpod.review.primary.resource-identity.v1",
            &[
                "review-1",
                "review-binding",
                "review-folder",
                "review-file",
                "review-file",
                "review-path",
            ],
        );
        let placement_hash = identity_hash(
            "labpod.review.primary.placement-identity.v1",
            &[
                "C:/LabPod/Managed",
                "review-folder",
                "folder-path",
                "review-path",
            ],
        );
        let parent_hash = identity_hash(
            "labpod.review.primary.parent-identity.v1",
            &[
                "project-1",
                authority_revision,
                "C:/LabPod/Managed",
                "2026-07-27T00:00:00.000Z",
            ],
        );
        let metadata_fingerprint = identity_hash(
            "labpod.review.primary.metadata-authority.v1",
            &[
                "review-1",
                "project-1",
                authority_revision,
                "review-binding",
                "2026-07-27T00:00:00.000Z",
                "review-folder",
                "2026-07-27T00:00:00.000Z",
                "review-file",
                "2026-07-27T00:00:00.000Z",
                "review-file",
                "2026-07-27T00:00:00.000Z",
                "2026-07-27T00:00:00.000Z",
            ],
        );
        RecoveryInitializationRequest {
            scope: ProvisioningScopeIdentity {
                owner_type: DurablePlanOwnerType::Review,
                owner_id: "review-1".to_string(),
                scope_kind: DurablePlanScopeKind::Channel,
                manuscript_channel: Some(DurableManuscriptChannel::Primary),
            },
            predecessor_operation_id: predecessor,
            process_generation: "process-cra-2-c".to_string(),
            planning_challenge_id: "challenge-1".to_string(),
            planning_repository_epoch: "epoch-1".to_string(),
            planning_repository_revision: "1".to_string(),
            planning_deadline_monotonic_ms: 1_000,
            authorization_deadline_monotonic_ms: 1_000,
            metadata: RecoveryMetadataPrecondition {
                project_id: "project-1".to_string(),
                planning_authority_revision: authority_revision.to_string(),
                owner_updated_at: None,
                owner_deleted_at: None,
                binding_id: "review-binding".to_string(),
                binding_updated_at: "2026-07-27T00:00:00.000Z".to_string(),
                default_folder_file_ref_id: "review-folder".to_string(),
                default_folder_updated_at: "2026-07-27T00:00:00.000Z".to_string(),
                default_folder_path_identity_key: "folder-path".to_string(),
                default_manuscript_file_ref_id: "review-file".to_string(),
                default_manuscript_updated_at: "2026-07-27T00:00:00.000Z".to_string(),
                default_manuscript_path_identity_key: "review-path".to_string(),
                current_file_ref_id: "review-file".to_string(),
                current_updated_at: "2026-07-27T00:00:00.000Z".to_string(),
                current_path_identity_key: "review-path".to_string(),
                managed_root_updated_at: "2026-07-27T00:00:00.000Z".to_string(),
                canonical_resource_identity_hash: resource_hash,
                canonical_placement_identity_hash: placement_hash,
                parent_shared_identity_hash: parent_hash,
                initial_bytes_hash: None,
                metadata_fingerprint,
            },
            completed_predecessor,
            occurred_at: "2026-07-27T00:00:00.000Z".to_string(),
        }
    }

    struct TestDatabase {
        directory: PathBuf,
        path: PathBuf,
        connection: Connection,
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn database() -> TestDatabase {
        let directory = std::env::temp_dir().join(format!("labpod-cra-2-c-{}", Uuid::new_v4()));
        fs::create_dir(&directory).expect("create temp");
        let path = directory.join("fixture.sqlite3");
        crate::db::initialize_database_at(&path).expect("exact v41");
        let connection = Connection::open(&path).expect("open");
        connection
            .execute(
                "INSERT INTO file_refs (
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES (
                   'review-folder','review','review-1','primary','folder','defaultFolder',
                   'managed','folder','C:/LabPod/Managed/review-1',
                   'folder-path','Review workspace',?1,?1
                 )",
                ["2026-07-27T00:00:00.000Z"],
            )
            .expect("folder ref");
        connection
            .execute(
                "INSERT OR IGNORE INTO managed_root_settings (
                   id,configured_root,created_at,updated_at
                 ) VALUES ('managed-root','C:/LabPod/Managed',?1,?1)",
                ["2026-07-27T00:00:00.000Z"],
            )
            .expect("root");
        connection
            .execute(
                "INSERT INTO file_refs (
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES (
                   'review-file','review','review-1','primary','file','manuscript',
                   'managed','markdown','C:/LabPod/Managed/review-1/review.md',
                   'review-path','Review',?1,?1
                 )",
                ["2026-07-27T00:00:00.000Z"],
            )
            .expect("file ref");
        connection
            .execute(
                "INSERT INTO manuscript_bindings (
                   id,owner_type,owner_id,manuscript_channel,
                   default_folder_file_ref_id,default_manuscript_file_ref_id,
                   current_file_ref_id,created_at,updated_at
                 ) VALUES (
                   'review-binding','review','review-1','primary',
                   'review-folder','review-file','review-file',?1,?1
                 )",
                ["2026-07-27T00:00:00.000Z"],
            )
            .expect("binding");
        TestDatabase {
            directory,
            path,
            connection,
        }
    }

    fn lose_known_commit_response(
        result: RecoveryInitializationResult,
    ) -> RecoveryInitializationResult {
        match result {
            RecoveryInitializationResult::KnownCommitted(_) => {
                RecoveryInitializationResult::CommitOutcomeUnknown
            }
            other => other,
        }
    }

    #[test]
    fn root_is_single_uses_schema_native_null_links_and_survives_response_loss_retry() {
        let mut database = database();
        let connection = &mut database.connection;
        let context = context();
        let first_request = request(connection, None);
        let lost_response =
            lose_known_commit_response(initialize_canonical_root_recovery_atomically(
                connection,
                &context,
                first_request,
                &|| 10,
            ));
        assert!(matches!(
            lost_response,
            RecoveryInitializationResult::CommitOutcomeUnknown
        ));
        let replay_request = request(connection, None);
        let second = initialize_canonical_root_recovery_atomically(
            connection,
            &context,
            replay_request,
            &|| 11,
        );
        let authority = match second {
            RecoveryInitializationResult::AuthoritativeExisting(authority) => authority,
            other => panic!("unexpected retry {other:?}"),
        };
        assert!(authority.operation.previous_operation_id.is_none());
        assert!(authority.operation.root_operation_id.is_none());
    }

    #[test]
    fn completed_predecessor_has_one_direct_successor_preserves_root_and_survives_response_loss_retry(
    ) {
        let mut database = database();
        let connection = &mut database.connection;
        let context = context();
        let root_request = request(connection, None);
        let root = initialize_canonical_root_recovery_atomically(
            connection,
            &context,
            root_request,
            &|| 10,
        );
        let root_id = match root {
            RecoveryInitializationResult::KnownCommitted(authority) => {
                authority.operation.operation_id
            }
            other => panic!("unexpected {other:?}"),
        };
        connection
            .execute(
                "DELETE FROM manuscript_provisioning_active_claims WHERE operation_id=?1",
                [&root_id],
            )
            .expect("release completed claim");
        connection
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET phase='completed',operation_status='terminal-completed',
                     result_classification='completed',next_action='none',
                     final_verification_outcome='passed',terminal_at=?2,
                     updated_at=?2,revision=revision+1
                 WHERE operation_id=?1",
                (&root_id, "2026-07-27T00:01:00.000Z"),
            )
            .expect("complete predecessor");
        connection
            .execute(
                "INSERT INTO manuscript_provisioning_audit_outbox (
                   operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
                 ) VALUES (?1,'pending',0,0,?2,?2)",
                (&root_id, "2026-07-27T00:01:00.000Z"),
            )
            .expect("complete predecessor outbox");
        let successor_request = request(connection, Some(root_id.clone()));
        let lost_response =
            lose_known_commit_response(create_successor_recovery_after_completed_atomically(
                connection,
                &context,
                successor_request,
                &|| 20,
            ));
        assert!(matches!(
            lost_response,
            RecoveryInitializationResult::CommitOutcomeUnknown
        ));
        let replay_request = request(connection, Some(root_id.clone()));
        let second = create_successor_recovery_after_completed_atomically(
            connection,
            &context,
            replay_request,
            &|| 21,
        );
        let existing_id = match second {
            RecoveryInitializationResult::AuthoritativeExisting(authority) => {
                assert_eq!(
                    authority.operation.previous_operation_id.as_deref(),
                    Some(root_id.as_str())
                );
                assert_eq!(
                    authority.operation.root_operation_id.as_deref(),
                    Some(root_id.as_str())
                );
                authority.operation.operation_id
            }
            other => panic!("unexpected {other:?}"),
        };
        assert!(!existing_id.is_empty());
        let child_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE previous_operation_id=?1",
                [&root_id],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(child_count, 1);
    }

    #[test]
    fn concurrent_root_and_successor_entry_each_have_one_durable_winner() {
        fn run_root_race(path: &std::path::Path) -> Vec<String> {
            let barrier = Arc::new(Barrier::new(2));
            let mut workers = Vec::new();
            for _ in 0..2 {
                let barrier = barrier.clone();
                let path = path.to_path_buf();
                workers.push(thread::spawn(move || {
                    let mut connection = Connection::open(path).expect("open worker");
                    barrier.wait();
                    let root_request = request(&connection, None);
                    match initialize_canonical_root_recovery_atomically(
                        &mut connection,
                        &context(),
                        root_request,
                        &|| 10,
                    ) {
                        RecoveryInitializationResult::KnownCommitted(authority)
                        | RecoveryInitializationResult::AuthoritativeExisting(authority) => {
                            authority.operation.operation_id
                        }
                        other => panic!("unexpected root race result {other:?}"),
                    }
                }));
            }
            workers
                .into_iter()
                .map(|worker| worker.join().expect("root worker"))
                .collect()
        }

        fn run_successor_race(path: &std::path::Path, predecessor_id: &str) -> Vec<String> {
            let barrier = Arc::new(Barrier::new(2));
            let mut workers = Vec::new();
            for _ in 0..2 {
                let barrier = barrier.clone();
                let path = path.to_path_buf();
                let predecessor_id = predecessor_id.to_string();
                workers.push(thread::spawn(move || {
                    let mut connection = Connection::open(path).expect("open worker");
                    barrier.wait();
                    let successor_request = request(&connection, Some(predecessor_id));
                    match create_successor_recovery_after_completed_atomically(
                        &mut connection,
                        &context(),
                        successor_request,
                        &|| 20,
                    ) {
                        RecoveryInitializationResult::KnownCommitted(authority)
                        | RecoveryInitializationResult::AuthoritativeExisting(authority) => {
                            authority.operation.operation_id
                        }
                        other => panic!("unexpected successor race result {other:?}"),
                    }
                }));
            }
            workers
                .into_iter()
                .map(|worker| worker.join().expect("successor worker"))
                .collect()
        }

        let database = database();
        let root_ids = run_root_race(&database.path);
        assert_eq!(root_ids[0], root_ids[1]);
        let root_count: i64 = database
            .connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE previous_operation_id IS NULL AND root_operation_id IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("root count");
        assert_eq!(root_count, 1);

        let root_id = &root_ids[0];
        database
            .connection
            .execute(
                "DELETE FROM manuscript_provisioning_active_claims WHERE operation_id=?1",
                [root_id],
            )
            .expect("release completed claim");
        database
            .connection
            .execute(
                "UPDATE manuscript_provisioning_operation_attempts
                 SET phase='completed',operation_status='terminal-completed',
                     result_classification='completed',next_action='none',
                     final_verification_outcome='passed',terminal_at=?2,
                     updated_at=?2,revision=revision+1
                 WHERE operation_id=?1",
                (root_id, "2026-07-27T00:01:00.000Z"),
            )
            .expect("complete predecessor");
        database
            .connection
            .execute(
                "INSERT INTO manuscript_provisioning_audit_outbox (
                   operation_id,delivery_status,revision,delivery_attempt_count,created_at,updated_at
                 ) VALUES (?1,'pending',0,0,?2,?2)",
                (root_id, "2026-07-27T00:01:00.000Z"),
            )
            .expect("complete predecessor outbox");

        let successor_ids = run_successor_race(&database.path, root_id);
        assert_eq!(successor_ids[0], successor_ids[1]);
        let successor_count: i64 = database
            .connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
                 WHERE previous_operation_id=?1",
                [root_id],
                |row| row.get(0),
            )
            .expect("successor count");
        assert_eq!(successor_count, 1);
    }

    #[test]
    fn admission_expiry_rolls_back_before_any_rows_are_created() {
        let mut database = database();
        let context = context();
        let stale_request = request(&database.connection, None);
        let result = initialize_canonical_root_recovery_atomically(
            &mut database.connection,
            &context,
            stale_request,
            &|| 1_000,
        );
        assert!(matches!(
            result,
            RecoveryInitializationResult::AdmissionStale
        ));
        let count: i64 = database
            .connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn initial_guard_attachment_is_one_winner_and_resolves_foundation_only() {
        let mut database = database();
        let process_generation = Arc::new(ProcessGeneration::fixed_for_test("process-cra-2-c"));
        let ownership_context = Arc::new(ClaimOwnershipRepositoryContext::new(
            process_generation.clone(),
            Arc::new(FixedRepositoryUtcClock::new(1_800_000_000_000)),
        ));
        let provider = Arc::new(
            SqliteRuntimeDatabaseProvider::new_isolated(
                database.path.clone(),
                &format!("local.labpod.cra-2-c.{}.test", Uuid::new_v4()),
            )
            .expect("provider"),
        );
        let runtime = ProvisioningRuntime::new_production(
            provider,
            ownership_context.clone(),
            Arc::new(FixedMonotonicClock::new(10)),
            Arc::new(RecordingTicker::default()),
            Arc::new(InlineRuntimeTaskSpawner),
            Arc::new(NoopRuntimeEventSink),
        );
        let supervisor = runtime
            .retained_ownership_supervisor_for_test()
            .expect("supervisor");
        let initial_request = request(&database.connection, None);
        let result = initialize_canonical_root_recovery_atomically(
            &mut database.connection,
            &ownership_context,
            initial_request,
            &|| 10,
        );
        let authority = match result {
            RecoveryInitializationResult::KnownCommitted(authority) => authority,
            other => panic!("unexpected {other:?}"),
        };
        assert!(matches!(
            supervisor.attach_initial_recovery_ownership_with_fault_for_test(authority),
            InitialRecoveryOwnershipAttachmentResult::CommittedButUnattached
        ));
        let replay_request = request(&database.connection, None);
        let replay = initialize_canonical_root_recovery_atomically(
            &mut database.connection,
            &ownership_context,
            replay_request,
            &|| 11,
        );
        let replay_authority = match replay {
            RecoveryInitializationResult::AuthoritativeExisting(authority) => authority,
            other => panic!("unexpected replay {other:?}"),
        };
        let attached = match supervisor.attach_initial_recovery_ownership(replay_authority) {
            InitialRecoveryOwnershipAttachmentResult::Attached(attached) => attached,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(
            attached.source,
            RecoveryOwnershipSource::InitialRootOwnership
        );
        let authority_registry = Arc::new(OwnerAuthorityLeaseRegistry::from_process_generation(
            process_generation,
        ));
        let foundation = Arc::new(
            SharedExecutorFoundation::from_runtime_for_test(&runtime, authority_registry)
                .expect("foundation"),
        );
        let ready = SharedExecutorFoundationProvider::new(foundation)
            .resolve_attached(attached)
            .expect("foundation ready");
        assert_eq!(
            ready.ownership_source,
            RecoveryOwnershipSource::InitialRootOwnership
        );
        assert!(!ready.operation_id.is_empty());
        assert!(!ready.claim_id.is_empty());
        let _resolved_only = ready.shared_foundation();

        let restarted_generation = Arc::new(ProcessGeneration::fixed_for_test(
            "process-cra-2-c-restarted",
        ));
        let restarted_context = Arc::new(ClaimOwnershipRepositoryContext::new(
            restarted_generation,
            Arc::new(FixedRepositoryUtcClock::new(1_800_000_500_000)),
        ));
        let restarted_provider = Arc::new(
            SqliteRuntimeDatabaseProvider::new_isolated(
                database.path.clone(),
                &format!("local.labpod.cra-2-c.restart.{}.test", Uuid::new_v4()),
            )
            .expect("restart provider"),
        );
        let restarted_runtime = ProvisioningRuntime::new_production(
            restarted_provider,
            restarted_context,
            Arc::new(FixedMonotonicClock::new(20)),
            Arc::new(RecordingTicker::default()),
            Arc::new(InlineRuntimeTaskSpawner),
            Arc::new(NoopRuntimeEventSink),
        );
        let restarted_supervisor = restarted_runtime
            .retained_ownership_supervisor_for_test()
            .expect("restart supervisor");
        let _ = restarted_supervisor.tick();
        assert!(matches!(
            restarted_supervisor.registry_lifecycle_for_claim(&ready.claim_id),
            Some(
                RuntimeRegistryLifecycle::OrphanedDurableClaim
                    | RuntimeRegistryLifecycle::OwnershipExpiredCandidate
            )
        ));
    }
}
