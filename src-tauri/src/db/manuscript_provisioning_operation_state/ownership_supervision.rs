use super::step_progress::{
    DurableStepPlanRow, DurableStepProgressRow, LiteratureChildProgressProjection,
};
use super::{
    claim_from_row, database_error, outbox_from_row, read_active_claim_for_operation,
    read_attempt_plan, read_attempt_step_progress, read_literature_child_projections,
    read_operation_attempt, ProvisioningActiveClaim, ProvisioningAuditOutbox,
    ProvisioningOperationAttempt, RepositoryResult, CLAIM_SELECT,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt::Write;

/// A fresh, repository-owned read-only observation. It is deliberately not a
/// Runtime Handle, proof, Permit, or takeover authority.
#[derive(Debug)]
pub(crate) struct DurableClaimObservation {
    pub(crate) operation_id: String,
    pub(crate) claim: Option<ProvisioningActiveClaim>,
    pub(crate) attempt: Option<ProvisioningOperationAttempt>,
    pub(crate) plan: Option<DurableStepPlanRow>,
    pub(crate) steps: Vec<DurableStepProgressRow>,
    pub(crate) projections: Vec<LiteratureChildProgressProjection>,
    pub(crate) outboxes: Vec<ProvisioningAuditOutbox>,
}

impl DurableClaimObservation {
    pub(crate) fn claim_id(&self) -> Option<&str> {
        self.claim.as_ref().map(|claim| claim.claim_id.as_str())
    }

    pub(crate) fn is_identity_consistent(&self) -> bool {
        let (Some(claim), Some(attempt), Some(plan)) = (&self.claim, &self.attempt, &self.plan)
        else {
            return false;
        };
        claim.operation_id == self.operation_id
            && attempt.operation_id == self.operation_id
            && plan.operation_id == self.operation_id
            && claim.scope_kind == attempt.scope_kind
            && claim.owner_type == attempt.owner_type
            && claim.owner_id == attempt.owner_id
            && claim.manuscript_channel == attempt.manuscript_channel
            && plan.owner_type.as_str() == attempt.owner_type
            && plan.owner_id == attempt.owner_id
            && plan.scope_kind.as_str() == attempt.scope_kind
            && plan.manuscript_channel.map(|value| value.as_str())
                == attempt.manuscript_channel.as_deref()
            && self.steps.len() as i64 == plan.step_count
            && self.steps.iter().enumerate().all(|(index, step)| {
                step.operation_id == self.operation_id
                    && step.plan_id == plan.plan_id
                    && step.step_ordinal == index as i64
            })
            && self.projection_is_consistent(attempt)
    }

    pub(crate) fn is_terminal_identity_consistent(&self) -> bool {
        let (Some(attempt), Some(plan)) = (&self.attempt, &self.plan) else {
            return false;
        };
        attempt.operation_id == self.operation_id
            && plan.operation_id == self.operation_id
            && plan.owner_type.as_str() == attempt.owner_type
            && plan.owner_id == attempt.owner_id
            && plan.scope_kind.as_str() == attempt.scope_kind
            && plan.manuscript_channel.map(|value| value.as_str())
                == attempt.manuscript_channel.as_deref()
            && self.steps.len() as i64 == plan.step_count
            && self.steps.iter().enumerate().all(|(index, step)| {
                step.operation_id == self.operation_id
                    && step.plan_id == plan.plan_id
                    && step.step_ordinal == index as i64
            })
            && self.projection_is_consistent(attempt)
    }

    fn projection_is_consistent(&self, attempt: &ProvisioningOperationAttempt) -> bool {
        if attempt.owner_type == "literature" && attempt.scope_kind == "literature-aggregate" {
            self.projections.len() == 2
                && self.projections.iter().all(|projection| {
                    projection.aggregate_operation_id == self.operation_id
                        && projection.owner_type.as_str() == attempt.owner_type
                        && projection.owner_id == attempt.owner_id
                })
        } else {
            self.projections.is_empty()
        }
    }

    pub(crate) fn is_original_active_complete(&self) -> bool {
        self.is_identity_consistent()
            && self
                .attempt
                .as_ref()
                .is_some_and(|attempt| attempt.operation_status == "active")
            && self.outboxes.is_empty()
    }

    pub(crate) fn is_recovery_retained_complete(&self) -> bool {
        self.is_identity_consistent()
            && self.attempt.as_ref().is_some_and(|attempt| {
                attempt.operation_status == "terminal-recovery-required"
                    && attempt.phase == "failed"
                    && attempt.next_action.as_deref() == Some("recover")
                    && attempt.terminal_at.is_some()
            })
            && self.outboxes.len() == 1
    }

    pub(crate) fn is_safe_terminal_complete(&self) -> bool {
        self.claim.is_none()
            && self.is_terminal_identity_consistent()
            && self.attempt.as_ref().is_some_and(|attempt| {
                attempt.operation_status.starts_with("terminal-")
                    && attempt.operation_status != "terminal-recovery-required"
                    && attempt.terminal_at.is_some()
            })
            && self.outboxes.len() == 1
    }

    pub(crate) fn create_abandonment_fingerprint(
        &self,
    ) -> Option<AbandonmentObservationFingerprint> {
        if !self.is_identity_consistent() {
            return None;
        }
        let claim = self.claim.as_ref()?;
        let attempt = self.attempt.as_ref()?;
        let plan = self.plan.as_ref()?;
        let mut canonical = String::new();
        push(&mut canonical, "claim_id", Some(&claim.claim_id));
        push(&mut canonical, "operation_id", Some(&claim.operation_id));
        push(&mut canonical, "owner_type", Some(&claim.owner_type));
        push(&mut canonical, "owner_id", Some(&claim.owner_id));
        push(&mut canonical, "scope_kind", Some(&claim.scope_kind));
        push(
            &mut canonical,
            "manuscript_channel",
            claim.manuscript_channel.as_deref(),
        );
        push(
            &mut canonical,
            "claim_owner_token",
            Some(&claim.claim_owner_token),
        );
        push_i64(&mut canonical, "claim_revision", claim.claim_revision);
        push(
            &mut canonical,
            "last_heartbeat_at",
            Some(&claim.last_heartbeat_at),
        );
        push(&mut canonical, "attempt_phase", Some(&attempt.phase));
        push(
            &mut canonical,
            "attempt_status",
            Some(&attempt.operation_status),
        );
        push(
            &mut canonical,
            "attempt_next_action",
            attempt.next_action.as_deref(),
        );
        push_i64(&mut canonical, "attempt_revision", attempt.revision);
        push(&mut canonical, "plan_id", Some(&plan.plan_id));
        push(
            &mut canonical,
            "plan_identity_fingerprint",
            Some(&plan.plan_identity_fingerprint),
        );
        push(
            &mut canonical,
            "precondition_snapshot_hash",
            Some(&plan.precondition_snapshot_hash),
        );
        push_i64(&mut canonical, "step_count", self.steps.len() as i64);
        for step in &self.steps {
            push(&mut canonical, "step_id", Some(&step.step_id));
            push_i64(&mut canonical, "step_ordinal", step.step_ordinal);
            push(&mut canonical, "step_kind", Some(step.step_kind.as_str()));
            push(
                &mut canonical,
                "step_boundary",
                Some(step.boundary.as_str()),
            );
            push(
                &mut canonical,
                "step_effect",
                Some(step.effect_outcome.as_str()),
            );
            push(
                &mut canonical,
                "step_readback",
                Some(step.readback_outcome.as_str()),
            );
            push_i64(
                &mut canonical,
                "step_progress_revision",
                step.progress_revision,
            );
            push(
                &mut canonical,
                "step_required",
                Some(if step.is_required { "1" } else { "0" }),
            );
        }
        push_i64(
            &mut canonical,
            "projection_count",
            self.projections.len() as i64,
        );
        for projection in &self.projections {
            push(
                &mut canonical,
                "projection_channel",
                Some(projection.manuscript_channel.as_str()),
            );
            push(
                &mut canonical,
                "projection_operation",
                Some(&projection.current_operation_id),
            );
            push(
                &mut canonical,
                "projection_status",
                Some(projection.child_summary_status.as_str()),
            );
            push_i64(&mut canonical, "projection_revision", projection.revision);
        }
        push_i64(&mut canonical, "outbox_count", self.outboxes.len() as i64);
        for outbox in &self.outboxes {
            push(
                &mut canonical,
                "outbox_status",
                Some(&outbox.delivery_status),
            );
            push_i64(&mut canonical, "outbox_revision", outbox.revision);
            push_i64(
                &mut canonical,
                "outbox_delivery_attempt_count",
                outbox.delivery_attempt_count,
            );
        }
        Some(AbandonmentObservationFingerprint {
            sha256: format!("{:x}", Sha256::digest(canonical.as_bytes())),
        })
    }
}

/// Stable hash of the complete authoritative observation. Deliberately
/// non-Clone and non-Serde.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AbandonmentObservationFingerprint {
    sha256: String,
}

impl AbandonmentObservationFingerprint {
    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.sha256 == other.sha256
    }

    pub(crate) fn as_sha256(&self) -> &str {
        &self.sha256
    }

    #[cfg(test)]
    pub(crate) fn sha256_for_test(&self) -> &str {
        &self.sha256
    }
}

/// Durable-only P1-03 evidence consumed by the P1-04 repository context.
/// Process generation and Registry generations deliberately do not belong
/// here.
#[derive(Debug)]
pub(crate) struct RecoveryEligibilityDurableEvidence {
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
    second_repository_utc_observation: i64,
    fingerprint: AbandonmentObservationFingerprint,
}

impl RecoveryEligibilityDurableEvidence {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn seal(
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
        second_repository_utc_observation: i64,
        first_fingerprint: AbandonmentObservationFingerprint,
        second_fingerprint: AbandonmentObservationFingerprint,
    ) -> Option<Self> {
        if !first_fingerprint.matches(&second_fingerprint) {
            return None;
        }
        Some(Self {
            operation_id,
            claim_id,
            owner_type,
            owner_id,
            scope_kind,
            manuscript_channel,
            claim_owner_token,
            claim_revision,
            last_heartbeat_at,
            derived_expiry,
            first_repository_utc_observation,
            second_repository_utc_observation,
            fingerprint: second_fingerprint,
        })
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn claim_id(&self) -> &str {
        &self.claim_id
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

    pub(crate) fn derived_expiry(&self) -> i64 {
        self.derived_expiry
    }

    pub(crate) fn first_repository_utc_observation(&self) -> i64 {
        self.first_repository_utc_observation
    }

    pub(crate) fn second_repository_utc_observation(&self) -> i64 {
        self.second_repository_utc_observation
    }

    pub(crate) fn fingerprint(&self) -> &AbandonmentObservationFingerprint {
        &self.fingerprint
    }
}

fn push(canonical: &mut String, label: &str, value: Option<&str>) {
    let _ = write!(canonical, "{}:{}:", label.len(), label);
    match value {
        Some(value) => {
            let _ = write!(canonical, "{}:{};", value.len(), value);
        }
        None => canonical.push_str("-;"),
    }
}

fn push_i64(canonical: &mut String, label: &str, value: i64) {
    push(canonical, label, Some(&value.to_string()));
}

pub(crate) fn inspect_durable_claim(
    connection: &Connection,
    operation_id: &str,
) -> RepositoryResult<DurableClaimObservation> {
    let claim = read_active_claim_for_operation(connection, operation_id)?;
    let attempt = read_operation_attempt(connection, operation_id)?;
    let plan = read_attempt_plan(connection, operation_id)?;
    let steps = read_attempt_step_progress(connection, operation_id)?;
    let projections = if attempt.as_ref().is_some_and(|attempt| {
        attempt.owner_type == "literature" && attempt.scope_kind == "literature-aggregate"
    }) {
        read_literature_child_projections(connection, operation_id)?
    } else {
        Vec::new()
    };
    let mut statement = connection
        .prepare(
            "SELECT operation_id,delivery_status,revision,delivery_attempt_count,
                    operation_log_id,error_code,created_at,updated_at,delivered_at
             FROM manuscript_provisioning_audit_outbox
             WHERE operation_id=?1 ORDER BY revision, created_at",
        )
        .map_err(|error| database_error("prepare ownership outbox observation", error))?;
    let outboxes = statement
        .query_map([operation_id], outbox_from_row)
        .map_err(|error| database_error("query ownership outbox observation", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("decode ownership outbox observation", error))?;
    Ok(DurableClaimObservation {
        operation_id: operation_id.to_string(),
        claim,
        attempt,
        plan,
        steps,
        projections,
        outboxes,
    })
}

/// The only repository-owned read-only discovery entry for active/recovery
/// Claims that are absent from the process-local Registry snapshot.
pub(crate) fn discover_unrepresented_durable_claims(
    connection: &Connection,
    represented_claim_ids: &HashSet<String>,
) -> RepositoryResult<Vec<DurableClaimObservation>> {
    let mut statement = connection
        .prepare(&format!("{CLAIM_SELECT} ORDER BY claimed_at, claim_id"))
        .map_err(|error| database_error("prepare durable Claim discovery", error))?;
    let claims = statement
        .query_map([], claim_from_row)
        .map_err(|error| database_error("query durable Claim discovery", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("decode durable Claim discovery", error))?;
    let mut observations = Vec::new();
    for claim in claims {
        if represented_claim_ids.contains(&claim.claim_id) {
            continue;
        }
        observations.push(
            inspect_durable_claim(connection, &claim.operation_id).unwrap_or_else(|_| {
                DurableClaimObservation {
                    operation_id: claim.operation_id.clone(),
                    claim: Some(claim),
                    attempt: None,
                    plan: None,
                    steps: Vec::new(),
                    projections: Vec::new(),
                    outboxes: Vec::new(),
                }
            }),
        );
    }
    Ok(observations)
}
