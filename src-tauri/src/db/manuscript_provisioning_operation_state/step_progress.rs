#![allow(dead_code)]

use chrono::DateTime;
use rusqlite::{types::Type, Row};
use std::io;
use std::str::FromStr;

pub(crate) use crate::manuscript_provisioning_contract::{
    DurableManuscriptChannel, DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind,
    DurableStepBoundary, DurableStepEffectOutcome, DurableStepKind, DurableStepReadbackOutcome,
    DurableStepScope, PlanTemplateKind, ProvisioningNextAction, ProvisioningResultClassification,
    DURABLE_STEP_ROW_DECODE_INVALID, PROVISIONING_OWNER_ID_MAX_BYTES,
};

pub(crate) const DURABLE_STEP_HASH_INVALID: &str = "hash-vocabulary-invalid";
pub(crate) const DURABLE_STEP_TIMESTAMP_INVALID: &str = "timestamp-invalid";
pub(crate) const DURABLE_STEP_FACTS_INVALID: &str = "step-progress-facts-invalid";

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(crate) enum $name {
            $($variant),+
        }

        impl $name {
            pub(crate) const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }

        impl FromStr for $name {
            type Err = &'static str;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(DURABLE_STEP_ROW_DECODE_INVALID),
                }
            }
        }
    };
}

string_enum!(PlanFingerprintProfile {
    RestrictedJcsSha256V1 => "restricted-jcs-sha256-v1",
});

string_enum!(LiteratureChildSummaryStatus {
    Assigned => "assigned",
    TerminalCompleted => "terminal-completed",
    TerminalUnresolved => "terminal-unresolved",
});

string_enum!(LiteratureCurrentOperationScopeKind {
    LiteratureAggregate => "literature-aggregate",
    LiteratureChild => "literature-child",
});

string_enum!(LiteratureDefaultReadiness {
    Ready => "ready",
    NotReady => "not-ready",
    NotVerified => "not-verified",
});

string_enum!(LiteratureFinalVerificationOutcome {
    NotRun => "not-run",
    Passed => "passed",
    NotPassed => "not-passed",
    NotVerified => "not-verified",
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableStepPlanRow {
    pub plan_id: String,
    pub operation_id: String,
    pub plan_version: i64,
    pub plan_template_kind: PlanTemplateKind,
    pub plan_identity_fingerprint: String,
    pub precondition_snapshot_hash: String,
    pub fingerprint_profile: PlanFingerprintProfile,
    pub owner_type: DurablePlanOwnerType,
    pub owner_id: String,
    pub scope_kind: DurablePlanScopeKind,
    pub manuscript_channel: Option<DurableManuscriptChannel>,
    pub intent: DurablePlanIntent,
    pub canonical_resource_identity_hash: String,
    pub canonical_placement_identity_hash: String,
    pub parent_shared_identity_hash: Option<String>,
    pub step_count: i64,
    pub planner_version: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableStepProgressRow {
    pub step_id: String,
    pub plan_id: String,
    pub operation_id: String,
    pub step_ordinal: i64,
    pub step_kind: DurableStepKind,
    pub step_scope: DurableStepScope,
    pub step_version: i64,
    pub is_required: bool,
    pub boundary: DurableStepBoundary,
    pub effect_outcome: DurableStepEffectOutcome,
    pub readback_outcome: DurableStepReadbackOutcome,
    pub observed_identity_hash: Option<String>,
    pub resource_record_id: Option<String>,
    pub effect_facts_schema_version: i64,
    pub progress_revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub effect_observed_at: Option<String>,
    pub readback_verified_at: Option<String>,
    pub converged_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiteratureChildProgressProjection {
    pub aggregate_operation_id: String,
    pub owner_type: DurablePlanOwnerType,
    pub owner_id: String,
    pub manuscript_channel: DurableManuscriptChannel,
    pub current_operation_id: String,
    pub current_operation_scope_kind: LiteratureCurrentOperationScopeKind,
    pub revision: i64,
    pub child_summary_status: LiteratureChildSummaryStatus,
    pub result_classification: Option<ProvisioningResultClassification>,
    pub next_action: Option<ProvisioningNextAction>,
    pub default_readiness: LiteratureDefaultReadiness,
    pub final_verification_outcome: LiteratureFinalVerificationOutcome,
    pub original_cause_code: Option<String>,
    pub updated_at: String,
}

fn conversion_error(index: usize, code: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(io::Error::new(io::ErrorKind::InvalidData, code)),
    )
}

pub(crate) fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

pub(crate) fn is_utc_timestamp(value: &str) -> bool {
    (20..=40).contains(&value.len())
        && value.ends_with('Z')
        && DateTime::parse_from_rfc3339(value).is_ok()
}

fn require_hash(value: &str, index: usize) -> rusqlite::Result<()> {
    if is_lowercase_sha256(value) {
        Ok(())
    } else {
        Err(conversion_error(index, DURABLE_STEP_HASH_INVALID))
    }
}

fn require_optional_hash(value: Option<&str>, index: usize) -> rusqlite::Result<()> {
    match value {
        Some(value) => require_hash(value, index),
        None => Ok(()),
    }
}

fn require_timestamp(value: &str, index: usize) -> rusqlite::Result<()> {
    if is_utc_timestamp(value) {
        Ok(())
    } else {
        Err(conversion_error(index, DURABLE_STEP_TIMESTAMP_INVALID))
    }
}

fn require_optional_timestamp(value: Option<&str>, index: usize) -> rusqlite::Result<()> {
    match value {
        Some(value) => require_timestamp(value, index),
        None => Ok(()),
    }
}

fn parse_enum<T: FromStr<Err = &'static str>>(value: &str, index: usize) -> rusqlite::Result<T> {
    value.parse().map_err(|code| conversion_error(index, code))
}

fn parse_optional_enum<T: FromStr<Err = &'static str>>(
    value: Option<&str>,
    index: usize,
) -> rusqlite::Result<Option<T>> {
    value.map(|value| parse_enum(value, index)).transpose()
}

fn bounded_nonempty(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum
}

pub(crate) fn durable_step_plan_from_row(row: &Row<'_>) -> rusqlite::Result<DurableStepPlanRow> {
    let plan_id: String = row.get(0)?;
    let plan_version: i64 = row.get(2)?;
    let template: String = row.get(3)?;
    let fingerprint: String = row.get(4)?;
    let precondition: String = row.get(5)?;
    let profile: String = row.get(6)?;
    let resource_hash: String = row.get(12)?;
    let placement_hash: String = row.get(13)?;
    let parent_hash: Option<String> = row.get(14)?;
    let owner_type: String = row.get(7)?;
    let owner_id: String = row.get(8)?;
    let scope_kind: String = row.get(9)?;
    let manuscript_channel: Option<String> = row.get(10)?;
    let intent: String = row.get(11)?;
    let step_count: i64 = row.get(15)?;
    let planner_version: String = row.get(16)?;
    let created_at: String = row.get(17)?;
    require_hash(&plan_id, 0)?;
    require_hash(&fingerprint, 4)?;
    require_hash(&precondition, 5)?;
    require_hash(&resource_hash, 12)?;
    require_hash(&placement_hash, 13)?;
    require_optional_hash(parent_hash.as_deref(), 14)?;
    require_timestamp(&created_at, 17)?;
    if plan_version != 1
        || !(0..=32).contains(&step_count)
        || !bounded_nonempty(&owner_id, PROVISIONING_OWNER_ID_MAX_BYTES)
        || !bounded_nonempty(&planner_version, 64)
    {
        return Err(conversion_error(2, DURABLE_STEP_FACTS_INVALID));
    }
    let owner_type = parse_enum(&owner_type, 7)?;
    let scope_kind = parse_enum(&scope_kind, 9)?;
    let manuscript_channel = parse_optional_enum(manuscript_channel.as_deref(), 10)?;
    let intent = parse_enum(&intent, 11)?;
    let identity_is_valid = match (scope_kind, owner_type, manuscript_channel) {
        (
            DurablePlanScopeKind::Channel,
            DurablePlanOwnerType::Literature,
            Some(
                DurableManuscriptChannel::LiteratureOutline
                | DurableManuscriptChannel::DedicatedNotes,
            ),
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
        )
        | (DurablePlanScopeKind::LiteratureAggregate, DurablePlanOwnerType::Literature, None)
        | (
            DurablePlanScopeKind::LiteratureChild,
            DurablePlanOwnerType::Literature,
            Some(
                DurableManuscriptChannel::LiteratureOutline
                | DurableManuscriptChannel::DedicatedNotes,
            ),
        ) => true,
        _ => false,
    };
    if !identity_is_valid || (step_count == 0 && intent != DurablePlanIntent::Recover) {
        return Err(conversion_error(9, DURABLE_STEP_FACTS_INVALID));
    }
    Ok(DurableStepPlanRow {
        plan_id,
        operation_id: row.get(1)?,
        plan_version,
        plan_template_kind: parse_enum(&template, 3)?,
        plan_identity_fingerprint: fingerprint,
        precondition_snapshot_hash: precondition,
        fingerprint_profile: parse_enum(&profile, 6)?,
        owner_type,
        owner_id,
        scope_kind,
        manuscript_channel,
        intent,
        canonical_resource_identity_hash: resource_hash,
        canonical_placement_identity_hash: placement_hash,
        parent_shared_identity_hash: parent_hash,
        step_count,
        planner_version,
        created_at,
    })
}

pub(crate) fn durable_step_progress_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<DurableStepProgressRow> {
    let step_id: String = row.get(0)?;
    let step_ordinal: i64 = row.get(3)?;
    let kind: String = row.get(4)?;
    let scope: String = row.get(5)?;
    let step_version: i64 = row.get(6)?;
    let required: i64 = row.get(7)?;
    let boundary_text: String = row.get(8)?;
    let effect_text: String = row.get(9)?;
    let readback_text: String = row.get(10)?;
    let observed_hash: Option<String> = row.get(11)?;
    let resource_record_id: Option<String> = row.get(12)?;
    let effect_facts_schema_version: i64 = row.get(13)?;
    let progress_revision: i64 = row.get(14)?;
    let created_at: String = row.get(15)?;
    let updated_at: String = row.get(16)?;
    let started_at: Option<String> = row.get(17)?;
    let observed_at: Option<String> = row.get(18)?;
    let verified_at: Option<String> = row.get(19)?;
    let converged_at: Option<String> = row.get(20)?;
    require_hash(&step_id, 0)?;
    require_optional_hash(observed_hash.as_deref(), 11)?;
    require_timestamp(&created_at, 15)?;
    require_timestamp(&updated_at, 16)?;
    require_optional_timestamp(started_at.as_deref(), 17)?;
    require_optional_timestamp(observed_at.as_deref(), 18)?;
    require_optional_timestamp(verified_at.as_deref(), 19)?;
    require_optional_timestamp(converged_at.as_deref(), 20)?;
    if required != 1
        || !(0..=31).contains(&step_ordinal)
        || step_version != 1
        || effect_facts_schema_version != 1
        || progress_revision < 0
        || resource_record_id
            .as_deref()
            .is_some_and(|value| !bounded_nonempty(value, 128))
    {
        return Err(conversion_error(7, DURABLE_STEP_FACTS_INVALID));
    }
    let boundary = parse_enum(&boundary_text, 8)?;
    let effect_outcome = parse_enum(&effect_text, 9)?;
    let readback_outcome = parse_enum(&readback_text, 10)?;
    if !boundary_facts_are_valid(
        boundary,
        effect_outcome,
        readback_outcome,
        observed_hash.is_some(),
        started_at.is_some(),
        observed_at.is_some(),
        verified_at.is_some(),
        converged_at.is_some(),
    ) {
        return Err(conversion_error(8, DURABLE_STEP_FACTS_INVALID));
    }
    Ok(DurableStepProgressRow {
        step_id,
        plan_id: row.get(1)?,
        operation_id: row.get(2)?,
        step_ordinal,
        step_kind: parse_enum(&kind, 4)?,
        step_scope: parse_enum(&scope, 5)?,
        step_version,
        is_required: true,
        boundary,
        effect_outcome,
        readback_outcome,
        observed_identity_hash: observed_hash,
        resource_record_id,
        effect_facts_schema_version,
        progress_revision,
        created_at,
        updated_at,
        started_at,
        effect_observed_at: observed_at,
        readback_verified_at: verified_at,
        converged_at,
    })
}

#[allow(clippy::too_many_arguments)]
fn boundary_facts_are_valid(
    boundary: DurableStepBoundary,
    effect: DurableStepEffectOutcome,
    readback: DurableStepReadbackOutcome,
    has_identity: bool,
    started: bool,
    observed: bool,
    verified: bool,
    converged: bool,
) -> bool {
    use DurableStepBoundary as Boundary;
    use DurableStepEffectOutcome as Effect;
    use DurableStepReadbackOutcome as Readback;
    match boundary {
        Boundary::Intended => {
            effect == Effect::Unobserved
                && readback == Readback::NotRun
                && !has_identity
                && !started
                && !observed
                && !verified
                && !converged
        }
        Boundary::Started => {
            started
                && !observed
                && !verified
                && !converged
                && ((effect == Effect::Unobserved
                    && matches!(
                        readback,
                        Readback::NotRun
                            | Readback::WrongType
                            | Readback::IdentityMismatch
                            | Readback::ContainmentFailed
                            | Readback::Conflict
                            | Readback::Unavailable
                    ))
                    || (effect == Effect::NoEffectProven && readback == Readback::VerifiedAbsent))
        }
        Boundary::EffectObserved => {
            matches!(
                effect,
                Effect::Created | Effect::Reused | Effect::Updated | Effect::Preserved
            ) && readback == Readback::EffectObserved
                && has_identity
                && started
                && observed
                && !verified
                && !converged
        }
        Boundary::ReadbackVerified => {
            matches!(
                effect,
                Effect::Created | Effect::Reused | Effect::Updated | Effect::Preserved
            ) && readback == Readback::Verified
                && has_identity
                && started
                && observed
                && verified
                && !converged
        }
        Boundary::Converged => {
            matches!(
                effect,
                Effect::Created | Effect::Reused | Effect::Updated | Effect::Preserved
            ) && readback == Readback::Verified
                && has_identity
                && started
                && observed
                && verified
                && converged
        }
    }
}

pub(crate) fn durable_step_is_fully_converged(step: &DurableStepProgressRow) -> bool {
    step.is_required
        && step.boundary == DurableStepBoundary::Converged
        && boundary_facts_are_valid(
            step.boundary,
            step.effect_outcome,
            step.readback_outcome,
            step.observed_identity_hash.is_some(),
            step.started_at.is_some(),
            step.effect_observed_at.is_some(),
            step.readback_verified_at.is_some(),
            step.converged_at.is_some(),
        )
}

pub(crate) fn literature_child_projection_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<LiteratureChildProgressProjection> {
    let owner_type: String = row.get(1)?;
    let owner_id: String = row.get(2)?;
    let manuscript_channel: String = row.get(3)?;
    let current_scope: String = row.get(5)?;
    let revision: i64 = row.get(6)?;
    let summary: String = row.get(7)?;
    let classification: Option<String> = row.get(8)?;
    let next_action: Option<String> = row.get(9)?;
    let readiness: String = row.get(10)?;
    let verification: String = row.get(11)?;
    let original_cause_code: Option<String> = row.get(12)?;
    let updated_at: String = row.get(13)?;
    require_timestamp(&updated_at, 13)?;
    let owner_type = parse_enum(&owner_type, 1)?;
    let manuscript_channel = parse_enum(&manuscript_channel, 3)?;
    let current_operation_scope_kind = parse_enum(&current_scope, 5)?;
    let child_summary_status = parse_enum(&summary, 7)?;
    let result_classification = parse_optional_enum(classification.as_deref(), 8)?;
    let next_action = parse_optional_enum(next_action.as_deref(), 9)?;
    let default_readiness = parse_enum(&readiness, 10)?;
    let final_verification_outcome = parse_enum(&verification, 11)?;
    if owner_type != DurablePlanOwnerType::Literature
        || !matches!(
            manuscript_channel,
            DurableManuscriptChannel::LiteratureOutline | DurableManuscriptChannel::DedicatedNotes
        )
        || revision < 0
        || !bounded_nonempty(&owner_id, PROVISIONING_OWNER_ID_MAX_BYTES)
        || original_cause_code
            .as_deref()
            .is_some_and(|value| !bounded_nonempty(value, 128))
        || !literature_projection_facts_are_valid(
            child_summary_status,
            result_classification,
            next_action,
            default_readiness,
            final_verification_outcome,
        )
    {
        return Err(conversion_error(7, DURABLE_STEP_FACTS_INVALID));
    }
    Ok(LiteratureChildProgressProjection {
        aggregate_operation_id: row.get(0)?,
        owner_type,
        owner_id,
        manuscript_channel,
        current_operation_id: row.get(4)?,
        current_operation_scope_kind,
        revision,
        child_summary_status,
        result_classification,
        next_action,
        default_readiness,
        final_verification_outcome,
        original_cause_code,
        updated_at,
    })
}

fn literature_projection_facts_are_valid(
    summary: LiteratureChildSummaryStatus,
    classification: Option<ProvisioningResultClassification>,
    next_action: Option<ProvisioningNextAction>,
    readiness: LiteratureDefaultReadiness,
    verification: LiteratureFinalVerificationOutcome,
) -> bool {
    match summary {
        LiteratureChildSummaryStatus::Assigned => classification.is_none() && next_action.is_none(),
        LiteratureChildSummaryStatus::TerminalCompleted => {
            classification == Some(ProvisioningResultClassification::Completed)
                && next_action == Some(ProvisioningNextAction::None)
                && readiness == LiteratureDefaultReadiness::Ready
                && verification == LiteratureFinalVerificationOutcome::Passed
        }
        LiteratureChildSummaryStatus::TerminalUnresolved => matches!(
            (classification, next_action),
            (
                Some(ProvisioningResultClassification::Retryable),
                Some(ProvisioningNextAction::Retry)
            ) | (
                Some(ProvisioningResultClassification::RepairRequired),
                Some(ProvisioningNextAction::Repair)
            ) | (
                Some(ProvisioningResultClassification::ProvisioningRecoveryRequired),
                Some(ProvisioningNextAction::Recover)
            ) | (
                Some(ProvisioningResultClassification::LifecycleDecisionRequired),
                Some(ProvisioningNextAction::LifecycleDecision)
            ) | (
                Some(ProvisioningResultClassification::Blocked),
                Some(ProvisioningNextAction::Stop)
            )
        ),
    }
}
