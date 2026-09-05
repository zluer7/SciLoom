use super::feedback::RuntimeSafeErrorCode;
use super::recovery_snapshot::RecoveryInspectionSnapshot;
use super::slot::{SlotCoordinator, SlotLease};
use crate::db::manuscript_provisioning_operation_state::{
    list_active_operation_attempts, list_stale_or_crash_claim_candidates,
    read_active_claim_for_operation, read_operation_attempt,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryDecisionInput {
    pub user_confirmed: bool,
    pub confirmed: RecoveryInspectionSnapshot,
    pub fresh: RecoveryInspectionSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthoritativeRecoveryState {
    pub operation_id: String,
    pub operation_revision: i64,
    pub claim_id: Option<String>,
    pub claim_revision: Option<i64>,
    pub claim_holder: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub scope_kind: String,
    pub recovery_candidate: bool,
    pub other_active_authority: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RecoveryDecisionKind {
    RecoveryReady,
    PreconditionChanged,
    Blocked,
    Busy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryDecisionResult {
    pub kind: RecoveryDecisionKind,
    pub operation_id: Option<String>,
    pub safe_error_code: Option<RuntimeSafeErrorCode>,
}

pub(crate) struct RecoveryDecisionGuard {
    slots: Arc<SlotCoordinator>,
    lease: Option<SlotLease>,
    generation: u64,
}

pub(crate) fn read_authoritative_recovery_state(
    connection: &Connection,
    operation_id: &str,
    current_app_instance_token: &str,
    observed_at: &str,
) -> Result<AuthoritativeRecoveryState, RuntimeSafeErrorCode> {
    let attempt = read_operation_attempt(connection, operation_id)
        .map_err(|_| RuntimeSafeErrorCode::RecoveryDecisionBlocked)?
        .ok_or(RuntimeSafeErrorCode::RecoveryDecisionBlocked)?;
    let claim = read_active_claim_for_operation(connection, operation_id)
        .map_err(|_| RuntimeSafeErrorCode::RecoveryDecisionBlocked)?;
    let stale_or_crash =
        list_stale_or_crash_claim_candidates(connection, current_app_instance_token, observed_at)
            .map_err(|_| RuntimeSafeErrorCode::RecoveryDecisionBlocked)?
            .into_iter()
            .any(|candidate| candidate.attempt.operation_id == operation_id);
    let other_active_authority = list_active_operation_attempts(connection)
        .map_err(|_| RuntimeSafeErrorCode::RecoveryDecisionBlocked)?
        .into_iter()
        .any(|other| {
            other.operation_id != operation_id
                && other.owner_type == attempt.owner_type
                && other.owner_id == attempt.owner_id
                && other.scope_kind == attempt.scope_kind
                && other.manuscript_channel == attempt.manuscript_channel
        });
    let claim_holder = match claim.as_ref() {
        None => "none",
        Some(claim) if claim.claim_owner_token == current_app_instance_token => "current-instance",
        Some(_) => "other-instance",
    };
    Ok(AuthoritativeRecoveryState {
        operation_id: attempt.operation_id,
        operation_revision: attempt.revision,
        claim_id: claim.as_ref().map(|claim| claim.claim_id.clone()),
        claim_revision: claim.as_ref().map(|claim| claim.claim_revision),
        claim_holder: claim_holder.to_string(),
        owner_type: attempt.owner_type,
        owner_id: attempt.owner_id,
        manuscript_channel: attempt
            .manuscript_channel
            .unwrap_or_else(|| "aggregate".to_string()),
        scope_kind: attempt.scope_kind,
        recovery_candidate: attempt.operation_status == "terminal-recovery-required"
            || stale_or_crash,
        other_active_authority,
    })
}

impl RecoveryDecisionGuard {
    pub(super) fn new(slots: Arc<SlotCoordinator>, lease: SlotLease, generation: u64) -> Self {
        Self {
            slots,
            lease: Some(lease),
            generation,
        }
    }
}

impl Drop for RecoveryDecisionGuard {
    fn drop(&mut self) {
        if let Some(lease) = &self.lease {
            self.slots.release(lease, self.generation);
        }
    }
}

pub(super) fn compare_recovery_decision(
    input: &RecoveryDecisionInput,
    authority: &AuthoritativeRecoveryState,
) -> RecoveryDecisionResult {
    if !input.user_confirmed
        || input.confirmed.validate().is_err()
        || input.fresh.validate().is_err()
    {
        return blocked(RuntimeSafeErrorCode::RecoverySnapshotInvalid);
    }
    if input.confirmed.snapshot_hash != input.fresh.snapshot_hash {
        return changed();
    }
    let fresh = &input.fresh;
    if authority.owner_type != fresh.owner_type
        || authority.owner_id != fresh.owner_id
        || authority.manuscript_channel != fresh.manuscript_channel
        || authority.scope_kind != fresh.scope_kind
    {
        return blocked(RuntimeSafeErrorCode::RecoveryDecisionBlocked);
    }
    if !fresh.all_resources_ready()
        || !authority.recovery_candidate
        || authority.other_active_authority
    {
        return blocked(RuntimeSafeErrorCode::RecoveryDecisionBlocked);
    }
    if authority.operation_id != fresh.observed_operation_id
        || authority.operation_revision != fresh.observed_operation_revision
        || authority.claim_id != fresh.observed_claim_id
        || authority.claim_revision != fresh.observed_claim_revision
        || authority.claim_holder != fresh.observed_claim_holder
    {
        return changed();
    }
    RecoveryDecisionResult {
        kind: RecoveryDecisionKind::RecoveryReady,
        operation_id: Some(authority.operation_id.clone()),
        safe_error_code: None,
    }
}

pub(super) fn blocked(code: RuntimeSafeErrorCode) -> RecoveryDecisionResult {
    RecoveryDecisionResult {
        kind: RecoveryDecisionKind::Blocked,
        operation_id: None,
        safe_error_code: Some(code),
    }
}

pub(super) fn busy() -> RecoveryDecisionResult {
    RecoveryDecisionResult {
        kind: RecoveryDecisionKind::Busy,
        operation_id: None,
        safe_error_code: Some(RuntimeSafeErrorCode::RecoveryDecisionBusy),
    }
}

fn changed() -> RecoveryDecisionResult {
    RecoveryDecisionResult {
        kind: RecoveryDecisionKind::PreconditionChanged,
        operation_id: None,
        safe_error_code: Some(RuntimeSafeErrorCode::RecoveryPreconditionChanged),
    }
}
