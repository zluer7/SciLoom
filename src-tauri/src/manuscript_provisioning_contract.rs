#![allow(dead_code)]

use std::collections::BTreeSet;
use std::str::FromStr;

pub(crate) const PROVISIONING_ACTIVE_CLAIM_CONFLICT: &str = "PROVISIONING_ACTIVE_CLAIM_CONFLICT";
pub(crate) const PROVISIONING_OPERATION_CAS_CONFLICT: &str = "PROVISIONING_OPERATION_CAS_CONFLICT";
pub(crate) const PROVISIONING_OPERATION_INVALID_INPUT: &str =
    "PROVISIONING_OPERATION_INVALID_INPUT";
pub(crate) const PROVISIONING_OPERATION_STATE_UNAVAILABLE: &str =
    "PROVISIONING_OPERATION_STATE_UNAVAILABLE";
pub(crate) const PROVISIONING_RUNTIME_INTERNAL_FAILURE: &str =
    "PROVISIONING_RUNTIME_INTERNAL_FAILURE";
pub(crate) const PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE: &str =
    "PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE";
pub(crate) const PROVISIONING_OWNER_ID_MAX_BYTES: usize = 128;
pub(crate) const PHYSICAL_CONTAINMENT_BLOCKED: &str = "containment-blocked";
pub(crate) const PHYSICAL_REPARSE_BLOCKED: &str = "reparse-blocked";
pub(crate) const PHYSICAL_WRONG_TYPE: &str = "wrong-type";
pub(crate) const PHYSICAL_MUTATION_CONDITION_FAILED: &str = "mutation-condition-failed";
pub(crate) const PHYSICAL_AUTHORITY_UNAVAILABLE: &str = "physical-unavailable";
pub(crate) const PHYSICAL_EFFECT_INDETERMINATE: &str = "physical-effect-indeterminate";
pub(crate) const PHYSICAL_IDENTITY_MISMATCH: &str = "physical-identity-mismatch";
pub(crate) const PHYSICAL_PARTIAL_EFFECT: &str = "physical-partial-effect";
pub(crate) const DURABLE_AUTHORITY_STALE: &str = "durable-authority-stale";
pub(crate) const DURABLE_IDENTITY_CONFLICT: &str = "durable-identity-conflict";
pub(crate) const DURABLE_NOT_FOUND: &str = "durable-not-found";
pub(crate) const DURABLE_INVALID_OPERATION_STATE: &str = "durable-invalid-operation-state";
pub(crate) const DURABLE_REPOSITORY_UNAVAILABLE: &str = "durable-repository-unavailable";
pub(crate) const DURABLE_INTERNAL_FAILURE: &str = "durable-internal-failure";
pub(crate) const DURABLE_STEP_ROW_DECODE_INVALID: &str = "enum-decode-invalid";

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

// This is the single exact-v41 vocabulary consumed by both the pure
// P-4-3 contract and the durable DTO decoder.
string_enum!(DurableStepKind {
    EnsureDirectory => "ensure-directory",
    EnsureManuscript => "ensure-manuscript",
    RegisterFolderFileRef => "register-folder-fileref",
    RegisterManuscriptFileRef => "register-manuscript-fileref",
    EstablishBinding => "establish-binding",
    ConvergeDefaultCurrent => "converge-default-current",
    ConvergeOwnerMetadata => "converge-owner-metadata",
});

string_enum!(DurableStepScope {
    Primary => "primary",
    LiteratureAggregate => "literature-aggregate",
    LiteratureOutline => "literature_outline",
    DedicatedNotes => "dedicated_notes",
});

string_enum!(PlanTemplateKind {
    ManagedPrimary => "managed-primary",
    ExperimentPrimary => "experiment-primary",
    ExperimentRunPrimary => "experiment-run-primary",
    LiteratureAggregate => "literature-aggregate",
    LiteratureChannel => "literature-channel",
});

string_enum!(DurablePlanOwnerType {
    Experiment => "experiment",
    ExperimentRun => "experimentRun",
    Literature => "literature",
    Review => "review",
    ResultItem => "resultItem",
    Finding => "finding",
    OutputCandidate => "outputCandidate",
    OutputGap => "outputGap",
    ResearchOutput => "researchOutput",
});

string_enum!(DurablePlanScopeKind {
    Channel => "channel",
    LiteratureAggregate => "literature-aggregate",
    LiteratureChild => "literature-child",
});

string_enum!(DurableManuscriptChannel {
    Primary => "primary",
    LiteratureOutline => "literature_outline",
    DedicatedNotes => "dedicated_notes",
});

string_enum!(DurablePlanIntent {
    CreateDefault => "create-default",
    Retry => "retry",
    Repair => "repair",
    Recover => "recover",
});

string_enum!(ProvisioningTrigger {
    OwnerCreate => "owner-create",
    ExplicitRetry => "explicit-retry",
    ExplicitRepair => "explicit-repair",
});

string_enum!(ProvisioningNextAction {
    None => "none",
    Retry => "retry",
    Repair => "repair",
    Recover => "recover",
    LifecycleDecision => "lifecycle-decision",
    Stop => "stop",
});

string_enum!(ProvisioningResultClassification {
    Completed => "completed",
    Retryable => "retryable",
    RepairRequired => "repair-required",
    ProvisioningRecoveryRequired => "provisioning-recovery-required",
    LifecycleDecisionRequired => "lifecycle-decision-required",
    Blocked => "blocked",
});

string_enum!(DurableStepBoundary {
    Intended => "intended",
    Started => "started",
    EffectObserved => "effect-observed",
    ReadbackVerified => "readback-verified",
    Converged => "converged",
});

string_enum!(DurableStepEffectOutcome {
    Unobserved => "unobserved",
    Created => "created",
    Reused => "reused",
    Updated => "updated",
    Preserved => "preserved",
    NoEffectProven => "no-effect-proven",
});

string_enum!(DurableStepReadbackOutcome {
    NotRun => "not-run",
    EffectObserved => "effect-observed",
    Verified => "verified",
    VerifiedAbsent => "verified-absent",
    WrongType => "wrong-type",
    IdentityMismatch => "identity-mismatch",
    ContainmentFailed => "containment-failed",
    Conflict => "conflict",
    Unavailable => "unavailable",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalExpectation {
    FormalTupleAfterFinalVerification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StableResultErrorMapping {
    ExactV41Authority,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperationIdempotencyRule {
    FreshCreate,
    NewAttemptAfterTerminalRetry,
    NewAttemptAfterTerminalRepair,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FormalStrategyKey {
    SingleChannel,
    LiteratureAggregate,
    LiteratureChild,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DescriptorKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdapterPortKey(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RequestIdentity {
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProvisioningScopeIdentity {
    pub owner_type: DurablePlanOwnerType,
    pub owner_id: String,
    pub scope_kind: DurablePlanScopeKind,
    pub manuscript_channel: Option<DurableManuscriptChannel>,
}

impl ProvisioningScopeIdentity {
    pub(crate) fn validate(&self) -> Result<(), ProvisioningContractError> {
        // Keep every provisioning layer aligned with the existing durable
        // schema. Canonical Literature CREATE uses the Result identity rather
        // than concatenating the full operation/authorization tuple.
        if !bounded_identifier(&self.owner_id, PROVISIONING_OWNER_ID_MAX_BYTES) {
            return Err(invalid_input());
        }
        let valid = match (self.owner_type, self.scope_kind, self.manuscript_channel) {
            (
                DurablePlanOwnerType::Literature,
                DurablePlanScopeKind::Channel | DurablePlanScopeKind::LiteratureChild,
                Some(
                    DurableManuscriptChannel::LiteratureOutline
                    | DurableManuscriptChannel::DedicatedNotes,
                ),
            )
            | (DurablePlanOwnerType::Literature, DurablePlanScopeKind::LiteratureAggregate, None)
            | (
                DurablePlanOwnerType::Experiment
                | DurablePlanOwnerType::ExperimentRun
                | DurablePlanOwnerType::Review
                | DurablePlanOwnerType::ResultItem
                | DurablePlanOwnerType::Finding
                | DurablePlanOwnerType::OutputCandidate
                | DurablePlanOwnerType::OutputGap
                | DurablePlanOwnerType::ResearchOutput,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
            ) => true,
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(contract_violation())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CanonicalResourceIdentity {
    pub resource_identity_hash: String,
    pub placement_identity_hash: String,
    pub parent_shared_identity_hash: Option<String>,
}

impl CanonicalResourceIdentity {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if is_lowercase_sha256(&self.resource_identity_hash)
            && is_lowercase_sha256(&self.placement_identity_hash)
            && self
                .parent_shared_identity_hash
                .as_deref()
                .is_none_or(is_lowercase_sha256)
        {
            Ok(())
        } else {
            Err(invalid_input())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct RequiredStep {
    pub kind: DurableStepKind,
    pub scope: DurableStepScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OperationReference {
    pub previous_operation_id: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalPredecessorPhase {
    Failed,
    Partial,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalPredecessorStatus {
    TerminalFailed,
    TerminalPartial,
    TerminalBlocked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthoritativeTerminalPredecessor {
    phase: TerminalPredecessorPhase,
    status: TerminalPredecessorStatus,
    classification: ProvisioningResultClassification,
    next_action: ProvisioningNextAction,
}

impl AuthoritativeTerminalPredecessor {
    pub(crate) const fn retryable_failed() -> Self {
        Self {
            phase: TerminalPredecessorPhase::Failed,
            status: TerminalPredecessorStatus::TerminalFailed,
            classification: ProvisioningResultClassification::Retryable,
            next_action: ProvisioningNextAction::Retry,
        }
    }

    pub(crate) const fn retryable_partial() -> Self {
        Self {
            phase: TerminalPredecessorPhase::Partial,
            status: TerminalPredecessorStatus::TerminalPartial,
            classification: ProvisioningResultClassification::Retryable,
            next_action: ProvisioningNextAction::Retry,
        }
    }

    pub(crate) const fn repair_required_failed() -> Self {
        Self {
            phase: TerminalPredecessorPhase::Failed,
            status: TerminalPredecessorStatus::TerminalFailed,
            classification: ProvisioningResultClassification::RepairRequired,
            next_action: ProvisioningNextAction::Repair,
        }
    }

    pub(crate) const fn repair_required_partial() -> Self {
        Self {
            phase: TerminalPredecessorPhase::Partial,
            status: TerminalPredecessorStatus::TerminalPartial,
            classification: ProvisioningResultClassification::RepairRequired,
            next_action: ProvisioningNextAction::Repair,
        }
    }

    pub(crate) const fn repair_required_blocked() -> Self {
        Self {
            phase: TerminalPredecessorPhase::Blocked,
            status: TerminalPredecessorStatus::TerminalBlocked,
            classification: ProvisioningResultClassification::RepairRequired,
            next_action: ProvisioningNextAction::Repair,
        }
    }

    pub(crate) const fn phase(&self) -> TerminalPredecessorPhase {
        self.phase
    }

    pub(crate) const fn status(&self) -> TerminalPredecessorStatus {
        self.status
    }

    pub(crate) const fn classification(&self) -> ProvisioningResultClassification {
        self.classification
    }

    pub(crate) const fn next_action(&self) -> ProvisioningNextAction {
        self.next_action
    }
}

impl OperationReference {
    fn validate(&self, _expected: ProvisioningNextAction) -> Result<(), ProvisioningContractError> {
        if bounded_identifier(&self.previous_operation_id, 128) && self.expected_revision >= 0 {
            Ok(())
        } else {
            Err(contract_violation())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExplicitAuthorization {
    pub authorization_id: String,
}

impl ExplicitAuthorization {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if bounded_identifier(&self.authorization_id, 128) {
            Ok(())
        } else {
            Err(invalid_input())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreateDefaultCommand {
    pub target: ProvisioningScopeIdentity,
    pub request: RequestIdentity,
    pub canonical_resource: CanonicalResourceIdentity,
    pub descriptor_key: DescriptorKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExplicitRetryCommand {
    pub target: ProvisioningScopeIdentity,
    pub request: RequestIdentity,
    pub canonical_resource: CanonicalResourceIdentity,
    pub descriptor_key: DescriptorKey,
    pub predecessor: OperationReference,
    pub authorization: ExplicitAuthorization,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExplicitRepairCommand {
    pub target: ProvisioningScopeIdentity,
    pub request: RequestIdentity,
    pub canonical_resource: CanonicalResourceIdentity,
    pub descriptor_key: DescriptorKey,
    pub predecessor: OperationReference,
    pub authorization: ExplicitAuthorization,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProvisioningCommand {
    CreateDefault(CreateDefaultCommand),
    ExplicitRetry(ExplicitRetryCommand),
    ExplicitRepair(ExplicitRepairCommand),
}

impl ProvisioningCommand {
    pub(crate) const fn intent(&self) -> DurablePlanIntent {
        match self {
            Self::CreateDefault(_) => DurablePlanIntent::CreateDefault,
            Self::ExplicitRetry(_) => DurablePlanIntent::Retry,
            Self::ExplicitRepair(_) => DurablePlanIntent::Repair,
        }
    }

    pub(crate) const fn trigger(&self) -> ProvisioningTrigger {
        match self {
            Self::CreateDefault(_) => ProvisioningTrigger::OwnerCreate,
            Self::ExplicitRetry(_) => ProvisioningTrigger::ExplicitRetry,
            Self::ExplicitRepair(_) => ProvisioningTrigger::ExplicitRepair,
        }
    }

    fn target(&self) -> &ProvisioningScopeIdentity {
        match self {
            Self::CreateDefault(command) => &command.target,
            Self::ExplicitRetry(command) => &command.target,
            Self::ExplicitRepair(command) => &command.target,
        }
    }

    fn request(&self) -> &RequestIdentity {
        match self {
            Self::CreateDefault(command) => &command.request,
            Self::ExplicitRetry(command) => &command.request,
            Self::ExplicitRepair(command) => &command.request,
        }
    }

    fn canonical_resource(&self) -> &CanonicalResourceIdentity {
        match self {
            Self::CreateDefault(command) => &command.canonical_resource,
            Self::ExplicitRetry(command) => &command.canonical_resource,
            Self::ExplicitRepair(command) => &command.canonical_resource,
        }
    }

    fn descriptor_key(&self) -> &DescriptorKey {
        match self {
            Self::CreateDefault(command) => &command.descriptor_key,
            Self::ExplicitRetry(command) => &command.descriptor_key,
            Self::ExplicitRepair(command) => &command.descriptor_key,
        }
    }

    fn validate_common(&self) -> Result<(), ProvisioningContractError> {
        self.target().validate()?;
        self.canonical_resource().validate()?;
        if !bounded_identifier(&self.request().request_id, 128)
            || !bounded_key(&self.descriptor_key().0)
        {
            return Err(invalid_input());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FamilyDescriptor {
    pub key: DescriptorKey,
    pub owner_type: DurablePlanOwnerType,
    pub scope_kind: DurablePlanScopeKind,
    pub manuscript_channel: Option<DurableManuscriptChannel>,
    pub legal_intents: Vec<DurablePlanIntent>,
    pub plan_template: PlanTemplateKind,
    pub canonical_steps: Vec<RequiredStep>,
    pub filename_policy_key: PolicyKey,
    pub placement_policy_key: PolicyKey,
    pub adapter_port_key: AdapterPortKey,
    pub readback_policy_key: PolicyKey,
    pub terminal_expectation: TerminalExpectation,
    pub result_error_mapping: StableResultErrorMapping,
    pub strategy_key: FormalStrategyKey,
}

impl FamilyDescriptor {
    pub(crate) fn validate(&self) -> Result<(), ProvisioningContractError> {
        ProvisioningScopeIdentity {
            owner_type: self.owner_type,
            owner_id: "descriptor-owner".to_string(),
            scope_kind: self.scope_kind,
            manuscript_channel: self.manuscript_channel,
        }
        .validate()?;
        if !bounded_key(&self.key.0)
            || !bounded_key(&self.filename_policy_key.0)
            || !bounded_key(&self.placement_policy_key.0)
            || !bounded_key(&self.adapter_port_key.0)
            || !bounded_key(&self.readback_policy_key.0)
            || self.legal_intents.is_empty()
            || self
                .legal_intents
                .iter()
                .any(|intent| *intent == DurablePlanIntent::Recover)
            || self.terminal_expectation != TerminalExpectation::FormalTupleAfterFinalVerification
        {
            return Err(contract_violation());
        }
        let legal_intents = self.legal_intents.iter().copied().collect::<BTreeSet<_>>();
        if legal_intents.len() != self.legal_intents.len() {
            return Err(contract_violation());
        }
        validate_step_set(&self.canonical_steps)?;
        if !steps_match_template(
            &self.canonical_steps,
            self.plan_template,
            self.scope_kind,
            self.manuscript_channel,
        )? {
            return Err(contract_violation());
        }
        let strategy_matches = matches!(
            (self.scope_kind, self.strategy_key),
            (
                DurablePlanScopeKind::Channel,
                FormalStrategyKey::SingleChannel
            ) | (
                DurablePlanScopeKind::LiteratureAggregate,
                FormalStrategyKey::LiteratureAggregate
            ) | (
                DurablePlanScopeKind::LiteratureChild,
                FormalStrategyKey::LiteratureChild
            )
        );
        let template_matches_owner = matches!(
            (
                self.owner_type,
                self.scope_kind,
                self.manuscript_channel,
                self.plan_template,
            ),
            (
                DurablePlanOwnerType::Experiment,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
                PlanTemplateKind::ExperimentPrimary,
            ) | (
                DurablePlanOwnerType::ExperimentRun,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
                PlanTemplateKind::ExperimentRunPrimary,
            ) | (
                DurablePlanOwnerType::Review
                    | DurablePlanOwnerType::ResultItem
                    | DurablePlanOwnerType::Finding
                    | DurablePlanOwnerType::OutputCandidate
                    | DurablePlanOwnerType::OutputGap
                    | DurablePlanOwnerType::ResearchOutput,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
                PlanTemplateKind::ManagedPrimary,
            ) | (
                DurablePlanOwnerType::Literature,
                DurablePlanScopeKind::LiteratureAggregate,
                None,
                PlanTemplateKind::LiteratureAggregate,
            ) | (
                DurablePlanOwnerType::Literature,
                DurablePlanScopeKind::Channel | DurablePlanScopeKind::LiteratureChild,
                Some(
                    DurableManuscriptChannel::LiteratureOutline
                        | DurableManuscriptChannel::DedicatedNotes,
                ),
                PlanTemplateKind::LiteratureChannel,
            )
        );
        if strategy_matches && template_matches_owner {
            Ok(())
        } else {
            Err(contract_violation())
        }
    }

    fn accepts(&self, command: &ProvisioningCommand) -> bool {
        self.key == *command.descriptor_key()
            && self.owner_type == command.target().owner_type
            && self.scope_kind == command.target().scope_kind
            && self.manuscript_channel == command.target().manuscript_channel
            && self.legal_intents.contains(&command.intent())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RootOperationDefinition {
    pub target: ProvisioningScopeIdentity,
    pub request: RequestIdentity,
    pub canonical_resource: CanonicalResourceIdentity,
    pub intent: DurablePlanIntent,
    pub trigger: ProvisioningTrigger,
    pub plan_template: PlanTemplateKind,
    pub required_steps: Vec<RequiredStep>,
    pub adapter_port_key: AdapterPortKey,
    pub terminal_expectation: TerminalExpectation,
    pub result_error_mapping: StableResultErrorMapping,
    pub idempotency_rule: OperationIdempotencyRule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChainedOperationDefinition {
    pub target: ProvisioningScopeIdentity,
    pub request: RequestIdentity,
    pub canonical_resource: CanonicalResourceIdentity,
    pub predecessor: OperationReference,
    pub authorization: ExplicitAuthorization,
    pub intent: DurablePlanIntent,
    pub trigger: ProvisioningTrigger,
    pub plan_template: PlanTemplateKind,
    pub required_steps: Vec<RequiredStep>,
    pub adapter_port_key: AdapterPortKey,
    pub terminal_expectation: TerminalExpectation,
    pub result_error_mapping: StableResultErrorMapping,
    pub idempotency_rule: OperationIdempotencyRule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OperationDefinition {
    CreateDefault(RootOperationDefinition),
    ExplicitRetry(ChainedOperationDefinition),
    ExplicitRepair(ChainedOperationDefinition),
}

impl OperationDefinition {
    fn required_steps(&self) -> &[RequiredStep] {
        match self {
            Self::CreateDefault(definition) => &definition.required_steps,
            Self::ExplicitRetry(definition) | Self::ExplicitRepair(definition) => {
                &definition.required_steps
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OperationDecision {
    Initialize(OperationDefinition),
}

pub(crate) fn resolve_operation(
    command: &ProvisioningCommand,
    descriptor: &FamilyDescriptor,
) -> Result<OperationDecision, ProvisioningContractError> {
    command.validate_common()?;
    descriptor.validate()?;
    if !descriptor.accepts(command) {
        return Err(contract_violation());
    }
    match command {
        ProvisioningCommand::CreateDefault(command) => Ok(OperationDecision::Initialize(
            OperationDefinition::CreateDefault(RootOperationDefinition {
                target: command.target.clone(),
                request: command.request.clone(),
                canonical_resource: command.canonical_resource.clone(),
                intent: DurablePlanIntent::CreateDefault,
                trigger: ProvisioningTrigger::OwnerCreate,
                plan_template: descriptor.plan_template,
                required_steps: descriptor.canonical_steps.clone(),
                adapter_port_key: descriptor.adapter_port_key.clone(),
                terminal_expectation: descriptor.terminal_expectation,
                result_error_mapping: descriptor.result_error_mapping,
                idempotency_rule: OperationIdempotencyRule::FreshCreate,
            }),
        )),
        ProvisioningCommand::ExplicitRetry(command) => {
            command
                .predecessor
                .validate(ProvisioningNextAction::Retry)?;
            command.authorization.validate()?;
            Ok(OperationDecision::Initialize(
                OperationDefinition::ExplicitRetry(ChainedOperationDefinition {
                    target: command.target.clone(),
                    request: command.request.clone(),
                    canonical_resource: command.canonical_resource.clone(),
                    predecessor: command.predecessor.clone(),
                    authorization: command.authorization.clone(),
                    intent: DurablePlanIntent::Retry,
                    trigger: ProvisioningTrigger::ExplicitRetry,
                    plan_template: descriptor.plan_template,
                    required_steps: descriptor.canonical_steps.clone(),
                    adapter_port_key: descriptor.adapter_port_key.clone(),
                    terminal_expectation: descriptor.terminal_expectation,
                    result_error_mapping: descriptor.result_error_mapping,
                    idempotency_rule: OperationIdempotencyRule::NewAttemptAfterTerminalRetry,
                }),
            ))
        }
        ProvisioningCommand::ExplicitRepair(command) => {
            command
                .predecessor
                .validate(ProvisioningNextAction::Repair)?;
            command.authorization.validate()?;
            Ok(OperationDecision::Initialize(
                OperationDefinition::ExplicitRepair(ChainedOperationDefinition {
                    target: command.target.clone(),
                    request: command.request.clone(),
                    canonical_resource: command.canonical_resource.clone(),
                    predecessor: command.predecessor.clone(),
                    authorization: command.authorization.clone(),
                    intent: DurablePlanIntent::Repair,
                    trigger: ProvisioningTrigger::ExplicitRepair,
                    plan_template: descriptor.plan_template,
                    required_steps: descriptor.canonical_steps.clone(),
                    adapter_port_key: descriptor.adapter_port_key.clone(),
                    terminal_expectation: descriptor.terminal_expectation,
                    result_error_mapping: descriptor.result_error_mapping,
                    idempotency_rule: OperationIdempotencyRule::NewAttemptAfterTerminalRepair,
                }),
            ))
        }
    }
}

fn validate_step_set(steps: &[RequiredStep]) -> Result<(), ProvisioningContractError> {
    let unique = steps.iter().cloned().collect::<BTreeSet<_>>();
    if steps.is_empty() || steps.len() > 32 || unique.len() != steps.len() {
        Err(contract_violation())
    } else {
        Ok(())
    }
}

fn steps_are_ordered_subsequence(selected: &[RequiredStep], canonical: &[RequiredStep]) -> bool {
    let mut next = 0;
    for step in selected {
        let Some(relative) = canonical[next..]
            .iter()
            .position(|candidate| candidate == step)
        else {
            return false;
        };
        next += relative + 1;
    }
    true
}

fn steps_match_template(
    steps: &[RequiredStep],
    template: PlanTemplateKind,
    scope_kind: DurablePlanScopeKind,
    channel: Option<DurableManuscriptChannel>,
) -> Result<bool, ProvisioningContractError> {
    if matches!(
        (template, scope_kind, channel),
        (
            PlanTemplateKind::LiteratureAggregate,
            DurablePlanScopeKind::LiteratureAggregate,
            None
        )
    ) {
        return Ok(literature_aggregate_steps_are_valid(steps));
    }
    Ok(steps_are_ordered_subsequence(
        steps,
        &canonical_template_order(template, scope_kind, channel)?,
    ))
}

fn literature_aggregate_steps_are_valid(steps: &[RequiredStep]) -> bool {
    let shared_order = [
        RequiredStep {
            kind: DurableStepKind::EnsureDirectory,
            scope: DurableStepScope::LiteratureAggregate,
        },
        RequiredStep {
            kind: DurableStepKind::RegisterFolderFileRef,
            scope: DurableStepScope::LiteratureAggregate,
        },
        RequiredStep {
            kind: DurableStepKind::ConvergeOwnerMetadata,
            scope: DurableStepScope::LiteratureAggregate,
        },
    ];
    let shared = steps
        .iter()
        .filter(|step| step.scope == DurableStepScope::LiteratureAggregate)
        .cloned()
        .collect::<Vec<_>>();
    let outline = steps
        .iter()
        .filter(|step| step.scope == DurableStepScope::LiteratureOutline)
        .cloned()
        .collect::<Vec<_>>();
    let notes = steps
        .iter()
        .filter(|step| step.scope == DurableStepScope::DedicatedNotes)
        .cloned()
        .collect::<Vec<_>>();
    if shared.len() + outline.len() + notes.len() != steps.len()
        || !steps_are_ordered_subsequence(&shared, &shared_order)
        || !steps_are_ordered_subsequence(
            &outline,
            &literature_channel_order(DurableStepScope::LiteratureOutline),
        )
        || !steps_are_ordered_subsequence(
            &notes,
            &literature_channel_order(DurableStepScope::DedicatedNotes),
        )
    {
        return false;
    }
    let last_shared_prerequisite = steps
        .iter()
        .enumerate()
        .filter(|(_, step)| {
            step.scope == DurableStepScope::LiteratureAggregate
                && matches!(
                    step.kind,
                    DurableStepKind::EnsureDirectory | DurableStepKind::RegisterFolderFileRef
                )
        })
        .map(|(index, _)| index)
        .max();
    let first_branch = steps
        .iter()
        .enumerate()
        .filter(|(_, step)| {
            matches!(
                step.scope,
                DurableStepScope::LiteratureOutline | DurableStepScope::DedicatedNotes
            )
        })
        .map(|(index, _)| index)
        .min();
    if last_shared_prerequisite
        .zip(first_branch)
        .is_some_and(|(shared, branch)| shared > branch)
    {
        return false;
    }
    let owner_metadata = steps.iter().position(|step| {
        step.scope == DurableStepScope::LiteratureAggregate
            && step.kind == DurableStepKind::ConvergeOwnerMetadata
    });
    !owner_metadata.is_some_and(|metadata| {
        steps.iter().enumerate().any(|(index, step)| {
            index > metadata && step.scope != DurableStepScope::LiteratureAggregate
        })
    })
}

fn canonical_template_order(
    template: PlanTemplateKind,
    scope_kind: DurablePlanScopeKind,
    channel: Option<DurableManuscriptChannel>,
) -> Result<Vec<RequiredStep>, ProvisioningContractError> {
    let steps = match (template, scope_kind, channel) {
        (
            PlanTemplateKind::ManagedPrimary
            | PlanTemplateKind::ExperimentPrimary
            | PlanTemplateKind::ExperimentRunPrimary,
            DurablePlanScopeKind::Channel,
            Some(DurableManuscriptChannel::Primary),
        ) => [
            DurableStepKind::EnsureDirectory,
            DurableStepKind::EnsureManuscript,
            DurableStepKind::RegisterFolderFileRef,
            DurableStepKind::RegisterManuscriptFileRef,
            DurableStepKind::EstablishBinding,
            DurableStepKind::ConvergeDefaultCurrent,
            DurableStepKind::ConvergeOwnerMetadata,
        ]
        .into_iter()
        .map(|kind| RequiredStep {
            kind,
            scope: DurableStepScope::Primary,
        })
        .collect(),
        (
            PlanTemplateKind::LiteratureChannel,
            DurablePlanScopeKind::Channel | DurablePlanScopeKind::LiteratureChild,
            Some(DurableManuscriptChannel::LiteratureOutline),
        ) => literature_channel_order(DurableStepScope::LiteratureOutline),
        (
            PlanTemplateKind::LiteratureChannel,
            DurablePlanScopeKind::Channel | DurablePlanScopeKind::LiteratureChild,
            Some(DurableManuscriptChannel::DedicatedNotes),
        ) => literature_channel_order(DurableStepScope::DedicatedNotes),
        _ => return Err(contract_violation()),
    };
    Ok(steps)
}

/// Returns the repository-owned, full canonical descriptor for an exact-v41
/// durable scope. Callers select only the frozen descriptor key; they cannot
/// provide a Step subset or ordinal sequence.
pub(crate) fn canonical_family_descriptor(
    scope: &ProvisioningScopeIdentity,
    key: &DescriptorKey,
) -> Result<FamilyDescriptor, ProvisioningContractError> {
    scope.validate()?;
    let (expected_key, plan_template, canonical_steps, strategy_key) =
        match (scope.owner_type, scope.scope_kind, scope.manuscript_channel) {
            (
                DurablePlanOwnerType::Experiment,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
            ) => (
                "managed-primary-v1",
                PlanTemplateKind::ExperimentPrimary,
                canonical_template_order(
                    PlanTemplateKind::ExperimentPrimary,
                    scope.scope_kind,
                    scope.manuscript_channel,
                )?,
                FormalStrategyKey::SingleChannel,
            ),
            (
                DurablePlanOwnerType::ExperimentRun,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
            ) => (
                "managed-primary-v1",
                PlanTemplateKind::ExperimentRunPrimary,
                canonical_template_order(
                    PlanTemplateKind::ExperimentRunPrimary,
                    scope.scope_kind,
                    scope.manuscript_channel,
                )?,
                FormalStrategyKey::SingleChannel,
            ),
            (
                DurablePlanOwnerType::Review
                | DurablePlanOwnerType::ResultItem
                | DurablePlanOwnerType::Finding
                | DurablePlanOwnerType::OutputCandidate
                | DurablePlanOwnerType::OutputGap
                | DurablePlanOwnerType::ResearchOutput,
                DurablePlanScopeKind::Channel,
                Some(DurableManuscriptChannel::Primary),
            ) => (
                "managed-primary-v1",
                PlanTemplateKind::ManagedPrimary,
                canonical_template_order(
                    PlanTemplateKind::ManagedPrimary,
                    scope.scope_kind,
                    scope.manuscript_channel,
                )?,
                FormalStrategyKey::SingleChannel,
            ),
            (DurablePlanOwnerType::Literature, DurablePlanScopeKind::LiteratureAggregate, None) => {
                let mut steps = vec![
                    RequiredStep {
                        kind: DurableStepKind::EnsureDirectory,
                        scope: DurableStepScope::LiteratureAggregate,
                    },
                    RequiredStep {
                        kind: DurableStepKind::RegisterFolderFileRef,
                        scope: DurableStepScope::LiteratureAggregate,
                    },
                ];
                steps.extend(literature_channel_order(
                    DurableStepScope::LiteratureOutline,
                ));
                steps.extend(literature_channel_order(DurableStepScope::DedicatedNotes));
                steps.push(RequiredStep {
                    kind: DurableStepKind::ConvergeOwnerMetadata,
                    scope: DurableStepScope::LiteratureAggregate,
                });
                (
                    "literature-aggregate-v1",
                    PlanTemplateKind::LiteratureAggregate,
                    steps,
                    FormalStrategyKey::LiteratureAggregate,
                )
            }
            (
                DurablePlanOwnerType::Literature,
                DurablePlanScopeKind::Channel,
                Some(
                    DurableManuscriptChannel::LiteratureOutline
                    | DurableManuscriptChannel::DedicatedNotes,
                ),
            ) => (
                "literature-channel-v1",
                PlanTemplateKind::LiteratureChannel,
                canonical_template_order(
                    PlanTemplateKind::LiteratureChannel,
                    scope.scope_kind,
                    scope.manuscript_channel,
                )?,
                FormalStrategyKey::SingleChannel,
            ),
            // Literature child is a separately authorized aggregate-owned
            // operation family and is intentionally not an ordinary R1-R entry.
            _ => return Err(contract_violation()),
        };
    if key.0 != expected_key {
        return Err(contract_violation());
    }
    let prefix = expected_key.trim_end_matches("-v1");
    let descriptor = FamilyDescriptor {
        key: key.clone(),
        owner_type: scope.owner_type,
        scope_kind: scope.scope_kind,
        manuscript_channel: scope.manuscript_channel,
        legal_intents: vec![
            DurablePlanIntent::CreateDefault,
            DurablePlanIntent::Retry,
            DurablePlanIntent::Repair,
        ],
        plan_template,
        canonical_steps,
        filename_policy_key: PolicyKey(format!("{prefix}-filename-v1")),
        placement_policy_key: PolicyKey(format!("{prefix}-placement-v1")),
        adapter_port_key: AdapterPortKey(format!("{prefix}-port-v1")),
        readback_policy_key: PolicyKey(format!("{prefix}-readback-v1")),
        terminal_expectation: TerminalExpectation::FormalTupleAfterFinalVerification,
        result_error_mapping: StableResultErrorMapping::ExactV41Authority,
        strategy_key,
    };
    descriptor.validate()?;
    Ok(descriptor)
}

fn literature_channel_order(scope: DurableStepScope) -> Vec<RequiredStep> {
    [
        DurableStepKind::EnsureManuscript,
        DurableStepKind::RegisterManuscriptFileRef,
        DurableStepKind::EstablishBinding,
        DurableStepKind::ConvergeDefaultCurrent,
    ]
    .into_iter()
    .map(|kind| RequiredStep { kind, scope })
    .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResourceType {
    Folder,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContainmentReadback {
    Verified,
    Failed,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadbackIdentity {
    pub canonical_identity_hash: String,
    pub authoritative_revision: i64,
}

impl ReadbackIdentity {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if is_lowercase_sha256(&self.canonical_identity_hash) && self.authoritative_revision >= 0 {
            Ok(())
        } else {
            Err(invalid_input())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExistingResourceReadback {
    resource_type: ResourceType,
    identity: ReadbackIdentity,
    containment: ContainmentReadback,
    file_ref_id: Option<String>,
    binding_id: Option<String>,
}

impl ExistingResourceReadback {
    pub(crate) fn new_verified(
        resource_type: ResourceType,
        identity: ReadbackIdentity,
        containment: ContainmentReadback,
        file_ref_id: Option<String>,
        binding_id: Option<String>,
        owner_scope_match: bool,
    ) -> Result<Self, ProvisioningContractError> {
        let semantics_verified = owner_scope_match
            && matches!(
                (resource_type, containment),
                (ResourceType::Markdown, ContainmentReadback::Verified)
                    | (ResourceType::Folder, ContainmentReadback::NotApplicable)
            );
        if !semantics_verified {
            return Err(contract_violation());
        }
        let readback = Self {
            resource_type,
            identity,
            containment,
            file_ref_id,
            binding_id,
        };
        readback.validate()?;
        Ok(readback)
    }

    fn validate(&self) -> Result<(), ProvisioningContractError> {
        self.identity.validate()?;
        for identifier in [self.file_ref_id.as_deref(), self.binding_id.as_deref()]
            .into_iter()
            .flatten()
        {
            if !bounded_identifier(identifier, 128) {
                return Err(invalid_input());
            }
        }
        if matches!(
            (self.resource_type, self.containment),
            (ResourceType::Markdown, ContainmentReadback::Verified)
                | (ResourceType::Folder, ContainmentReadback::NotApplicable)
        ) {
            Ok(())
        } else {
            Err(contract_violation())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AbsentEvidence {
    pub resource_type: ResourceType,
    pub canonical_identity_hash: String,
    pub owner_scope_match: bool,
    pub missing_canonical_count: u8,
}

impl AbsentEvidence {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if is_lowercase_sha256(&self.canonical_identity_hash)
            && self.owner_scope_match
            && self.missing_canonical_count == 1
        {
            Ok(())
        } else {
            Err(contract_violation())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConflictKind {
    WrongType,
    IdentityMismatch,
    ContainmentFailed,
    OwnershipConflict,
    PolicyConflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConflictFacts {
    pub code: Option<StableErrorCode>,
    pub kind: ConflictKind,
    pub canonical_identity_hash: String,
}

impl ConflictFacts {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if is_lowercase_sha256(&self.canonical_identity_hash) {
            Ok(())
        } else {
            Err(invalid_input())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnavailableFacts {
    pub authority: UnavailableAuthority,
    pub code: StableErrorCode,
}

impl UnavailableFacts {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if matches!(
            (self.authority, self.code),
            (
                UnavailableAuthority::Adapter,
                StableErrorCode::RuntimeAdapterUnavailable,
            ) | (
                UnavailableAuthority::Adapter,
                StableErrorCode::PhysicalAuthorityUnavailable,
            ) | (
                UnavailableAuthority::Readback,
                StableErrorCode::OperationStateUnavailable,
            ) | (
                UnavailableAuthority::Readback,
                StableErrorCode::PhysicalAuthorityUnavailable,
            )
        ) {
            Ok(())
        } else {
            Err(contract_violation())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnavailableAuthority {
    Adapter,
    Readback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IndeterminateFacts {
    pub stage: IndeterminateStage,
    pub code: StableErrorCode,
    pub canonical_identity_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IndeterminateStage {
    AdapterEffect,
    Readback,
}

impl IndeterminateFacts {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if matches!(
            (self.stage, self.code),
            (
                IndeterminateStage::AdapterEffect | IndeterminateStage::Readback,
                StableErrorCode::RuntimeInternalFailure
            ) | (
                IndeterminateStage::AdapterEffect | IndeterminateStage::Readback,
                StableErrorCode::PhysicalEffectIndeterminate
            )
        ) && is_lowercase_sha256(&self.canonical_identity_hash)
        {
            Ok(())
        } else {
            Err(invalid_input())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppliedEffectKind {
    Created,
    Updated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectCompletionKind {
    CompleteEffect,
    PartialEffect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EffectReceipt {
    pub effect_kind: AppliedEffectKind,
    pub completion: EffectCompletionKind,
    pub canonical_identity_hash: String,
    pub resource_record_id: Option<String>,
    pub byte_length: Option<u64>,
}

impl EffectReceipt {
    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if !is_lowercase_sha256(&self.canonical_identity_hash)
            || self
                .resource_record_id
                .as_deref()
                .is_some_and(|identifier| !bounded_identifier(identifier, 128))
        {
            Err(invalid_input())
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AdapterOutcome {
    Applied(EffectReceipt),
    Reused(ReadbackIdentity),
    NoEffectProven(AbsentEvidence),
    Conflict(ConflictFacts),
    Unavailable(UnavailableFacts),
    Indeterminate(IndeterminateFacts),
}

impl AdapterOutcome {
    pub(crate) const fn effect_receipt(&self) -> Option<&EffectReceipt> {
        match self {
            Self::Applied(receipt) => Some(receipt),
            Self::Reused(_)
            | Self::NoEffectProven(_)
            | Self::Conflict(_)
            | Self::Unavailable(_)
            | Self::Indeterminate(_) => None,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), ProvisioningContractError> {
        match self {
            Self::Applied(receipt) => receipt.validate(),
            Self::Reused(identity) => identity.validate(),
            Self::NoEffectProven(absence) => absence.validate(),
            Self::Conflict(facts) => facts.validate(),
            Self::Unavailable(facts) => facts.validate(),
            Self::Indeterminate(facts) => facts.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TypedReadback {
    Exists(ExistingResourceReadback),
    Partial(PartialEffectReadback),
    Absent(AbsentEvidence),
    Conflict(ConflictFacts),
    Unavailable(UnavailableFacts),
    Indeterminate(IndeterminateFacts),
}

impl TypedReadback {
    pub(crate) fn validate(&self) -> Result<(), ProvisioningContractError> {
        match self {
            Self::Exists(readback) => readback.validate(),
            Self::Partial(readback) => readback.validate(),
            Self::Absent(absence) => absence.validate(),
            Self::Conflict(facts) => facts.validate(),
            Self::Unavailable(facts) => facts.validate(),
            Self::Indeterminate(facts) => facts.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PartialEffectReadback {
    pub canonical_identity_hash: String,
    pub observed_effect_count: u32,
}

impl PartialEffectReadback {
    pub(crate) fn new_verified(
        canonical_identity_hash: String,
        observed_effect_count: u32,
    ) -> Result<Self, ProvisioningContractError> {
        let readback = Self {
            canonical_identity_hash,
            observed_effect_count,
        };
        readback.validate()?;
        Ok(readback)
    }

    fn validate(&self) -> Result<(), ProvisioningContractError> {
        if is_lowercase_sha256(&self.canonical_identity_hash) && self.observed_effect_count > 0 {
            Ok(())
        } else {
            Err(invalid_input())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StableTerminalDisposition {
    pub classification: ProvisioningResultClassification,
    pub next_action: ProvisioningNextAction,
    pub code: Option<StableErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MappingDecision {
    Continue,
    Terminal(StableTerminalDisposition),
}

impl StableResultErrorMapping {
    pub(crate) fn map_adapter_outcome(
        self,
        outcome: &AdapterOutcome,
    ) -> Result<MappingDecision, ProvisioningContractError> {
        outcome.validate()?;
        let decision = match outcome {
            AdapterOutcome::Applied(_) | AdapterOutcome::Reused(_) => MappingDecision::Continue,
            AdapterOutcome::NoEffectProven(_) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::Retryable,
                    next_action: ProvisioningNextAction::Retry,
                    code: None,
                })
            }
            AdapterOutcome::Conflict(facts) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::Blocked,
                    next_action: ProvisioningNextAction::Stop,
                    code: facts.code,
                })
            }
            AdapterOutcome::Unavailable(facts) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::ProvisioningRecoveryRequired,
                    next_action: ProvisioningNextAction::Recover,
                    code: Some(facts.code),
                })
            }
            AdapterOutcome::Indeterminate(facts) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::ProvisioningRecoveryRequired,
                    next_action: ProvisioningNextAction::Recover,
                    code: Some(facts.code),
                })
            }
        };
        Ok(decision)
    }

    pub(crate) fn map_readback(
        self,
        readback: &TypedReadback,
    ) -> Result<MappingDecision, ProvisioningContractError> {
        readback.validate()?;
        let decision = match readback {
            TypedReadback::Exists(_) => MappingDecision::Continue,
            TypedReadback::Partial(_) => MappingDecision::Terminal(StableTerminalDisposition {
                classification: ProvisioningResultClassification::ProvisioningRecoveryRequired,
                next_action: ProvisioningNextAction::Recover,
                code: Some(StableErrorCode::PhysicalPartialEffect),
            }),
            TypedReadback::Absent(_) => MappingDecision::Terminal(StableTerminalDisposition {
                classification: ProvisioningResultClassification::RepairRequired,
                next_action: ProvisioningNextAction::Repair,
                code: None,
            }),
            TypedReadback::Conflict(facts) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::Blocked,
                    next_action: ProvisioningNextAction::Stop,
                    code: facts.code,
                })
            }
            TypedReadback::Unavailable(facts) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::ProvisioningRecoveryRequired,
                    next_action: ProvisioningNextAction::Recover,
                    code: Some(facts.code),
                })
            }
            TypedReadback::Indeterminate(facts) => {
                MappingDecision::Terminal(StableTerminalDisposition {
                    classification: ProvisioningResultClassification::ProvisioningRecoveryRequired,
                    next_action: ProvisioningNextAction::Recover,
                    code: Some(facts.code),
                })
            }
        };
        Ok(decision)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProvisioningResult {
    Completed {
        request: RequestIdentity,
        canonical_identity: ReadbackIdentity,
    },
    FreshAlreadyReady {
        request: RequestIdentity,
        canonical_identity: ReadbackIdentity,
    },
    AuthoritativeReplay {
        request: RequestIdentity,
        operation_id: String,
        canonical_identity: ReadbackIdentity,
    },
    SameRequestIdentityReplay {
        request: RequestIdentity,
        operation_id: String,
        canonical_identity: ReadbackIdentity,
    },
    RetryAllowed {
        request: RequestIdentity,
        code: StableErrorCode,
    },
    RepairAllowed {
        request: RequestIdentity,
        code: StableErrorCode,
    },
    RecoveryRequired {
        request: RequestIdentity,
        code: StableErrorCode,
    },
    Blocked {
        request: RequestIdentity,
        code: StableErrorCode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProvisioningContractErrorKind {
    InvalidInput,
    ContractViolation,
    StaleAuthority,
    ConcurrencyConflict,
    ResourceConflict,
    Unavailable,
    Indeterminate,
    RecoveryRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StableErrorCode {
    ActiveClaimConflict,
    OperationCasConflict,
    OperationInvalidInput,
    OperationStateUnavailable,
    RuntimeAdapterUnavailable,
    RuntimeInternalFailure,
    PhysicalContainmentBlocked,
    PhysicalReparseBlocked,
    PhysicalWrongType,
    PhysicalMutationConditionFailed,
    PhysicalAuthorityUnavailable,
    PhysicalEffectIndeterminate,
    PhysicalIdentityMismatch,
    PhysicalPartialEffect,
    DurableAuthorityStale,
    DurableIdentityConflict,
    DurableNotFound,
    DurableInvalidOperationState,
    DurableRepositoryUnavailable,
    DurableInternalFailure,
}

impl StableErrorCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::ActiveClaimConflict => PROVISIONING_ACTIVE_CLAIM_CONFLICT,
            Self::OperationCasConflict => PROVISIONING_OPERATION_CAS_CONFLICT,
            Self::OperationInvalidInput => PROVISIONING_OPERATION_INVALID_INPUT,
            Self::OperationStateUnavailable => PROVISIONING_OPERATION_STATE_UNAVAILABLE,
            Self::RuntimeAdapterUnavailable => PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE,
            Self::RuntimeInternalFailure => PROVISIONING_RUNTIME_INTERNAL_FAILURE,
            Self::PhysicalContainmentBlocked => PHYSICAL_CONTAINMENT_BLOCKED,
            Self::PhysicalReparseBlocked => PHYSICAL_REPARSE_BLOCKED,
            Self::PhysicalWrongType => PHYSICAL_WRONG_TYPE,
            Self::PhysicalMutationConditionFailed => PHYSICAL_MUTATION_CONDITION_FAILED,
            Self::PhysicalAuthorityUnavailable => PHYSICAL_AUTHORITY_UNAVAILABLE,
            Self::PhysicalEffectIndeterminate => PHYSICAL_EFFECT_INDETERMINATE,
            Self::PhysicalIdentityMismatch => PHYSICAL_IDENTITY_MISMATCH,
            Self::PhysicalPartialEffect => PHYSICAL_PARTIAL_EFFECT,
            Self::DurableAuthorityStale => DURABLE_AUTHORITY_STALE,
            Self::DurableIdentityConflict => DURABLE_IDENTITY_CONFLICT,
            Self::DurableNotFound => DURABLE_NOT_FOUND,
            Self::DurableInvalidOperationState => DURABLE_INVALID_OPERATION_STATE,
            Self::DurableRepositoryUnavailable => DURABLE_REPOSITORY_UNAVAILABLE,
            Self::DurableInternalFailure => DURABLE_INTERNAL_FAILURE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProvisioningContractError {
    pub kind: ProvisioningContractErrorKind,
    pub code: StableErrorCode,
}

fn error(kind: ProvisioningContractErrorKind, code: StableErrorCode) -> ProvisioningContractError {
    ProvisioningContractError { kind, code }
}

fn invalid_input() -> ProvisioningContractError {
    error(
        ProvisioningContractErrorKind::InvalidInput,
        StableErrorCode::OperationInvalidInput,
    )
}

fn contract_violation() -> ProvisioningContractError {
    error(
        ProvisioningContractErrorKind::ContractViolation,
        StableErrorCode::OperationInvalidInput,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OrchestrationRequest {
    ValidateCommand,
    ResolveDescriptor,
    RequestAtomicInitialization,
    RequestStepStarted(RequiredStep),
    RequestAdapterMutation(RequiredStep),
    RequestEffectObservation(RequiredStep),
    RequestTypedReadback(RequiredStep),
    RequestReadbackVerification(RequiredStep),
    RequestConvergence(RequiredStep),
    RequestFinalVerification,
    RequestTerminal,
    ReturnTypedResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OrchestrationResponse {
    CommandValidated,
    DescriptorResolved,
    AtomicInitializationResolved,
    StepStartedRecorded(RequiredStep),
    AdapterOutcomeExpected(RequiredStep),
    EffectObservationRecorded(RequiredStep),
    TypedReadbackExpected(RequiredStep),
    ReadbackVerificationRecorded(RequiredStep),
    ConvergenceRecorded(RequiredStep),
    FinalVerificationResolved,
    TerminalResolved,
    TypedResultReturned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OrchestrationFailureDisposition {
    RejectWithoutAttempt,
    ReturnAuthoritativeConflict,
    StopBeforeAdapter,
    UseStableResultErrorMapping,
    HandoffRecoveryWithoutAdapterReplay,
    PreserveAuthoritativeFacts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrchestrationExchange {
    pub request: OrchestrationRequest,
    pub response: OrchestrationResponse,
    pub failure_disposition: OrchestrationFailureDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PureOrchestrationProtocol {
    pub exchanges: Vec<OrchestrationExchange>,
}

impl PureOrchestrationProtocol {
    pub(crate) fn requests(&self) -> Vec<OrchestrationRequest> {
        self.exchanges
            .iter()
            .map(|exchange| exchange.request.clone())
            .collect()
    }
}

pub(crate) fn build_pure_orchestration_protocol(
    decision: &OperationDecision,
) -> PureOrchestrationProtocol {
    let mut exchanges = vec![
        OrchestrationExchange {
            request: OrchestrationRequest::ValidateCommand,
            response: OrchestrationResponse::CommandValidated,
            failure_disposition: OrchestrationFailureDisposition::RejectWithoutAttempt,
        },
        OrchestrationExchange {
            request: OrchestrationRequest::ResolveDescriptor,
            response: OrchestrationResponse::DescriptorResolved,
            failure_disposition: OrchestrationFailureDisposition::RejectWithoutAttempt,
        },
    ];
    let OperationDecision::Initialize(definition) = decision;
    exchanges.push(OrchestrationExchange {
        request: OrchestrationRequest::RequestAtomicInitialization,
        response: OrchestrationResponse::AtomicInitializationResolved,
        failure_disposition: OrchestrationFailureDisposition::ReturnAuthoritativeConflict,
    });
    for step in definition.required_steps() {
        exchanges.extend([
            OrchestrationExchange {
                request: OrchestrationRequest::RequestStepStarted(step.clone()),
                response: OrchestrationResponse::StepStartedRecorded(step.clone()),
                failure_disposition: OrchestrationFailureDisposition::StopBeforeAdapter,
            },
            OrchestrationExchange {
                request: OrchestrationRequest::RequestAdapterMutation(step.clone()),
                response: OrchestrationResponse::AdapterOutcomeExpected(step.clone()),
                failure_disposition:
                    OrchestrationFailureDisposition::HandoffRecoveryWithoutAdapterReplay,
            },
            OrchestrationExchange {
                request: OrchestrationRequest::RequestEffectObservation(step.clone()),
                response: OrchestrationResponse::EffectObservationRecorded(step.clone()),
                failure_disposition:
                    OrchestrationFailureDisposition::HandoffRecoveryWithoutAdapterReplay,
            },
            OrchestrationExchange {
                request: OrchestrationRequest::RequestTypedReadback(step.clone()),
                response: OrchestrationResponse::TypedReadbackExpected(step.clone()),
                failure_disposition: OrchestrationFailureDisposition::UseStableResultErrorMapping,
            },
            OrchestrationExchange {
                request: OrchestrationRequest::RequestReadbackVerification(step.clone()),
                response: OrchestrationResponse::ReadbackVerificationRecorded(step.clone()),
                failure_disposition:
                    OrchestrationFailureDisposition::HandoffRecoveryWithoutAdapterReplay,
            },
            OrchestrationExchange {
                request: OrchestrationRequest::RequestConvergence(step.clone()),
                response: OrchestrationResponse::ConvergenceRecorded(step.clone()),
                failure_disposition:
                    OrchestrationFailureDisposition::HandoffRecoveryWithoutAdapterReplay,
            },
        ]);
    }
    exchanges.extend([
        OrchestrationExchange {
            request: OrchestrationRequest::RequestFinalVerification,
            response: OrchestrationResponse::FinalVerificationResolved,
            failure_disposition: OrchestrationFailureDisposition::UseStableResultErrorMapping,
        },
        OrchestrationExchange {
            request: OrchestrationRequest::RequestTerminal,
            response: OrchestrationResponse::TerminalResolved,
            failure_disposition:
                OrchestrationFailureDisposition::HandoffRecoveryWithoutAdapterReplay,
        },
        OrchestrationExchange {
            request: OrchestrationRequest::ReturnTypedResult,
            response: OrchestrationResponse::TypedResultReturned,
            failure_disposition: OrchestrationFailureDisposition::PreserveAuthoritativeFacts,
        },
    ]);
    PureOrchestrationProtocol { exchanges }
}

pub(crate) fn validate_orchestration_protocol(
    decision: &OperationDecision,
    protocol: &PureOrchestrationProtocol,
) -> Result<(), ProvisioningContractError> {
    if *protocol == build_pure_orchestration_protocol(decision) {
        Ok(())
    } else {
        Err(contract_violation())
    }
}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.'))
}

fn bounded_key(value: &str) -> bool {
    bounded_identifier(value, 128)
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}
