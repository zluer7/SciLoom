//! LP12-4 canonical production bridge for reference owners.
//!
//! This is one command family with a typed owner discriminator.  Owner-specific
//! code is limited to authoritative reads and typed field application; all
//! orchestration is delegated to the F2-1 canonical engine.

use super::formal_switch_execution::{
    binding_digest, canonical_transaction_payload_bytes, derive_finalization_identity,
    derive_pre_activation_finalization, execute_settlement_atomic,
    freeze_confirmation_identity, lifecycle_coverage_digest, owner_protected_row_digest,
    read_binding, revalidate_and_prepare_exact,
    CanonicalFormalSwitchEngineV1, CanonicalRuntimeReacquisitionPortV1,
    CanonicalTransactionResultV1, FinalRevalidationPortV1,
    FinalRevalidationSnapshotV1, FormalSwitchFinalConfirmationEvidenceV1,
    FormalSwitchOwnerApplierV1, MountedRuntimeEvidenceV1, OwnerLifecycleV1,
    OwnerProtectedStateV1, ParentLifecycleV1, ProtectedFieldV1,
    ResolvedOldCurrentFileV1, RuntimeActivationSnapshotV1, SettlementExecutionOutcomeV1,
};
use super::formal_switch_foundation::encoding::{
    sha256, CandidateIdentityV1, FormalSwitchEntryKind, FormalSwitchImmutableEnvelopeV1,
    FormalSwitchManuscriptChannel, FormalSwitchOwnerType, FormalSwitchReviewType,
    ReplacementItemV1, SettlementPlanV1,
};
use super::formal_switch_foundation::state::FormalSwitchOperationState;
use super::formal_switch_foundation::{
    advance_phase_cas, mark_contained_or_blocked_cas, read_old_recovery_drain_snapshot,
    read_unresolved_operation_summaries,
    ExecutableFormalSwitchOperationV1,
};
use crate::markdown_file::{
    apply_explicit_manuscript_byte_range_atomic, read_explicit_physical_snapshot,
    AtomicByteRangeCasInput, AtomicByteRangeCasStatus, ExplicitPhysicalSnapshot,
    MAX_MARKDOWN_FILE_BYTES,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

const EXPERIMENT_KEYS: [&str; 6] = [
    "purposeAndQuestion",
    "conditionSummary",
    "methodSummary",
    "resultSummary",
    "conclusionAndNextSteps",
    "other",
];
const RUN_KEYS: [&str; 6] = [
    "conditionSummary",
    "variableParameterSummary",
    "methodSummary",
    "resultSummary",
    "conclusionNotes",
    "other",
];
const LITERATURE_OUTLINE_KEYS: [&str; 7] = [
    "summary",
    "research_problem",
    "application_object",
    "method_overview",
    "main_conclusion",
    "limitations",
    "other",
];
const LITERATURE_NOTES_KEYS: [&str; 6] = [
    "summary",
    "project_relevance",
    "related_objects",
    "reusable_methods",
    "comparable_conclusions",
    "other",
];
const RESULT_ITEM_KEYS: [&str; 6] = [
    "summary",
    "keyPhenomenon",
    "conditionBrief",
    "initialJudgement",
    "conversionValue",
    "other",
];
const FINDING_KEYS: [&str; 6] = [
    "content",
    "supportingEvidence",
    "noveltyDifference",
    "reliabilityJudgement",
    "boundaryOrMissingEvidence",
    "other",
];
const OUTPUT_CANDIDATE_KEYS: [&str; 6] = [
    "coreClaim",
    "outputType",
    "innovationContribution",
    "evidenceSummary",
    "risksAndGaps",
    "other",
];
const OUTPUT_GAP_KEYS: [&str; 6] = [
    "gapDescription",
    "gapType",
    "affectedObject",
    "strengtheningPlan",
    "completionCriteria",
    "other",
];
const RESEARCH_OUTPUT_KEYS: [&str; 6] = [
    "summary",
    "outputType",
    "coreContribution",
    "sourceChainSummary",
    "archiveUsage",
    "other",
];
const REVIEW_STAGE_KEYS: [&str; 7] = [
    "stage_summary",
    "key_progress",
    "completed_items",
    "major_problems",
    "cause_analysis",
    "next_plan",
    "other",
];
const REVIEW_PERIODIC_KEYS: [&str; 7] = [
    "period_summary",
    "period_completed",
    "period_pending",
    "major_problems",
    "cause_analysis",
    "next_period_plan",
    "other",
];
const REVIEW_EXPERIMENT_COMPARISON_KEYS: [&str; 7] = [
    "comparison_summary",
    "comparison_targets",
    "key_differences",
    "main_conclusions",
    "anomalies_and_problems",
    "next_experiment_plan",
    "other",
];
const REVIEW_LITERATURE_COMPARISON_KEYS: [&str; 7] = [
    "literature_overview",
    "literature_scope",
    "method_differences",
    "consensus_and_divergence",
    "research_gaps_and_references",
    "next_reading_or_research_plan",
    "other",
];
const REVIEW_CUSTOM_KEYS: [&str; 6] = [
    "custom_summary",
    "completed_items",
    "major_problems",
    "cause_analysis",
    "next_plan",
    "other",
];
const LITERATURE_OUTLINE_CUSTOM_KEYS: [&str; 6] = [
    "outlineResearchProblem",
    "outlineApplicationObject",
    "outlineMethodOverview",
    "outlineMainConclusion",
    "outlineLimitations",
    "outlineOther",
];
const LITERATURE_NOTES_CUSTOM_KEYS: [&str; 6] = [
    "knowledgeProjectSummary",
    "knowledgeProjectRelevance",
    "knowledgeRelatedObjectNotes",
    "knowledgeReusableMethods",
    "knowledgeComparableConclusions",
    "knowledgeOther",
];

static CANONICAL_ENGINE: OnceLock<CanonicalFormalSwitchEngineV1> = OnceLock::new();
static TARGET_CLEANUP_PROCESS_STATE: OnceLock<Mutex<TargetCleanupProcessState>> =
    OnceLock::new();
static EXPERIMENT_APPLIER: ExperimentFormalSwitchOwnerApplierV1 =
    ExperimentFormalSwitchOwnerApplierV1;
static RUN_APPLIER: ExperimentRunFormalSwitchOwnerApplierV1 =
    ExperimentRunFormalSwitchOwnerApplierV1;
static LITERATURE_APPLIER: LiteratureFormalSwitchOwnerApplierV1 =
    LiteratureFormalSwitchOwnerApplierV1;
static REVIEW_APPLIER: ReviewFormalSwitchOwnerApplierV1 = ReviewFormalSwitchOwnerApplierV1;
static OUTPUTS_APPLIER: OutputsFormalSwitchOwnerApplierV1 =
    OutputsFormalSwitchOwnerApplierV1;

fn canonical_engine() -> &'static CanonicalFormalSwitchEngineV1 {
    CANONICAL_ENGINE.get_or_init(CanonicalFormalSwitchEngineV1::default)
}

#[derive(Default)]
struct TargetCleanupProcessState {
    fresh_operations: HashSet<String>,
    attempted_operations: HashSet<String>,
}

fn target_cleanup_process_state() -> &'static Mutex<TargetCleanupProcessState> {
    TARGET_CLEANUP_PROCESS_STATE.get_or_init(|| Mutex::new(TargetCleanupProcessState::default()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReferenceOwnerKind {
    Experiment,
    ExperimentRun,
    Literature,
    Review,
    ResultItem,
    Finding,
    OutputCandidate,
    OutputGap,
    ResearchOutput,
}

impl ReferenceOwnerKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "experiment" => Ok(Self::Experiment),
            "experimentRun" => Ok(Self::ExperimentRun),
            "literature" => Ok(Self::Literature),
            "review" => Ok(Self::Review),
            "resultItem" => Ok(Self::ResultItem),
            "finding" => Ok(Self::Finding),
            "outputCandidate" => Ok(Self::OutputCandidate),
            "outputGap" => Ok(Self::OutputGap),
            "researchOutput" => Ok(Self::ResearchOutput),
            _ => Err("FORMAL_SWITCH_REFERENCE_OWNER_NOT_ADMITTED".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Experiment => "experiment",
            Self::ExperimentRun => "experimentRun",
            Self::Literature => "literature",
            Self::Review => "review",
            Self::ResultItem => "resultItem",
            Self::Finding => "finding",
            Self::OutputCandidate => "outputCandidate",
            Self::OutputGap => "outputGap",
            Self::ResearchOutput => "researchOutput",
        }
    }

    fn owner_type(self) -> FormalSwitchOwnerType {
        match self {
            Self::Experiment => FormalSwitchOwnerType::Experiment,
            Self::ExperimentRun => FormalSwitchOwnerType::ExperimentRun,
            Self::Literature => FormalSwitchOwnerType::Literature,
            Self::Review => FormalSwitchOwnerType::Review,
            Self::ResultItem => FormalSwitchOwnerType::ResultItem,
            Self::Finding => FormalSwitchOwnerType::Finding,
            Self::OutputCandidate => FormalSwitchOwnerType::OutputCandidate,
            Self::OutputGap => FormalSwitchOwnerType::OutputGap,
            Self::ResearchOutput => FormalSwitchOwnerType::ResearchOutput,
        }
    }

    fn allows_missing_project(self) -> bool {
        matches!(self, Self::Literature | Self::Review)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReferenceManuscriptChannel {
    Primary,
    LiteratureOutline,
    DedicatedNotes,
}

impl ReferenceManuscriptChannel {
    fn parse(kind: ReferenceOwnerKind, value: &str) -> Result<Self, String> {
        match (kind, value) {
            (
                ReferenceOwnerKind::Experiment
                | ReferenceOwnerKind::ExperimentRun
                | ReferenceOwnerKind::Review
                | ReferenceOwnerKind::ResultItem
                | ReferenceOwnerKind::Finding
                | ReferenceOwnerKind::OutputCandidate
                | ReferenceOwnerKind::OutputGap
                | ReferenceOwnerKind::ResearchOutput,
                "primary",
            ) => {
                Ok(Self::Primary)
            }
            (ReferenceOwnerKind::Literature, "literature_outline") => {
                Ok(Self::LiteratureOutline)
            }
            (ReferenceOwnerKind::Literature, "dedicated_notes") => Ok(Self::DedicatedNotes),
            _ => Err("FORMAL_SWITCH_REFERENCE_OWNER_CHANNEL_NOT_ADMITTED".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::LiteratureOutline => "literature_outline",
            Self::DedicatedNotes => "dedicated_notes",
        }
    }

    fn canonical(self) -> FormalSwitchManuscriptChannel {
        match self {
            Self::Primary => FormalSwitchManuscriptChannel::Primary,
            Self::LiteratureOutline => FormalSwitchManuscriptChannel::LiteratureOutline,
            Self::DedicatedNotes => FormalSwitchManuscriptChannel::DedicatedNotes,
        }
    }
}

impl ReferenceOwnerKind {

    fn descriptor_identity(self, channel: ReferenceManuscriptChannel) -> &'static str {
        match (self, channel) {
            (Self::Experiment, ReferenceManuscriptChannel::Primary) => "labpod.experiment.primary.formal-switch/v1",
            (Self::ExperimentRun, ReferenceManuscriptChannel::Primary) => "labpod.experiment-run.primary.formal-switch/v1",
            (Self::Literature, ReferenceManuscriptChannel::LiteratureOutline) => "labpod.literature.literature-outline.formal-switch/v1",
            (Self::Literature, ReferenceManuscriptChannel::DedicatedNotes) => "labpod.literature.dedicated-notes.formal-switch/v1",
            (Self::ResultItem, ReferenceManuscriptChannel::Primary) => "labpod.result-item.primary.formal-switch/v1",
            (Self::Finding, ReferenceManuscriptChannel::Primary) => "labpod.finding.primary.formal-switch/v1",
            (Self::OutputCandidate, ReferenceManuscriptChannel::Primary) => "labpod.output-candidate.primary.formal-switch/v1",
            (Self::OutputGap, ReferenceManuscriptChannel::Primary) => "labpod.output-gap.primary.formal-switch/v1",
            (Self::ResearchOutput, ReferenceManuscriptChannel::Primary) => "labpod.research-output.primary.formal-switch/v1",
            _ => unreachable!("validated reference owner channel"),
        }
    }

    fn descriptor_bytes(self, channel: ReferenceManuscriptChannel) -> &'static [u8] {
        match (self, channel) {
            (Self::Experiment, ReferenceManuscriptChannel::Primary) => b"experiment|primary|purposeAndQuestion|conditionSummary|methodSummary|resultSummary|conclusionAndNextSteps|other",
            (Self::ExperimentRun, ReferenceManuscriptChannel::Primary) => b"experimentRun|primary|conditionSummary|variableParameterSummary|methodSummary|resultSummary|conclusionNotes|other",
            (Self::Literature, ReferenceManuscriptChannel::LiteratureOutline) => b"literature|literature_outline|summary|research_problem|application_object|method_overview|main_conclusion|limitations|other",
            (Self::Literature, ReferenceManuscriptChannel::DedicatedNotes) => b"literature|dedicated_notes|summary|project_relevance|related_objects|reusable_methods|comparable_conclusions|other",
            (Self::ResultItem, ReferenceManuscriptChannel::Primary) => b"resultItem|primary|summary|keyPhenomenon|conditionBrief|initialJudgement|conversionValue|other",
            (Self::Finding, ReferenceManuscriptChannel::Primary) => b"finding|primary|content|supportingEvidence|noveltyDifference|reliabilityJudgement|boundaryOrMissingEvidence|other",
            (Self::OutputCandidate, ReferenceManuscriptChannel::Primary) => b"outputCandidate|primary|coreClaim|outputType|innovationContribution|evidenceSummary|risksAndGaps|other",
            (Self::OutputGap, ReferenceManuscriptChannel::Primary) => b"outputGap|primary|gapDescription|gapType|affectedObject|strengtheningPlan|completionCriteria|other",
            (Self::ResearchOutput, ReferenceManuscriptChannel::Primary) => b"researchOutput|primary|summary|outputType|coreContribution|sourceChainSummary|archiveUsage|other",
            _ => unreachable!("validated reference owner channel"),
        }
    }

    fn keys(self, channel: ReferenceManuscriptChannel) -> &'static [&'static str] {
        match (self, channel) {
            (Self::Experiment, ReferenceManuscriptChannel::Primary) => &EXPERIMENT_KEYS,
            (Self::ExperimentRun, ReferenceManuscriptChannel::Primary) => &RUN_KEYS,
            (Self::Literature, ReferenceManuscriptChannel::LiteratureOutline) => &LITERATURE_OUTLINE_KEYS,
            (Self::Literature, ReferenceManuscriptChannel::DedicatedNotes) => &LITERATURE_NOTES_KEYS,
            (Self::ResultItem, ReferenceManuscriptChannel::Primary) => &RESULT_ITEM_KEYS,
            (Self::Finding, ReferenceManuscriptChannel::Primary) => &FINDING_KEYS,
            (Self::OutputCandidate, ReferenceManuscriptChannel::Primary) => &OUTPUT_CANDIDATE_KEYS,
            (Self::OutputGap, ReferenceManuscriptChannel::Primary) => &OUTPUT_GAP_KEYS,
            (Self::ResearchOutput, ReferenceManuscriptChannel::Primary) => &RESEARCH_OUTPUT_KEYS,
            _ => unreachable!("validated reference owner channel"),
        }
    }
}

fn parse_review_subtype(value: &str) -> Result<FormalSwitchReviewType, String> {
    match value {
        "stage" => Ok(FormalSwitchReviewType::Stage),
        "periodic" => Ok(FormalSwitchReviewType::Periodic),
        "experiment_comparison" => Ok(FormalSwitchReviewType::ExperimentComparison),
        "literature_comparison" => Ok(FormalSwitchReviewType::LiteratureComparison),
        "custom" => Ok(FormalSwitchReviewType::Custom),
        _ => Err("FORMAL_SWITCH_REVIEW_SUBTYPE_INVALID".into()),
    }
}

fn review_keys(subtype: FormalSwitchReviewType) -> &'static [&'static str] {
    match subtype {
        FormalSwitchReviewType::Stage => &REVIEW_STAGE_KEYS,
        FormalSwitchReviewType::Periodic => &REVIEW_PERIODIC_KEYS,
        FormalSwitchReviewType::ExperimentComparison => &REVIEW_EXPERIMENT_COMPARISON_KEYS,
        FormalSwitchReviewType::LiteratureComparison => &REVIEW_LITERATURE_COMPARISON_KEYS,
        FormalSwitchReviewType::Custom => &REVIEW_CUSTOM_KEYS,
    }
}

fn canonical_owner_subtype(
    kind: ReferenceOwnerKind,
    value: Option<&str>,
) -> Result<Option<FormalSwitchReviewType>, String> {
    match (kind, value) {
        (ReferenceOwnerKind::Review, Some(value)) => parse_review_subtype(value).map(Some),
        (ReferenceOwnerKind::Review, None) => Err("FORMAL_SWITCH_REVIEW_SUBTYPE_REQUIRED".into()),
        (_, Some(_)) => Err("FORMAL_SWITCH_REFERENCE_OWNER_SUBTYPE_FORBIDDEN".into()),
        (_, None) => Ok(None),
    }
}

fn canonical_keys(
    kind: ReferenceOwnerKind,
    channel: ReferenceManuscriptChannel,
    subtype: Option<FormalSwitchReviewType>,
) -> Result<&'static [&'static str], String> {
    if kind == ReferenceOwnerKind::Review {
        if channel != ReferenceManuscriptChannel::Primary {
            return Err("FORMAL_SWITCH_REFERENCE_OWNER_CHANNEL_NOT_ADMITTED".into());
        }
        return subtype
            .map(review_keys)
            .ok_or_else(|| "FORMAL_SWITCH_REVIEW_SUBTYPE_REQUIRED".into());
    }
    if subtype.is_some() {
        return Err("FORMAL_SWITCH_REFERENCE_OWNER_SUBTYPE_FORBIDDEN".into());
    }
    Ok(kind.keys(channel))
}

fn canonical_descriptor(
    kind: ReferenceOwnerKind,
    channel: ReferenceManuscriptChannel,
    subtype: Option<FormalSwitchReviewType>,
) -> Result<(String, Vec<u8>), String> {
    if kind == ReferenceOwnerKind::Review {
        let subtype = subtype.ok_or_else(|| "FORMAL_SWITCH_REVIEW_SUBTYPE_REQUIRED".to_string())?;
        let keys = review_keys(subtype);
        let identity = format!("review/primary/{}/v1", subtype.as_str());
        let bytes = format!("review|primary|{}|{}", subtype.as_str(), keys.join("|"))
            .into_bytes();
        return Ok((identity, bytes));
    }
    if subtype.is_some() {
        return Err("FORMAL_SWITCH_REFERENCE_OWNER_SUBTYPE_FORBIDDEN".into());
    }
    Ok((
        kind.descriptor_identity(channel).into(),
        kind.descriptor_bytes(channel).to_vec(),
    ))
}

fn applier(kind: ReferenceOwnerKind) -> &'static dyn FormalSwitchOwnerApplierV1 {
    match kind {
        ReferenceOwnerKind::Experiment => &EXPERIMENT_APPLIER,
        ReferenceOwnerKind::ExperimentRun => &RUN_APPLIER,
        ReferenceOwnerKind::Literature => &LITERATURE_APPLIER,
        ReferenceOwnerKind::Review => &REVIEW_APPLIER,
        ReferenceOwnerKind::ResultItem
        | ReferenceOwnerKind::Finding
        | ReferenceOwnerKind::OutputCandidate
        | ReferenceOwnerKind::OutputGap
        | ReferenceOwnerKind::ResearchOutput => &OUTPUTS_APPLIER,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerReplacementInput {
    stable_key: String,
    value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerRuntimeEvidenceInput {
    actual_runtime_handle: String,
    runtime_generation: u64,
    runtime_consumer_id: String,
    logical_identity: String,
    file_ref_id: String,
}

impl ReferenceOwnerRuntimeEvidenceInput {
    fn mounted(&self) -> MountedRuntimeEvidenceV1 {
        MountedRuntimeEvidenceV1 {
            actual_runtime_handle: self.actual_runtime_handle.clone(),
            runtime_generation: self.runtime_generation,
            runtime_consumer_id: self.runtime_consumer_id.clone(),
            logical_identity: self.logical_identity.clone(),
            file_ref_identity: self.file_ref_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerBeginInput {
    owner_type: String,
    owner_id: String,
    manuscript_channel: String,
    owner_subtype: Option<String>,
    expected_structured_revision: Option<i64>,
    expected_descriptor_identity: Option<String>,
    expected_lifecycle_evidence: Option<String>,
    operation_id: String,
    occurred_at: String,
    occurred_at_epoch_ms: i64,
    old_current_file_ref_id: String,
    default_file_ref_id: String,
    target_file_ref_id: String,
    old_current_physical_revision: String,
    target_physical_revision: String,
    expected_old_current_post_text: String,
    replacements: Vec<ReferenceOwnerReplacementInput>,
    preview_snapshot_identity: String,
    current_runtime: ReferenceOwnerRuntimeEvidenceInput,
    target_runtime: ReferenceOwnerRuntimeEvidenceInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerActivationInput {
    actual_runtime_handle: String,
    runtime_generation: u64,
    runtime_consumer_id: String,
    logical_identity: String,
    file_ref_id: String,
    exact_active: bool,
    authoritative_physical_revision: String,
    authoritative_raw_byte_length: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerTargetCleanupSpanInput {
    line_start_byte: u64,
    owned_end_byte: u64,
    marker_kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerTargetCleanupInput {
    expected_revision: String,
    expected_pre_byte_length: u64,
    expected_post_text: String,
    exact_marker_spans: Vec<ReferenceOwnerTargetCleanupSpanInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ReferenceOwnerFormalSwitchBridgeRequest {
    InspectLegacyDrain,
    Begin { input: ReferenceOwnerBeginInput },
    Continue {
        operation_id: String,
        occurred_at: String,
        occurred_at_epoch_ms: i64,
    },
    ResolveActivation {
        operation_id: String,
        activation: ReferenceOwnerActivationInput,
        occurred_at_epoch_ms: i64,
    },
    CleanupTarget {
        operation_id: String,
        cleanup: ReferenceOwnerTargetCleanupInput,
    },
    ListRecoveries {
        owner_type: String,
        owner_id: String,
        manuscript_channel: String,
        owner_subtype: Option<String>,
    },
    DiscoverRecoveries,
    CancelPrepared { operation_id: String, occurred_at_epoch_ms: i64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceOwnerRecoverySummary {
    operation_id: String,
    owner_type: String,
    owner_id: String,
    manuscript_channel: String,
    owner_subtype: Option<String>,
    phase: String,
    phase_revision: i64,
    terminal_code: Option<String>,
    old_current_file_ref_id: String,
    default_file_ref_id: String,
    target_file_ref_id: String,
    parent_owner_id: Option<String>,
    project_id: Option<String>,
    created_at_epoch_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ReferenceOwnerFormalSwitchBridgeResult {
    LegacyDrain {
        experiment_unresolved: i64,
        experiment_prepared_or_unknown: i64,
        experiment_run_unresolved: i64,
        experiment_run_prepared_or_unknown: i64,
    },
    ActivationRequired {
        operation_id: String,
        owner_type: String,
        owner_id: String,
        manuscript_channel: String,
        owner_subtype: Option<String>,
        target_file_ref_id: String,
        default_file_ref_id: String,
        activation_logical_identity: String,
        finalization_identity: String,
    },
    Resolved {
        operation_id: String,
        owner_type: String,
        owner_id: String,
        manuscript_channel: String,
        owner_subtype: Option<String>,
        target_file_ref_id: String,
        default_file_ref_id: String,
    },
    Recoveries { items: Vec<ReferenceOwnerRecoverySummary> },
    TargetCleanup {
        operation_id: String,
        attempted: bool,
        classification: String,
        actual_physical_revision: String,
        actual_raw_byte_length: u64,
    },
    Canceled { operation_id: String },
}

#[derive(Debug, Clone)]
struct FileRefFacts {
    id: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    resource_kind: String,
    file_role: String,
    location_mode: String,
    file_type: String,
    path: String,
    path_identity: String,
    file_name: String,
    configured_root: Option<String>,
    deleted_at: Option<String>,
}

fn managed_root(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT configured_root FROM managed_root_settings WHERE id='managed-root' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("FORMAL_SWITCH_MANAGED_ROOT_READ_FAILED:{error}"))
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn read_file_ref(
    connection: &Connection,
    kind: ReferenceOwnerKind,
    channel: ReferenceManuscriptChannel,
    owner_id: &str,
    file_ref_id: &str,
) -> Result<FileRefFacts, String> {
    let mut facts = connection
        .query_row(
            "SELECT id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,file_type,path,path_identity_key,deleted_at FROM file_refs WHERE id=?1",
            [file_ref_id],
            |row| {
                let path: String = row.get(8)?;
                Ok(FileRefFacts {
                    id: row.get(0)?, owner_type: row.get(1)?, owner_id: row.get(2)?,
                    channel: row.get(3)?, resource_kind: row.get(4)?, file_role: row.get(5)?,
                    location_mode: row.get(6)?, file_type: row.get(7)?, file_name: file_name(&path),
                    path, path_identity: row.get(9)?, configured_root: None, deleted_at: row.get(10)?,
                })
            },
        )
        .map_err(|error| format!("FORMAL_SWITCH_FILE_REF_READ_FAILED:{error}"))?;
    if facts.owner_type != kind.as_str()
        || facts.owner_id != owner_id
        || facts.channel != channel.as_str()
        || facts.resource_kind != "file"
        || facts.file_role != "manuscript"
        || facts.file_type != "markdown"
        || !matches!(facts.location_mode.as_str(), "managed" | "external")
        || facts.path_identity.trim().is_empty()
        || facts.file_name.trim().is_empty()
        || facts.deleted_at.is_some()
    {
        return Err("FORMAL_SWITCH_FILE_REF_IDENTITY_INVALID".into());
    }
    if facts.location_mode == "managed" {
        facts.configured_root = managed_root(connection)?;
        if facts.configured_root.is_none() {
            return Err("FORMAL_SWITCH_MANAGED_ROOT_UNAVAILABLE".into());
        }
    }
    Ok(facts)
}

fn physical_snapshot(facts: &FileRefFacts) -> Result<ExplicitPhysicalSnapshot, String> {
    read_explicit_physical_snapshot(
        &facts.path,
        &facts.path_identity,
        &facts.file_name,
        &facts.location_mode,
        facts.configured_root.as_deref(),
    )
    .map_err(str::to_string)
}

fn resolved_old_current(facts: &FileRefFacts) -> ResolvedOldCurrentFileV1 {
    ResolvedOldCurrentFileV1 {
        file_ref_identity: facts.id.clone(),
        file_path: facts.path.clone(),
        path_identity: facts.path_identity.clone(),
        file_name: facts.file_name.clone(),
        location_mode: facts.location_mode.clone(),
        configured_root: facts.configured_root.clone(),
    }
}

fn digest_row(row: &Row<'_>, columns: usize) -> Result<[u8; 32], rusqlite::Error> {
    let mut bytes = Vec::new();
    for index in 0..columns {
        match row.get_ref(index)? {
            ValueRef::Null => bytes.extend_from_slice(b"N;"),
            ValueRef::Integer(value) => bytes.extend_from_slice(format!("I{value};").as_bytes()),
            ValueRef::Real(value) => bytes.extend_from_slice(format!("R{};", value.to_bits()).as_bytes()),
            ValueRef::Text(value) => {
                bytes.extend_from_slice(format!("T{}:", value.len()).as_bytes());
                bytes.extend_from_slice(value);
                bytes.push(b';');
            }
            ValueRef::Blob(value) => {
                bytes.extend_from_slice(format!("B{}:", value.len()).as_bytes());
                bytes.extend_from_slice(value);
                bytes.push(b';');
            }
        }
    }
    Ok(sha256(&bytes))
}

fn timestamp_from_envelope(envelope: &FormalSwitchImmutableEnvelopeV1) -> Result<String, String> {
    DateTime::<Utc>::from_timestamp_millis(envelope.created_at_epoch_ms)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| "FORMAL_SWITCH_TIMESTAMP_INVALID".into())
}

fn replacement_map(
    envelope: &FormalSwitchImmutableEnvelopeV1,
    expected_keys: &[&str],
) -> Result<BTreeMap<String, Option<String>>, String> {
    if envelope.replacement_dto.len() != expected_keys.len() {
        return Err("FORMAL_SWITCH_OWNER_REPLACEMENT_SET_INVALID".into());
    }
    let values = envelope
        .replacement_dto
        .iter()
        .map(|item| (item.stable_key.clone(), item.value.clone()))
        .collect::<BTreeMap<_, _>>();
    if values.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !values.contains_key(*key))
    {
        return Err("FORMAL_SWITCH_OWNER_REPLACEMENT_SET_INVALID".into());
    }
    Ok(values)
}

struct ExperimentFormalSwitchOwnerApplierV1;

impl FormalSwitchOwnerApplierV1 for ExperimentFormalSwitchOwnerApplierV1 {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String> {
        let (project_id, fields) = connection.query_row(
            "SELECT project_id,purpose_and_question,condition_summary,method_summary,result_summary,conclusion_and_next_steps,other FROM experiments WHERE id=?1",
            [&envelope.owner_id],
            |row| Ok((row.get::<_, String>(0)?, (1..=6).map(|index| row.get::<_, Option<String>>(index)).collect::<Result<Vec<_>, _>>()?)),
        ).map_err(|error| format!("FORMAL_SWITCH_EXPERIMENT_OWNER_READ_FAILED:{error}"))?;
        let context_summary_input_digest = connection.query_row(
            "SELECT title,rating,tags,purpose_and_question,condition_summary,method_summary,result_summary,conclusion_and_next_steps,other FROM experiments WHERE id=?1",
            [&envelope.owner_id], |row| digest_row(row, 9),
        ).map_err(|error| format!("FORMAL_SWITCH_EXPERIMENT_CONTEXT_READ_FAILED:{error}"))?;
        let unowned_state_digest = connection.query_row(
            "SELECT id,project_id,route_id,task_id,title,status,rating,tags,usable_for_paper,usable_for_report,usable_for_patent,schema_version,source,condition_items,method_steps,variables,materials,custom_fields,legacy,migrated_from_legacy,experiment_name,machine_object,fault_type,speed,load,sensor_config,data_path,sampling_rate,duration,problem_notes,next_action,created_local_date,created_local_time,workspace_title_identity,created_at,deleted_at FROM experiments WHERE id=?1",
            [&envelope.owner_id], |row| digest_row(row, 36),
        ).map_err(|error| format!("FORMAL_SWITCH_EXPERIMENT_UNOWNED_READ_FAILED:{error}"))?;
        Ok(OwnerProtectedStateV1 {
            project_id: Some(project_id), parent_identity: None, review_type: None,
            context_summary_input_digest,
            protected_fields: EXPERIMENT_KEYS.iter().zip(fields).map(|(key, value)| ProtectedFieldV1 { stable_key: (*key).into(), value }).collect(),
            unowned_state_digest,
        })
    }

    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String> {
        let (_project_id, deleted_at): (String, Option<String>) = connection.query_row(
            "SELECT project_id,deleted_at FROM experiments WHERE id=?1", [&envelope.owner_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|error| format!("FORMAL_SWITCH_EXPERIMENT_LIFECYCLE_READ_FAILED:{error}"))?;
        Ok(OwnerLifecycleV1 {
            owner_deleted_at: deleted_at,
            parent_chain: Vec::new(),
        })
    }

    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String> {
        let values = replacement_map(envelope, &EXPERIMENT_KEYS)?;
        let changed = connection.execute(
            "UPDATE experiments SET purpose_and_question=?1,condition_summary=?2,method_summary=?3,result_summary=?4,conclusion_and_next_steps=?5,other=?6,updated_at=?7 WHERE id=?8 AND deleted_at IS NULL",
            params![
                values["purposeAndQuestion"], values["conditionSummary"], values["methodSummary"],
                values["resultSummary"], values["conclusionAndNextSteps"], values["other"],
                timestamp_from_envelope(envelope)?, envelope.owner_id,
            ],
        ).map_err(|error| format!("FORMAL_SWITCH_EXPERIMENT_APPLIER_FAILED:{error}"))?;
        if changed != 1 { return Err("FORMAL_SWITCH_EXPERIMENT_APPLIER_CAS_FAILED".into()); }
        Ok(())
    }
}

struct ExperimentRunFormalSwitchOwnerApplierV1;

impl FormalSwitchOwnerApplierV1 for ExperimentRunFormalSwitchOwnerApplierV1 {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String> {
        let (experiment_id, project_id, fields) = connection.query_row(
            "SELECT experiment_id,project_id,condition_summary,variable_parameter_summary,method_summary,result_summary,conclusion,summary_other FROM experiment_runs WHERE id=?1",
            [&envelope.owner_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, (2..=7).map(|index| row.get::<_, Option<String>>(index)).collect::<Result<Vec<_>, _>>()?)),
        ).map_err(|error| format!("FORMAL_SWITCH_RUN_OWNER_READ_FAILED:{error}"))?;
        let context_summary_input_digest = connection.query_row(
            "SELECT r.title,r.rating,r.tags,e.title,r.condition_summary,r.variable_parameter_summary,r.method_summary,r.result_summary,r.conclusion,r.summary_other FROM experiment_runs r JOIN experiments e ON e.id=r.experiment_id WHERE r.id=?1",
            [&envelope.owner_id], |row| digest_row(row, 10),
        ).map_err(|error| format!("FORMAL_SWITCH_RUN_CONTEXT_READ_FAILED:{error}"))?;
        let unowned_state_digest = connection.query_row(
            "SELECT id,experiment_id,project_id,route_id,task_id,title,run_label,status,started_at,completed_at,rating,tags,schema_version,source,condition_items,method_steps,variables,materials,custom_fields,legacy,created_local_date,created_local_time,workspace_title_identity,created_at,deleted_at FROM experiment_runs WHERE id=?1",
            [&envelope.owner_id], |row| digest_row(row, 25),
        ).map_err(|error| format!("FORMAL_SWITCH_RUN_UNOWNED_READ_FAILED:{error}"))?;
        Ok(OwnerProtectedStateV1 {
            project_id: Some(project_id),
            parent_identity: Some(("experiment".into(), experiment_id)),
            review_type: None, context_summary_input_digest,
            protected_fields: RUN_KEYS.iter().zip(fields).map(|(key, value)| ProtectedFieldV1 { stable_key: (*key).into(), value }).collect(),
            unowned_state_digest,
        })
    }

    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String> {
        let (experiment_id, project_id, deleted_at): (String, String, Option<String>) = connection.query_row(
            "SELECT experiment_id,project_id,deleted_at FROM experiment_runs WHERE id=?1", [&envelope.owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|error| format!("FORMAL_SWITCH_RUN_LIFECYCLE_READ_FAILED:{error}"))?;
        let (parent_project_id, parent_deleted_at): (String, Option<String>) = connection.query_row(
            "SELECT project_id,deleted_at FROM experiments WHERE id=?1", [&experiment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|error| format!("FORMAL_SWITCH_RUN_PARENT_LIFECYCLE_READ_FAILED:{error}"))?;
        if parent_project_id != project_id { return Err("FORMAL_SWITCH_RUN_PARENT_PROJECT_MISMATCH".into()); }
        Ok(OwnerLifecycleV1 {
            owner_deleted_at: deleted_at,
            parent_chain: vec![
                ParentLifecycleV1 { owner_type: "experiment".into(), owner_id: experiment_id, deleted_at: parent_deleted_at },
            ],
        })
    }

    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String> {
        let values = replacement_map(envelope, &RUN_KEYS)?;
        let changed = connection.execute(
            "UPDATE experiment_runs SET condition_summary=?1,variable_parameter_summary=?2,method_summary=?3,result_summary=?4,conclusion=?5,summary_other=?6,updated_at=?7 WHERE id=?8 AND deleted_at IS NULL",
            params![
                values["conditionSummary"], values["variableParameterSummary"], values["methodSummary"],
                values["resultSummary"], values["conclusionNotes"], values["other"],
                timestamp_from_envelope(envelope)?, envelope.owner_id,
            ],
        ).map_err(|error| format!("FORMAL_SWITCH_RUN_APPLIER_FAILED:{error}"))?;
        if changed != 1 { return Err("FORMAL_SWITCH_RUN_APPLIER_CAS_FAILED".into()); }
        Ok(())
    }
}

struct ReviewFormalSwitchOwnerApplierV1;

fn envelope_review_subtype(
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<FormalSwitchReviewType, String> {
    if envelope.owner_type != FormalSwitchOwnerType::Review
        || envelope.manuscript_channel != FormalSwitchManuscriptChannel::Primary
    {
        return Err("FORMAL_SWITCH_REVIEW_ENVELOPE_IDENTITY_INVALID".into());
    }
    envelope
        .owner_subtype
        .ok_or_else(|| "FORMAL_SWITCH_REVIEW_SUBTYPE_REQUIRED".into())
}

fn review_state(
    connection: &Connection,
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<super::review_structured_state::ReviewStructuredStateRecord, String> {
    let subtype = envelope_review_subtype(envelope)?;
    let state = super::review_structured_state::read_state_in_connection(
        connection,
        &envelope.owner_id,
    )?
    .ok_or_else(|| "SECOND_LAYER_NOT_PROVISIONED".to_string())?;
    let expected_descriptor = format!("review/primary/{}/v1", subtype.as_str());
    if state.review_type != subtype.as_str()
        || state.descriptor_identity != expected_descriptor
        || envelope.descriptor_identity != expected_descriptor
    {
        return Err("FORMAL_SWITCH_REVIEW_DESCRIPTOR_IDENTITY_CONFLICT".into());
    }
    Ok(state)
}

fn review_exact_post_evidence(
    state: &super::review_structured_state::ReviewStructuredStateRecord,
) -> JsonValue {
    serde_json::json!({
        "contractVersion": "ReviewFormalSwitchExactPostEvidenceV1",
        "reviewId": state.review_id,
        "ownerSubtype": state.review_type,
        "descriptorIdentity": state.descriptor_identity,
        "structuredRevision": state.structured_revision,
        "lifecycleEvidence": state.lifecycle_evidence,
        "lifecycleStatus": state.lifecycle_status,
        "updatedAt": state.updated_at,
    })
}

impl FormalSwitchOwnerApplierV1 for ReviewFormalSwitchOwnerApplierV1 {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String> {
        let state = review_state(connection, envelope)?;
        let context_summary_input_digest = sha256(
            &serde_json::to_vec(&serde_json::json!({
                "contractVersion": "ReviewFormalSwitchStructuredCasV1",
                "reviewId": state.review_id,
                "ownerSubtype": state.review_type,
                "descriptorIdentity": state.descriptor_identity,
                "structuredRevision": state.structured_revision,
                "lifecycleEvidence": state.lifecycle_evidence,
                "lifecycleStatus": state.lifecycle_status,
            }))
            .map_err(|error| format!("FORMAL_SWITCH_REVIEW_CAS_ENCODING_FAILED:{error}"))?,
        );
        let unowned_state_digest = sha256(
            &serde_json::to_vec(&serde_json::json!({
                "reviewId": state.review_id,
                "createdAt": state.created_at,
            }))
            .map_err(|error| format!("FORMAL_SWITCH_REVIEW_UNOWNED_ENCODING_FAILED:{error}"))?,
        );
        Ok(OwnerProtectedStateV1 {
            project_id: None,
            parent_identity: None,
            review_type: Some(state.review_type),
            context_summary_input_digest,
            protected_fields: state
                .outline_sections
                .into_iter()
                .map(|section| ProtectedFieldV1 {
                    stable_key: section.key,
                    value: (!section.content.is_empty()).then_some(section.content),
                })
                .collect(),
            unowned_state_digest,
        })
    }

    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String> {
        let state = review_state(connection, envelope)?;
        Ok(OwnerLifecycleV1 {
            owner_deleted_at: (state.lifecycle_status != "active").then(|| {
                format!("{}:{}", state.lifecycle_status, state.lifecycle_evidence)
            }),
            parent_chain: Vec::new(),
        })
    }

    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String> {
        let subtype = envelope_review_subtype(envelope)?;
        let state = review_state(connection, envelope)?;
        let values = replacement_map(envelope, review_keys(subtype))?;
        let input = super::review_structured_state::ReplaceReviewStructuredStateInput {
            review_id: envelope.owner_id.clone(),
            expected_structured_revision: state.structured_revision,
            expected_descriptor_identity: state.descriptor_identity.clone(),
            expected_lifecycle_evidence: state.lifecycle_evidence.clone(),
            review_type: state.review_type,
            outline_sections: review_keys(subtype)
                .iter()
                .map(|key| super::review_structured_state::ReviewOutlineSectionRecord {
                    key: (*key).into(),
                    content: values[*key].clone().unwrap_or_default(),
                })
                .collect(),
        };
        super::review_structured_state::replace_in_existing_transaction(
            connection,
            &input,
            &timestamp_from_envelope(envelope)?,
        )?;
        Ok(())
    }

    fn read_exact_post_evidence(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<Option<JsonValue>, String> {
        Ok(Some(review_exact_post_evidence(&review_state(
            connection,
            envelope,
        )?)))
    }

    fn exact_post_evidence_matches(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
        evidence: Option<&JsonValue>,
    ) -> Result<bool, String> {
        Ok(evidence.is_some_and(|expected| {
            review_state(connection, envelope)
                .map(|state| review_exact_post_evidence(&state) == *expected)
                .unwrap_or(false)
        }))
    }
}

fn envelope_reference_channel(
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<ReferenceManuscriptChannel, String> {
    let kind = ReferenceOwnerKind::parse(envelope.owner_type.as_str())?;
    ReferenceManuscriptChannel::parse(kind, envelope.manuscript_channel.as_str())
}

fn literature_custom_key(
    channel: ReferenceManuscriptChannel,
    stable_key: &str,
) -> Option<&'static str> {
    match (channel, stable_key) {
        (ReferenceManuscriptChannel::LiteratureOutline, "research_problem") => {
            Some("outlineResearchProblem")
        }
        (ReferenceManuscriptChannel::LiteratureOutline, "application_object") => {
            Some("outlineApplicationObject")
        }
        (ReferenceManuscriptChannel::LiteratureOutline, "method_overview") => {
            Some("outlineMethodOverview")
        }
        (ReferenceManuscriptChannel::LiteratureOutline, "main_conclusion") => {
            Some("outlineMainConclusion")
        }
        (ReferenceManuscriptChannel::LiteratureOutline, "limitations") => {
            Some("outlineLimitations")
        }
        (ReferenceManuscriptChannel::LiteratureOutline, "other") => Some("outlineOther"),
        (ReferenceManuscriptChannel::DedicatedNotes, "summary") => {
            Some("knowledgeProjectSummary")
        }
        (ReferenceManuscriptChannel::DedicatedNotes, "project_relevance") => {
            Some("knowledgeProjectRelevance")
        }
        (ReferenceManuscriptChannel::DedicatedNotes, "related_objects") => {
            Some("knowledgeRelatedObjectNotes")
        }
        (ReferenceManuscriptChannel::DedicatedNotes, "reusable_methods") => {
            Some("knowledgeReusableMethods")
        }
        (ReferenceManuscriptChannel::DedicatedNotes, "comparable_conclusions") => {
            Some("knowledgeComparableConclusions")
        }
        (ReferenceManuscriptChannel::DedicatedNotes, "other") => Some("knowledgeOther"),
        _ => None,
    }
}

fn literature_owned_custom_keys(
    channel: ReferenceManuscriptChannel,
) -> &'static [&'static str] {
    match channel {
        ReferenceManuscriptChannel::LiteratureOutline => &LITERATURE_OUTLINE_CUSTOM_KEYS,
        ReferenceManuscriptChannel::DedicatedNotes => &LITERATURE_NOTES_CUSTOM_KEYS,
        ReferenceManuscriptChannel::Primary => &[],
    }
}

fn literature_custom_field_matches(field: &JsonValue, key: &str) -> bool {
    let Some(object) = field.as_object() else {
        return false;
    };
    object.get("id").and_then(JsonValue::as_str) == Some(key)
        || object.get("name").and_then(JsonValue::as_str) == Some(key)
}

fn parse_literature_custom_fields(raw: Option<&str>) -> Result<Vec<JsonValue>, String> {
    let value = match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => serde_json::from_str::<JsonValue>(raw)
            .map_err(|_| "FORMAL_SWITCH_LITERATURE_CUSTOM_FIELDS_INVALID".to_string())?,
        None => JsonValue::Array(Vec::new()),
    };
    let JsonValue::Array(fields) = value else {
        return Err("FORMAL_SWITCH_LITERATURE_CUSTOM_FIELDS_INVALID".into());
    };
    let all_keys = LITERATURE_OUTLINE_CUSTOM_KEYS
        .iter()
        .chain(LITERATURE_NOTES_CUSTOM_KEYS.iter())
        .copied()
        .collect::<Vec<_>>();
    for field in &fields {
        let matches = all_keys
            .iter()
            .filter(|key| literature_custom_field_matches(field, key))
            .count();
        if matches > 1 {
            return Err("FORMAL_SWITCH_LITERATURE_CUSTOM_FIELD_IDENTITY_AMBIGUOUS".into());
        }
    }
    for key in all_keys {
        if fields
            .iter()
            .filter(|field| literature_custom_field_matches(field, key))
            .count()
            > 1
        {
            return Err("FORMAL_SWITCH_LITERATURE_CUSTOM_FIELD_DUPLICATE".into());
        }
    }
    Ok(fields)
}

fn literature_custom_string(
    fields: &[JsonValue],
    key: &str,
) -> Result<Option<String>, String> {
    let Some(field) = fields
        .iter()
        .find(|field| literature_custom_field_matches(field, key))
    else {
        return Ok(None);
    };
    match field.get("value") {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err("FORMAL_SWITCH_LITERATURE_CONTROLLED_VALUE_INVALID".into()),
    }
}

fn append_sql_value(bytes: &mut Vec<u8>, value: &SqlValue) {
    match value {
        SqlValue::Null => bytes.extend_from_slice(b"N;"),
        SqlValue::Integer(value) => bytes.extend_from_slice(format!("I{value};").as_bytes()),
        SqlValue::Real(value) => {
            bytes.extend_from_slice(format!("R{};", value.to_bits()).as_bytes())
        }
        SqlValue::Text(value) => {
            bytes.extend_from_slice(format!("T{}:", value.len()).as_bytes());
            bytes.extend_from_slice(value.as_bytes());
            bytes.push(b';');
        }
        SqlValue::Blob(value) => {
            bytes.extend_from_slice(format!("B{}:", value.len()).as_bytes());
            bytes.extend_from_slice(value);
            bytes.push(b';');
        }
    }
}

fn append_optional_text(bytes: &mut Vec<u8>, value: &Option<String>) {
    append_sql_value(
        bytes,
        &value
            .as_ref()
            .map(|value| SqlValue::Text(value.clone()))
            .unwrap_or(SqlValue::Null),
    );
}

fn read_sql_values(
    connection: &Connection,
    sql: &str,
    owner_id: &str,
    column_count: usize,
    error_code: &str,
) -> Result<Vec<SqlValue>, String> {
    connection
        .query_row(sql, [owner_id], |row| {
            (0..column_count)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("{error_code}:{error}"))
}

fn literature_context_digest(
    connection: &Connection,
    owner_id: &str,
    protected_fields: &[ProtectedFieldV1],
) -> Result<[u8; 32], String> {
    let values = read_sql_values(
        connection,
        "SELECT title,authors,year,publication_type,venue,doi,url,importance,keywords FROM literatures WHERE id=?1",
        owner_id,
        9,
        "FORMAL_SWITCH_LITERATURE_CONTEXT_READ_FAILED",
    )?;
    let mut bytes = Vec::new();
    for value in &values {
        append_sql_value(&mut bytes, value);
    }
    for field in protected_fields {
        append_optional_text(&mut bytes, &field.value);
    }
    Ok(sha256(&bytes))
}

fn literature_unowned_digest(
    connection: &Connection,
    owner_id: &str,
    channel: ReferenceManuscriptChannel,
    custom_fields: &[JsonValue],
) -> Result<[u8; 32], String> {
    let (sql, column_count) = match channel {
        ReferenceManuscriptChannel::LiteratureOutline => (
            "SELECT id,title,authors,year,venue,publication_type,keywords,doi,url,pdf_path,local_file_path,bibtex_key,citation_key,external_ids,reading_status,importance,primary_project_id,tags,is_archived,archived_at,schema_version,source,ai_metadata,created_at,deleted_at FROM literatures WHERE id=?1",
            25,
        ),
        ReferenceManuscriptChannel::DedicatedNotes => (
            "SELECT id,title,authors,year,venue,publication_type,abstract,keywords,doi,url,pdf_path,local_file_path,bibtex_key,citation_key,external_ids,reading_status,importance,primary_project_id,tags,is_archived,archived_at,schema_version,source,ai_metadata,created_at,deleted_at FROM literatures WHERE id=?1",
            26,
        ),
        ReferenceManuscriptChannel::Primary => {
            return Err("FORMAL_SWITCH_LITERATURE_CHANNEL_INVALID".into())
        }
    };
    let values = read_sql_values(
        connection,
        sql,
        owner_id,
        column_count,
        "FORMAL_SWITCH_LITERATURE_UNOWNED_READ_FAILED",
    )?;
    let owned_keys = literature_owned_custom_keys(channel);
    let preserved_custom_fields = custom_fields
        .iter()
        .filter(|field| {
            !owned_keys
                .iter()
                .any(|key| literature_custom_field_matches(field, key))
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    for value in &values {
        append_sql_value(&mut bytes, value);
    }
    let custom_bytes = serde_json::to_vec(&preserved_custom_fields)
        .map_err(|_| "FORMAL_SWITCH_LITERATURE_CUSTOM_FIELDS_INVALID".to_string())?;
    bytes.extend_from_slice(format!("J{}:", custom_bytes.len()).as_bytes());
    bytes.extend_from_slice(&custom_bytes);
    Ok(sha256(&bytes))
}

struct LiteratureFormalSwitchOwnerApplierV1;

impl FormalSwitchOwnerApplierV1 for LiteratureFormalSwitchOwnerApplierV1 {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String> {
        let channel = envelope_reference_channel(envelope)?;
        if channel == ReferenceManuscriptChannel::Primary {
            return Err("FORMAL_SWITCH_LITERATURE_CHANNEL_INVALID".into());
        }
        let (project_id, abstract_value, custom_fields_raw): (
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT primary_project_id,abstract,custom_fields FROM literatures WHERE id=?1",
                [&envelope.owner_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("FORMAL_SWITCH_LITERATURE_OWNER_READ_FAILED:{error}"))?;
        let custom_fields = parse_literature_custom_fields(custom_fields_raw.as_deref())?;
        let mut protected_fields = Vec::new();
        for stable_key in ReferenceOwnerKind::Literature.keys(channel) {
            let value = if channel == ReferenceManuscriptChannel::LiteratureOutline
                && *stable_key == "summary"
            {
                abstract_value.clone()
            } else {
                let custom_key = literature_custom_key(channel, stable_key)
                    .ok_or_else(|| "FORMAL_SWITCH_LITERATURE_MAPPING_INVALID".to_string())?;
                literature_custom_string(&custom_fields, custom_key)?
            };
            protected_fields.push(ProtectedFieldV1 {
                stable_key: (*stable_key).into(),
                value,
            });
        }
        let context_summary_input_digest = literature_context_digest(
            connection,
            &envelope.owner_id,
            &protected_fields,
        )?;
        let unowned_state_digest = literature_unowned_digest(
            connection,
            &envelope.owner_id,
            channel,
            &custom_fields,
        )?;
        Ok(OwnerProtectedStateV1 {
            project_id,
            parent_identity: None,
            review_type: None,
            context_summary_input_digest,
            protected_fields,
            unowned_state_digest,
        })
    }

    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String> {
        let deleted_at = connection
            .query_row(
                "SELECT deleted_at FROM literatures WHERE id=?1",
                [&envelope.owner_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|error| {
                format!("FORMAL_SWITCH_LITERATURE_LIFECYCLE_READ_FAILED:{error}")
            })?;
        Ok(OwnerLifecycleV1 {
            owner_deleted_at: deleted_at,
            parent_chain: Vec::new(),
        })
    }

    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String> {
        let channel = envelope_reference_channel(envelope)?;
        if channel == ReferenceManuscriptChannel::Primary {
            return Err("FORMAL_SWITCH_LITERATURE_CHANNEL_INVALID".into());
        }
        let values = replacement_map(
            envelope,
            ReferenceOwnerKind::Literature.keys(channel),
        )?;
        let custom_fields_raw = connection
            .query_row(
                "SELECT custom_fields FROM literatures WHERE id=?1",
                [&envelope.owner_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|error| {
                format!("FORMAL_SWITCH_LITERATURE_CUSTOM_FIELDS_READ_FAILED:{error}")
            })?;
        let custom_fields = parse_literature_custom_fields(custom_fields_raw.as_deref())?;
        let owned_keys = literature_owned_custom_keys(channel);
        let mut merged = custom_fields
            .into_iter()
            .filter(|field| {
                !owned_keys
                    .iter()
                    .any(|key| literature_custom_field_matches(field, key))
            })
            .collect::<Vec<_>>();
        for stable_key in ReferenceOwnerKind::Literature.keys(channel) {
            let Some(custom_key) = literature_custom_key(channel, stable_key) else {
                continue;
            };
            let Some(value) = values.get(*stable_key).cloned().flatten() else {
                continue;
            };
            let group = if channel == ReferenceManuscriptChannel::LiteratureOutline {
                "literatureStructuredOutline"
            } else {
                "literatureKnowledgeDeposit"
            };
            merged.push(serde_json::json!({
                "id": custom_key,
                "name": custom_key,
                "value": value,
                "valueType": "text",
                "group": group,
            }));
        }
        let merged_json = serde_json::to_string(&merged)
            .map_err(|_| "FORMAL_SWITCH_LITERATURE_CUSTOM_FIELDS_INVALID".to_string())?;
        let occurred_at = timestamp_from_envelope(envelope)?;
        let changed = if channel == ReferenceManuscriptChannel::LiteratureOutline {
            connection.execute(
                "UPDATE literatures SET abstract=?1,custom_fields=?2,updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
                params![values["summary"], merged_json, occurred_at, envelope.owner_id],
            )
        } else {
            connection.execute(
                "UPDATE literatures SET custom_fields=?1,updated_at=?2 WHERE id=?3 AND deleted_at IS NULL",
                params![merged_json, occurred_at, envelope.owner_id],
            )
        }
        .map_err(|error| format!("FORMAL_SWITCH_LITERATURE_APPLIER_FAILED:{error}"))?;
        if changed != 1 {
            return Err("FORMAL_SWITCH_LITERATURE_APPLIER_CAS_FAILED".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
struct OutputsOwnerContract {
    kind: ReferenceOwnerKind,
    direct_stable_key: &'static str,
    structured_keys: &'static [&'static str],
}

impl OutputsOwnerContract {
    fn from_envelope(envelope: &FormalSwitchImmutableEnvelopeV1) -> Result<Self, String> {
        let kind = ReferenceOwnerKind::parse(envelope.owner_type.as_str())?;
        let (direct_stable_key, structured_keys) = match kind {
            ReferenceOwnerKind::ResultItem => ("summary", &RESULT_ITEM_KEYS[1..]),
            ReferenceOwnerKind::Finding => ("content", &FINDING_KEYS[1..]),
            ReferenceOwnerKind::OutputCandidate => ("coreClaim", &OUTPUT_CANDIDATE_KEYS[1..]),
            ReferenceOwnerKind::OutputGap => ("gapDescription", &OUTPUT_GAP_KEYS[1..]),
            ReferenceOwnerKind::ResearchOutput => ("summary", &RESEARCH_OUTPUT_KEYS[1..]),
            _ => return Err("FORMAL_SWITCH_OUTPUTS_OWNER_NOT_ADMITTED".into()),
        };
        if envelope.manuscript_channel != FormalSwitchManuscriptChannel::Primary {
            return Err("FORMAL_SWITCH_OUTPUTS_CHANNEL_INVALID".into());
        }
        Ok(Self { kind, direct_stable_key, structured_keys })
    }

    fn all_keys(self) -> &'static [&'static str] {
        self.kind.keys(ReferenceManuscriptChannel::Primary)
    }

    fn controls(self, key: &str) -> bool {
        key == self.direct_stable_key || self.structured_keys.contains(&key)
    }
}

fn normalized_output_controlled_value(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn parse_outputs_structured_summary(
    raw: &str,
    contract: OutputsOwnerContract,
) -> Result<Vec<JsonValue>, String> {
    let value = serde_json::from_str::<JsonValue>(raw)
        .map_err(|_| "FORMAL_SWITCH_OUTPUTS_STRUCTURED_SUMMARY_INVALID".to_string())?;
    let JsonValue::Array(fields) = value else {
        return Err("FORMAL_SWITCH_OUTPUTS_STRUCTURED_SUMMARY_INVALID".into());
    };
    let mut controlled_counts = BTreeMap::<String, usize>::new();
    for field in &fields {
        let object = field
            .as_object()
            .ok_or_else(|| "FORMAL_SWITCH_OUTPUTS_STRUCTURED_FIELD_INVALID".to_string())?;
        let key = object
            .get("key")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| "FORMAL_SWITCH_OUTPUTS_STRUCTURED_KEY_INVALID".to_string())?;
        if contract.controls(key) {
            *controlled_counts.entry(key.into()).or_default() += 1;
            if !object.get("value").is_some_and(JsonValue::is_string) {
                return Err("FORMAL_SWITCH_OUTPUTS_CONTROLLED_VALUE_INVALID".into());
            }
        }
    }
    if controlled_counts.values().any(|count| *count > 1) {
        return Err("FORMAL_SWITCH_OUTPUTS_CONTROLLED_FIELD_DUPLICATE".into());
    }
    Ok(fields)
}

fn output_structured_value(
    fields: &[JsonValue],
    stable_key: &str,
) -> Result<Option<String>, String> {
    let Some(field) = fields.iter().find(|field| {
        field.get("key").and_then(JsonValue::as_str) == Some(stable_key)
    }) else {
        return Ok(None);
    };
    let value = field
        .get("value")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "FORMAL_SWITCH_OUTPUTS_CONTROLLED_VALUE_INVALID".to_string())?;
    Ok(normalized_output_controlled_value(Some(value.into())))
}

fn read_outputs_owner_core(
    connection: &Connection,
    kind: ReferenceOwnerKind,
    owner_id: &str,
) -> Result<(String, Option<String>, String), String> {
    let result = match kind {
        ReferenceOwnerKind::ResultItem => connection.query_row(
            "SELECT project_id,summary,structured_summary FROM result_items WHERE id=?1",
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ),
        ReferenceOwnerKind::Finding => connection.query_row(
            "SELECT project_id,summary,structured_summary FROM findings WHERE id=?1",
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ),
        ReferenceOwnerKind::OutputCandidate => connection.query_row(
            "SELECT project_id,description,structured_summary FROM output_candidates WHERE id=?1",
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ),
        ReferenceOwnerKind::OutputGap => connection.query_row(
            "SELECT project_id,description,structured_summary FROM output_gaps WHERE id=?1",
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ),
        ReferenceOwnerKind::ResearchOutput => connection.query_row(
            "SELECT project_id,description,structured_summary FROM outputs WHERE id=?1",
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ),
        _ => return Err("FORMAL_SWITCH_OUTPUTS_OWNER_NOT_ADMITTED".into()),
    };
    result.map_err(|error| format!("FORMAL_SWITCH_OUTPUTS_OWNER_READ_FAILED:{error}"))
}

fn read_outputs_unowned_values(
    connection: &Connection,
    kind: ReferenceOwnerKind,
    owner_id: &str,
) -> Result<Vec<SqlValue>, String> {
    let (sql, count) = match kind {
        ReferenceOwnerKind::ResultItem => (
            "SELECT id,project_id,route_id,task_id,experiment_id,experiment_run_id,source_type,source_id,title,result_type,status,value_json,unit,file_ref_id,tags,is_asset,asset_marked_at,asset_reason,asset_quality,usable_for,schema_version,custom_fields,created_at,deleted_at FROM result_items WHERE id=?1",
            24,
        ),
        ReferenceOwnerKind::Finding => (
            "SELECT id,project_id,route_id,task_id,experiment_id,title,status,finding_type,confidence,maturity,tags,schema_version,custom_fields,created_at,deleted_at FROM findings WHERE id=?1",
            15,
        ),
        ReferenceOwnerKind::OutputCandidate => (
            "SELECT id,project_id,route_id,task_id,title,candidate_type,status,maturity,priority,tags,schema_version,custom_fields,created_at,deleted_at FROM output_candidates WHERE id=?1",
            14,
        ),
        ReferenceOwnerKind::OutputGap => (
            "SELECT id,project_id,title,gap_type,status,priority,related_task_id,related_route_node_id,resolved_at,schema_version,custom_fields,created_at,deleted_at FROM output_gaps WHERE id=?1",
            13,
        ),
        ReferenceOwnerKind::ResearchOutput => (
            "SELECT id,project_id,task_id,experiment_id,output_name,output_type,status,usable_for_paper,provenance,created_at,deleted_at FROM outputs WHERE id=?1",
            11,
        ),
        _ => return Err("FORMAL_SWITCH_OUTPUTS_OWNER_NOT_ADMITTED".into()),
    };
    read_sql_values(
        connection,
        sql,
        owner_id,
        count,
        "FORMAL_SWITCH_OUTPUTS_UNOWNED_READ_FAILED",
    )
}

fn outputs_unowned_digest(
    connection: &Connection,
    owner_id: &str,
    contract: OutputsOwnerContract,
    structured_fields: &[JsonValue],
) -> Result<[u8; 32], String> {
    let values = read_outputs_unowned_values(connection, contract.kind, owner_id)?;
    let preserved = structured_fields
        .iter()
        .filter(|field| {
            field
                .get("key")
                .and_then(JsonValue::as_str)
                .is_none_or(|key| !contract.controls(key))
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    for value in &values {
        append_sql_value(&mut bytes, value);
    }
    let structured_bytes = serde_json::to_vec(&preserved)
        .map_err(|_| "FORMAL_SWITCH_OUTPUTS_STRUCTURED_SUMMARY_INVALID".to_string())?;
    bytes.extend_from_slice(format!("J{}:", structured_bytes.len()).as_bytes());
    bytes.extend_from_slice(&structured_bytes);
    Ok(sha256(&bytes))
}

fn outputs_context_digest(
    project_id: &str,
    protected_fields: &[ProtectedFieldV1],
    structured_fields: &[JsonValue],
    contract: OutputsOwnerContract,
) -> Result<[u8; 32], String> {
    let mut bytes = Vec::new();
    append_sql_value(&mut bytes, &SqlValue::Text(contract.kind.as_str().into()));
    append_sql_value(&mut bytes, &SqlValue::Text(project_id.into()));
    for field in protected_fields {
        append_optional_text(&mut bytes, &field.value);
    }
    let controlled_shape = structured_fields
        .iter()
        .filter(|field| {
            field
                .get("key")
                .and_then(JsonValue::as_str)
                .is_some_and(|key| contract.controls(key))
        })
        .cloned()
        .collect::<Vec<_>>();
    let controlled_bytes = serde_json::to_vec(&controlled_shape)
        .map_err(|_| "FORMAL_SWITCH_OUTPUTS_STRUCTURED_SUMMARY_INVALID".to_string())?;
    bytes.extend_from_slice(format!("J{}:", controlled_bytes.len()).as_bytes());
    bytes.extend_from_slice(&controlled_bytes);
    Ok(sha256(&bytes))
}

fn read_outputs_deleted_at(
    connection: &Connection,
    kind: ReferenceOwnerKind,
    owner_id: &str,
) -> Result<Option<String>, String> {
    let result = match kind {
        ReferenceOwnerKind::ResultItem => connection.query_row(
            "SELECT deleted_at FROM result_items WHERE id=?1", [owner_id], |row| row.get(0),
        ),
        ReferenceOwnerKind::Finding => connection.query_row(
            "SELECT deleted_at FROM findings WHERE id=?1", [owner_id], |row| row.get(0),
        ),
        ReferenceOwnerKind::OutputCandidate => connection.query_row(
            "SELECT deleted_at FROM output_candidates WHERE id=?1", [owner_id], |row| row.get(0),
        ),
        ReferenceOwnerKind::OutputGap => connection.query_row(
            "SELECT deleted_at FROM output_gaps WHERE id=?1", [owner_id], |row| row.get(0),
        ),
        ReferenceOwnerKind::ResearchOutput => connection.query_row(
            "SELECT deleted_at FROM outputs WHERE id=?1", [owner_id], |row| row.get(0),
        ),
        _ => return Err("FORMAL_SWITCH_OUTPUTS_OWNER_NOT_ADMITTED".into()),
    };
    result.map_err(|error| format!("FORMAL_SWITCH_OUTPUTS_LIFECYCLE_READ_FAILED:{error}"))
}

fn apply_outputs_owned_fields(
    connection: &Connection,
    envelope: &FormalSwitchImmutableEnvelopeV1,
    contract: OutputsOwnerContract,
) -> Result<(), String> {
    let values = replacement_map(envelope, contract.all_keys())?;
    let (_, _, structured_raw) = read_outputs_owner_core(connection, contract.kind, &envelope.owner_id)?;
    let existing = parse_outputs_structured_summary(&structured_raw, contract)?;
    let mut merged = Vec::new();
    for (index, stable_key) in contract.structured_keys.iter().enumerate() {
        merged.push(serde_json::json!({
            "key": stable_key,
            "value": values.get(*stable_key).cloned().flatten().unwrap_or_default(),
            "order": index + 2,
        }));
    }
    merged.extend(existing.into_iter().filter(|field| {
        field
            .get("key")
            .and_then(JsonValue::as_str)
            .is_none_or(|key| !contract.controls(key))
    }));
    let structured_json = serde_json::to_string(&merged)
        .map_err(|_| "FORMAL_SWITCH_OUTPUTS_STRUCTURED_SUMMARY_INVALID".to_string())?;
    let direct_value = values
        .get(contract.direct_stable_key)
        .cloned()
        .flatten()
        .unwrap_or_default();
    let occurred_at = timestamp_from_envelope(envelope)?;
    let result = match contract.kind {
        ReferenceOwnerKind::ResultItem => connection.execute(
            "UPDATE result_items SET summary=?1,structured_summary=?2,updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
            params![direct_value, structured_json, occurred_at, envelope.owner_id],
        ),
        ReferenceOwnerKind::Finding => connection.execute(
            "UPDATE findings SET summary=?1,structured_summary=?2,updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
            params![direct_value, structured_json, occurred_at, envelope.owner_id],
        ),
        ReferenceOwnerKind::OutputCandidate => connection.execute(
            "UPDATE output_candidates SET description=?1,structured_summary=?2,updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
            params![direct_value, structured_json, occurred_at, envelope.owner_id],
        ),
        ReferenceOwnerKind::OutputGap => connection.execute(
            "UPDATE output_gaps SET description=?1,structured_summary=?2,updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
            params![direct_value, structured_json, occurred_at, envelope.owner_id],
        ),
        ReferenceOwnerKind::ResearchOutput => connection.execute(
            "UPDATE outputs SET description=?1,structured_summary=?2,updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
            params![direct_value, structured_json, occurred_at, envelope.owner_id],
        ),
        _ => return Err("FORMAL_SWITCH_OUTPUTS_OWNER_NOT_ADMITTED".into()),
    };
    let changed = result.map_err(|error| format!("FORMAL_SWITCH_OUTPUTS_APPLIER_FAILED:{error}"))?;
    if changed != 1 {
        return Err("FORMAL_SWITCH_OUTPUTS_APPLIER_CAS_FAILED".into());
    }
    Ok(())
}

struct OutputsFormalSwitchOwnerApplierV1;

impl FormalSwitchOwnerApplierV1 for OutputsFormalSwitchOwnerApplierV1 {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String> {
        let contract = OutputsOwnerContract::from_envelope(envelope)?;
        let (project_id, direct_value, structured_raw) =
            read_outputs_owner_core(connection, contract.kind, &envelope.owner_id)?;
        let structured_fields = parse_outputs_structured_summary(&structured_raw, contract)?;
        let mut protected_fields = vec![ProtectedFieldV1 {
            stable_key: contract.direct_stable_key.into(),
            value: normalized_output_controlled_value(direct_value),
        }];
        for stable_key in contract.structured_keys {
            protected_fields.push(ProtectedFieldV1 {
                stable_key: (*stable_key).into(),
                value: output_structured_value(&structured_fields, stable_key)?,
            });
        }
        let context_summary_input_digest = outputs_context_digest(
            &project_id,
            &protected_fields,
            &structured_fields,
            contract,
        )?;
        let unowned_state_digest = outputs_unowned_digest(
            connection,
            &envelope.owner_id,
            contract,
            &structured_fields,
        )?;
        Ok(OwnerProtectedStateV1 {
            project_id: Some(project_id),
            parent_identity: None,
            review_type: None,
            context_summary_input_digest,
            protected_fields,
            unowned_state_digest,
        })
    }

    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String> {
        let contract = OutputsOwnerContract::from_envelope(envelope)?;
        Ok(OwnerLifecycleV1 {
            owner_deleted_at: read_outputs_deleted_at(
                connection,
                contract.kind,
                &envelope.owner_id,
            )?,
            parent_chain: Vec::new(),
        })
    }

    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String> {
        apply_outputs_owned_fields(
            connection,
            envelope,
            OutputsOwnerContract::from_envelope(envelope)?,
        )
    }
}

fn validate_legacy_drain(connection: &Connection) -> Result<(), String> {
    let drain = read_old_recovery_drain_snapshot(connection)?;
    if drain.experiment_unresolved != 0
        || drain.experiment_prepared_or_unknown != 0
        || drain.run_unresolved != 0
        || drain.run_prepared_or_unknown != 0
    {
        return Err("LEGACY_UNRESOLVED_REFERENCE_RECOVERY_NOT_DRAINED".into());
    }
    Ok(())
}

fn normalized_replacements(
    kind: ReferenceOwnerKind,
    channel: ReferenceManuscriptChannel,
    subtype: Option<FormalSwitchReviewType>,
    input: &[ReferenceOwnerReplacementInput],
) -> Result<Vec<ReplacementItemV1>, String> {
    let expected_keys = canonical_keys(kind, channel, subtype)?;
    if input.len() != expected_keys.len() {
        return Err("FORMAL_SWITCH_OWNER_REPLACEMENT_SET_INVALID".into());
    }
    let keys = input.iter().map(|item| item.stable_key.as_str()).collect::<HashSet<_>>();
    if keys.len() != expected_keys.len() || expected_keys.iter().any(|key| !keys.contains(key)) {
        return Err("FORMAL_SWITCH_OWNER_REPLACEMENT_SET_INVALID".into());
    }
    Ok(expected_keys.iter().map(|key| {
        let source = input.iter().find(|item| item.stable_key == *key).expect("validated key");
        ReplacementItemV1 {
            stable_key: (*key).into(),
            value: if kind == ReferenceOwnerKind::Experiment && *key == "resultSummary" && source.value.is_none() {
                Some(String::new())
            } else { source.value.clone() },
        }
    }).collect())
}

struct BridgeRevalidationPort<'a> {
    connection: &'a Connection,
    applier: &'a dyn FormalSwitchOwnerApplierV1,
    confirmation_identity: String,
    current_runtime: MountedRuntimeEvidenceV1,
    target_runtime: MountedRuntimeEvidenceV1,
    old_file: FileRefFacts,
    target_file: FileRefFacts,
}

impl FinalRevalidationPortV1 for BridgeRevalidationPort<'_> {
    fn fresh_revalidate(
        &self,
        envelope: &FormalSwitchImmutableEnvelopeV1,
        envelope_sha256: [u8; 32],
    ) -> Result<FinalRevalidationSnapshotV1, String> {
        let binding = read_binding(self.connection, envelope)?;
        let lifecycle = self.applier.read_owner_lifecycle(self.connection, envelope)?;
        let lifecycle_digest = lifecycle_coverage_digest(envelope, &lifecycle, &binding)?;
        let owner = self.applier.read_owner_state(self.connection, envelope)?;
        let old = physical_snapshot(&self.old_file)?;
        let target = physical_snapshot(&self.target_file)?;
        Ok(FinalRevalidationSnapshotV1 {
            envelope_sha256,
            confirmation_evidence_identity: self.confirmation_identity.clone(),
            target_file_ref_identity: self.target_file.id.clone(),
            target_physical_revision: target.revision,
            target_sha256: target.sha256,
            target_byte_length: target.bytes.len() as u64,
            old_current_file_ref_identity: self.old_file.id.clone(),
            old_current_physical_revision: old.revision,
            old_current_sha256: old.sha256,
            owner_digest: owner_protected_row_digest(envelope, &owner, lifecycle_digest)?,
            binding_digest: binding_digest(&binding)?, lifecycle_digest,
            descriptor_identity: envelope.descriptor_identity.clone(),
            descriptor_version: envelope.descriptor_version,
            descriptor_sha256: envelope.descriptor_hash,
            current_mounted_runtime: Some(self.current_runtime.clone()),
            target_mounted_runtime: Some(self.target_runtime.clone()),
            target_zero_write_verified: true,
        })
    }
}

fn build_and_prepare(
    connection: &Connection,
    input: &ReferenceOwnerBeginInput,
) -> Result<ExecutableFormalSwitchOperationV1, String> {
    validate_legacy_drain(connection)?;
    let kind = ReferenceOwnerKind::parse(&input.owner_type)?;
    let channel = ReferenceManuscriptChannel::parse(kind, &input.manuscript_channel)?;
    let owner_subtype = canonical_owner_subtype(kind, input.owner_subtype.as_deref())?;
    if kind == ReferenceOwnerKind::Review {
        let expected_subtype = owner_subtype
            .ok_or_else(|| "FORMAL_SWITCH_REVIEW_SUBTYPE_REQUIRED".to_string())?
            .as_str();
        let cross_subtype_recovery_pending = read_unresolved_operation_summaries(connection)?
            .into_iter()
            .any(|summary| {
                summary.operation_id != input.operation_id
                    && summary.owner_type == kind.as_str()
                    && summary.owner_id == input.owner_id
                    && summary.manuscript_channel == channel.as_str()
                    && summary.owner_subtype != expected_subtype
            });
        if cross_subtype_recovery_pending {
            return Err("FORMAL_SWITCH_REVIEW_CROSS_SUBTYPE_RECOVERY_PENDING".into());
        }
    }
    let (descriptor_identity, descriptor_bytes) =
        canonical_descriptor(kind, channel, owner_subtype)?;
    let review_evidence_valid = if kind == ReferenceOwnerKind::Review {
        input.expected_structured_revision.is_some_and(|value| value >= 0)
            && input.expected_descriptor_identity.as_deref()
                == Some(descriptor_identity.as_str())
            && input
                .expected_lifecycle_evidence
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    } else {
        input.expected_structured_revision.is_none()
            && input.expected_descriptor_identity.is_none()
            && input.expected_lifecycle_evidence.is_none()
    };
    let occurred_at_epoch_ms = DateTime::parse_from_rfc3339(&input.occurred_at)
        .map_err(|_| "FORMAL_SWITCH_OCCURRED_AT_INVALID".to_string())?
        .timestamp_millis();
    let expected_current_logical_identity = format!(
        "{}:{}:{}:current:{}",
        kind.as_str(), input.owner_id, channel.as_str(), input.old_current_file_ref_id
    );
    let expected_target_logical_identity = format!(
        "{}:{}:{}:independent:{}",
        kind.as_str(), input.owner_id, channel.as_str(), input.target_file_ref_id
    );
    if input.operation_id.trim().is_empty()
        || input.owner_id.trim().is_empty()
        || input.occurred_at.trim().is_empty()
        || occurred_at_epoch_ms != input.occurred_at_epoch_ms
        || input.preview_snapshot_identity.trim().is_empty()
        || input.old_current_file_ref_id == input.target_file_ref_id
        || input.current_runtime.file_ref_id != input.old_current_file_ref_id
        || input.target_runtime.file_ref_id != input.target_file_ref_id
        || input.current_runtime.logical_identity != expected_current_logical_identity
        || input.target_runtime.logical_identity != expected_target_logical_identity
        || input.current_runtime.actual_runtime_handle.trim().is_empty()
        || input.target_runtime.actual_runtime_handle.trim().is_empty()
        || input.current_runtime.runtime_consumer_id.trim().is_empty()
        || input.target_runtime.runtime_consumer_id.trim().is_empty()
        || !review_evidence_valid
    {
        return Err("FORMAL_SWITCH_BRIDGE_INPUT_INVALID".into());
    }
    let old_file = read_file_ref(connection, kind, channel, &input.owner_id, &input.old_current_file_ref_id)?;
    let default_file = read_file_ref(connection, kind, channel, &input.owner_id, &input.default_file_ref_id)?;
    let target_file = read_file_ref(connection, kind, channel, &input.owner_id, &input.target_file_ref_id)?;
    if old_file.path_identity == target_file.path_identity { return Err("FORMAL_SWITCH_TARGET_CONFLICT".into()); }
    let old = physical_snapshot(&old_file)?;
    let target = physical_snapshot(&target_file)?;
    if old.revision != input.old_current_physical_revision || target.revision != input.target_physical_revision {
        return Err("FORMAL_SWITCH_PHYSICAL_REVISION_CONFLICT".into());
    }
    if old.bytes.len() as u64 > MAX_MARKDOWN_FILE_BYTES || target.bytes.len() as u64 > MAX_MARKDOWN_FILE_BYTES {
        return Err("MANUSCRIPT_FILE_TOO_LARGE".into());
    }
    let replacement_bytes = input.expected_old_current_post_text.as_bytes().to_vec();
    let replacement_has_bom = replacement_bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    if replacement_has_bom != (old.encoding == "utf-8-bom") {
        return Err("FORMAL_SWITCH_OLD_CURRENT_ENCODING_CONFLICT".into());
    }
    let replacement_dto =
        normalized_replacements(kind, channel, owner_subtype, &input.replacements)?;
    let current_runtime = input.current_runtime.mounted();
    let target_runtime = input.target_runtime.mounted();
    let mut envelope = FormalSwitchImmutableEnvelopeV1 {
        operation_id: input.operation_id.clone(), payload_version: 1,
        canonical_encoding_version: "CanonicalEnvelopeEncodingV1".into(), engine_contract_version: 1,
        descriptor_identity, descriptor_version: 1,
        descriptor_hash: sha256(&descriptor_bytes), candidate_contract_version: 1,
        settlement_plan_version: 1, transaction_payload_version: 1, recovery_payload_version: 1,
        owner_type: kind.owner_type(), owner_id: input.owner_id.clone(),
        manuscript_channel: channel.canonical(),
        entry_kind: FormalSwitchEntryKind::UserConfirmedSwitch, owner_subtype,
        old_current_file_ref_identity: old_file.id.clone(), default_file_ref_identity: default_file.id,
        target_file_ref_identity: target_file.id.clone(),
        old_current_logical_session_identity: current_runtime.logical_identity.clone(),
        target_logical_session_identity: target_runtime.logical_identity.clone(),
        candidate: CandidateIdentityV1 {
            file_ref_identity: target_file.id.clone(), physical_revision: target.revision.clone(),
            sha256: target.sha256, byte_length: target.bytes.len() as u64, encoding: target.encoding,
        },
        replacement_dto, owner_protected_row_digest: [0; 32], binding_digest: [0; 32],
        lifecycle_coverage_digest: [0; 32], old_current_expected_physical_revision: old.revision,
        settlement_plan: SettlementPlanV1 {
            byte_start: 0, byte_end: old.bytes.len() as u64,
            expected_whole_file_hash: old.sha256,
            expected_controlled_region_preimage_hash: sha256(&old.bytes),
            expected_whole_file_post_hash: sha256(&replacement_bytes),
            replacement_bytes,
            bom_state: if old.encoding == "utf-8-bom" { "UTF8_BOM" } else { "ABSENT" }.into(),
            line_ending_policy: "PRESERVE_SNAPSHOT_EXACT".into(), boundary_newline_ownership: "NONE".into(),
            write_once_operation_id: input.operation_id.clone(),
        },
        transaction_payload: Vec::new(), success_operation_log_id: input.operation_id.clone(),
        formal_switch_operation_id: input.operation_id.clone(),
        activation_logical_identity: format!("{}:{}:{}:current", kind.as_str(), input.owner_id, channel.as_str()),
        finalization_identity: "pending".into(), operation_custody_identity: "pending".into(),
        created_at_epoch_ms: input.occurred_at_epoch_ms,
    };
    let selected_applier = applier(kind);
    let binding = read_binding(connection, &envelope)?;
    if binding.current_file_ref_id.as_deref() != Some(input.old_current_file_ref_id.as_str())
        || binding.default_manuscript_file_ref_id.as_deref() != Some(input.default_file_ref_id.as_str())
        || binding.owner_type != kind.as_str() || binding.owner_id != input.owner_id
        || binding.manuscript_channel != channel.as_str() || binding.deleted_at.is_some()
    { return Err("FORMAL_SWITCH_BINDING_IDENTITY_CONFLICT".into()); }
    let lifecycle = selected_applier.read_owner_lifecycle(connection, &envelope)?;
    envelope.lifecycle_coverage_digest = lifecycle_coverage_digest(&envelope, &lifecycle, &binding)?;
    envelope.binding_digest = binding_digest(&binding)?;
    let owner = selected_applier.read_owner_state(connection, &envelope)?;
    if kind == ReferenceOwnerKind::Review {
        let state = review_state(connection, &envelope)?;
        if Some(state.structured_revision) != input.expected_structured_revision
            || input.expected_descriptor_identity.as_deref()
                != Some(state.descriptor_identity.as_str())
            || input.expected_lifecycle_evidence.as_deref()
                != Some(state.lifecycle_evidence.as_str())
            || state.lifecycle_status != "active"
        {
            return Err("FORMAL_SWITCH_REVIEW_STRUCTURED_EVIDENCE_CONFLICT".into());
        }
    }
    if (!kind.allows_missing_project() && owner.project_id.is_none()) || lifecycle.owner_deleted_at.is_some()
        || lifecycle.parent_chain.iter().any(|parent| parent.deleted_at.is_some())
    { return Err("FORMAL_SWITCH_OWNER_LIFECYCLE_CONFLICT".into()); }
    envelope.owner_protected_row_digest = owner_protected_row_digest(&envelope, &owner, envelope.lifecycle_coverage_digest)?;
    envelope.transaction_payload = canonical_transaction_payload_bytes(&envelope)?;
    envelope.finalization_identity = derive_finalization_identity(&envelope)?;
    let confirmation = freeze_confirmation_identity(FormalSwitchFinalConfirmationEvidenceV1 {
        evidence_identity: String::new(), operation_id: input.operation_id.clone(),
        owner_type: kind.as_str().into(), owner_id: input.owner_id.clone(), manuscript_channel: channel.as_str().into(),
        entry_kind: "USER_CONFIRMED_SWITCH".into(), old_current_file_ref_identity: old_file.id.clone(),
        target_file_ref_identity: target_file.id.clone(), candidate_file_ref_identity: target_file.id.clone(),
        candidate_physical_revision: target.revision, candidate_sha256: target.sha256,
        candidate_byte_length: target.bytes.len() as u64,
        replacement_dto_sha256: super::formal_switch_execution::replacement_dto_sha256(&envelope.replacement_dto)?,
        descriptor_identity: envelope.descriptor_identity.clone(), descriptor_version: 1,
        descriptor_sha256: envelope.descriptor_hash, preview_snapshot_identity: input.preview_snapshot_identity.clone(),
    })?;
    envelope.operation_custody_identity = confirmation.evidence_identity.clone();
    let port = BridgeRevalidationPort {
        connection, applier: selected_applier, confirmation_identity: confirmation.evidence_identity.clone(),
        current_runtime: current_runtime.clone(), target_runtime: target_runtime.clone(), old_file, target_file,
    };
    let executable = revalidate_and_prepare_exact(
        connection, &envelope, &confirmation, Some(&current_runtime), Some(&target_runtime), &port,
    )?.executable;
    let mut process = target_cleanup_process_state()
        .lock()
        .map_err(|_| "FORMAL_SWITCH_TARGET_CLEANUP_PROCESS_STATE_POISONED".to_string())?;
    process
        .fresh_operations
        .insert(executable.envelope.operation_id.clone());
    process
        .attempted_operations
        .remove(&executable.envelope.operation_id);
    Ok(executable)
}

fn payload_hash(executable: &ExecutableFormalSwitchOperationV1) -> Result<[u8; 32], String> {
    executable.record.payload_sha256.as_slice().try_into().map_err(|_| "FORMAL_SWITCH_PAYLOAD_HASH_INVALID".into())
}

fn frozen_target_candidate_matches(
    connection: &Connection,
    executable: &ExecutableFormalSwitchOperationV1,
    kind: ReferenceOwnerKind,
    channel: ReferenceManuscriptChannel,
) -> Result<bool, String> {
    let target = read_file_ref(
        connection,
        kind,
        channel,
        &executable.envelope.owner_id,
        &executable.envelope.target_file_ref_identity,
    )?;
    let actual = physical_snapshot(&target)?;
    let expected = &executable.envelope.candidate;
    Ok(actual.revision == expected.physical_revision
        && actual.sha256 == expected.sha256
        && actual.bytes.len() as u64 == expected.byte_length
        && actual.encoding == expected.encoding)
}

const ARCHIVE_BEGIN_MARKER: &[u8] =
    b"<!-- LABPOD:STRUCTURED_OUTLINE_ARCHIVE_BEGIN_V1 -->";
const ARCHIVE_BEGIN_HINT_PREFIX: &[u8] =
    b"<!-- LABPOD:STRUCTURED_OUTLINE_ARCHIVE_BEGIN_V1 | ";
const ARCHIVE_END_MARKER: &[u8] =
    b"<!-- LABPOD:STRUCTURED_OUTLINE_ARCHIVE_END_V1 -->";
const ARCHIVE_COMMENT_SUFFIX: &[u8] = b" -->";

fn exact_archive_begin_line(line: &[u8]) -> bool {
    if line == ARCHIVE_BEGIN_MARKER {
        return true;
    }
    if !line.starts_with(ARCHIVE_BEGIN_HINT_PREFIX)
        || !line.ends_with(ARCHIVE_COMMENT_SUFFIX)
    {
        return false;
    }
    let hint = &line[ARCHIVE_BEGIN_HINT_PREFIX.len()
        ..line.len() - ARCHIVE_COMMENT_SUFFIX.len()];
    !hint.is_empty() && !hint.windows(2).any(|window| window == b"--")
}

fn scan_exact_archive_marker_spans(
    bytes: &[u8],
) -> Vec<ReferenceOwnerTargetCleanupSpanInput> {
    let mut spans = Vec::new();
    let mut cursor = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        3
    } else {
        0
    };
    while cursor <= bytes.len() {
        let line_start = cursor;
        let mut line_end = cursor;
        while line_end < bytes.len() && bytes[line_end] != b'\n' && bytes[line_end] != b'\r' {
            line_end += 1;
        }
        let mut owned_end = line_end;
        if bytes.get(line_end) == Some(&b'\r') {
            owned_end += if bytes.get(line_end + 1) == Some(&b'\n') { 2 } else { 1 };
        } else if bytes.get(line_end) == Some(&b'\n') {
            owned_end += 1;
        }
        let line = &bytes[line_start..line_end];
        let marker_kind = if exact_archive_begin_line(line) {
            Some("BEGIN")
        } else if line == ARCHIVE_END_MARKER {
            Some("END")
        } else {
            None
        };
        if let Some(marker_kind) = marker_kind {
            spans.push(ReferenceOwnerTargetCleanupSpanInput {
                line_start_byte: line_start as u64,
                owned_end_byte: owned_end as u64,
                marker_kind: marker_kind.into(),
            });
        }
        if owned_end >= bytes.len() {
            break;
        }
        cursor = owned_end;
    }
    spans
}

fn cleanup_result(
    operation_id: &str,
    attempted: bool,
    classification: &str,
    actual: &ExplicitPhysicalSnapshot,
) -> ReferenceOwnerFormalSwitchBridgeResult {
    ReferenceOwnerFormalSwitchBridgeResult::TargetCleanup {
        operation_id: operation_id.into(),
        attempted,
        classification: classification.into(),
        actual_physical_revision: actual.revision.clone(),
        actual_raw_byte_length: actual.bytes.len() as u64,
    }
}

fn cleanup_target_once(
    connection: &Connection,
    operation_id: &str,
    cleanup: &ReferenceOwnerTargetCleanupInput,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    let executable = canonical_engine().recovery.read_verified(connection, operation_id)?;
    let kind = ReferenceOwnerKind::parse(executable.envelope.owner_type.as_str())?;
    let channel = ReferenceManuscriptChannel::parse(
        kind,
        executable.envelope.manuscript_channel.as_str(),
    )?;
    let target_file = read_file_ref(
        connection,
        kind,
        channel,
        &executable.envelope.owner_id,
        &executable.envelope.target_file_ref_identity,
    )?;
    let before = physical_snapshot(&target_file)?;
    let admitted = {
        let mut process = target_cleanup_process_state()
            .lock()
            .map_err(|_| "FORMAL_SWITCH_TARGET_CLEANUP_PROCESS_STATE_POISONED".to_string())?;
        if !process.fresh_operations.contains(operation_id)
            || process.attempted_operations.contains(operation_id)
            || executable.record.state.phase != "activation_pending"
        {
            false
        } else {
            process.attempted_operations.insert(operation_id.into());
            true
        }
    };
    if !admitted {
        return Ok(cleanup_result(operation_id, false, "NOT_CLEANED", &before));
    }
    let candidate = &executable.envelope.candidate;
    if cleanup.expected_revision != candidate.physical_revision
        || cleanup.expected_pre_byte_length != candidate.byte_length
    {
        return Ok(cleanup_result(operation_id, false, "NOT_CLEANED", &before));
    }
    if before.revision != candidate.physical_revision
        || before.sha256 != candidate.sha256
        || before.bytes.len() as u64 != candidate.byte_length
        || before.encoding != candidate.encoding
    {
        return Ok(cleanup_result(operation_id, false, "TARGET_CHANGED", &before));
    }
    let scanned = scan_exact_archive_marker_spans(&before.bytes);
    if scanned != cleanup.exact_marker_spans {
        return Ok(cleanup_result(operation_id, false, "NOT_CLEANED", &before));
    }
    if scanned.is_empty() {
        return Ok(cleanup_result(operation_id, false, "CLEAN", &before));
    }
    let mut post_bytes = Vec::with_capacity(before.bytes.len());
    let mut cursor = 0usize;
    for span in &scanned {
        let start = usize::try_from(span.line_start_byte)
            .map_err(|_| "FORMAL_SWITCH_TARGET_CLEANUP_SPAN_INVALID".to_string())?;
        let end = usize::try_from(span.owned_end_byte)
            .map_err(|_| "FORMAL_SWITCH_TARGET_CLEANUP_SPAN_INVALID".to_string())?;
        if start < cursor || start > end || end > before.bytes.len() {
            return Ok(cleanup_result(operation_id, false, "NOT_CLEANED", &before));
        }
        post_bytes.extend_from_slice(&before.bytes[cursor..start]);
        cursor = end;
    }
    post_bytes.extend_from_slice(&before.bytes[cursor..]);
    if post_bytes != cleanup.expected_post_text.as_bytes()
        || post_bytes.len() as u64 > MAX_MARKDOWN_FILE_BYTES
        || std::str::from_utf8(&post_bytes).is_err()
    {
        return Ok(cleanup_result(operation_id, false, "NOT_CLEANED", &before));
    }
    let pre_hash = sha256(&before.bytes);
    let post_hash = sha256(&post_bytes);
    let cas = apply_explicit_manuscript_byte_range_atomic(&AtomicByteRangeCasInput {
        file_path: &target_file.path,
        expected_path_identity: &target_file.path_identity,
        expected_file_name: &target_file.file_name,
        expected_revision: &cleanup.expected_revision,
        expected_whole_file_sha256: &pre_hash,
        byte_start: 0,
        byte_end: before.bytes.len() as u64,
        expected_region_sha256: &pre_hash,
        replacement_bytes: &post_bytes,
        expected_post_sha256: &post_hash,
        location_mode: &target_file.location_mode,
        configured_root: target_file.configured_root.as_deref(),
    });
    let after = physical_snapshot(&target_file)?;
    let classification = match cas {
        Ok(result)
            if matches!(
                result.status,
                AtomicByteRangeCasStatus::Applied | AtomicByteRangeCasStatus::AlreadyPost
            ) && after.bytes == post_bytes => "CLEAN",
        Ok(result)
            if matches!(
                result.status,
                AtomicByteRangeCasStatus::RevisionConflict
                    | AtomicByteRangeCasStatus::PreconditionConflict
            ) => "TARGET_CHANGED",
        Ok(_) => "RESIDUE",
        Err(_) if after.bytes == post_bytes => "CLEAN",
        Err(_) => "NOT_CLEANED",
    };
    Ok(cleanup_result(operation_id, true, classification, &after))
}

fn contain_or_block(
    connection: &Connection,
    executable: &ExecutableFormalSwitchOperationV1,
    contained: bool,
    now: i64,
) -> Result<(), String> {
    mark_contained_or_blocked_cas(
        connection, &executable.envelope.operation_id, &executable.record.state.phase,
        executable.record.phase_revision, &payload_hash(executable)?, contained,
        (&executable.record.state.settlement_outcome, &executable.record.state.db_outcome, &executable.record.state.activation_outcome), now,
    ).map(|_| ()).map_err(|error| format!("FORMAL_SWITCH_CONTAINMENT_FAILED:{error:?}"))
}

fn activation_result(
    connection: &Connection,
    executable: &ExecutableFormalSwitchOperationV1,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    let kind = ReferenceOwnerKind::parse(executable.envelope.owner_type.as_str())?;
    let channel = ReferenceManuscriptChannel::parse(
        kind,
        executable.envelope.manuscript_channel.as_str(),
    )?;
    let classification = super::formal_switch_execution::classify_durable_db_state(connection, executable, applier(kind));
    let finalization = derive_pre_activation_finalization(executable, classification)?;
    Ok(ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
        operation_id: finalization.operation_id, owner_type: finalization.owner_type,
        owner_id: finalization.owner_id, manuscript_channel: channel.as_str().into(),
        owner_subtype: executable.envelope.owner_subtype.map(|value| value.as_str().into()),
        target_file_ref_id: finalization.target_file_ref_identity,
        default_file_ref_id: executable.envelope.default_file_ref_identity.clone(),
        activation_logical_identity: finalization.activation_logical_identity,
        finalization_identity: finalization.finalization_identity,
    })
}

fn drive_to_activation(
    connection: &mut Connection,
    operation_id: &str,
    occurred_at: &str,
    now: i64,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    validate_legacy_drain(connection)?;
    for _ in 0..10 {
        let executable = canonical_engine().recovery.read_verified(connection, operation_id)?;
        let kind = ReferenceOwnerKind::parse(executable.envelope.owner_type.as_str())?;
        let channel = ReferenceManuscriptChannel::parse(
            kind,
            executable.envelope.manuscript_channel.as_str(),
        )?;
        let selected_applier = applier(kind);
        if matches!(
            executable.record.state.phase.as_str(),
            "prepared"
                | "settlement_started"
                | "settlement_complete"
                | "db_pending"
        ) && !frozen_target_candidate_matches(connection, &executable, kind, channel)?
        {
            contain_or_block(connection, &executable, false, now)?;
            return Err("FORMAL_SWITCH_TARGET_CANDIDATE_CONFLICT".into());
        }
        match executable.record.state.phase.as_str() {
            "prepared" => {
                let started = canonical_engine().recovery.begin_settlement(connection, &executable, now)?;
                let file = read_file_ref(connection, kind, channel, &started.envelope.owner_id, &started.envelope.old_current_file_ref_identity)?;
                match execute_settlement_atomic(&started.envelope, &resolved_old_current(&file))? {
                    outcome @ (SettlementExecutionOutcomeV1::Applied | SettlementExecutionOutcomeV1::AlreadyApplied) => {
                        canonical_engine().recovery.complete_settlement(connection, &started, outcome, now)?;
                    }
                    SettlementExecutionOutcomeV1::Conflict => {
                        contain_or_block(connection, &started, false, now)?;
                        return Err("FORMAL_SWITCH_SETTLEMENT_CONFLICT".into());
                    }
                    SettlementExecutionOutcomeV1::Unknown => {
                        contain_or_block(connection, &started, true, now)?;
                        return Err("FORMAL_SWITCH_SETTLEMENT_UNKNOWN".into());
                    }
                }
            }
            "settlement_started" => {
                let file = read_file_ref(connection, kind, channel, &executable.envelope.owner_id, &executable.envelope.old_current_file_ref_identity)?;
                match execute_settlement_atomic(&executable.envelope, &resolved_old_current(&file))? {
                    outcome @ (SettlementExecutionOutcomeV1::Applied | SettlementExecutionOutcomeV1::AlreadyApplied) => {
                        canonical_engine().recovery.complete_settlement(connection, &executable, outcome, now)?;
                    }
                    SettlementExecutionOutcomeV1::Conflict => {
                        contain_or_block(connection, &executable, false, now)?;
                        return Err("FORMAL_SWITCH_SETTLEMENT_CONFLICT".into());
                    }
                    SettlementExecutionOutcomeV1::Unknown => {
                        contain_or_block(connection, &executable, true, now)?;
                        return Err("FORMAL_SWITCH_SETTLEMENT_UNKNOWN".into());
                    }
                }
            }
            "settlement_complete" => { canonical_engine().recovery.begin_db(connection, &executable, now)?; }
            "db_pending" => {
                let outcome = match canonical_engine().recovery.continue_db_only(
                    connection, &executable, &canonical_engine().transaction, selected_applier, occurred_at,
                ) {
                    Ok(outcome) => outcome,
                    Err(error) if error.contains("DURABLE_STATE_UNVERIFIABLE") => {
                        contain_or_block(connection, &executable, false, now)?;
                        return Err("FORMAL_SWITCH_DB_CAS_CONFLICT".into());
                    }
                    Err(error) => return Err(error),
                };
                match outcome {
                    CanonicalTransactionResultV1::Committed | CanonicalTransactionResultV1::AlreadyCommitted => {
                        canonical_engine().recovery.complete_db(connection, &executable, outcome, now)?;
                    }
                    CanonicalTransactionResultV1::CasConflict => {
                        contain_or_block(connection, &executable, false, now)?;
                        return Err("FORMAL_SWITCH_DB_CAS_CONFLICT".into());
                    }
                    CanonicalTransactionResultV1::Inconsistent => {
                        contain_or_block(connection, &executable, true, now)?;
                        return Err("FORMAL_SWITCH_DB_INCONSISTENT".into());
                    }
                }
            }
            "db_complete" => {
                let classification = super::formal_switch_execution::classify_durable_db_state(connection, &executable, selected_applier);
                derive_pre_activation_finalization(&executable, classification)?;
                let pending = canonical_engine().recovery.begin_activation(connection, &executable, now)?;
                return activation_result(connection, &pending);
            }
            "activation_pending" => return activation_result(connection, &executable),
            "resolved" => return Ok(ReferenceOwnerFormalSwitchBridgeResult::Resolved {
                operation_id: executable.envelope.operation_id, owner_type: kind.as_str().into(),
                owner_id: executable.envelope.owner_id, manuscript_channel: channel.as_str().into(),
                owner_subtype: executable.envelope.owner_subtype.map(|value| value.as_str().into()),
                target_file_ref_id: executable.envelope.target_file_ref_identity,
                default_file_ref_id: executable.envelope.default_file_ref_identity,
            }),
            "cancelled_safe" => return Err("FORMAL_SWITCH_OPERATION_CANCELLED_SAFE".into()),
            "contained" | "blocked" => return Err("FORMAL_SWITCH_OPERATION_REQUIRES_ADJUDICATION".into()),
            _ => return Err("FORMAL_SWITCH_PHASE_UNKNOWN".into()),
        }
    }
    Err("FORMAL_SWITCH_DRIVE_LIMIT_EXCEEDED".into())
}

struct ObservedRuntimePort {
    snapshot: RuntimeActivationSnapshotV1,
}

impl CanonicalRuntimeReacquisitionPortV1 for ObservedRuntimePort {
    fn fresh_reacquire(
        &self,
        finalization: &super::formal_switch_execution::CanonicalFormalSwitchFinalizationResultV1,
    ) -> Result<RuntimeActivationSnapshotV1, String> {
        if self.snapshot.logical_identity != finalization.activation_logical_identity
            || self.snapshot.file_ref_identity != finalization.target_file_ref_identity
        { return Err("FORMAL_SWITCH_ACTIVATION_IDENTITY_MISMATCH".into()); }
        Ok(self.snapshot.clone())
    }

    fn read_actual_state(&self, snapshot: &RuntimeActivationSnapshotV1) -> Result<RuntimeActivationSnapshotV1, String> {
        Ok(snapshot.clone())
    }

    fn activate_idempotently(
        &self,
        _snapshot: &RuntimeActivationSnapshotV1,
        _finalization: &super::formal_switch_execution::CanonicalFormalSwitchFinalizationResultV1,
    ) -> Result<(), String> {
        if self.snapshot.exact_active { Ok(()) } else { Err("FORMAL_SWITCH_RUNTIME_NOT_ACTIVE".into()) }
    }
}

fn resolve_activation(
    connection: &Connection,
    operation_id: &str,
    activation: &ReferenceOwnerActivationInput,
    now: i64,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    let executable = canonical_engine().recovery.read_verified(connection, operation_id)?;
    if executable.record.state.phase == "resolved" {
        return Ok(ReferenceOwnerFormalSwitchBridgeResult::Resolved {
            operation_id: executable.envelope.operation_id, owner_type: executable.envelope.owner_type.as_str().into(),
            owner_id: executable.envelope.owner_id,
            manuscript_channel: executable.envelope.manuscript_channel.as_str().into(),
            owner_subtype: executable.envelope.owner_subtype.map(|value| value.as_str().into()),
            target_file_ref_id: executable.envelope.target_file_ref_identity,
            default_file_ref_id: executable.envelope.default_file_ref_identity,
        });
    }
    if executable.record.state.phase != "activation_pending" { return Err("FORMAL_SWITCH_ACTIVATION_PHASE_INVALID".into()); }
    let kind = ReferenceOwnerKind::parse(executable.envelope.owner_type.as_str())?;
    let channel = ReferenceManuscriptChannel::parse(
        kind,
        executable.envelope.manuscript_channel.as_str(),
    )?;
    let binding = read_binding(connection, &executable.envelope)?;
    if binding.current_file_ref_id.as_deref()
        != Some(executable.envelope.target_file_ref_identity.as_str())
        || binding.owner_type != kind.as_str()
        || binding.owner_id != executable.envelope.owner_id
        || binding.manuscript_channel != channel.as_str()
        || binding.deleted_at.is_some()
    {
        return Err("FORMAL_SWITCH_ACTIVATION_BINDING_CONFLICT".into());
    }
    let target_file = read_file_ref(
        connection,
        kind,
        channel,
        &executable.envelope.owner_id,
        &executable.envelope.target_file_ref_identity,
    )?;
    let actual_target = physical_snapshot(&target_file)?;
    if activation.authoritative_physical_revision != actual_target.revision
        || activation.authoritative_raw_byte_length != actual_target.bytes.len() as u64
    {
        return Err("FORMAL_SWITCH_ACTIVATION_ACTUAL_TARGET_CONFLICT".into());
    }
    let classification = super::formal_switch_execution::classify_durable_db_state(connection, &executable, applier(kind));
    let finalization = derive_pre_activation_finalization(&executable, classification)?;
    let port = ObservedRuntimePort { snapshot: RuntimeActivationSnapshotV1 {
        actual_runtime_handle: activation.actual_runtime_handle.clone(), runtime_generation: activation.runtime_generation,
        runtime_consumer_id: activation.runtime_consumer_id.clone(), logical_identity: activation.logical_identity.clone(),
        file_ref_identity: activation.file_ref_id.clone(), exact_active: activation.exact_active,
    }};
    let outcome = canonical_engine().activation.converge(&finalization, &port);
    let resolved = canonical_engine().recovery.resolve(connection, &executable, outcome, now)?;
    if resolved.record.state.phase != "resolved" { return Err("FORMAL_SWITCH_ACTIVATION_CONVERGENCE_UNKNOWN".into()); }
    Ok(ReferenceOwnerFormalSwitchBridgeResult::Resolved {
        operation_id: resolved.envelope.operation_id, owner_type: kind.as_str().into(),
        owner_id: resolved.envelope.owner_id,
        manuscript_channel: resolved.envelope.manuscript_channel.as_str().into(),
        owner_subtype: resolved.envelope.owner_subtype.map(|value| value.as_str().into()),
        target_file_ref_id: resolved.envelope.target_file_ref_identity,
        default_file_ref_id: resolved.envelope.default_file_ref_identity,
    })
}

fn reference_owner_relationships(
    connection: &Connection,
    kind: ReferenceOwnerKind,
    owner_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    match kind {
        ReferenceOwnerKind::Experiment => connection
            .query_row(
                "SELECT project_id FROM experiments WHERE id=?1",
                [owner_id],
                |row| Ok((None, Some(row.get(0)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_EXPERIMENT_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::ExperimentRun => connection
            .query_row(
                "SELECT experiment_id,project_id FROM experiment_runs WHERE id=?1",
                [owner_id],
                |row| Ok((Some(row.get(0)?), Some(row.get(1)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_RUN_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::Literature => connection
            .query_row(
                "SELECT primary_project_id FROM literatures WHERE id=?1",
                [owner_id],
                |row| Ok((None, row.get(0)?)),
            )
            .map_err(|error| format!("FORMAL_SWITCH_LITERATURE_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::Review => Ok((None, None)),
        ReferenceOwnerKind::ResultItem => connection
            .query_row(
                "SELECT project_id FROM result_items WHERE id=?1",
                [owner_id],
                |row| Ok((None, Some(row.get(0)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_RESULT_ITEM_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::Finding => connection
            .query_row(
                "SELECT project_id FROM findings WHERE id=?1",
                [owner_id],
                |row| Ok((None, Some(row.get(0)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_FINDING_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::OutputCandidate => connection
            .query_row(
                "SELECT project_id FROM output_candidates WHERE id=?1",
                [owner_id],
                |row| Ok((None, Some(row.get(0)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_OUTPUT_CANDIDATE_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::OutputGap => connection
            .query_row(
                "SELECT project_id FROM output_gaps WHERE id=?1",
                [owner_id],
                |row| Ok((None, Some(row.get(0)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_OUTPUT_GAP_RELATIONSHIP_READ_FAILED:{error}")),
        ReferenceOwnerKind::ResearchOutput => connection
            .query_row(
                "SELECT project_id FROM outputs WHERE id=?1",
                [owner_id],
                |row| Ok((None, Some(row.get(0)?))),
            )
            .map_err(|error| format!("FORMAL_SWITCH_RESEARCH_OUTPUT_RELATIONSHIP_READ_FAILED:{error}")),
    }
}

fn list_recoveries(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
    manuscript_channel: &str,
    owner_subtype: Option<&str>,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    validate_legacy_drain(connection)?;
    let kind = ReferenceOwnerKind::parse(owner_type)?;
    let channel = ReferenceManuscriptChannel::parse(kind, manuscript_channel)?;
    let expected_subtype = canonical_owner_subtype(kind, owner_subtype)?;
    let summaries = read_unresolved_operation_summaries(connection)?;
    let mut items = Vec::new();
    for summary in summaries.into_iter().filter(|item| item.owner_type == kind.as_str() && item.owner_id == owner_id) {
        let executable = canonical_engine().recovery.read_verified(connection, &summary.operation_id)?;
        if executable.envelope.manuscript_channel.as_str() != channel.as_str() {
            continue;
        }
        if executable.envelope.owner_subtype != expected_subtype {
            continue;
        }
        let (parent_owner_id, project_id) = reference_owner_relationships(connection, kind, &summary.owner_id)?;
        items.push(ReferenceOwnerRecoverySummary {
            operation_id: summary.operation_id, owner_type: summary.owner_type, owner_id: summary.owner_id,
            manuscript_channel: channel.as_str().into(),
            owner_subtype: executable.envelope.owner_subtype.map(|value| value.as_str().into()),
            phase: summary.phase, phase_revision: summary.phase_revision, terminal_code: summary.terminal_code,
            old_current_file_ref_id: executable.envelope.old_current_file_ref_identity,
            default_file_ref_id: executable.envelope.default_file_ref_identity,
            target_file_ref_id: executable.envelope.target_file_ref_identity,
            parent_owner_id,
            project_id,
            created_at_epoch_ms: executable.envelope.created_at_epoch_ms,
        });
    }
    Ok(ReferenceOwnerFormalSwitchBridgeResult::Recoveries { items })
}

fn discover_recoveries(connection: &Connection) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    validate_legacy_drain(connection)?;
    let mut items = Vec::new();
    for summary in read_unresolved_operation_summaries(connection)? {
        if !matches!(
            summary.owner_type.as_str(),
            "experiment"
                | "experimentRun"
                | "literature"
                | "review"
                | "resultItem"
                | "finding"
                | "outputCandidate"
                | "outputGap"
                | "researchOutput"
        ) {
            continue;
        }
        let executable = canonical_engine().recovery.read_verified(connection, &summary.operation_id)?;
        let kind = ReferenceOwnerKind::parse(&summary.owner_type)?;
        let channel = ReferenceManuscriptChannel::parse(
            kind,
            executable.envelope.manuscript_channel.as_str(),
        )?;
        let (parent_owner_id, project_id) = reference_owner_relationships(connection, kind, &summary.owner_id)?;
        items.push(ReferenceOwnerRecoverySummary {
            operation_id: summary.operation_id, owner_type: summary.owner_type, owner_id: summary.owner_id,
            manuscript_channel: channel.as_str().into(),
            owner_subtype: executable.envelope.owner_subtype.map(|value| value.as_str().into()),
            phase: summary.phase, phase_revision: summary.phase_revision, terminal_code: summary.terminal_code,
            old_current_file_ref_id: executable.envelope.old_current_file_ref_identity,
            default_file_ref_id: executable.envelope.default_file_ref_identity,
            target_file_ref_id: executable.envelope.target_file_ref_identity,
            parent_owner_id,
            project_id,
            created_at_epoch_ms: executable.envelope.created_at_epoch_ms,
        });
    }
    Ok(ReferenceOwnerFormalSwitchBridgeResult::Recoveries { items })
}

fn cancel_prepared(
    connection: &Connection,
    operation_id: &str,
    now: i64,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    let executable = canonical_engine().recovery.read_verified(connection, operation_id)?;
    if executable.record.state.phase != "prepared" { return Err("FORMAL_SWITCH_SAFE_CANCEL_NOT_ALLOWED".into()); }
    advance_phase_cas(
        connection, operation_id, "prepared", executable.record.phase_revision, &payload_hash(&executable)?,
        &FormalSwitchOperationState {
            phase: "cancelled_safe".into(), settlement_outcome: "UNKNOWN".into(),
            db_outcome: "NOT_APPLIED".into(), activation_outcome: "PENDING".into(),
            terminal_code: Some("CANCELLED_SAFE".into()),
        }, None, None, None, now,
    ).map_err(|error| format!("FORMAL_SWITCH_SAFE_CANCEL_FAILED:{error:?}"))?;
    Ok(ReferenceOwnerFormalSwitchBridgeResult::Canceled { operation_id: operation_id.into() })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn reference_owner_formal_switch_bridge(
    app: AppHandle,
    request: ReferenceOwnerFormalSwitchBridgeRequest,
) -> Result<ReferenceOwnerFormalSwitchBridgeResult, String> {
    let mut connection = super::open_connection(&app)?;
    match request {
        ReferenceOwnerFormalSwitchBridgeRequest::InspectLegacyDrain => {
            let drain = read_old_recovery_drain_snapshot(&connection)?;
            Ok(ReferenceOwnerFormalSwitchBridgeResult::LegacyDrain {
                experiment_unresolved: drain.experiment_unresolved,
                experiment_prepared_or_unknown: drain.experiment_prepared_or_unknown,
                experiment_run_unresolved: drain.run_unresolved,
                experiment_run_prepared_or_unknown: drain.run_prepared_or_unknown,
            })
        }
        ReferenceOwnerFormalSwitchBridgeRequest::Begin { input } => {
            let executable = build_and_prepare(&connection, &input)?;
            drive_to_activation(&mut connection, &executable.envelope.operation_id, &input.occurred_at, input.occurred_at_epoch_ms)
        }
        ReferenceOwnerFormalSwitchBridgeRequest::Continue { operation_id, occurred_at, occurred_at_epoch_ms } => {
            drive_to_activation(&mut connection, &operation_id, &occurred_at, occurred_at_epoch_ms)
        }
        ReferenceOwnerFormalSwitchBridgeRequest::ResolveActivation { operation_id, activation, occurred_at_epoch_ms } => {
            resolve_activation(&connection, &operation_id, &activation, occurred_at_epoch_ms)
        }
        ReferenceOwnerFormalSwitchBridgeRequest::CleanupTarget { operation_id, cleanup } => {
            cleanup_target_once(&connection, &operation_id, &cleanup)
        }
        ReferenceOwnerFormalSwitchBridgeRequest::ListRecoveries {
            owner_type,
            owner_id,
            manuscript_channel,
            owner_subtype,
        } => {
            list_recoveries(
                &connection,
                &owner_type,
                &owner_id,
                &manuscript_channel,
                owner_subtype.as_deref(),
            )
        }
        ReferenceOwnerFormalSwitchBridgeRequest::DiscoverRecoveries => discover_recoveries(&connection),
        ReferenceOwnerFormalSwitchBridgeRequest::CancelPrepared { operation_id, occurred_at_epoch_ms } => {
            cancel_prepared(&connection, &operation_id, occurred_at_epoch_ms)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn frontend_camel_case_field_bearing_bridge_requests_deserialize_exactly() {
        let list = serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
            serde_json::json!({
                "action": "listRecoveries",
                "ownerType": "review",
                "ownerId": "review-1",
                "manuscriptChannel": "primary",
                "ownerSubtype": "stage"
            }),
        )
        .expect("frontend listRecoveries request");
        match list {
            ReferenceOwnerFormalSwitchBridgeRequest::ListRecoveries {
                owner_type,
                owner_id,
                manuscript_channel,
                owner_subtype,
            } => {
                assert_eq!(owner_type, "review");
                assert_eq!(owner_id, "review-1");
                assert_eq!(manuscript_channel, "primary");
                assert_eq!(owner_subtype.as_deref(), Some("stage"));
            }
            other => panic!("unexpected listRecoveries variant: {other:?}"),
        }

        let continue_request = serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
            serde_json::json!({
                "action": "continue",
                "operationId": "operation-continue",
                "occurredAt": "2026-08-11T18:00:00.000Z",
                "occurredAtEpochMs": 1_786_468_800_000_i64
            }),
        )
        .expect("frontend continue request");
        match continue_request {
            ReferenceOwnerFormalSwitchBridgeRequest::Continue {
                operation_id,
                occurred_at,
                occurred_at_epoch_ms,
            } => {
                assert_eq!(operation_id, "operation-continue");
                assert_eq!(occurred_at, "2026-08-11T18:00:00.000Z");
                assert_eq!(occurred_at_epoch_ms, 1_786_468_800_000_i64);
            }
            other => panic!("unexpected continue variant: {other:?}"),
        }

        let resolve = serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
            serde_json::json!({
                "action": "resolveActivation",
                "operationId": "operation-resolve",
                "activation": {
                    "actualRuntimeHandle": "runtime-1",
                    "runtimeGeneration": 7,
                    "runtimeConsumerId": "consumer-1",
                    "logicalIdentity": "experimentRun:run-1:primary:current",
                    "fileRefId": "file-ref-1",
                    "exactActive": true,
                    "authoritativePhysicalRevision": "revision-1",
                    "authoritativeRawByteLength": 123
                },
                "occurredAtEpochMs": 1_786_468_800_123_i64
            }),
        )
        .expect("frontend resolveActivation request");
        match resolve {
            ReferenceOwnerFormalSwitchBridgeRequest::ResolveActivation {
                operation_id,
                activation,
                occurred_at_epoch_ms,
            } => {
                assert_eq!(operation_id, "operation-resolve");
                assert_eq!(activation.actual_runtime_handle, "runtime-1");
                assert_eq!(activation.runtime_generation, 7);
                assert_eq!(activation.runtime_consumer_id, "consumer-1");
                assert_eq!(
                    activation.logical_identity,
                    "experimentRun:run-1:primary:current"
                );
                assert_eq!(activation.file_ref_id, "file-ref-1");
                assert!(activation.exact_active);
                assert_eq!(activation.authoritative_physical_revision, "revision-1");
                assert_eq!(activation.authoritative_raw_byte_length, 123);
                assert_eq!(occurred_at_epoch_ms, 1_786_468_800_123_i64);
            }
            other => panic!("unexpected resolveActivation variant: {other:?}"),
        }

        let cancel = serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
            serde_json::json!({
                "action": "cancelPrepared",
                "operationId": "operation-cancel",
                "occurredAtEpochMs": 1_786_468_800_456_i64
            }),
        )
        .expect("frontend cancelPrepared request");
        match cancel {
            ReferenceOwnerFormalSwitchBridgeRequest::CancelPrepared {
                operation_id,
                occurred_at_epoch_ms,
            } => {
                assert_eq!(operation_id, "operation-cancel");
                assert_eq!(occurred_at_epoch_ms, 1_786_468_800_456_i64);
            }
            other => panic!("unexpected cancelPrepared variant: {other:?}"),
        }

        assert!(serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
            serde_json::json!({
                "action": "listRecoveries",
                "owner_type": "experimentRun",
                "owner_id": "run-legacy",
                "manuscript_channel": "primary"
            })
        )
        .is_err());
    }

    #[test]
    fn frontend_camel_case_field_bearing_bridge_results_serialize_exactly() {
        let activation = serde_json::to_value(
            ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
                operation_id: "operation-1".into(),
                owner_type: "resultItem".into(),
                owner_id: "result-item-1".into(),
                manuscript_channel: "primary".into(),
                owner_subtype: None,
                target_file_ref_id: "target-1".into(),
                default_file_ref_id: "default-1".into(),
                activation_logical_identity:
                    "resultItem:result-item-1:primary:current".into(),
                finalization_identity: "finalization-1".into(),
            },
        )
        .expect("serialize activationRequired result");
        assert_eq!(activation["status"], "activationRequired");
        assert_eq!(activation["operationId"], "operation-1");
        assert_eq!(activation["ownerType"], "resultItem");
        assert_eq!(activation["ownerId"], "result-item-1");
        assert_eq!(activation["manuscriptChannel"], "primary");
        assert_eq!(activation["ownerSubtype"], serde_json::Value::Null);
        assert_eq!(activation["targetFileRefId"], "target-1");
        assert_eq!(activation["defaultFileRefId"], "default-1");
        assert_eq!(
            activation["activationLogicalIdentity"],
            "resultItem:result-item-1:primary:current"
        );
        assert_eq!(activation["finalizationIdentity"], "finalization-1");
        assert!(activation.get("operation_id").is_none());
        assert!(activation.get("owner_type").is_none());
        assert!(activation.get("target_file_ref_id").is_none());

        let cleanup = serde_json::to_value(
            ReferenceOwnerFormalSwitchBridgeResult::TargetCleanup {
                operation_id: "operation-1".into(),
                attempted: true,
                classification: "CLEAN".into(),
                actual_physical_revision: "revision-1".into(),
                actual_raw_byte_length: 42,
            },
        )
        .expect("serialize targetCleanup result");
        assert_eq!(cleanup["status"], "targetCleanup");
        assert_eq!(cleanup["operationId"], "operation-1");
        assert_eq!(cleanup["actualPhysicalRevision"], "revision-1");
        assert_eq!(cleanup["actualRawByteLength"], 42);
        assert!(cleanup.get("actual_physical_revision").is_none());
    }

    #[test]
    fn frontend_request_inventory_deserializes_fieldless_and_begin_actions() {
        assert!(matches!(
            serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
                serde_json::json!({ "action": "inspectLegacyDrain" })
            )
            .expect("frontend inspectLegacyDrain request"),
            ReferenceOwnerFormalSwitchBridgeRequest::InspectLegacyDrain
        ));
        assert!(matches!(
            serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
                serde_json::json!({ "action": "discoverRecoveries" })
            )
            .expect("frontend discoverRecoveries request"),
            ReferenceOwnerFormalSwitchBridgeRequest::DiscoverRecoveries
        ));

        let begin = serde_json::from_value::<ReferenceOwnerFormalSwitchBridgeRequest>(
            serde_json::json!({
                "action": "begin",
                "input": {
                    "ownerType": "experimentRun",
                    "ownerId": "run-1",
                    "manuscriptChannel": "primary",
                    "expectedStructuredRevision": 4,
                    "expectedDescriptorIdentity": "descriptor-1",
                    "expectedLifecycleEvidence": "lifecycle-1",
                    "operationId": "operation-begin",
                    "occurredAt": "2026-08-11T18:00:00.000Z",
                    "occurredAtEpochMs": 1_786_468_800_000_i64,
                    "oldCurrentFileRefId": "old-current",
                    "defaultFileRefId": "default",
                    "targetFileRefId": "target",
                    "oldCurrentPhysicalRevision": "old-revision",
                    "targetPhysicalRevision": "target-revision",
                    "expectedOldCurrentPostText": "expected post",
                    "replacements": [
                        { "stableKey": "conditionSummary", "value": "condition" }
                    ],
                    "previewSnapshotIdentity": "preview-1",
                    "currentRuntime": {
                        "actualRuntimeHandle": "current-runtime",
                        "runtimeGeneration": 3,
                        "runtimeConsumerId": "current-consumer",
                        "logicalIdentity": "experimentRun:run-1:primary:current",
                        "fileRefId": "old-current"
                    },
                    "targetRuntime": {
                        "actualRuntimeHandle": "target-runtime",
                        "runtimeGeneration": 5,
                        "runtimeConsumerId": "target-consumer",
                        "logicalIdentity": "experimentRun:run-1:primary:independent",
                        "fileRefId": "target"
                    }
                }
            }),
        )
        .expect("frontend begin request");
        match begin {
            ReferenceOwnerFormalSwitchBridgeRequest::Begin { input } => {
                assert_eq!(input.owner_type, "experimentRun");
                assert_eq!(input.owner_id, "run-1");
                assert_eq!(input.manuscript_channel, "primary");
                assert_eq!(input.expected_structured_revision, Some(4));
                assert_eq!(input.operation_id, "operation-begin");
                assert_eq!(input.replacements.len(), 1);
                assert_eq!(input.replacements[0].stable_key, "conditionSummary");
                assert_eq!(input.current_runtime.runtime_generation, 3);
                assert_eq!(input.target_runtime.runtime_generation, 5);
            }
            other => panic!("unexpected begin variant: {other:?}"),
        }
    }

    struct Fixture {
        root: PathBuf,
        connection: Connection,
        old_path: PathBuf,
        target_path: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn root(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("labpod-f2-2-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn identity(path: &Path) -> String {
        let mut value = crate::provisioning::path_for_result(&fs::canonicalize(path).unwrap()).replace('\\', "/");
        if value.len() > 1 && !value.ends_with(":/") { value = value.trim_end_matches('/').into(); }
        if cfg!(windows) || value.starts_with("//") { value = value.to_lowercase(); }
        value
    }

    fn review_state_for_test(
        connection: &Connection,
        review_id: &str,
    ) -> super::super::review_structured_state::ReviewStructuredStateRecord {
        super::super::review_structured_state::read_state_in_connection(
            connection,
            review_id,
        )
        .unwrap()
        .unwrap()
    }

    fn configure_review_type(fixture: &Fixture, review_type: &str) {
        let subtype = parse_review_subtype(review_type).unwrap();
        let sections = review_keys(subtype)
            .iter()
            .map(|key| super::super::review_structured_state::ReviewOutlineSectionRecord {
                key: (*key).into(),
                content: format!("old-{key}"),
            })
            .collect::<Vec<_>>();
        fixture.connection.execute(
            "UPDATE review_structured_states
             SET review_type=?1,descriptor_identity=?2,outline_sections_json=?3,
                 structured_revision=0,updated_at='2026-08-10T00:00:00.000Z'
             WHERE review_id='review-1'",
            params![
                review_type,
                format!("review/primary/{review_type}/v1"),
                serde_json::to_string(&sections).unwrap(),
            ],
        ).unwrap();
    }

    fn formal_switch_log_count(connection: &Connection, operation_id: &str) -> i64 {
        connection.query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id=?1",
            [operation_id],
            |row| row.get(0),
        ).unwrap()
    }

    fn output_structured_seed(kind: ReferenceOwnerKind) -> String {
        let keys = kind.keys(ReferenceManuscriptChannel::Primary);
        let mut fields = vec![serde_json::json!({
            "key": keys[0],
            "value": "retired-nested-direct",
            "order": 1,
        })];
        fields.extend(keys[1..].iter().enumerate().map(|(index, key)| {
            serde_json::json!({
                "key": key,
                "value": format!("old-{key}"),
                "order": index + 2,
            })
        }));
        fields.push(serde_json::json!({
            "key": "unownedNote",
            "value": "preserve-me",
            "order": 99,
        }));
        serde_json::to_string(&fields).unwrap()
    }

    fn seed(
        owner_type: ReferenceOwnerKind,
        channel: ReferenceManuscriptChannel,
    ) -> Fixture {
        ReferenceManuscriptChannel::parse(owner_type, channel.as_str()).unwrap();
        let root = root(&format!("{}-{}", owner_type.as_str(), channel.as_str()));
        let old_path = root.join("old.md");
        let default_path = root.join("default.md");
        let target_path = root.join("target.md");
        fs::write(&old_path, "# Old\nbody\n").unwrap();
        fs::write(&default_path, "# Default\n").unwrap();
        fs::write(&target_path, "# Candidate\ncanonical source\n").unwrap();
        let connection = Connection::open(root.join("state.sqlite3")).unwrap();
        super::super::schema::run_migrations(&connection).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        connection.execute(
            "INSERT INTO experiments (id,project_id,title,experiment_name,machine_object,fault_type,sensor_config,data_path,result_summary,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at,deleted_at) VALUES ('experiment-1','project-1','Parent','Parent','machine','fault','sensor','data','old-result','2026-08-10','1200','parent-workspace','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
            [],
        ).unwrap();
        let owner_id = match owner_type {
            ReferenceOwnerKind::Experiment => "experiment-1",
            ReferenceOwnerKind::ExperimentRun => {
                connection.execute(
                    "INSERT INTO experiment_runs (id,experiment_id,project_id,title,run_label,status,condition_summary,variable_parameter_summary,method_summary,result_summary,conclusion,summary_other,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at,deleted_at) VALUES ('run-1','experiment-1','project-1','Run','R1','planned','old-c','old-v','old-m','old-r','old-k','old-o','2026-08-10','1200','run-workspace','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [],
                ).unwrap();
                "run-1"
            }
            ReferenceOwnerKind::Literature => {
                let custom_fields = serde_json::to_string(&serde_json::json!([
                    {"id":"outlineResearchProblem","name":"outlineResearchProblem","value":"old-outline-problem","valueType":"text","group":"literatureStructuredOutline"},
                    {"id":"outlineLimitations","name":"outlineLimitations","value":"old-outline-limitations","valueType":"text","group":"literatureStructuredOutline"},
                    {"id":"knowledgeProjectSummary","name":"knowledgeProjectSummary","value":"old-notes-summary","valueType":"text","group":"literatureKnowledgeDeposit"},
                    {"id":"knowledgeProjectRelevance","name":"knowledgeProjectRelevance","value":"old-notes-relevance","valueType":"text","group":"literatureKnowledgeDeposit"},
                    {"id":"venueRank","name":"venueRank","value":"Q1","valueType":"text","group":"literatureIntro"}
                ])).unwrap();
                connection.execute(
                    "INSERT INTO literatures (id,title,authors,year,venue,publication_type,abstract,keywords,reading_status,importance,primary_project_id,tags,is_archived,schema_version,source,custom_fields,created_at,updated_at,deleted_at) VALUES ('literature-1','Literature','[]',2026,'Venue','journal','old-abstract','[]','unread','high',NULL,'[]',0,2,'manual',?1,'2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [custom_fields],
                ).unwrap();
                "literature-1"
            }
            ReferenceOwnerKind::Review => {
                let sections = REVIEW_STAGE_KEYS
                    .iter()
                    .map(|key| super::super::review_structured_state::ReviewOutlineSectionRecord {
                        key: (*key).into(),
                        content: format!("old-{key}"),
                    })
                    .collect::<Vec<_>>();
                connection.execute(
                    "INSERT INTO review_structured_states(review_id,review_type,descriptor_identity,outline_sections_json,structured_revision,created_at,updated_at) VALUES ('review-1','stage','review/primary/stage/v1',?1,0,'2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z')",
                    [serde_json::to_string(&sections).unwrap()],
                ).unwrap();
                "review-1"
            }
            ReferenceOwnerKind::ResultItem => {
                connection.execute(
                    "INSERT INTO result_items (id,project_id,source_type,source_id,title,result_type,status,structured_summary,summary,tags,is_asset,schema_version,custom_fields,created_at,updated_at,deleted_at) VALUES ('result-item-1','project-1','manual','source-1','Result item','observation','pending_review',?1,'old-direct','[]',0,1,'[]','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [output_structured_seed(owner_type)],
                ).unwrap();
                "result-item-1"
            }
            ReferenceOwnerKind::Finding => {
                connection.execute(
                    "INSERT INTO findings (id,project_id,title,summary,status,structured_summary,tags,schema_version,custom_fields,created_at,updated_at,deleted_at) VALUES ('finding-1','project-1','Finding','old-direct','pending_confirmation',?1,'[]',1,'[]','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [output_structured_seed(owner_type)],
                ).unwrap();
                "finding-1"
            }
            ReferenceOwnerKind::OutputCandidate => {
                connection.execute(
                    "INSERT INTO output_candidates (id,project_id,title,description,candidate_type,status,structured_summary,tags,schema_version,custom_fields,created_at,updated_at,deleted_at) VALUES ('candidate-1','project-1','Candidate','old-direct','paper','draft',?1,'[]',1,'[]','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [output_structured_seed(owner_type)],
                ).unwrap();
                connection.execute(
                    "INSERT INTO output_candidates (id,project_id,title,description,candidate_type,status,structured_summary,tags,schema_version,custom_fields,created_at,updated_at,deleted_at) VALUES ('candidate-other','project-1','Other candidate','other-direct','paper','draft','[]','[]',1,'[]','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [],
                ).unwrap();
                "candidate-1"
            }
            ReferenceOwnerKind::OutputGap => {
                connection.execute(
                    "INSERT INTO output_gaps (id,project_id,title,description,gap_type,status,structured_summary,schema_version,custom_fields,created_at,updated_at,deleted_at) VALUES ('gap-1','project-1','Gap','old-direct','evidence','open',?1,1,'[]','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [output_structured_seed(owner_type)],
                ).unwrap();
                "gap-1"
            }
            ReferenceOwnerKind::ResearchOutput => {
                connection.execute(
                    "INSERT INTO outputs (id,project_id,output_name,output_type,status,structured_summary,usable_for_paper,description,created_at,updated_at,deleted_at) VALUES ('output-1','project-1','Output','paper','draft',?1,0,'old-direct','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    [output_structured_seed(owner_type)],
                ).unwrap();
                "output-1"
            }
        };
        for (id, path) in [("old", &old_path), ("default", &default_path), ("target", &target_path)] {
            connection.execute(
                "INSERT INTO file_refs (id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,file_type,path,path_identity_key,title,created_at,updated_at,deleted_at) VALUES (?1,?2,?3,?4,'file','manuscript','external','markdown',?5,?6,?1,'2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                params![id, owner_type.as_str(), owner_id, channel.as_str(), path.to_string_lossy(), identity(path)],
            ).unwrap();
        }
        connection.execute(
            "INSERT INTO manuscript_bindings (id,owner_type,owner_id,manuscript_channel,default_manuscript_file_ref_id,current_file_ref_id,schema_version,created_at,updated_at,deleted_at) VALUES (?1,?2,?3,?4,'default','old',1,'2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
            params![format!("binding-{owner_id}-{}", channel.as_str()), owner_type.as_str(), owner_id, channel.as_str()],
        ).unwrap();
        if owner_type == ReferenceOwnerKind::Literature {
            let other_channel = if channel == ReferenceManuscriptChannel::LiteratureOutline {
                ReferenceManuscriptChannel::DedicatedNotes
            } else {
                ReferenceManuscriptChannel::LiteratureOutline
            };
            for role in ["old", "default", "target"] {
                let id = format!("other-{role}");
                let path = root.join(format!("other-{role}.md"));
                fs::write(&path, format!("# Other {role}\n")).unwrap();
                connection.execute(
                    "INSERT INTO file_refs (id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,file_type,path,path_identity_key,title,created_at,updated_at,deleted_at) VALUES (?1,'literature','literature-1',?2,'file','manuscript','external','markdown',?3,?4,?1,'2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                    params![id, other_channel.as_str(), path.to_string_lossy(), identity(&path)],
                ).unwrap();
            }
            connection.execute(
                "INSERT INTO manuscript_bindings (id,owner_type,owner_id,manuscript_channel,default_manuscript_file_ref_id,current_file_ref_id,schema_version,created_at,updated_at,deleted_at) VALUES (?1,'literature','literature-1',?2,'other-default','other-old',1,'2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',NULL)",
                params![format!("binding-literature-1-{}", other_channel.as_str()), other_channel.as_str()],
            ).unwrap();
        }
        Fixture { root, connection, old_path, target_path }
    }

    fn begin_input(
        fixture: &Fixture,
        kind: ReferenceOwnerKind,
        channel: ReferenceManuscriptChannel,
        operation_id: &str,
    ) -> ReferenceOwnerBeginInput {
        let owner_id = match kind {
            ReferenceOwnerKind::Experiment => "experiment-1",
            ReferenceOwnerKind::ExperimentRun => "run-1",
            ReferenceOwnerKind::Literature => "literature-1",
            ReferenceOwnerKind::Review => "review-1",
            ReferenceOwnerKind::ResultItem => "result-item-1",
            ReferenceOwnerKind::Finding => "finding-1",
            ReferenceOwnerKind::OutputCandidate => "candidate-1",
            ReferenceOwnerKind::OutputGap => "gap-1",
            ReferenceOwnerKind::ResearchOutput => "output-1",
        };
        let old_file = read_file_ref(&fixture.connection, kind, channel, owner_id, "old").unwrap();
        let target_file = read_file_ref(&fixture.connection, kind, channel, owner_id, "target").unwrap();
        let old = physical_snapshot(&old_file).unwrap();
        let target = physical_snapshot(&target_file).unwrap();
        let review_state = if kind == ReferenceOwnerKind::Review {
            Some(review_state_for_test(&fixture.connection, owner_id))
        } else {
            None
        };
        let owner_subtype = review_state
            .as_ref()
            .map(|state| parse_review_subtype(&state.review_type).unwrap());
        let replacements = canonical_keys(kind, channel, owner_subtype).unwrap().iter().map(|key| ReferenceOwnerReplacementInput {
            stable_key: (*key).into(), value: Some(format!("new-{key}")),
        }).collect();
        ReferenceOwnerBeginInput {
            owner_type: kind.as_str().into(), owner_id: owner_id.into(),
            manuscript_channel: channel.as_str().into(), operation_id: operation_id.into(),
            owner_subtype: owner_subtype.map(|value| value.as_str().into()),
            expected_structured_revision: review_state.as_ref().map(|state| state.structured_revision),
            expected_descriptor_identity: review_state.as_ref().map(|state| state.descriptor_identity.clone()),
            expected_lifecycle_evidence: review_state.as_ref().map(|state| state.lifecycle_evidence.clone()),
            occurred_at: "2026-08-10T01:00:00.000Z".into(), occurred_at_epoch_ms: 1_786_323_600_000,
            old_current_file_ref_id: "old".into(), default_file_ref_id: "default".into(), target_file_ref_id: "target".into(),
            old_current_physical_revision: old.revision, target_physical_revision: target.revision,
            expected_old_current_post_text: "# Old\ncanonical context\nbody\n".into(), replacements,
            preview_snapshot_identity: format!("preview-{operation_id}"),
            current_runtime: ReferenceOwnerRuntimeEvidenceInput {
                actual_runtime_handle: format!("current-{owner_id}"), runtime_generation: 1,
                runtime_consumer_id: format!("current-consumer-{owner_id}"),
                logical_identity: format!("{}:{owner_id}:{}:current:old", kind.as_str(), channel.as_str()), file_ref_id: "old".into(),
            },
            target_runtime: ReferenceOwnerRuntimeEvidenceInput {
                actual_runtime_handle: format!("target-{owner_id}"), runtime_generation: 1,
                runtime_consumer_id: format!("target-consumer-{owner_id}"),
                logical_identity: format!("{}:{owner_id}:{}:independent:target", kind.as_str(), channel.as_str()), file_ref_id: "target".into(),
            },
        }
    }

    fn resolve_ticket(
        connection: &Connection,
        result: ReferenceOwnerFormalSwitchBridgeResult,
    ) -> ReferenceOwnerFormalSwitchBridgeResult {
        let ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
            operation_id, target_file_ref_id, activation_logical_identity, ..
        } = result else { panic!("activation ticket required") };
        let executable = canonical_engine()
            .recovery
            .read_verified(connection, &operation_id)
            .unwrap();
        resolve_activation(connection, &operation_id, &ReferenceOwnerActivationInput {
            actual_runtime_handle: "activated-current".into(), runtime_generation: 2,
            runtime_consumer_id: "activated-consumer".into(), logical_identity: activation_logical_identity,
            file_ref_id: target_file_ref_id, exact_active: true,
            authoritative_physical_revision: executable.envelope.candidate.physical_revision,
            authoritative_raw_byte_length: executable.envelope.candidate.byte_length,
        }, 1_786_326_001_000).unwrap()
    }

    fn custom_value(raw: &str, key: &str) -> Option<String> {
        serde_json::from_str::<Vec<JsonValue>>(raw)
            .unwrap()
            .into_iter()
            .find(|field| literature_custom_field_matches(field, key))
            .and_then(|field| field.get("value").and_then(JsonValue::as_str).map(str::to_string))
    }

    fn has_custom_key(raw: &str, key: &str) -> bool {
        serde_json::from_str::<Vec<JsonValue>>(raw)
            .unwrap()
            .iter()
            .any(|field| literature_custom_field_matches(field, key))
    }

    fn output_owner_id(kind: ReferenceOwnerKind) -> &'static str {
        match kind {
            ReferenceOwnerKind::ResultItem => "result-item-1",
            ReferenceOwnerKind::Finding => "finding-1",
            ReferenceOwnerKind::OutputCandidate => "candidate-1",
            ReferenceOwnerKind::OutputGap => "gap-1",
            ReferenceOwnerKind::ResearchOutput => "output-1",
            _ => panic!("Outputs owner required"),
        }
    }

    fn output_direct_and_structured(
        connection: &Connection,
        kind: ReferenceOwnerKind,
    ) -> (String, String) {
        let owner_id = output_owner_id(kind);
        match kind {
            ReferenceOwnerKind::ResultItem => connection.query_row(
                "SELECT summary,structured_summary FROM result_items WHERE id=?1",
                [owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ),
            ReferenceOwnerKind::Finding => connection.query_row(
                "SELECT summary,structured_summary FROM findings WHERE id=?1",
                [owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ),
            ReferenceOwnerKind::OutputCandidate => connection.query_row(
                "SELECT description,structured_summary FROM output_candidates WHERE id=?1",
                [owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ),
            ReferenceOwnerKind::OutputGap => connection.query_row(
                "SELECT description,structured_summary FROM output_gaps WHERE id=?1",
                [owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ),
            ReferenceOwnerKind::ResearchOutput => connection.query_row(
                "SELECT description,structured_summary FROM outputs WHERE id=?1",
                [owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ),
            _ => panic!("Outputs owner required"),
        }
        .unwrap()
    }

    fn output_structured_value(raw: &str, key: &str) -> Option<String> {
        serde_json::from_str::<Vec<JsonValue>>(raw)
            .unwrap()
            .into_iter()
            .find(|field| field.get("key").and_then(JsonValue::as_str) == Some(key))
            .and_then(|field| field.get("value").and_then(JsonValue::as_str).map(str::to_string))
    }

    fn output_has_structured_key(raw: &str, key: &str) -> bool {
        serde_json::from_str::<Vec<JsonValue>>(raw)
            .unwrap()
            .iter()
            .any(|field| field.get("key").and_then(JsonValue::as_str) == Some(key))
    }

    fn mutate_output_unowned_state(
        connection: &Connection,
        kind: ReferenceOwnerKind,
    ) {
        let owner_id = output_owner_id(kind);
        let changed = match kind {
            ReferenceOwnerKind::ResultItem => connection.execute(
                "UPDATE result_items SET status='confirmed' WHERE id=?1",
                [owner_id],
            ),
            ReferenceOwnerKind::Finding => connection.execute(
                "UPDATE findings SET status='confirmed' WHERE id=?1",
                [owner_id],
            ),
            ReferenceOwnerKind::OutputCandidate => connection.execute(
                "UPDATE output_candidates SET status='ready' WHERE id=?1",
                [owner_id],
            ),
            ReferenceOwnerKind::OutputGap => connection.execute(
                "UPDATE output_gaps SET status='resolved' WHERE id=?1",
                [owner_id],
            ),
            ReferenceOwnerKind::ResearchOutput => connection.execute(
                "UPDATE outputs SET status='completed' WHERE id=?1",
                [owner_id],
            ),
            _ => panic!("Outputs owner required"),
        }
        .unwrap();
        assert_eq!(changed, 1);
    }

    #[test]
    fn experiment_reference_owner_uses_canonical_recovery_after_post_and_resolves_exactly_once() {
        let mut fixture = seed(ReferenceOwnerKind::Experiment, ReferenceManuscriptChannel::Primary);
        let target_before = fs::read(&fixture.target_path).unwrap();
        let prepared = build_and_prepare(&fixture.connection, &begin_input(&fixture, ReferenceOwnerKind::Experiment, ReferenceManuscriptChannel::Primary, "f2-2-experiment")).unwrap();
        let started = canonical_engine().recovery.begin_settlement(&fixture.connection, &prepared, 1_786_326_000_100).unwrap();
        let old = read_file_ref(&fixture.connection, ReferenceOwnerKind::Experiment, ReferenceManuscriptChannel::Primary, "experiment-1", "old").unwrap();
        assert_eq!(execute_settlement_atomic(&started.envelope, &resolved_old_current(&old)).unwrap(), SettlementExecutionOutcomeV1::Applied);
        let ticket = drive_to_activation(&mut fixture.connection, "f2-2-experiment", "2026-08-10T01:00:00.000Z", 1_786_326_000_200).unwrap();
        assert!(matches!(resolve_ticket(&fixture.connection, ticket), ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }));
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before, "target must remain byte-identical");
        assert_eq!(fs::read_to_string(&fixture.old_path).unwrap(), "# Old\ncanonical context\nbody\n");
        let (purpose, current, log_count): (String, String, i64) = fixture.connection.query_row(
            "SELECT e.purpose_and_question,b.current_file_ref_id,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f2-2-experiment') FROM experiments e JOIN manuscript_bindings b ON b.owner_id=e.id WHERE e.id='experiment-1'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(purpose, "new-purposeAndQuestion");
        assert_eq!(current, "target");
        assert_eq!(log_count, 1);
        let restarted = drive_to_activation(&mut fixture.connection, "f2-2-experiment", "2026-08-10T01:00:02.000Z", 1_786_326_002_000).unwrap();
        assert!(matches!(restarted, ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }));
    }

    #[test]
    fn experiment_run_reference_owner_preserves_parent_and_isolated_target_with_exact_mapping() {
        let mut fixture = seed(ReferenceOwnerKind::ExperimentRun, ReferenceManuscriptChannel::Primary);
        let target_before = fs::read(&fixture.target_path).unwrap();
        let input = begin_input(&fixture, ReferenceOwnerKind::ExperimentRun, ReferenceManuscriptChannel::Primary, "f2-2-run");
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let ticket = drive_to_activation(&mut fixture.connection, &prepared.envelope.operation_id, &input.occurred_at, input.occurred_at_epoch_ms).unwrap();
        assert!(matches!(resolve_ticket(&fixture.connection, ticket), ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }));
        let (experiment_id, condition, current, parent_title, log_count): (String, String, String, String, i64) = fixture.connection.query_row(
            "SELECT r.experiment_id,r.condition_summary,b.current_file_ref_id,e.title,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f2-2-run') FROM experiment_runs r JOIN experiments e ON e.id=r.experiment_id JOIN manuscript_bindings b ON b.owner_id=r.id WHERE r.id='run-1'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(experiment_id, "experiment-1");
        assert_eq!(condition, "new-conditionSummary");
        assert_eq!(current, "target");
        assert_eq!(parent_title, "Parent");
        assert_eq!(log_count, 1);
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
    }

    #[test]
    fn reference_owner_binding_cas_conflict_contains_without_owner_binding_or_success_log_repair() {
        let mut fixture = seed(ReferenceOwnerKind::ExperimentRun, ReferenceManuscriptChannel::Primary);
        let input = begin_input(&fixture, ReferenceOwnerKind::ExperimentRun, ReferenceManuscriptChannel::Primary, "f2-2-run-cas");
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        fixture.connection.execute(
            "UPDATE manuscript_bindings SET updated_at='external-writer' WHERE owner_id='run-1'", [],
        ).unwrap();
        let error = drive_to_activation(&mut fixture.connection, &prepared.envelope.operation_id, &input.occurred_at, input.occurred_at_epoch_ms).unwrap_err();
        assert!(error.contains("DB_CAS_CONFLICT"), "{error}");
        let (condition, current, updated_at, log_count, phase): (String, String, String, i64, String) = fixture.connection.query_row(
            "SELECT r.condition_summary,b.current_file_ref_id,b.updated_at,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f2-2-run-cas'),(SELECT phase FROM formal_switch_operations WHERE operation_id='f2-2-run-cas') FROM experiment_runs r JOIN manuscript_bindings b ON b.owner_id=r.id WHERE r.id='run-1'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(condition, "old-c");
        assert_eq!(current, "old");
        assert_eq!(updated_at, "external-writer");
        assert_eq!(log_count, 0);
        assert_eq!(phase, "blocked");
    }

    #[test]
    fn literature_outline_uses_canonical_transaction_and_preserves_notes_unowned_and_other_channel() {
        let channel = ReferenceManuscriptChannel::LiteratureOutline;
        let mut fixture = seed(ReferenceOwnerKind::Literature, channel);
        let target_before = fs::read(&fixture.target_path).unwrap();
        let mut input = begin_input(
            &fixture,
            ReferenceOwnerKind::Literature,
            channel,
            "f3-2-literature-outline",
        );
        input
            .replacements
            .iter_mut()
            .find(|item| item.stable_key == "limitations")
            .unwrap()
            .value = None;
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let ticket = drive_to_activation(
            &mut fixture.connection,
            &prepared.envelope.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms,
        ).unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
            manuscript_channel,
            ..
        } = &ticket else { panic!("activation ticket required") };
        assert_eq!(manuscript_channel, "literature_outline");
        assert!(matches!(
            resolve_ticket(&fixture.connection, ticket),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
        let (abstract_value, custom_fields, current, default_file, other_current, log_count):
            (String, String, String, String, String, i64) = fixture.connection.query_row(
                "SELECT l.abstract,l.custom_fields,b.current_file_ref_id,b.default_manuscript_file_ref_id,(SELECT current_file_ref_id FROM manuscript_bindings WHERE owner_type='literature' AND owner_id=l.id AND manuscript_channel='dedicated_notes'),(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f3-2-literature-outline') FROM literatures l JOIN manuscript_bindings b ON b.owner_type='literature' AND b.owner_id=l.id AND b.manuscript_channel='literature_outline' WHERE l.id='literature-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            ).unwrap();
        assert_eq!(abstract_value, "new-summary");
        assert_eq!(custom_value(&custom_fields, "outlineResearchProblem").as_deref(), Some("new-research_problem"));
        assert!(!has_custom_key(&custom_fields, "outlineLimitations"));
        assert_eq!(custom_value(&custom_fields, "knowledgeProjectSummary").as_deref(), Some("old-notes-summary"));
        assert_eq!(custom_value(&custom_fields, "venueRank").as_deref(), Some("Q1"));
        assert_eq!(current, "target");
        assert_eq!(default_file, "default");
        assert_eq!(other_current, "other-old");
        assert_eq!(log_count, 1);
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
    }

    #[test]
    fn literature_notes_recovery_survives_restart_and_activation_retry_without_reparse_or_cross_channel_write() {
        let channel = ReferenceManuscriptChannel::DedicatedNotes;
        let fixture = seed(ReferenceOwnerKind::Literature, channel);
        let target_before = fs::read(&fixture.target_path).unwrap();
        let mut input = begin_input(
            &fixture,
            ReferenceOwnerKind::Literature,
            channel,
            "f3-2-literature-notes-restart",
        );
        input
            .replacements
            .iter_mut()
            .find(|item| item.stable_key == "project_relevance")
            .unwrap()
            .value = None;
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::Recoveries {
            items: notes_recoveries,
        } = list_recoveries(
            &fixture.connection,
            "literature",
            "literature-1",
            "dedicated_notes",
            None,
        )
        .unwrap()
        else {
            panic!("notes recovery list required")
        };
        assert_eq!(notes_recoveries.len(), 1);
        assert_eq!(notes_recoveries[0].manuscript_channel, "dedicated_notes");
        let ReferenceOwnerFormalSwitchBridgeResult::Recoveries {
            items: outline_recoveries,
        } = list_recoveries(
            &fixture.connection,
            "literature",
            "literature-1",
            "literature_outline",
            None,
        )
        .unwrap()
        else {
            panic!("outline recovery list required")
        };
        assert!(outline_recoveries.is_empty());
        let started = canonical_engine().recovery.begin_settlement(
            &fixture.connection,
            &prepared,
            input.occurred_at_epoch_ms + 1,
        ).unwrap();
        let old = read_file_ref(
            &fixture.connection,
            ReferenceOwnerKind::Literature,
            channel,
            "literature-1",
            "old",
        ).unwrap();
        assert_eq!(
            execute_settlement_atomic(&started.envelope, &resolved_old_current(&old)).unwrap(),
            SettlementExecutionOutcomeV1::Applied
        );
        let mut restarted = Connection::open(fixture.root.join("state.sqlite3")).unwrap();
        let ticket = drive_to_activation(
            &mut restarted,
            &prepared.envelope.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms + 2,
        ).unwrap();
        let activation_retry = drive_to_activation(
            &mut restarted,
            &prepared.envelope.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms + 3,
        ).unwrap();
        assert!(matches!(ticket, ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired { .. }));
        assert!(matches!(
            resolve_ticket(&restarted, activation_retry),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
        let (abstract_value, custom_fields, current, other_current, log_count):
            (String, String, String, String, i64) = restarted.query_row(
                "SELECT l.abstract,l.custom_fields,b.current_file_ref_id,(SELECT current_file_ref_id FROM manuscript_bindings WHERE owner_type='literature' AND owner_id=l.id AND manuscript_channel='literature_outline'),(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f3-2-literature-notes-restart') FROM literatures l JOIN manuscript_bindings b ON b.owner_type='literature' AND b.owner_id=l.id AND b.manuscript_channel='dedicated_notes' WHERE l.id='literature-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            ).unwrap();
        assert_eq!(abstract_value, "old-abstract");
        assert_eq!(custom_value(&custom_fields, "outlineResearchProblem").as_deref(), Some("old-outline-problem"));
        assert_eq!(custom_value(&custom_fields, "knowledgeProjectSummary").as_deref(), Some("new-summary"));
        assert!(!has_custom_key(&custom_fields, "knowledgeProjectRelevance"));
        assert_eq!(custom_value(&custom_fields, "venueRank").as_deref(), Some("Q1"));
        assert_eq!(current, "target");
        assert_eq!(other_current, "other-old");
        assert_eq!(log_count, 1);
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
    }

    #[test]
    fn literature_shared_owner_row_conflict_blocks_owner_binding_and_success_log() {
        let channel = ReferenceManuscriptChannel::LiteratureOutline;
        let mut fixture = seed(ReferenceOwnerKind::Literature, channel);
        let input = begin_input(
            &fixture,
            ReferenceOwnerKind::Literature,
            channel,
            "f3-2-literature-owner-cas",
        );
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let raw: String = fixture.connection.query_row(
            "SELECT custom_fields FROM literatures WHERE id='literature-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        let mut custom_fields = serde_json::from_str::<Vec<JsonValue>>(&raw).unwrap();
        custom_fields.push(serde_json::json!({
            "id":"knowledgeOther","name":"knowledgeOther","value":"concurrent-notes-write","valueType":"text","group":"literatureKnowledgeDeposit"
        }));
        fixture.connection.execute(
            "UPDATE literatures SET custom_fields=?1 WHERE id='literature-1'",
            [serde_json::to_string(&custom_fields).unwrap()],
        ).unwrap();
        let error = drive_to_activation(
            &mut fixture.connection,
            &prepared.envelope.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(error.contains("DB_CAS_CONFLICT"), "{error}");
        let (abstract_value, current, log_count, phase): (String, String, i64, String) =
            fixture.connection.query_row(
                "SELECT l.abstract,b.current_file_ref_id,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f3-2-literature-owner-cas'),(SELECT phase FROM formal_switch_operations WHERE operation_id='f3-2-literature-owner-cas') FROM literatures l JOIN manuscript_bindings b ON b.owner_type='literature' AND b.owner_id=l.id AND b.manuscript_channel='literature_outline' WHERE l.id='literature-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).unwrap();
        assert_eq!(abstract_value, "old-abstract");
        assert_eq!(current, "old");
        assert_eq!(log_count, 0);
        assert_eq!(phase, "blocked");
    }

    #[test]
    fn literature_candidate_and_lifecycle_conflicts_have_no_owner_binding_or_success_log_commit() {
        let channel = ReferenceManuscriptChannel::DedicatedNotes;
        let candidate_fixture = seed(ReferenceOwnerKind::Literature, channel);
        let candidate_input = begin_input(
            &candidate_fixture,
            ReferenceOwnerKind::Literature,
            channel,
            "f3-2-literature-target-conflict",
        );
        fs::write(&candidate_fixture.target_path, "# Changed target\n").unwrap();
        let candidate_error = build_and_prepare(&candidate_fixture.connection, &candidate_input).unwrap_err();
        assert!(candidate_error.contains("PHYSICAL_REVISION_CONFLICT"), "{candidate_error}");
        let candidate_operation_count: i64 = candidate_fixture.connection.query_row(
            "SELECT COUNT(*) FROM formal_switch_operations WHERE operation_id='f3-2-literature-target-conflict'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(candidate_operation_count, 0);

        let mut lifecycle_fixture = seed(ReferenceOwnerKind::Literature, channel);
        let lifecycle_input = begin_input(
            &lifecycle_fixture,
            ReferenceOwnerKind::Literature,
            channel,
            "f3-2-literature-lifecycle-conflict",
        );
        let prepared = build_and_prepare(&lifecycle_fixture.connection, &lifecycle_input).unwrap();
        lifecycle_fixture.connection.execute(
            "UPDATE literatures SET deleted_at='2026-08-10T01:00:01.000Z' WHERE id='literature-1'",
            [],
        ).unwrap();
        let lifecycle_error = drive_to_activation(
            &mut lifecycle_fixture.connection,
            &prepared.envelope.operation_id,
            &lifecycle_input.occurred_at,
            lifecycle_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(lifecycle_error.contains("DB_CAS_CONFLICT"), "{lifecycle_error}");
        let (current, log_count): (String, i64) = lifecycle_fixture.connection.query_row(
            "SELECT b.current_file_ref_id,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f3-2-literature-lifecycle-conflict') FROM manuscript_bindings b WHERE b.owner_type='literature' AND b.owner_id='literature-1' AND b.manuscript_channel='dedicated_notes'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(current, "old");
        assert_eq!(log_count, 0);
    }

    #[test]
    fn output_candidate_canonical_chain_survives_restart_and_resolves_exactly_once() {
        let kind = ReferenceOwnerKind::OutputCandidate;
        let channel = ReferenceManuscriptChannel::Primary;
        let fixture = seed(kind, channel);
        let target_before = fs::read(&fixture.target_path).unwrap();
        let mut input = begin_input(
            &fixture,
            kind,
            channel,
            "f3-3-output-candidate-restart",
        );
        input
            .replacements
            .iter_mut()
            .find(|item| item.stable_key == "risksAndGaps")
            .unwrap()
            .value = None;
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::Recoveries { items } = list_recoveries(
            &fixture.connection,
            kind.as_str(),
            output_owner_id(kind),
            channel.as_str(),
            None,
        ).unwrap() else { panic!("Outputs Recovery list required") };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].owner_type, "outputCandidate");
        assert_eq!(items[0].manuscript_channel, "primary");

        let started = canonical_engine().recovery.begin_settlement(
            &fixture.connection,
            &prepared,
            input.occurred_at_epoch_ms + 1,
        ).unwrap();
        let old = read_file_ref(
            &fixture.connection,
            kind,
            channel,
            output_owner_id(kind),
            "old",
        ).unwrap();
        assert_eq!(
            execute_settlement_atomic(&started.envelope, &resolved_old_current(&old)).unwrap(),
            SettlementExecutionOutcomeV1::Applied
        );

        let mut restarted = Connection::open(fixture.root.join("state.sqlite3")).unwrap();
        let ticket = drive_to_activation(
            &mut restarted,
            &prepared.envelope.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms + 2,
        ).unwrap();
        assert!(matches!(ticket, ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired { .. }));
        let activation_retry = drive_to_activation(
            &mut restarted,
            &prepared.envelope.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms + 3,
        ).unwrap();
        assert!(matches!(
            resolve_ticket(&restarted, activation_retry),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
        assert!(matches!(
            drive_to_activation(
                &mut restarted,
                &prepared.envelope.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms + 4,
            ).unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));

        let (direct, structured) = output_direct_and_structured(&restarted, kind);
        assert_eq!(direct, "new-coreClaim");
        assert_eq!(output_structured_value(&structured, "outputType").as_deref(), Some("new-outputType"));
        assert_eq!(output_structured_value(&structured, "risksAndGaps").as_deref(), Some(""));
        assert_eq!(output_structured_value(&structured, "unownedNote").as_deref(), Some("preserve-me"));
        assert!(!output_has_structured_key(&structured, "coreClaim"));
        let (current, default_file, log_count, other_direct): (String, String, i64, String) = restarted.query_row(
            "SELECT b.current_file_ref_id,b.default_manuscript_file_ref_id,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id='f3-3-output-candidate-restart'),(SELECT description FROM output_candidates WHERE id='candidate-other') FROM manuscript_bindings b WHERE b.owner_type='outputCandidate' AND b.owner_id='candidate-1' AND b.manuscript_channel='primary'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(current, "target");
        assert_eq!(default_file, "default");
        assert_eq!(log_count, 1);
        assert_eq!(other_direct, "other-direct", "another Outputs owner must stay isolated");
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
        assert_eq!(fs::read_to_string(&fixture.old_path).unwrap(), "# Old\ncanonical context\nbody\n");
    }

    #[test]
    fn other_outputs_owners_share_exact_mapping_clear_preservation_and_zero_target_write() {
        for kind in [
            ReferenceOwnerKind::ResultItem,
            ReferenceOwnerKind::Finding,
            ReferenceOwnerKind::OutputGap,
            ReferenceOwnerKind::ResearchOutput,
        ] {
            let channel = ReferenceManuscriptChannel::Primary;
            let mut fixture = seed(kind, channel);
            let target_before = fs::read(&fixture.target_path).unwrap();
            let operation_id = format!("f3-3-{}-success", kind.as_str());
            let mut input = begin_input(&fixture, kind, channel, &operation_id);
            let cleared_key = kind.keys(channel).last().unwrap().to_string();
            input
                .replacements
                .iter_mut()
                .find(|item| item.stable_key == cleared_key)
                .unwrap()
                .value = None;
            let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
            let ticket = drive_to_activation(
                &mut fixture.connection,
                &prepared.envelope.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms,
            ).unwrap();
            assert!(matches!(
                resolve_ticket(&fixture.connection, ticket),
                ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
            ));
            let keys = kind.keys(channel);
            let (direct, structured) = output_direct_and_structured(&fixture.connection, kind);
            assert_eq!(direct, format!("new-{}", keys[0]));
            for key in &keys[1..] {
                let expected = if *key == cleared_key {
                    String::new()
                } else {
                    format!("new-{key}")
                };
                assert_eq!(
                    output_structured_value(&structured, key).as_deref(),
                    Some(expected.as_str()),
                    "{} exact mapping for {key}",
                    kind.as_str(),
                );
            }
            assert_eq!(output_structured_value(&structured, "unownedNote").as_deref(), Some("preserve-me"));
            assert!(!output_has_structured_key(&structured, keys[0]));
            let (current, default_file): (String, String) = fixture.connection.query_row(
                "SELECT current_file_ref_id,default_manuscript_file_ref_id FROM manuscript_bindings WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel='primary'",
                params![kind.as_str(), output_owner_id(kind)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            let log_count: i64 = fixture.connection.query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id=?1",
                [&operation_id],
                |row| row.get(0),
            ).unwrap();
            assert_eq!(current, "target");
            assert_eq!(default_file, "default");
            assert_eq!(log_count, 1);
            assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
        }

        for kind in [
            ReferenceOwnerKind::ResultItem,
            ReferenceOwnerKind::Finding,
            ReferenceOwnerKind::OutputCandidate,
            ReferenceOwnerKind::OutputGap,
            ReferenceOwnerKind::ResearchOutput,
        ] {
            let channel = ReferenceManuscriptChannel::Primary;
            let mut fixture = seed(kind, channel);
            let target_before = fs::read(&fixture.target_path).unwrap();
            let operation_id = format!("f3-3-{}-full-clear", kind.as_str());
            let mut input = begin_input(&fixture, kind, channel, &operation_id);
            for replacement in &mut input.replacements {
                replacement.value = None;
            }
            let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
            let ticket = drive_to_activation(
                &mut fixture.connection,
                &prepared.envelope.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms,
            ).unwrap();
            assert!(matches!(
                resolve_ticket(&fixture.connection, ticket),
                ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
            ));
            let keys = kind.keys(channel);
            let (direct, structured) = output_direct_and_structured(&fixture.connection, kind);
            assert_eq!(direct, "", "{} direct CLEAR", kind.as_str());
            for key in &keys[1..] {
                assert_eq!(
                    output_structured_value(&structured, key).as_deref(),
                    Some(""),
                    "{} structured CLEAR for {key}",
                    kind.as_str(),
                );
            }
            assert_eq!(output_structured_value(&structured, "unownedNote").as_deref(), Some("preserve-me"));
            assert!(!output_has_structured_key(&structured, keys[0]));
            assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
        }
    }

    #[test]
    fn every_outputs_owner_detects_unowned_writer_with_zero_owner_binding_or_success_log_commit() {
        for kind in [
            ReferenceOwnerKind::ResultItem,
            ReferenceOwnerKind::Finding,
            ReferenceOwnerKind::OutputCandidate,
            ReferenceOwnerKind::OutputGap,
            ReferenceOwnerKind::ResearchOutput,
        ] {
            let channel = ReferenceManuscriptChannel::Primary;
            let mut fixture = seed(kind, channel);
            let target_before = fs::read(&fixture.target_path).unwrap();
            let operation_id = format!("f3-3-{}-owner-cas", kind.as_str());
            let input = begin_input(&fixture, kind, channel, &operation_id);
            let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
            mutate_output_unowned_state(&fixture.connection, kind);
            let error = drive_to_activation(
                &mut fixture.connection,
                &prepared.envelope.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms,
            ).unwrap_err();
            assert!(error.contains("DB_CAS_CONFLICT"), "{}: {error}", kind.as_str());
            let (direct, _) = output_direct_and_structured(&fixture.connection, kind);
            let current: String = fixture.connection.query_row(
                "SELECT current_file_ref_id FROM manuscript_bindings WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel='primary'",
                params![kind.as_str(), output_owner_id(kind)],
                |row| row.get(0),
            ).unwrap();
            let log_count: i64 = fixture.connection.query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id=?1",
                [&operation_id],
                |row| row.get(0),
            ).unwrap();
            assert_eq!(direct, "old-direct");
            assert_eq!(current, "old");
            assert_eq!(log_count, 0);
            assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
        }
    }

    #[test]
    fn output_candidate_binding_lifecycle_and_old_current_conflicts_fail_closed() {
        let kind = ReferenceOwnerKind::OutputCandidate;
        let channel = ReferenceManuscriptChannel::Primary;

        let mut binding_fixture = seed(kind, channel);
        let binding_input = begin_input(
            &binding_fixture,
            kind,
            channel,
            "f3-3-output-candidate-binding-cas",
        );
        let prepared = build_and_prepare(&binding_fixture.connection, &binding_input).unwrap();
        binding_fixture.connection.execute(
            "UPDATE manuscript_bindings SET updated_at='external-writer' WHERE owner_type='outputCandidate' AND owner_id='candidate-1' AND manuscript_channel='primary'",
            [],
        ).unwrap();
        let binding_error = drive_to_activation(
            &mut binding_fixture.connection,
            &prepared.envelope.operation_id,
            &binding_input.occurred_at,
            binding_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(binding_error.contains("DB_CAS_CONFLICT"), "{binding_error}");

        let mut lifecycle_fixture = seed(kind, channel);
        let lifecycle_input = begin_input(
            &lifecycle_fixture,
            kind,
            channel,
            "f3-3-output-candidate-lifecycle-cas",
        );
        let prepared = build_and_prepare(&lifecycle_fixture.connection, &lifecycle_input).unwrap();
        lifecycle_fixture.connection.execute(
            "UPDATE output_candidates SET deleted_at='2026-08-10T01:00:01.000Z' WHERE id='candidate-1'",
            [],
        ).unwrap();
        let lifecycle_error = drive_to_activation(
            &mut lifecycle_fixture.connection,
            &prepared.envelope.operation_id,
            &lifecycle_input.occurred_at,
            lifecycle_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(lifecycle_error.contains("DB_CAS_CONFLICT"), "{lifecycle_error}");

        let mut old_fixture = seed(kind, channel);
        let target_before = fs::read(&old_fixture.target_path).unwrap();
        let old_input = begin_input(
            &old_fixture,
            kind,
            channel,
            "f3-3-output-candidate-old-current-drift",
        );
        let prepared = build_and_prepare(&old_fixture.connection, &old_input).unwrap();
        fs::write(&old_fixture.old_path, "# Concurrent old-current write\n").unwrap();
        let old_error = drive_to_activation(
            &mut old_fixture.connection,
            &prepared.envelope.operation_id,
            &old_input.occurred_at,
            old_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(old_error.contains("SETTLEMENT_CONFLICT"), "{old_error}");
        assert_eq!(fs::read(&old_fixture.target_path).unwrap(), target_before);

        for (connection, operation_id) in [
            (&binding_fixture.connection, "f3-3-output-candidate-binding-cas"),
            (&lifecycle_fixture.connection, "f3-3-output-candidate-lifecycle-cas"),
            (&old_fixture.connection, "f3-3-output-candidate-old-current-drift"),
        ] {
            let (direct, _) = output_direct_and_structured(connection, kind);
            let current: String = connection.query_row(
                "SELECT current_file_ref_id FROM manuscript_bindings WHERE owner_type='outputCandidate' AND owner_id='candidate-1' AND manuscript_channel='primary'",
                [],
                |row| row.get(0),
            ).unwrap();
            let log_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id=?1",
                [operation_id],
                |row| row.get(0),
            ).unwrap();
            assert_eq!(direct, "old-direct");
            assert_eq!(current, "old");
            assert_eq!(log_count, 0);
        }
    }

    #[test]
    fn f3_5_all_review_formal_types_use_one_canonical_transaction_with_exact_isolation() {
        for review_type in [
            "stage",
            "periodic",
            "experiment_comparison",
            "literature_comparison",
            "custom",
        ] {
            let kind = ReferenceOwnerKind::Review;
            let channel = ReferenceManuscriptChannel::Primary;
            let mut fixture = seed(kind, channel);
            configure_review_type(&fixture, review_type);
            let target_before = fs::read(&fixture.target_path).unwrap();
            let operation_id = format!("f3-5-review-{review_type}-success");
            let mut input = begin_input(&fixture, kind, channel, &operation_id);
            input.replacements[1].value = None;
            let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
            assert_eq!(prepared.envelope.owner_type, FormalSwitchOwnerType::Review);
            assert_eq!(
                prepared.envelope.owner_subtype.map(|value| value.as_str()),
                Some(review_type)
            );
            assert_eq!(
                prepared.envelope.descriptor_identity,
                format!("review/primary/{review_type}/v1")
            );
            let ticket = drive_to_activation(
                &mut fixture.connection,
                &prepared.envelope.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms,
            ).unwrap();
            let ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
                owner_type,
                owner_subtype,
                owner_id,
                manuscript_channel,
                ..
            } = &ticket else { panic!("Review activation ticket required") };
            assert_eq!(owner_type, "review");
            assert_eq!(owner_subtype.as_deref(), Some(review_type));
            assert_eq!(owner_id, "review-1");
            assert_eq!(manuscript_channel, "primary");
            assert!(matches!(
                resolve_ticket(&fixture.connection, ticket),
                ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
            ));
            let state = review_state_for_test(&fixture.connection, "review-1");
            assert_eq!(state.review_type, review_type);
            assert_eq!(state.structured_revision, 1);
            assert_eq!(state.lifecycle_status, "active");
            assert_eq!(state.lifecycle_evidence, "review-lifecycle/v1:none");
            for (index, section) in state.outline_sections.iter().enumerate() {
                let expected = if index == 1 {
                    String::new()
                } else {
                    format!("new-{}", section.key)
                };
                assert_eq!(section.content, expected, "{review_type}:{}", section.key);
            }
            let (current, default_file): (String, String) = fixture.connection.query_row(
                "SELECT current_file_ref_id,default_manuscript_file_ref_id
                 FROM manuscript_bindings
                 WHERE owner_type='review' AND owner_id='review-1' AND manuscript_channel='primary'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(current, "target");
            assert_eq!(default_file, "default");
            assert_eq!(formal_switch_log_count(&fixture.connection, &operation_id), 1);
            let confirmation: String = fixture.connection.query_row(
                "SELECT confirmation FROM operation_logs WHERE formal_switch_operation_id=?1",
                [&operation_id],
                |row| row.get(0),
            ).unwrap();
            let evidence: JsonValue = serde_json::from_str(&confirmation).unwrap();
            assert_eq!(
                evidence.pointer("/exactPostEvidence/ownerSpecificPostEvidence/ownerSubtype")
                    .and_then(JsonValue::as_str),
                Some(review_type)
            );
            assert_eq!(
                evidence.pointer("/exactPostEvidence/ownerSpecificPostEvidence/structuredRevision")
                    .and_then(JsonValue::as_i64),
                Some(1)
            );
            assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
            assert!(matches!(
                drive_to_activation(
                    &mut fixture.connection,
                    &operation_id,
                    &input.occurred_at,
                    input.occurred_at_epoch_ms + 10,
                ).unwrap(),
                ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
            ));
            assert_eq!(
                review_state_for_test(&fixture.connection, "review-1").structured_revision,
                1
            );
            assert_eq!(formal_switch_log_count(&fixture.connection, &operation_id), 1);
        }
    }

    #[test]
    fn f3_5_review_generic_recovery_survives_restart_exact_commit_activation_retry_and_safe_cancel() {
        let kind = ReferenceOwnerKind::Review;
        let channel = ReferenceManuscriptChannel::Primary;
        let fixture = seed(kind, channel);
        configure_review_type(&fixture, "custom");
        let target_before = fs::read(&fixture.target_path).unwrap();
        let mut input = begin_input(
            &fixture,
            kind,
            channel,
            "f3-5-review-custom-restart",
        );
        input.replacements[2].value = None;
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::Recoveries { items } = list_recoveries(
            &fixture.connection,
            "review",
            "review-1",
            "primary",
            Some("custom"),
        ).unwrap() else { panic!("Review Recovery list required") };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].owner_subtype.as_deref(), Some("custom"));
        let ReferenceOwnerFormalSwitchBridgeResult::Recoveries { items } = list_recoveries(
            &fixture.connection,
            "review",
            "review-1",
            "primary",
            Some("stage"),
        ).unwrap() else { panic!("Review isolated Recovery list required") };
        assert!(items.is_empty());

        let started = canonical_engine().recovery.begin_settlement(
            &fixture.connection,
            &prepared,
            input.occurred_at_epoch_ms + 1,
        ).unwrap();
        let old = read_file_ref(
            &fixture.connection,
            kind,
            channel,
            "review-1",
            "old",
        ).unwrap();
        assert_eq!(
            execute_settlement_atomic(&started.envelope, &resolved_old_current(&old)).unwrap(),
            SettlementExecutionOutcomeV1::Applied
        );
        let settled = canonical_engine().recovery.complete_settlement(
            &fixture.connection,
            &started,
            SettlementExecutionOutcomeV1::Applied,
            input.occurred_at_epoch_ms + 2,
        ).unwrap();
        let db_pending = canonical_engine().recovery.begin_db(
            &fixture.connection,
            &settled,
            input.occurred_at_epoch_ms + 3,
        ).unwrap();
        let mut committed_connection = Connection::open(fixture.root.join("state.sqlite3")).unwrap();
        assert_eq!(
            canonical_engine().transaction.execute(
                &mut committed_connection,
                &db_pending,
                &REVIEW_APPLIER,
                &input.occurred_at,
            ).unwrap(),
            CanonicalTransactionResultV1::Committed
        );
        drop(committed_connection);
        assert_eq!(review_state_for_test(&fixture.connection, "review-1").structured_revision, 1);
        assert_eq!(formal_switch_log_count(&fixture.connection, &input.operation_id), 1);

        let mut restarted = Connection::open(fixture.root.join("state.sqlite3")).unwrap();
        let ticket = drive_to_activation(
            &mut restarted,
            &input.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms + 4,
        ).unwrap();
        let activation_retry = drive_to_activation(
            &mut restarted,
            &input.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms + 5,
        ).unwrap();
        assert!(matches!(ticket, ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired { .. }));
        assert!(matches!(
            resolve_ticket(&restarted, activation_retry),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
        assert!(matches!(
            drive_to_activation(
                &mut restarted,
                &input.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms + 6,
            ).unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
        assert_eq!(review_state_for_test(&restarted, "review-1").structured_revision, 1);
        assert_eq!(formal_switch_log_count(&restarted, &input.operation_id), 1);
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);

        let cancel_fixture = seed(kind, channel);
        configure_review_type(&cancel_fixture, "stage");
        let cancel_target_before = fs::read(&cancel_fixture.target_path).unwrap();
        let cancel_input = begin_input(
            &cancel_fixture,
            kind,
            channel,
            "f3-5-review-stage-safe-cancel",
        );
        build_and_prepare(&cancel_fixture.connection, &cancel_input).unwrap();
        assert!(matches!(
            cancel_prepared(
                &cancel_fixture.connection,
                &cancel_input.operation_id,
                cancel_input.occurred_at_epoch_ms + 1,
            ).unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::Canceled { .. }
        ));
        assert_eq!(
            review_state_for_test(&cancel_fixture.connection, "review-1").structured_revision,
            0
        );
        let current: String = cancel_fixture.connection.query_row(
            "SELECT current_file_ref_id FROM manuscript_bindings
             WHERE owner_type='review' AND owner_id='review-1' AND manuscript_channel='primary'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(current, "old");
        assert_eq!(formal_switch_log_count(&cancel_fixture.connection, &cancel_input.operation_id), 0);
        assert_eq!(fs::read(&cancel_fixture.target_path).unwrap(), cancel_target_before);
    }

    #[test]
    fn f3_5_review_structured_descriptor_lifecycle_binding_and_target_conflicts_fail_closed() {
        let kind = ReferenceOwnerKind::Review;
        let channel = ReferenceManuscriptChannel::Primary;

        let descriptor_fixture = seed(kind, channel);
        let mut descriptor_input = begin_input(
            &descriptor_fixture,
            kind,
            channel,
            "f3-5-review-descriptor-conflict",
        );
        descriptor_input.expected_descriptor_identity =
            Some("review/primary/custom/v1".into());
        assert!(build_and_prepare(&descriptor_fixture.connection, &descriptor_input)
            .unwrap_err()
            .contains("BRIDGE_INPUT_INVALID"));

        let lifecycle_fixture = seed(kind, channel);
        let mut lifecycle_input = begin_input(
            &lifecycle_fixture,
            kind,
            channel,
            "f3-5-review-lifecycle-input-conflict",
        );
        lifecycle_input.expected_lifecycle_evidence = Some("stale-lifecycle".into());
        assert!(build_and_prepare(&lifecycle_fixture.connection, &lifecycle_input)
            .unwrap_err()
            .contains("STRUCTURED_EVIDENCE_CONFLICT"));

        let target_fixture = seed(kind, channel);
        let target_input = begin_input(
            &target_fixture,
            kind,
            channel,
            "f3-5-review-target-conflict",
        );
        fs::write(&target_fixture.target_path, "# Concurrent target write\n").unwrap();
        assert!(build_and_prepare(&target_fixture.connection, &target_input)
            .unwrap_err()
            .contains("PHYSICAL_REVISION_CONFLICT"));

        let mut target_drift_fixture = seed(kind, channel);
        let target_drift_input = begin_input(
            &target_drift_fixture,
            kind,
            channel,
            "f3-5-review-target-post-prepare-drift",
        );
        let prepared = build_and_prepare(
            &target_drift_fixture.connection,
            &target_drift_input,
        ).unwrap();
        let externally_changed_target = b"# Concurrent target write after prepare\n";
        fs::write(&target_drift_fixture.target_path, externally_changed_target).unwrap();
        assert!(drive_to_activation(
            &mut target_drift_fixture.connection,
            &prepared.envelope.operation_id,
            &target_drift_input.occurred_at,
            target_drift_input.occurred_at_epoch_ms,
        ).is_err());
        assert_eq!(
            fs::read(&target_drift_fixture.target_path).unwrap(),
            externally_changed_target
        );
        assert_eq!(
            formal_switch_log_count(
                &target_drift_fixture.connection,
                &target_drift_input.operation_id,
            ),
            0
        );

        let mut old_current_drift_fixture = seed(kind, channel);
        let old_current_drift_input = begin_input(
            &old_current_drift_fixture,
            kind,
            channel,
            "f3-5-review-old-current-post-prepare-drift",
        );
        let prepared = build_and_prepare(
            &old_current_drift_fixture.connection,
            &old_current_drift_input,
        ).unwrap();
        fs::write(
            &old_current_drift_fixture.old_path,
            "# Concurrent old-current write after prepare\n",
        ).unwrap();
        assert_eq!(
            drive_to_activation(
                &mut old_current_drift_fixture.connection,
                &prepared.envelope.operation_id,
                &old_current_drift_input.occurred_at,
                old_current_drift_input.occurred_at_epoch_ms,
            ).unwrap_err(),
            "FORMAL_SWITCH_SETTLEMENT_CONFLICT"
        );
        assert_eq!(
            formal_switch_log_count(
                &old_current_drift_fixture.connection,
                &old_current_drift_input.operation_id,
            ),
            0
        );

        let mut activation_drift_fixture = seed(kind, channel);
        let activation_drift_input = begin_input(
            &activation_drift_fixture,
            kind,
            channel,
            "f3-5-review-target-activation-drift",
        );
        let prepared = build_and_prepare(
            &activation_drift_fixture.connection,
            &activation_drift_input,
        ).unwrap();
        let ticket = drive_to_activation(
            &mut activation_drift_fixture.connection,
            &prepared.envelope.operation_id,
            &activation_drift_input.occurred_at,
            activation_drift_input.occurred_at_epoch_ms,
        ).unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
            operation_id,
            target_file_ref_id,
            activation_logical_identity,
            ..
        } = ticket else { panic!("activation ticket required") };
        let externally_changed_target = b"# Concurrent target write before activation resolve\n";
        fs::write(
            &activation_drift_fixture.target_path,
            externally_changed_target,
        ).unwrap();
        let actual_target = physical_snapshot(
            &read_file_ref(
                &activation_drift_fixture.connection,
                kind,
                channel,
                &activation_drift_input.owner_id,
                &target_file_ref_id,
            ).unwrap(),
        ).unwrap();
        assert!(matches!(
            resolve_activation(
                &activation_drift_fixture.connection,
                &operation_id,
                &ReferenceOwnerActivationInput {
                    actual_runtime_handle: "activated-current".into(),
                    runtime_generation: 2,
                    runtime_consumer_id: "activated-consumer".into(),
                    logical_identity: activation_logical_identity,
                    file_ref_id: target_file_ref_id,
                    exact_active: true,
                    authoritative_physical_revision: actual_target.revision,
                    authoritative_raw_byte_length: actual_target.bytes.len() as u64,
                },
                activation_drift_input.occurred_at_epoch_ms + 1,
            ).unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
        assert_eq!(
            fs::read(&activation_drift_fixture.target_path).unwrap(),
            externally_changed_target
        );
        assert_eq!(
            formal_switch_log_count(
                &activation_drift_fixture.connection,
                &activation_drift_input.operation_id,
            ),
            1
        );

        let mut structured_fixture = seed(kind, channel);
        let structured_input = begin_input(
            &structured_fixture,
            kind,
            channel,
            "f3-5-review-structured-revision-cas",
        );
        let prepared = build_and_prepare(&structured_fixture.connection, &structured_input).unwrap();
        structured_fixture.connection.execute(
            "UPDATE review_structured_states
             SET structured_revision=structured_revision+1,updated_at='external-structured-writer'
             WHERE review_id='review-1'",
            [],
        ).unwrap();
        let error = drive_to_activation(
            &mut structured_fixture.connection,
            &prepared.envelope.operation_id,
            &structured_input.occurred_at,
            structured_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(error.contains("DB_CAS_CONFLICT"), "{error}");

        let mut binding_fixture = seed(kind, channel);
        let binding_input = begin_input(
            &binding_fixture,
            kind,
            channel,
            "f3-5-review-binding-cas",
        );
        let prepared = build_and_prepare(&binding_fixture.connection, &binding_input).unwrap();
        binding_fixture.connection.execute(
            "UPDATE manuscript_bindings SET updated_at='external-binding-writer'
             WHERE owner_type='review' AND owner_id='review-1' AND manuscript_channel='primary'",
            [],
        ).unwrap();
        let error = drive_to_activation(
            &mut binding_fixture.connection,
            &prepared.envelope.operation_id,
            &binding_input.occurred_at,
            binding_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(error.contains("DB_CAS_CONFLICT"), "{error}");

        let mut lifecycle_cas_fixture = seed(kind, channel);
        let lifecycle_cas_input = begin_input(
            &lifecycle_cas_fixture,
            kind,
            channel,
            "f3-5-review-lifecycle-cas",
        );
        let prepared = build_and_prepare(
            &lifecycle_cas_fixture.connection,
            &lifecycle_cas_input,
        ).unwrap();
        lifecycle_cas_fixture.connection.execute(
            "INSERT INTO review_lifecycle_actions(
               lifecycle_action_id,operation_type,review_id,project_id,
               expected_review_source_state,expected_review_updated_at,target_review_updated_at,
               target_review_deleted_at,expected_planning_epoch,expected_planning_revision,
               planned_committed_planning_revision,planning_effect_id,exact_recycle_entry_id,
               operation_log_effect_id,recycle_effect_id,current_stage,created_at,updated_at
             ) VALUES(
               'f3-5-pending-delete','review_soft_delete','review-1','project-1',
               'active','2026-08-10T00:00:00Z','2026-08-10T00:01:00Z',
               '2026-08-10T00:01:00Z','epoch-1','1','2','planning-delete','recycle-1',
               'log-delete','recycle-delete','prepared','2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
             )",
            [],
        ).unwrap();
        let error = drive_to_activation(
            &mut lifecycle_cas_fixture.connection,
            &prepared.envelope.operation_id,
            &lifecycle_cas_input.occurred_at,
            lifecycle_cas_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(error.contains("DB_CAS_CONFLICT"), "{error}");

        for (fixture, operation_id) in [
            (&structured_fixture, "f3-5-review-structured-revision-cas"),
            (&binding_fixture, "f3-5-review-binding-cas"),
            (&lifecycle_cas_fixture, "f3-5-review-lifecycle-cas"),
        ] {
            let current: String = fixture.connection.query_row(
                "SELECT current_file_ref_id FROM manuscript_bindings
                 WHERE owner_type='review' AND owner_id='review-1' AND manuscript_channel='primary'",
                [],
                |row| row.get(0),
            ).unwrap();
            assert_eq!(current, "old");
            assert_eq!(formal_switch_log_count(&fixture.connection, operation_id), 0);
        }
        assert_eq!(formal_switch_log_count(&descriptor_fixture.connection, &descriptor_input.operation_id), 0);
        assert_eq!(formal_switch_log_count(&lifecycle_fixture.connection, &lifecycle_input.operation_id), 0);
        assert_eq!(formal_switch_log_count(&target_fixture.connection, &target_input.operation_id), 0);

        let mut subtype_drift_fixture = seed(kind, channel);
        let subtype_drift_target_before = fs::read(&subtype_drift_fixture.target_path).unwrap();
        let subtype_drift_input = begin_input(
            &subtype_drift_fixture,
            kind,
            channel,
            "f3-5-review-subtype-drift",
        );
        let prepared = build_and_prepare(
            &subtype_drift_fixture.connection,
            &subtype_drift_input,
        ).unwrap();
        configure_review_type(&subtype_drift_fixture, "custom");
        let next_subtype_input = begin_input(
            &subtype_drift_fixture,
            kind,
            channel,
            "f3-5-review-cross-subtype-while-recovery-pending",
        );
        assert_eq!(
            build_and_prepare(&subtype_drift_fixture.connection, &next_subtype_input)
                .unwrap_err(),
            "FORMAL_SWITCH_REVIEW_CROSS_SUBTYPE_RECOVERY_PENDING"
        );
        let error = drive_to_activation(
            &mut subtype_drift_fixture.connection,
            &prepared.envelope.operation_id,
            &subtype_drift_input.occurred_at,
            subtype_drift_input.occurred_at_epoch_ms,
        ).unwrap_err();
        assert!(error.contains("DB_CAS_CONFLICT"), "{error}");
        let current: String = subtype_drift_fixture.connection.query_row(
            "SELECT current_file_ref_id FROM manuscript_bindings
             WHERE owner_type='review' AND owner_id='review-1' AND manuscript_channel='primary'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(current, "old");
        assert_eq!(
            formal_switch_log_count(
                &subtype_drift_fixture.connection,
                &subtype_drift_input.operation_id,
            ),
            0
        );
        assert_eq!(
            fs::read(&subtype_drift_fixture.target_path).unwrap(),
            subtype_drift_target_before
        );
    }

    #[test]
    fn reference_owner_legacy_drain_is_zero_on_current_schema_fixture() {
        let fixture = seed(ReferenceOwnerKind::Experiment, ReferenceManuscriptChannel::Primary);
        let drain = read_old_recovery_drain_snapshot(&fixture.connection).unwrap();
        assert_eq!((drain.experiment_unresolved, drain.experiment_prepared_or_unknown, drain.run_unresolved, drain.run_prepared_or_unknown), (0, 0, 0, 0));
        validate_legacy_drain(&fixture.connection).unwrap();
    }

    #[test]
    fn f5_5_target_gate_runs_after_old_settlement_and_before_the_single_db_transaction() {
        let kind = ReferenceOwnerKind::Experiment;
        let channel = ReferenceManuscriptChannel::Primary;
        let mut fixture = seed(kind, channel);
        let input = begin_input(&fixture, kind, channel, "f5-5-post-settlement-target-gate");
        let prepared = build_and_prepare(&fixture.connection, &input).unwrap();
        let started = canonical_engine()
            .recovery
            .begin_settlement(
                &fixture.connection,
                &prepared,
                input.occurred_at_epoch_ms,
            )
            .unwrap();
        let old_file = read_file_ref(
            &fixture.connection,
            kind,
            channel,
            &input.owner_id,
            &input.old_current_file_ref_id,
        )
        .unwrap();
        let settlement = execute_settlement_atomic(
            &started.envelope,
            &resolved_old_current(&old_file),
        )
        .unwrap();
        let settled = canonical_engine()
            .recovery
            .complete_settlement(
                &fixture.connection,
                &started,
                settlement,
                input.occurred_at_epoch_ms + 1,
            )
            .unwrap();
        assert_eq!(settled.record.state.phase, "settlement_complete");
        assert_eq!(
            fs::read(&fixture.old_path).unwrap(),
            input.expected_old_current_post_text.as_bytes()
        );
        fs::write(&fixture.target_path, b"# target changed after old settlement\n").unwrap();
        assert_eq!(
            drive_to_activation(
                &mut fixture.connection,
                &input.operation_id,
                &input.occurred_at,
                input.occurred_at_epoch_ms + 2,
            )
            .unwrap_err(),
            "FORMAL_SWITCH_TARGET_CANDIDATE_CONFLICT"
        );
        let current: String = fixture
            .connection
            .query_row(
                "SELECT current_file_ref_id FROM manuscript_bindings WHERE owner_type='experiment' AND owner_id='experiment-1' AND manuscript_channel='primary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current, "old");
        assert_eq!(formal_switch_log_count(&fixture.connection, &input.operation_id), 0);
    }

    #[test]
    fn f5_5_target_cleanup_is_content_preserving_once_only_and_restart_never_replays_it() {
        let kind = ReferenceOwnerKind::Experiment;
        let channel = ReferenceManuscriptChannel::Primary;
        let marker_source = concat!(
            "prefix body\n",
            "<!-- LABPOD:STRUCTURED_OUTLINE_ARCHIVE_BEGIN_V1 | target -->\n",
            "archive interior 中文\n",
            "<!-- LABPOD:STRUCTURED_OUTLINE_ARCHIVE_END_V1 -->\n",
            "suffix body\n"
        );
        let expected_post = "prefix body\narchive interior 中文\nsuffix body\n";

        let mut fixture = seed(kind, channel);
        fs::write(&fixture.target_path, marker_source.as_bytes()).unwrap();
        let input = begin_input(&fixture, kind, channel, "f5-5-cleanup-once");
        build_and_prepare(&fixture.connection, &input).unwrap();
        let ticket = drive_to_activation(
            &mut fixture.connection,
            &input.operation_id,
            &input.occurred_at,
            input.occurred_at_epoch_ms,
        )
        .unwrap();
        assert!(matches!(ticket, ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired { .. }));
        let cleanup = ReferenceOwnerTargetCleanupInput {
            expected_revision: input.target_physical_revision.clone(),
            expected_pre_byte_length: marker_source.len() as u64,
            expected_post_text: expected_post.into(),
            exact_marker_spans: scan_exact_archive_marker_spans(marker_source.as_bytes()),
        };
        let first = cleanup_target_once(&fixture.connection, &input.operation_id, &cleanup).unwrap();
        assert!(matches!(
            first,
            ReferenceOwnerFormalSwitchBridgeResult::TargetCleanup {
                attempted: true,
                ref classification,
                ..
            } if classification == "CLEAN"
        ));
        assert_eq!(fs::read(&fixture.target_path).unwrap(), expected_post.as_bytes());
        let second = cleanup_target_once(&fixture.connection, &input.operation_id, &cleanup).unwrap();
        assert!(matches!(
            second,
            ReferenceOwnerFormalSwitchBridgeResult::TargetCleanup {
                attempted: false,
                ref classification,
                ..
            } if classification == "NOT_CLEANED"
        ));
        let actual = physical_snapshot(
            &read_file_ref(
                &fixture.connection,
                kind,
                channel,
                &input.owner_id,
                &input.target_file_ref_id,
            )
            .unwrap(),
        )
        .unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
            operation_id,
            target_file_ref_id,
            activation_logical_identity,
            ..
        } = ticket else { unreachable!() };
        assert!(matches!(
            resolve_activation(
                &fixture.connection,
                &operation_id,
                &ReferenceOwnerActivationInput {
                    actual_runtime_handle: "f5-5-runtime".into(),
                    runtime_generation: 1,
                    runtime_consumer_id: "f5-5-consumer".into(),
                    logical_identity: activation_logical_identity,
                    file_ref_id: target_file_ref_id,
                    exact_active: true,
                    authoritative_physical_revision: actual.revision,
                    authoritative_raw_byte_length: actual.bytes.len() as u64,
                },
                input.occurred_at_epoch_ms + 3,
            )
            .unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));

        let mut restarted = seed(kind, channel);
        fs::write(&restarted.target_path, marker_source.as_bytes()).unwrap();
        let restart_input = begin_input(&restarted, kind, channel, "f5-5-restart-no-cleanup");
        let prepared = build_and_prepare(&restarted.connection, &restart_input).unwrap();
        let restart_ticket = drive_to_activation(
            &mut restarted.connection,
            &prepared.envelope.operation_id,
            &restart_input.occurred_at,
            restart_input.occurred_at_epoch_ms,
        )
        .unwrap();
        target_cleanup_process_state()
            .lock()
            .unwrap()
            .fresh_operations
            .remove(&restart_input.operation_id);
        let restart_cleanup = ReferenceOwnerTargetCleanupInput {
            expected_revision: restart_input.target_physical_revision.clone(),
            expected_pre_byte_length: marker_source.len() as u64,
            expected_post_text: expected_post.into(),
            exact_marker_spans: scan_exact_archive_marker_spans(marker_source.as_bytes()),
        };
        assert!(matches!(
            cleanup_target_once(
                &restarted.connection,
                &restart_input.operation_id,
                &restart_cleanup,
            )
            .unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::TargetCleanup {
                attempted: false,
                ref classification,
                ..
            } if classification == "NOT_CLEANED"
        ));
        assert_eq!(fs::read(&restarted.target_path).unwrap(), marker_source.as_bytes());
        let actual = physical_snapshot(
            &read_file_ref(
                &restarted.connection,
                kind,
                channel,
                &restart_input.owner_id,
                &restart_input.target_file_ref_id,
            )
            .unwrap(),
        )
        .unwrap();
        let ReferenceOwnerFormalSwitchBridgeResult::ActivationRequired {
            operation_id,
            target_file_ref_id,
            activation_logical_identity,
            ..
        } = restart_ticket else { panic!("activation ticket required") };
        assert!(matches!(
            resolve_activation(
                &restarted.connection,
                &operation_id,
                &ReferenceOwnerActivationInput {
                    actual_runtime_handle: "restart-runtime".into(),
                    runtime_generation: 1,
                    runtime_consumer_id: "restart-consumer".into(),
                    logical_identity: activation_logical_identity,
                    file_ref_id: target_file_ref_id,
                    exact_active: true,
                    authoritative_physical_revision: actual.revision,
                    authoritative_raw_byte_length: actual.bytes.len() as u64,
                },
                restart_input.occurred_at_epoch_ms + 1,
            )
            .unwrap(),
            ReferenceOwnerFormalSwitchBridgeResult::Resolved { .. }
        ));
    }
}
