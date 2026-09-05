use crate::manuscript_provisioning_contract::{
    build_pure_orchestration_protocol, resolve_operation, validate_orchestration_protocol,
    AbsentEvidence, AdapterOutcome, AdapterPortKey, AppliedEffectKind, CanonicalResourceIdentity,
    ContainmentReadback, CreateDefaultCommand, DescriptorKey, DurableManuscriptChannel,
    DurablePlanIntent, DurablePlanOwnerType, DurablePlanScopeKind, DurableStepKind,
    DurableStepScope, EffectCompletionKind, EffectReceipt, ExistingResourceReadback,
    ExplicitAuthorization, ExplicitRepairCommand, ExplicitRetryCommand, FamilyDescriptor,
    FormalStrategyKey, MappingDecision, OperationDecision, OperationDefinition,
    OperationIdempotencyRule, OperationReference, OrchestrationRequest, PartialEffectReadback,
    PlanTemplateKind, PolicyKey, ProvisioningCommand, ProvisioningContractErrorKind,
    ProvisioningNextAction, ProvisioningResultClassification, ProvisioningScopeIdentity,
    ProvisioningTrigger, ReadbackIdentity, RequestIdentity, RequiredStep, ResourceType,
    StableErrorCode, StableResultErrorMapping, TerminalExpectation, TypedReadback,
};

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn primary_scope(owner_type: DurablePlanOwnerType, owner_id: &str) -> ProvisioningScopeIdentity {
    ProvisioningScopeIdentity {
        owner_type,
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
    }
}

fn canonical_identity() -> CanonicalResourceIdentity {
    CanonicalResourceIdentity {
        resource_identity_hash: HASH_A.to_string(),
        placement_identity_hash: HASH_B.to_string(),
        parent_shared_identity_hash: None,
    }
}

fn request() -> RequestIdentity {
    RequestIdentity {
        request_id: "request-1".to_string(),
    }
}

fn required_steps(scope: DurableStepScope) -> Vec<RequiredStep> {
    vec![
        RequiredStep {
            kind: DurableStepKind::EnsureDirectory,
            scope,
        },
        RequiredStep {
            kind: DurableStepKind::EnsureManuscript,
            scope,
        },
        RequiredStep {
            kind: DurableStepKind::RegisterFolderFileRef,
            scope,
        },
        RequiredStep {
            kind: DurableStepKind::RegisterManuscriptFileRef,
            scope,
        },
        RequiredStep {
            kind: DurableStepKind::EstablishBinding,
            scope,
        },
        RequiredStep {
            kind: DurableStepKind::ConvergeDefaultCurrent,
            scope,
        },
    ]
}

fn descriptor_for(owner_type: DurablePlanOwnerType) -> FamilyDescriptor {
    let plan_template = match owner_type {
        DurablePlanOwnerType::Experiment => PlanTemplateKind::ExperimentPrimary,
        DurablePlanOwnerType::ExperimentRun => PlanTemplateKind::ExperimentRunPrimary,
        _ => PlanTemplateKind::ManagedPrimary,
    };
    FamilyDescriptor {
        key: DescriptorKey("managed-primary-v1".to_string()),
        owner_type,
        scope_kind: DurablePlanScopeKind::Channel,
        manuscript_channel: Some(DurableManuscriptChannel::Primary),
        legal_intents: vec![
            DurablePlanIntent::CreateDefault,
            DurablePlanIntent::Retry,
            DurablePlanIntent::Repair,
        ],
        plan_template,
        canonical_steps: required_steps(DurableStepScope::Primary),
        filename_policy_key: PolicyKey("managed-primary-filename-v1".to_string()),
        placement_policy_key: PolicyKey("managed-primary-placement-v1".to_string()),
        adapter_port_key: AdapterPortKey("managed-primary-port-v1".to_string()),
        readback_policy_key: PolicyKey("managed-primary-readback-v1".to_string()),
        terminal_expectation: TerminalExpectation::FormalTupleAfterFinalVerification,
        result_error_mapping: StableResultErrorMapping::ExactV41Authority,
        strategy_key: FormalStrategyKey::SingleChannel,
    }
}

fn predecessor(next_action: ProvisioningNextAction) -> OperationReference {
    assert!(matches!(
        next_action,
        ProvisioningNextAction::Retry | ProvisioningNextAction::Repair
    ));
    OperationReference {
        previous_operation_id: "operation-previous".to_string(),
        expected_revision: 3,
    }
}

fn authorization() -> ExplicitAuthorization {
    ExplicitAuthorization {
        authorization_id: "authorization-1".to_string(),
    }
}

fn create_default() -> ProvisioningCommand {
    ProvisioningCommand::CreateDefault(CreateDefaultCommand {
        target: primary_scope(DurablePlanOwnerType::Review, "review-1"),
        request: request(),
        canonical_resource: canonical_identity(),
        descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
    })
}

fn explicit_retry() -> ProvisioningCommand {
    ProvisioningCommand::ExplicitRetry(ExplicitRetryCommand {
        target: primary_scope(DurablePlanOwnerType::Review, "review-1"),
        request: request(),
        canonical_resource: canonical_identity(),
        descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
        predecessor: predecessor(ProvisioningNextAction::Retry),
        authorization: authorization(),
    })
}

fn explicit_repair() -> ProvisioningCommand {
    ProvisioningCommand::ExplicitRepair(ExplicitRepairCommand {
        target: primary_scope(DurablePlanOwnerType::Review, "review-1"),
        request: request(),
        canonical_resource: canonical_identity(),
        descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
        predecessor: predecessor(ProvisioningNextAction::Repair),
        authorization: authorization(),
    })
}

#[test]
fn p4_3_a_commands_declare_intent_without_caller_supplied_actual_authority() {
    let cases = [
        (
            create_default(),
            DurablePlanIntent::CreateDefault,
            ProvisioningTrigger::OwnerCreate,
        ),
        (
            explicit_retry(),
            DurablePlanIntent::Retry,
            ProvisioningTrigger::ExplicitRetry,
        ),
        (
            explicit_repair(),
            DurablePlanIntent::Repair,
            ProvisioningTrigger::ExplicitRepair,
        ),
    ];

    for (command, intent, trigger) in cases {
        assert_eq!(command.intent(), intent);
        assert_eq!(command.trigger(), trigger);
    }
}

#[test]
fn p4_3_a_all_commands_resolve_only_to_initialization_definitions() {
    let descriptor = descriptor_for(DurablePlanOwnerType::Review);

    let create = resolve_operation(&create_default(), &descriptor).unwrap();
    let retry = resolve_operation(&explicit_retry(), &descriptor).unwrap();
    let repair = resolve_operation(&explicit_repair(), &descriptor).unwrap();

    let OperationDecision::Initialize(OperationDefinition::CreateDefault(create)) = create else {
        panic!("create-default must remain a root initialization definition");
    };
    assert_eq!(create.intent, DurablePlanIntent::CreateDefault);
    assert_eq!(create.trigger, ProvisioningTrigger::OwnerCreate);
    assert_eq!(
        create.idempotency_rule,
        OperationIdempotencyRule::FreshCreate
    );
    assert_eq!(
        create.required_steps,
        required_steps(DurableStepScope::Primary)
    );

    let OperationDecision::Initialize(OperationDefinition::ExplicitRetry(retry)) = retry else {
        panic!("retry must remain a chained initialization definition");
    };
    assert_eq!(retry.intent, DurablePlanIntent::Retry);
    assert_eq!(retry.trigger, ProvisioningTrigger::ExplicitRetry);
    assert_eq!(
        retry.idempotency_rule,
        OperationIdempotencyRule::NewAttemptAfterTerminalRetry
    );
    assert_eq!(retry.predecessor.expected_revision, 3);

    let OperationDecision::Initialize(OperationDefinition::ExplicitRepair(repair)) = repair else {
        panic!("repair must remain a chained initialization definition");
    };
    assert_eq!(repair.intent, DurablePlanIntent::Repair);
    assert_eq!(repair.trigger, ProvisioningTrigger::ExplicitRepair);
    assert_eq!(
        repair.idempotency_rule,
        OperationIdempotencyRule::NewAttemptAfterTerminalRepair
    );
    assert_eq!(repair.predecessor.expected_revision, 3);
}

#[test]
fn p4_3_a_predecessor_reference_remains_declared_cas_not_actual_snapshot() {
    let descriptor = descriptor_for(DurablePlanOwnerType::Review);
    let mut negative_revision = explicit_retry();
    let ProvisioningCommand::ExplicitRetry(command) = &mut negative_revision else {
        unreachable!();
    };
    command.predecessor.expected_revision = -1;
    let error = resolve_operation(&negative_revision, &descriptor).unwrap_err();
    assert_eq!(error.kind, ProvisioningContractErrorKind::ContractViolation);

    let source = include_str!("manuscript_provisioning_contract.rs");
    let reference = source
        .split("pub(crate) struct OperationReference")
        .nth(1)
        .and_then(|tail| tail.split('}').next())
        .expect("OperationReference source");
    assert!(!reference.contains("root_operation_id"));
    assert!(!reference.contains("terminal"));
}

#[test]
fn p4_3_a_descriptor_and_scope_mismatches_are_rejected() {
    let wrong_descriptor = descriptor_for(DurablePlanOwnerType::Finding);
    let error = resolve_operation(&create_default(), &wrong_descriptor).unwrap_err();
    assert_eq!(error.kind, ProvisioningContractErrorKind::ContractViolation);

    let malformed_scope = ProvisioningCommand::CreateDefault(CreateDefaultCommand {
        target: ProvisioningScopeIdentity {
            owner_type: DurablePlanOwnerType::Review,
            owner_id: "review-1".to_string(),
            scope_kind: DurablePlanScopeKind::LiteratureAggregate,
            manuscript_channel: None,
        },
        request: request(),
        canonical_resource: canonical_identity(),
        descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
    });
    assert!(resolve_operation(
        &malformed_scope,
        &descriptor_for(DurablePlanOwnerType::Review)
    )
    .is_err());
}

#[test]
fn p4_3_a_pure_protocol_keeps_atomic_initialization_and_ordered_step_boundaries() {
    let decision = resolve_operation(
        &create_default(),
        &descriptor_for(DurablePlanOwnerType::Review),
    )
    .unwrap();
    let protocol = build_pure_orchestration_protocol(&decision);
    let requests = protocol.requests();

    assert_eq!(requests[0], OrchestrationRequest::ValidateCommand);
    assert_eq!(requests[1], OrchestrationRequest::ResolveDescriptor);
    assert_eq!(
        requests[2],
        OrchestrationRequest::RequestAtomicInitialization
    );
    assert!(matches!(
        requests.last(),
        Some(OrchestrationRequest::ReturnTypedResult)
    ));
    assert_eq!(
        requests
            .iter()
            .filter(|request| matches!(request, OrchestrationRequest::RequestAdapterMutation(_)))
            .count(),
        required_steps(DurableStepScope::Primary).len()
    );
    validate_orchestration_protocol(&decision, &protocol).unwrap();
}

#[test]
fn p4_3_a_protocol_shape_depends_on_canonical_steps_not_caller_actual_facts() {
    let create = resolve_operation(
        &create_default(),
        &descriptor_for(DurablePlanOwnerType::Review),
    )
    .unwrap();
    let retry = resolve_operation(
        &explicit_retry(),
        &descriptor_for(DurablePlanOwnerType::Review),
    )
    .unwrap();
    let create_protocol = build_pure_orchestration_protocol(&create);
    validate_orchestration_protocol(&retry, &create_protocol).unwrap();
}

#[test]
fn p4_3_a_readback_and_adapter_outcomes_remain_typed() {
    let existing = ExistingResourceReadback::new_verified(
        ResourceType::Markdown,
        ReadbackIdentity {
            canonical_identity_hash: HASH_A.to_string(),
            authoritative_revision: 2,
        },
        ContainmentReadback::Verified,
        Some("file-ref-1".to_string()),
        Some("binding-1".to_string()),
        true,
    )
    .unwrap();
    assert!(StableResultErrorMapping::ExactV41Authority
        .map_readback(&TypedReadback::Exists(existing))
        .is_ok_and(|decision| decision == MappingDecision::Continue));

    let partial = PartialEffectReadback::new_verified(HASH_A.to_string(), 1).unwrap();
    let MappingDecision::Terminal(terminal) = StableResultErrorMapping::ExactV41Authority
        .map_readback(&TypedReadback::Partial(partial))
        .unwrap()
    else {
        panic!("partial readback must require recovery");
    };
    assert_eq!(
        terminal.classification,
        ProvisioningResultClassification::ProvisioningRecoveryRequired
    );
    assert_eq!(terminal.next_action, ProvisioningNextAction::Recover);
    assert_eq!(terminal.code, Some(StableErrorCode::PhysicalPartialEffect));

    let absence = AbsentEvidence {
        resource_type: ResourceType::Markdown,
        canonical_identity_hash: HASH_A.to_string(),
        owner_scope_match: true,
        missing_canonical_count: 1,
    };
    let MappingDecision::Terminal(terminal) = StableResultErrorMapping::ExactV41Authority
        .map_readback(&TypedReadback::Absent(absence.clone()))
        .unwrap()
    else {
        panic!("verified absence must require repair");
    };
    assert_eq!(terminal.next_action, ProvisioningNextAction::Repair);

    let MappingDecision::Terminal(terminal) = StableResultErrorMapping::ExactV41Authority
        .map_adapter_outcome(&AdapterOutcome::NoEffectProven(absence))
        .unwrap()
    else {
        panic!("no-effect adapter outcome must remain retryable");
    };
    assert_eq!(terminal.next_action, ProvisioningNextAction::Retry);
}

#[test]
fn p4_3_a_only_applied_adapter_outcomes_expose_effect_receipts() {
    let receipt = EffectReceipt {
        effect_kind: AppliedEffectKind::Created,
        completion: EffectCompletionKind::CompleteEffect,
        canonical_identity_hash: HASH_A.to_string(),
        resource_record_id: Some("file-ref-1".to_string()),
        byte_length: Some(32),
    };
    let applied = AdapterOutcome::Applied(receipt.clone());
    assert_eq!(applied.effect_receipt(), Some(&receipt));

    let reused = AdapterOutcome::Reused(ReadbackIdentity {
        canonical_identity_hash: HASH_A.to_string(),
        authoritative_revision: 3,
    });
    assert_eq!(reused.effect_receipt(), None);
}

#[test]
fn p4_3_a_stable_error_catalog_includes_narrowed_authority_failures() {
    let cases = [
        (
            StableErrorCode::DurableAuthorityStale,
            "durable-authority-stale",
        ),
        (
            StableErrorCode::DurableIdentityConflict,
            "durable-identity-conflict",
        ),
        (StableErrorCode::DurableNotFound, "durable-not-found"),
        (
            StableErrorCode::DurableInvalidOperationState,
            "durable-invalid-operation-state",
        ),
        (
            StableErrorCode::DurableRepositoryUnavailable,
            "durable-repository-unavailable",
        ),
        (
            StableErrorCode::DurableInternalFailure,
            "durable-internal-failure",
        ),
    ];
    for (code, expected) in cases {
        assert_eq!(code.as_str(), expected);
    }
}
