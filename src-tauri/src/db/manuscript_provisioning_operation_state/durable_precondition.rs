#![allow(dead_code)]

use super::step_progress::{DurableStepProgressRow, DurableStepReadbackOutcome};
use super::step_progress_repository::{read_attempt_plan, read_attempt_step_progress};
use super::{read_operation_attempt, ProvisioningOperationAttempt};
use crate::manuscript_provisioning_contract::{
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
    DurableStepBoundary, DurableStepEffectOutcome, ProvisioningScopeIdentity, StableErrorCode,
};
use rusqlite::{OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use uuid::Uuid;

const DURABLE_PRECONDITION_DOMAIN: &str = "labpod.provisioning-durable-precondition";
const DURABLE_PRECONDITION_VERSION: i64 = 1;
const MAX_IDENTIFIER_LENGTH: usize = 128;
const CLOSED_PAYLOAD_KEYS: [&str; 11] = [
    "binding",
    "currentLeaf",
    "domain",
    "durableOwner",
    "fileRefs",
    "intent",
    "managedRoot",
    "predecessor",
    "priorSteps",
    "scope",
    "version",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DurablePreconditionRequest {
    pub operation_id: String,
    pub scope: ProvisioningScopeIdentity,
    pub intent: DurablePlanIntent,
    pub predecessor_operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableScopeFacts {
    owner_type: DurablePlanOwnerType,
    owner_id: String,
    scope_kind: DurablePlanScopeKind,
    manuscript_channel: Option<DurableManuscriptChannel>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableOwnerFacts {
    owner_type: DurablePlanOwnerType,
    owner_id: String,
    lifecycle: DurableLifecycle,
    identity_parts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DurableLifecycle {
    Active,
    Deleted,
}

impl DurableLifecycle {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableFileRefFacts {
    slot: String,
    file_ref_id: String,
    manuscript_channel: String,
    resource_kind: String,
    location_mode: String,
    path_identity_key: String,
    schema_version: i64,
    lifecycle: DurableLifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableBindingFacts {
    binding_id: String,
    manuscript_channel: String,
    default_folder_file_ref_id: Option<String>,
    default_manuscript_file_ref_id: Option<String>,
    current_file_ref_id: Option<String>,
    schema_version: i64,
    lifecycle: DurableLifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableBindingSet {
    entries: Vec<DurableBindingFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableManagedRootFacts {
    root_id: String,
    configured_root_identity: String,
    schema_version: i64,
    lifecycle: DurableLifecycle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableOperationFacts {
    operation_id: String,
    root_operation_id: String,
    revision: i64,
    phase: String,
    operation_status: String,
    result_classification: Option<String>,
    next_action: Option<String>,
    final_verification_outcome: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurablePriorStepFacts {
    ordinal: i64,
    step_id: String,
    step_kind: String,
    step_scope: String,
    boundary: String,
    progress_revision: i64,
    effect_digest: String,
    readback_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DurablePreconditionPayload {
    domain: &'static str,
    version: i64,
    scope: DurableScopeFacts,
    intent: DurablePlanIntent,
    durable_owner: Option<DurableOwnerFacts>,
    file_refs: Vec<DurableFileRefFacts>,
    binding: Option<DurableBindingSet>,
    managed_root: Option<DurableManagedRootFacts>,
    predecessor: Option<DurableOperationFacts>,
    current_leaf: Option<DurableOperationFacts>,
    prior_steps: Vec<DurablePriorStepFacts>,
}

#[derive(Debug)]
pub(super) struct DurablePreconditionToken {
    domain: &'static str,
    version: i64,
    operation_id: String,
    scope: DurableScopeFacts,
    intent: DurablePlanIntent,
    canonical_payload_hash: String,
    canonical_payload: String,
    payload: DurablePreconditionPayload,
    repository_generation: Uuid,
    transaction_marker: Uuid,
    recovery_entry_binding: Option<RecoveryDurablePreconditionBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RecoveryDurablePreconditionBinding {
    pub entry_action: &'static str,
    pub process_generation: String,
    pub planning_challenge_id: String,
    pub planning_repository_epoch: String,
    pub planning_repository_revision: String,
}

impl DurablePreconditionToken {
    /// Restricted Plan-writer view. The token has no public constructor and
    /// this accessor remains inside the operation-state repository boundary.
    pub(super) fn canonical_hash_for_plan_insert(
        &self,
        operation_id: &str,
        scope: &ProvisioningScopeIdentity,
        intent: DurablePlanIntent,
    ) -> Result<&str, StableErrorCode> {
        if self.domain != DURABLE_PRECONDITION_DOMAIN
            || self.version != DURABLE_PRECONDITION_VERSION
            || self.repository_generation != repository_generation()
            || self.operation_id != operation_id
            || self.intent != intent
            || self.scope.owner_type != scope.owner_type
            || self.scope.owner_id != scope.owner_id
            || self.scope.scope_kind != scope.scope_kind
            || self.scope.manuscript_channel != scope.manuscript_channel
            || self.transaction_marker.is_nil()
        {
            return Err(StableErrorCode::DurableIdentityConflict);
        }
        Ok(&self.canonical_payload_hash)
    }

    pub(super) fn canonical_hash_for_recovery_insert(
        &self,
        operation_id: &str,
        scope: &ProvisioningScopeIdentity,
        binding: &RecoveryDurablePreconditionBinding,
    ) -> Result<&str, StableErrorCode> {
        self.canonical_hash_for_plan_insert(operation_id, scope, DurablePlanIntent::Recover)?;
        if self.recovery_entry_binding.as_ref() != Some(binding)
            || binding.entry_action.is_empty()
            || binding.process_generation.is_empty()
            || binding.planning_challenge_id.is_empty()
            || binding.planning_repository_epoch.is_empty()
            || binding.planning_repository_revision.is_empty()
        {
            return Err(StableErrorCode::DurableIdentityConflict);
        }
        Ok(&self.canonical_payload_hash)
    }
}

#[derive(Debug)]
pub(super) struct DurableRetryFacts {
    predecessor_operation_id: String,
    root_operation_id: String,
    predecessor_revision: i64,
    current_leaf_operation_id: String,
    prior_steps: Vec<DurablePriorStepFacts>,
}

#[derive(Debug)]
pub(super) struct DurableRepairFacts {
    predecessor_operation_id: String,
    root_operation_id: String,
    predecessor_revision: i64,
    current_leaf_operation_id: String,
    prior_steps: Vec<DurablePriorStepFacts>,
}

#[derive(Debug)]
pub(super) enum DurableRevalidationResult {
    Matched(DurablePreconditionToken),
    DurableAuthorityStale,
    IdentityConflict,
    NotFound,
    InvalidOperationState,
    RepositoryUnavailable,
    InternalFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DurableReplayExistingState {
    ActiveExisting,
    TerminalExisting,
    RecoveryRequiredExisting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DurableReplayClassification {
    ExactImmutablePayloadMatch(DurableReplayExistingState),
    IdentityConflict,
    DurableAuthorityStale,
    NoExisting,
}

pub(super) struct DurablePreconditionBuilder;

impl DurablePreconditionBuilder {
    pub(super) fn build_in_transaction(
        transaction: &Transaction<'_>,
        request: &DurablePreconditionRequest,
    ) -> Result<DurablePreconditionToken, StableErrorCode> {
        Self::build_internal(transaction, request, false, false, None)
    }

    pub(super) fn build_recovery_in_transaction(
        transaction: &Transaction<'_>,
        request: &DurablePreconditionRequest,
        binding: RecoveryDurablePreconditionBinding,
    ) -> Result<DurablePreconditionToken, StableErrorCode> {
        if request.intent != DurablePlanIntent::Recover {
            return Err(StableErrorCode::DurableInvalidOperationState);
        }
        Self::build_internal(transaction, request, false, false, Some(binding))
    }

    fn build_internal(
        transaction: &Transaction<'_>,
        request: &DurablePreconditionRequest,
        allow_inactive: bool,
        fail_canonical: bool,
        recovery_entry_binding: Option<RecoveryDurablePreconditionBinding>,
    ) -> Result<DurablePreconditionToken, StableErrorCode> {
        let payload = build_payload(transaction, request, allow_inactive)?;
        let canonical_payload = if fail_canonical {
            return Err(StableErrorCode::DurableInternalFailure);
        } else {
            canonical_payload_json(&payload)?
        };
        let canonical_payload_hash = sha256_lowercase(canonical_payload.as_bytes());
        Ok(DurablePreconditionToken {
            domain: DURABLE_PRECONDITION_DOMAIN,
            version: DURABLE_PRECONDITION_VERSION,
            operation_id: request.operation_id.clone(),
            scope: payload.scope.clone(),
            intent: request.intent,
            canonical_payload_hash,
            canonical_payload,
            payload,
            repository_generation: repository_generation(),
            transaction_marker: Uuid::new_v4(),
            recovery_entry_binding,
        })
    }

    pub(super) fn short_revalidate_in_transaction(
        transaction: &Transaction<'_>,
        operation_id: &str,
    ) -> DurableRevalidationResult {
        let (attempt, plan) = match read_attempt_and_plan(transaction, operation_id) {
            Ok(Some(facts)) => facts,
            Ok(None) => return DurableRevalidationResult::NotFound,
            Err(_) => return DurableRevalidationResult::RepositoryUnavailable,
        };
        if !attempt_plan_identity_matches(&attempt, &plan) {
            return DurableRevalidationResult::IdentityConflict;
        }
        let request = match request_from_attempt(&attempt) {
            Ok(request) => request,
            Err(_) => return DurableRevalidationResult::InvalidOperationState,
        };
        match Self::build_internal(transaction, &request, true, false, None) {
            Ok(token) if token.canonical_payload_hash == plan.precondition_snapshot_hash => {
                DurableRevalidationResult::Matched(token)
            }
            Ok(_) => DurableRevalidationResult::DurableAuthorityStale,
            Err(StableErrorCode::DurableIdentityConflict) => {
                DurableRevalidationResult::IdentityConflict
            }
            Err(StableErrorCode::DurableNotFound) => DurableRevalidationResult::NotFound,
            Err(StableErrorCode::DurableRepositoryUnavailable) => {
                DurableRevalidationResult::RepositoryUnavailable
            }
            Err(StableErrorCode::DurableInternalFailure) => {
                DurableRevalidationResult::InternalFailure
            }
            Err(StableErrorCode::DurableInvalidOperationState) => {
                DurableRevalidationResult::DurableAuthorityStale
            }
            Err(_) => DurableRevalidationResult::InvalidOperationState,
        }
    }

    pub(super) fn classify_replay_in_transaction(
        transaction: &Transaction<'_>,
        operation_id: &str,
        token: &DurablePreconditionToken,
    ) -> DurableReplayClassification {
        if operation_id != token.operation_id
            || token.repository_generation != repository_generation()
        {
            return DurableReplayClassification::IdentityConflict;
        }
        let (attempt, plan) = match read_attempt_and_plan(transaction, operation_id) {
            Ok(Some(facts)) => facts,
            Ok(None) => return DurableReplayClassification::NoExisting,
            Err(_) => return DurableReplayClassification::IdentityConflict,
        };
        if !attempt_plan_identity_matches(&attempt, &plan)
            || plan.precondition_snapshot_hash != token.canonical_payload_hash
        {
            return DurableReplayClassification::IdentityConflict;
        }
        match Self::short_revalidate_in_transaction(transaction, operation_id) {
            DurableRevalidationResult::Matched(_) => {
                let existing = if attempt.operation_status == "active" {
                    DurableReplayExistingState::ActiveExisting
                } else if attempt.operation_status == "terminal-recovery-required" {
                    DurableReplayExistingState::RecoveryRequiredExisting
                } else {
                    DurableReplayExistingState::TerminalExisting
                };
                DurableReplayClassification::ExactImmutablePayloadMatch(existing)
            }
            DurableRevalidationResult::DurableAuthorityStale => {
                DurableReplayClassification::DurableAuthorityStale
            }
            DurableRevalidationResult::NotFound => DurableReplayClassification::NoExisting,
            _ => DurableReplayClassification::IdentityConflict,
        }
    }

    pub(super) fn read_retry_facts_in_transaction(
        transaction: &Transaction<'_>,
        request: &DurablePreconditionRequest,
    ) -> Result<DurableRetryFacts, StableErrorCode> {
        if request.intent != DurablePlanIntent::Retry {
            return Err(StableErrorCode::DurableIdentityConflict);
        }
        let (predecessor, steps) = read_predecessor_and_steps(transaction, request, "retry")?;
        if steps.iter().any(|step| {
            step.boundary == DurableStepBoundary::Started
                && step.effect_outcome == DurableStepEffectOutcome::Unobserved
                && step.readback_outcome == DurableStepReadbackOutcome::NotRun
        }) {
            return Err(StableErrorCode::DurableInvalidOperationState);
        }
        Ok(DurableRetryFacts {
            predecessor_operation_id: predecessor.operation_id.clone(),
            root_operation_id: root_operation_id(&predecessor),
            predecessor_revision: predecessor.revision,
            current_leaf_operation_id: predecessor.operation_id,
            prior_steps: steps.iter().map(prior_step_facts).collect(),
        })
    }

    pub(super) fn read_repair_facts_in_transaction(
        transaction: &Transaction<'_>,
        request: &DurablePreconditionRequest,
    ) -> Result<DurableRepairFacts, StableErrorCode> {
        if request.intent != DurablePlanIntent::Repair {
            return Err(StableErrorCode::DurableIdentityConflict);
        }
        let (predecessor, steps) = read_predecessor_and_steps(transaction, request, "repair")?;
        Ok(DurableRepairFacts {
            predecessor_operation_id: predecessor.operation_id.clone(),
            root_operation_id: root_operation_id(&predecessor),
            predecessor_revision: predecessor.revision,
            current_leaf_operation_id: predecessor.operation_id,
            prior_steps: steps.iter().map(prior_step_facts).collect(),
        })
    }

    #[cfg(test)]
    pub(super) fn build_with_canonical_fault_for_test(
        transaction: &Transaction<'_>,
        request: &DurablePreconditionRequest,
    ) -> Result<DurablePreconditionToken, StableErrorCode> {
        Self::build_internal(transaction, request, false, true, None)
    }
}

fn build_payload(
    transaction: &Transaction<'_>,
    request: &DurablePreconditionRequest,
    allow_inactive: bool,
) -> Result<DurablePreconditionPayload, StableErrorCode> {
    validate_request(request)?;
    let durable_owner = read_durable_owner(transaction, &request.scope)?;
    if !allow_inactive
        && durable_owner
            .as_ref()
            .is_some_and(|owner| owner.lifecycle == DurableLifecycle::Deleted)
    {
        return Err(StableErrorCode::DurableInvalidOperationState);
    }
    let file_refs = read_file_refs(transaction, &request.scope)?;
    let binding = read_binding(transaction, &request.scope)?;
    let managed_root = read_managed_root(transaction)?;
    if !allow_inactive
        && (binding.as_ref().is_some_and(|set| {
            set.entries
                .iter()
                .any(|entry| entry.lifecycle == DurableLifecycle::Deleted)
        }) || managed_root
            .as_ref()
            .is_some_and(|root| root.lifecycle == DurableLifecycle::Deleted))
    {
        return Err(StableErrorCode::DurableInvalidOperationState);
    }
    let (predecessor, current_leaf, prior_steps) = read_operation_facts(transaction, request)?;
    Ok(DurablePreconditionPayload {
        domain: DURABLE_PRECONDITION_DOMAIN,
        version: DURABLE_PRECONDITION_VERSION,
        scope: DurableScopeFacts {
            owner_type: request.scope.owner_type,
            owner_id: request.scope.owner_id.clone(),
            scope_kind: request.scope.scope_kind,
            manuscript_channel: request.scope.manuscript_channel,
        },
        intent: request.intent,
        durable_owner,
        file_refs,
        binding,
        managed_root,
        predecessor,
        current_leaf,
        prior_steps,
    })
}

fn validate_request(request: &DurablePreconditionRequest) -> Result<(), StableErrorCode> {
    request
        .scope
        .validate()
        .map_err(|_| StableErrorCode::DurableInvalidOperationState)?;
    if request.operation_id.is_empty()
        || request.operation_id.len() > MAX_IDENTIFIER_LENGTH
        || request.predecessor_operation_id.as_deref() == Some(request.operation_id.as_str())
    {
        return Err(StableErrorCode::DurableInvalidOperationState);
    }
    let predecessor_required = matches!(
        request.intent,
        DurablePlanIntent::Retry | DurablePlanIntent::Repair
    );
    if (predecessor_required && request.predecessor_operation_id.is_none())
        || (request.intent == DurablePlanIntent::CreateDefault
            && request.predecessor_operation_id.is_some())
    {
        return Err(StableErrorCode::DurableInvalidOperationState);
    }
    Ok(())
}

fn read_durable_owner(
    transaction: &Transaction<'_>,
    scope: &ProvisioningScopeIdentity,
) -> Result<Option<DurableOwnerFacts>, StableErrorCode> {
    if scope.owner_type == DurablePlanOwnerType::Review {
        return Ok(None);
    }
    let (identity_parts, deleted_at): (Vec<String>, Option<String>) = match scope.owner_type {
        DurablePlanOwnerType::Experiment => transaction
            .query_row(
                "SELECT project_id,task_id,deleted_at FROM experiments WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    let project: String = row.get(0)?;
                    let task: Option<String> = row.get(1)?;
                    Ok((vec![project, task.unwrap_or_default()], row.get(2)?))
                },
            )
            .optional(),
        DurablePlanOwnerType::ExperimentRun => transaction
            .query_row(
                "SELECT experiment_id,project_id,route_id,task_id,deleted_at
                 FROM experiment_runs WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        ],
                        row.get(4)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::Literature => transaction
            .query_row(
                "SELECT primary_project_id,deleted_at FROM literatures WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![row.get::<_, Option<String>>(0)?.unwrap_or_default()],
                        row.get(1)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::ResultItem => transaction
            .query_row(
                "SELECT project_id,route_id,task_id,experiment_id,experiment_run_id,
                        source_type,source_id,deleted_at
                 FROM result_items WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ],
                        row.get(7)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::Finding => transaction
            .query_row(
                "SELECT project_id,route_id,task_id,experiment_id,deleted_at
                 FROM findings WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        ],
                        row.get(4)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::OutputCandidate => transaction
            .query_row(
                "SELECT project_id,route_id,task_id,deleted_at
                 FROM output_candidates WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        ],
                        row.get(3)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::OutputGap => transaction
            .query_row(
                "SELECT project_id,related_task_id,related_route_node_id,deleted_at
                 FROM output_gaps WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        ],
                        row.get(3)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::ResearchOutput => transaction
            .query_row(
                "SELECT project_id,task_id,experiment_id,deleted_at FROM outputs WHERE id=?1",
                [&scope.owner_id],
                |row| {
                    Ok((
                        vec![
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        ],
                        row.get(3)?,
                    ))
                },
            )
            .optional(),
        DurablePlanOwnerType::Review => unreachable!("Review returned above"),
    }
    .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
    .ok_or(StableErrorCode::DurableNotFound)?;
    Ok(Some(DurableOwnerFacts {
        owner_type: scope.owner_type,
        owner_id: scope.owner_id.clone(),
        lifecycle: lifecycle(deleted_at),
        identity_parts,
    }))
}

fn read_file_refs(
    transaction: &Transaction<'_>,
    scope: &ProvisioningScopeIdentity,
) -> Result<Vec<DurableFileRefFacts>, StableErrorCode> {
    let mut statement = transaction
        .prepare(
            "SELECT file_role,id,manuscript_channel,resource_kind,location_mode,
                    path_identity_key,schema_version,deleted_at
             FROM file_refs
             WHERE owner_type=?1 AND owner_id=?2
               AND file_role IN ('defaultFolder','manuscript')
               AND (?3=1 OR manuscript_channel=?4)
             ORDER BY file_role,id",
        )
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    let aggregate = i64::from(scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate);
    let channel = scope.manuscript_channel.map(|value| value.as_str());
    let rows = statement
        .query_map(
            rusqlite::params![
                scope.owner_type.as_str(),
                scope.owner_id,
                aggregate,
                channel
            ],
            |row| {
                Ok(DurableFileRefFacts {
                    slot: row.get(0)?,
                    file_ref_id: row.get(1)?,
                    manuscript_channel: row.get(2)?,
                    resource_kind: row.get(3)?,
                    location_mode: row.get(4)?,
                    path_identity_key: row.get(5)?,
                    schema_version: row.get(6)?,
                    lifecycle: lifecycle(row.get(7)?),
                })
            },
        )
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    Ok(rows)
}

fn read_binding(
    transaction: &Transaction<'_>,
    scope: &ProvisioningScopeIdentity,
) -> Result<Option<DurableBindingSet>, StableErrorCode> {
    let mut statement = transaction
        .prepare(
            "SELECT id,manuscript_channel,default_folder_file_ref_id,
                    default_manuscript_file_ref_id,current_file_ref_id,schema_version,deleted_at
             FROM manuscript_bindings
             WHERE owner_type=?1 AND owner_id=?2
               AND (?3=1 OR manuscript_channel=?4)
             ORDER BY manuscript_channel,id",
        )
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    let aggregate = i64::from(scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate);
    let channel = scope.manuscript_channel.map(|value| value.as_str());
    let entries = statement
        .query_map(
            rusqlite::params![
                scope.owner_type.as_str(),
                scope.owner_id,
                aggregate,
                channel
            ],
            |row| {
                Ok(DurableBindingFacts {
                    binding_id: row.get(0)?,
                    manuscript_channel: row.get(1)?,
                    default_folder_file_ref_id: row.get(2)?,
                    default_manuscript_file_ref_id: row.get(3)?,
                    current_file_ref_id: row.get(4)?,
                    schema_version: row.get(5)?,
                    lifecycle: lifecycle(row.get(6)?),
                })
            },
        )
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    Ok((!entries.is_empty()).then_some(DurableBindingSet { entries }))
}

fn read_managed_root(
    transaction: &Transaction<'_>,
) -> Result<Option<DurableManagedRootFacts>, StableErrorCode> {
    transaction
        .query_row(
            "SELECT id,configured_root,schema_version,deleted_at
             FROM managed_root_settings WHERE id='managed-root'",
            [],
            |row| {
                Ok(DurableManagedRootFacts {
                    root_id: row.get(0)?,
                    configured_root_identity: row.get(1)?,
                    schema_version: row.get(2)?,
                    lifecycle: lifecycle(row.get(3)?),
                })
            },
        )
        .optional()
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)
}

fn read_operation_facts(
    transaction: &Transaction<'_>,
    request: &DurablePreconditionRequest,
) -> Result<
    (
        Option<DurableOperationFacts>,
        Option<DurableOperationFacts>,
        Vec<DurablePriorStepFacts>,
    ),
    StableErrorCode,
> {
    if request.predecessor_operation_id.is_some() {
        let expected_action = match request.intent {
            DurablePlanIntent::Retry => "retry",
            DurablePlanIntent::Repair => "repair",
            DurablePlanIntent::Recover => {
                let predecessor_id = request
                    .predecessor_operation_id
                    .as_deref()
                    .ok_or(StableErrorCode::DurableInvalidOperationState)?;
                let predecessor = read_operation_attempt(transaction, predecessor_id)
                    .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
                    .ok_or(StableErrorCode::DurableNotFound)?;
                if predecessor.owner_type != request.scope.owner_type.as_str()
                    || predecessor.owner_id != request.scope.owner_id
                    || predecessor.scope_kind != request.scope.scope_kind.as_str()
                    || predecessor.manuscript_channel.as_deref()
                        != request.scope.manuscript_channel.map(|value| value.as_str())
                    || predecessor.operation_status != "terminal-completed"
                    || predecessor.result_classification.as_deref() != Some("completed")
                    || predecessor.next_action.as_deref() != Some("none")
                    || predecessor.final_verification_outcome != "passed"
                    || !predecessor_is_current_leaf(
                        transaction,
                        predecessor_id,
                        &request.operation_id,
                    )?
                {
                    return Err(StableErrorCode::DurableInvalidOperationState);
                }
                let steps = read_attempt_step_progress(transaction, predecessor_id)
                    .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
                let facts = operation_facts(&predecessor);
                return Ok((
                    Some(facts.clone()),
                    Some(facts),
                    steps.iter().map(prior_step_facts).collect(),
                ));
            }
            DurablePlanIntent::CreateDefault => {
                return Err(StableErrorCode::DurableInvalidOperationState)
            }
        };
        let (predecessor, steps) =
            read_predecessor_and_steps(transaction, request, expected_action)?;
        let facts = operation_facts(&predecessor);
        return Ok((
            Some(facts.clone()),
            Some(facts),
            steps.iter().map(prior_step_facts).collect(),
        ));
    }
    let current_leaf = read_unrelated_current_leaf(transaction, request)?;
    Ok((
        None,
        current_leaf.map(|value| operation_facts(&value)),
        Vec::new(),
    ))
}

fn read_predecessor_and_steps(
    transaction: &Transaction<'_>,
    request: &DurablePreconditionRequest,
    expected_action: &str,
) -> Result<(ProvisioningOperationAttempt, Vec<DurableStepProgressRow>), StableErrorCode> {
    let predecessor_id = request
        .predecessor_operation_id
        .as_deref()
        .ok_or(StableErrorCode::DurableInvalidOperationState)?;
    let predecessor = read_operation_attempt(transaction, predecessor_id)
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
        .ok_or(StableErrorCode::DurableNotFound)?;
    if predecessor.owner_type != request.scope.owner_type.as_str()
        || predecessor.owner_id != request.scope.owner_id
        || predecessor.scope_kind != request.scope.scope_kind.as_str()
        || predecessor.manuscript_channel.as_deref()
            != request.scope.manuscript_channel.map(|value| value.as_str())
        || predecessor.next_action.as_deref() != Some(expected_action)
        || predecessor.operation_status == "active"
    {
        return Err(StableErrorCode::DurableInvalidOperationState);
    }
    if !predecessor_is_current_leaf(transaction, predecessor_id, &request.operation_id)? {
        return Err(StableErrorCode::DurableIdentityConflict);
    }
    let steps = read_attempt_step_progress(transaction, predecessor_id)
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    if steps.is_empty() {
        return Err(StableErrorCode::DurableInvalidOperationState);
    }
    Ok((predecessor, steps))
}

fn predecessor_is_current_leaf(
    transaction: &Transaction<'_>,
    predecessor_id: &str,
    excluded_operation_id: &str,
) -> Result<bool, StableErrorCode> {
    transaction
        .query_row(
            "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts
             WHERE previous_operation_id=?1 AND operation_id<>?2",
            (predecessor_id, excluded_operation_id),
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count == 0)
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)
}

fn read_unrelated_current_leaf(
    transaction: &Transaction<'_>,
    request: &DurablePreconditionRequest,
) -> Result<Option<ProvisioningOperationAttempt>, StableErrorCode> {
    let mut statement = transaction
        .prepare(
            "SELECT operation_id FROM manuscript_provisioning_operation_attempts AS candidate
             WHERE owner_type=?1 AND owner_id=?2 AND scope_kind=?3
               AND ((?4 IS NULL AND manuscript_channel IS NULL) OR manuscript_channel=?4)
               AND operation_id<>?5
               AND NOT EXISTS (
                 SELECT 1 FROM manuscript_provisioning_operation_attempts AS child
                 WHERE child.previous_operation_id=candidate.operation_id
                   AND child.operation_id<>?5
               )
             ORDER BY started_at DESC,operation_id
             LIMIT 2",
        )
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    let ids = statement
        .query_map(
            rusqlite::params![
                request.scope.owner_type.as_str(),
                request.scope.owner_id,
                request.scope.scope_kind.as_str(),
                request.scope.manuscript_channel.map(|value| value.as_str()),
                request.operation_id,
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    if ids.len() > 1 {
        return Err(StableErrorCode::DurableIdentityConflict);
    }
    ids.first()
        .map(|id| {
            read_operation_attempt(transaction, id)
                .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?
                .ok_or(StableErrorCode::DurableNotFound)
        })
        .transpose()
}

fn read_attempt_and_plan(
    transaction: &Transaction<'_>,
    operation_id: &str,
) -> Result<
    Option<(
        ProvisioningOperationAttempt,
        super::step_progress::DurableStepPlanRow,
    )>,
    StableErrorCode,
> {
    let attempt = read_operation_attempt(transaction, operation_id)
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    let Some(attempt) = attempt else {
        return Ok(None);
    };
    let plan = read_attempt_plan(transaction, operation_id)
        .map_err(|_| StableErrorCode::DurableRepositoryUnavailable)?;
    Ok(plan.map(|plan| (attempt, plan)))
}

fn attempt_plan_identity_matches(
    attempt: &ProvisioningOperationAttempt,
    plan: &super::step_progress::DurableStepPlanRow,
) -> bool {
    attempt.operation_id == plan.operation_id
        && attempt.owner_type == plan.owner_type.as_str()
        && attempt.owner_id == plan.owner_id
        && attempt.scope_kind == plan.scope_kind.as_str()
        && attempt.manuscript_channel.as_deref()
            == plan.manuscript_channel.map(|value| value.as_str())
        && attempt.intent == plan.intent.as_str()
}

fn request_from_attempt(
    attempt: &ProvisioningOperationAttempt,
) -> Result<DurablePreconditionRequest, StableErrorCode> {
    let owner_type = attempt
        .owner_type
        .parse()
        .map_err(|_| StableErrorCode::DurableInvalidOperationState)?;
    let scope_kind = attempt
        .scope_kind
        .parse()
        .map_err(|_| StableErrorCode::DurableInvalidOperationState)?;
    let manuscript_channel = attempt
        .manuscript_channel
        .as_deref()
        .map(str::parse)
        .transpose()
        .map_err(|_| StableErrorCode::DurableInvalidOperationState)?;
    let intent = attempt
        .intent
        .parse()
        .map_err(|_| StableErrorCode::DurableInvalidOperationState)?;
    Ok(DurablePreconditionRequest {
        operation_id: attempt.operation_id.clone(),
        scope: ProvisioningScopeIdentity {
            owner_type,
            owner_id: attempt.owner_id.clone(),
            scope_kind,
            manuscript_channel,
        },
        intent,
        predecessor_operation_id: attempt.previous_operation_id.clone(),
    })
}

fn operation_facts(attempt: &ProvisioningOperationAttempt) -> DurableOperationFacts {
    DurableOperationFacts {
        operation_id: attempt.operation_id.clone(),
        root_operation_id: root_operation_id(attempt),
        revision: attempt.revision,
        phase: attempt.phase.clone(),
        operation_status: attempt.operation_status.clone(),
        result_classification: attempt.result_classification.clone(),
        next_action: attempt.next_action.clone(),
        final_verification_outcome: attempt.final_verification_outcome.clone(),
    }
}

fn root_operation_id(attempt: &ProvisioningOperationAttempt) -> String {
    attempt
        .root_operation_id
        .clone()
        .unwrap_or_else(|| attempt.operation_id.clone())
}

fn prior_step_facts(step: &DurableStepProgressRow) -> DurablePriorStepFacts {
    let effect_digest = sha256_lowercase(
        format!(
            "labpod.durable-step-effect.v1\0{}\0{}\0{}",
            step.boundary.as_str(),
            step.effect_outcome.as_str(),
            step.resource_record_id.as_deref().unwrap_or("")
        )
        .as_bytes(),
    );
    let readback_digest = sha256_lowercase(
        format!(
            "labpod.durable-step-readback.v1\0{}\0{}",
            step.readback_outcome.as_str(),
            step.observed_identity_hash.as_deref().unwrap_or("")
        )
        .as_bytes(),
    );
    DurablePriorStepFacts {
        ordinal: step.step_ordinal,
        step_id: step.step_id.clone(),
        step_kind: step.step_kind.as_str().to_string(),
        step_scope: step.step_scope.as_str().to_string(),
        boundary: step.boundary.as_str().to_string(),
        progress_revision: step.progress_revision,
        effect_digest,
        readback_digest,
    }
}

fn lifecycle(deleted_at: Option<String>) -> DurableLifecycle {
    if deleted_at.is_some() {
        DurableLifecycle::Deleted
    } else {
        DurableLifecycle::Active
    }
}

fn canonical_payload_json(payload: &DurablePreconditionPayload) -> Result<String, StableErrorCode> {
    let value = json!({
        "binding": payload.binding.as_ref().map(|binding| {
            json!({
                "entries": binding.entries.iter().map(|entry| json!({
                    "bindingId": entry.binding_id,
                    "currentFileRefId": entry.current_file_ref_id,
                    "defaultFolderFileRefId": entry.default_folder_file_ref_id,
                    "defaultManuscriptFileRefId": entry.default_manuscript_file_ref_id,
                    "lifecycle": entry.lifecycle.as_str(),
                    "manuscriptChannel": entry.manuscript_channel,
                    "schemaVersion": entry.schema_version,
                })).collect::<Vec<_>>()
            })
        }),
        "currentLeaf": payload.current_leaf.as_ref().map(operation_value),
        "domain": payload.domain,
        "durableOwner": payload.durable_owner.as_ref().map(|owner| json!({
            "identityParts": owner.identity_parts,
            "lifecycle": owner.lifecycle.as_str(),
            "ownerId": owner.owner_id,
            "ownerType": owner.owner_type.as_str(),
        })),
        "fileRefs": payload.file_refs.iter().map(|file_ref| json!({
            "fileRefId": file_ref.file_ref_id,
            "lifecycle": file_ref.lifecycle.as_str(),
            "locationMode": file_ref.location_mode,
            "manuscriptChannel": file_ref.manuscript_channel,
            "pathIdentityKey": file_ref.path_identity_key,
            "resourceKind": file_ref.resource_kind,
            "schemaVersion": file_ref.schema_version,
            "slot": file_ref.slot,
        })).collect::<Vec<_>>(),
        "intent": payload.intent.as_str(),
        "managedRoot": payload.managed_root.as_ref().map(|root| json!({
            "configuredRootIdentity": root.configured_root_identity,
            "lifecycle": root.lifecycle.as_str(),
            "rootId": root.root_id,
            "schemaVersion": root.schema_version,
        })),
        "predecessor": payload.predecessor.as_ref().map(operation_value),
        "priorSteps": payload.prior_steps.iter().map(|step| json!({
            "boundary": step.boundary,
            "effectDigest": step.effect_digest,
            "ordinal": step.ordinal,
            "progressRevision": step.progress_revision,
            "readbackDigest": step.readback_digest,
            "stepId": step.step_id,
            "stepKind": step.step_kind,
            "stepScope": step.step_scope,
        })).collect::<Vec<_>>(),
        "scope": {
            "manuscriptChannel": payload.scope.manuscript_channel.map(|value| value.as_str()),
            "ownerId": payload.scope.owner_id,
            "ownerType": payload.scope.owner_type.as_str(),
            "scopeKind": payload.scope.scope_kind.as_str(),
        },
        "version": payload.version,
    });
    if !has_closed_payload_keys(&value) {
        return Err(StableErrorCode::DurableInternalFailure);
    }
    let mut output = String::new();
    write_restricted_jcs(&value, &mut output)?;
    Ok(output)
}

fn operation_value(operation: &DurableOperationFacts) -> Value {
    json!({
        "finalVerificationOutcome": operation.final_verification_outcome,
        "nextAction": operation.next_action,
        "operationId": operation.operation_id,
        "operationStatus": operation.operation_status,
        "phase": operation.phase,
        "resultClassification": operation.result_classification,
        "revision": operation.revision,
        "rootOperationId": operation.root_operation_id,
    })
}

fn write_restricted_jcs(value: &Value, output: &mut String) -> Result<(), StableErrorCode> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            if value.is_i64() || value.is_u64() {
                output.push_str(&value.to_string());
            } else {
                return Err(StableErrorCode::DurableInternalFailure);
            }
        }
        Value::String(value) => output.push_str(
            &serde_json::to_string(value).map_err(|_| StableErrorCode::DurableInternalFailure)?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_restricted_jcs(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut ordered = values.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|(key, _)| key.encode_utf16().collect::<Vec<_>>());
            output.push('{');
            for (index, (key, value)) in ordered.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| StableErrorCode::DurableInternalFailure)?,
                );
                output.push(':');
                write_restricted_jcs(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn has_closed_payload_keys(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    let mut expected = CLOSED_PAYLOAD_KEYS.to_vec();
    expected.sort_unstable();
    actual == expected
}

fn sha256_lowercase(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn repository_generation() -> Uuid {
    static GENERATION: OnceLock<Uuid> = OnceLock::new();
    *GENERATION.get_or_init(Uuid::new_v4)
}

#[cfg(test)]
pub(super) fn validate_closed_payload_json_for_test(value: &str) -> bool {
    serde_json::from_str::<Value>(value)
        .ok()
        .as_ref()
        .is_some_and(has_closed_payload_keys)
}

#[cfg(test)]
impl DurablePreconditionToken {
    pub(super) fn canonical_hash_for_test(&self) -> &str {
        &self.canonical_payload_hash
    }

    pub(super) fn canonical_payload_for_test(&self) -> &str {
        &self.canonical_payload
    }

    pub(super) fn invalidate_generation_for_test(&mut self) {
        self.repository_generation = Uuid::new_v4();
    }

    pub(super) fn generation_is_current_for_test(&self) -> bool {
        self.repository_generation == repository_generation()
    }
}

#[cfg(test)]
impl DurableRetryFacts {
    pub(super) fn root_operation_id_for_test(&self) -> &str {
        &self.root_operation_id
    }

    pub(super) fn predecessor_revision_for_test(&self) -> i64 {
        self.predecessor_revision
    }

    pub(super) fn prior_step_count_for_test(&self) -> usize {
        self.prior_steps.len()
    }
}

#[cfg(test)]
impl DurableRepairFacts {
    pub(super) fn root_operation_id_for_test(&self) -> &str {
        &self.root_operation_id
    }

    pub(super) fn prior_step_count_for_test(&self) -> usize {
        self.prior_steps.len()
    }
}
