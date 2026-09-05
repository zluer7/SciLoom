use crate::db::manuscript_provisioning_operation_state::step_progress::{
    is_lowercase_sha256, DurableStepBoundary, DurableStepEffectOutcome, DurableStepProgressRow,
};
use crate::db::manuscript_provisioning_operation_state::step_progress_repository::{
    converge_step, mark_step_started, read_attempt_plan, read_attempt_step_progress,
    record_step_effect_observed, record_step_readback_verified, ProgressAuthorityInput,
};
use crate::db::manuscript_provisioning_operation_state::{
    initialize_chained_operation_in_connection, initialize_mainline_operation_atomically,
    read_active_claim_for_operation, read_operation_attempt,
    terminalize_attempt_release_claim_and_enqueue_audit,
    terminalize_attempt_retain_claim_and_enqueue_audit, ChainedAtomicInitializationRequest,
    ChainedAtomicInitializationResult, ChainedInitializationIntent,
    MainlineAtomicInitializationRequest, ProvisioningOperationAttempt, TerminalAttemptInput,
};
use crate::manuscript_provisioning_contract::{
    CanonicalResourceIdentity, DescriptorKey, DurableManuscriptChannel, DurablePlanOwnerType,
    DurablePlanScopeKind, DurableStepKind, DurableStepScope, ProvisioningScopeIdentity,
    PROVISIONING_OWNER_ID_MAX_BYTES,
};
use crate::owner_authority_lease::{
    AuthorityKey, AuthorityLeaseMode, AuthorityLeaseRequest, OwnerAuthorityLeaseRegistry,
};
use crate::provisioning_runtime::core::ProvisioningRuntime;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{State, WebviewWindow};

const MAINLINE_VERSION: &str = "lp12-a3-mainline-v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainlineAuthorityInput {
    token: String,
    requests: Vec<AuthorityLeaseRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainlineBeginInput {
    owner_type: String,
    owner_id: String,
    scope_kind: String,
    manuscript_channel: Option<String>,
    canonical_resource_identity_hash: String,
    canonical_placement_identity_hash: String,
    parent_shared_identity_hash: Option<String>,
    expected_directory_path: String,
    expected_manuscript_paths: Vec<MainlineExpectedManuscriptPath>,
    authority: MainlineAuthorityInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MainlineExpectedManuscriptPath {
    manuscript_channel: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainlineStepView {
    step_kind: String,
    step_scope: String,
    boundary: String,
    effect_outcome: String,
    observed_identity_hash: Option<String>,
    resource_record_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainlineOperationView {
    operation_id: String,
    root_operation_id: String,
    intent: String,
    operation_status: String,
    result_classification: Option<String>,
    next_action: Option<String>,
    ready: bool,
    resumed: bool,
    canonical_resource_identity_hash: String,
    canonical_placement_identity_hash: String,
    steps: Vec<MainlineStepView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainlineObservedStepInput {
    step_kind: String,
    step_scope: String,
    effect_outcome: String,
    observed_identity_hash: String,
    resource_record_id: Option<String>,
    readback_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainlineFinishInput {
    operation_id: String,
    ready: bool,
    #[serde(default)]
    effect_outcome_unknown: bool,
    cause_code: Option<String>,
    steps: Vec<MainlineObservedStepInput>,
    expected_directory_path: String,
    expected_manuscript_paths: Vec<MainlineExpectedManuscriptPath>,
    authority: MainlineAuthorityInput,
}

#[derive(Debug, Clone)]
struct FileRefEvidence {
    id: String,
    owner_type: String,
    owner_id: String,
    manuscript_channel: String,
    resource_kind: String,
    file_role: String,
    location_mode: String,
    path: String,
    path_identity_key: String,
    deleted_at: Option<String>,
}

fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn normalized_declared_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() || !std::path::Path::new(path).is_absolute() || path.contains('\0') {
        return Err("PROVISIONING_MAINLINE_PATH_INVALID".to_string());
    }
    let mut value = path.replace('\\', "/");
    if let Some(rest) = value.strip_prefix("//?/UNC/") {
        value = format!("//{rest}");
    } else if let Some(rest) = value.strip_prefix("//?/") {
        value = rest.to_string();
    }
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    Ok(value)
}

fn expected_channels(scope: &ProvisioningScopeIdentity) -> HashSet<String> {
    if scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
        [
            "literature_outline".to_string(),
            "dedicated_notes".to_string(),
        ]
        .into_iter()
        .collect()
    } else {
        [scope
            .manuscript_channel
            .map(|value| value.as_str())
            .unwrap_or("primary")
            .to_string()]
        .into_iter()
        .collect()
    }
}

fn canonical_resource_identity_hash(scope: &ProvisioningScopeIdentity) -> Result<String, String> {
    let canonical_scope = if scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
        "literature-aggregate"
    } else {
        "primary"
    };
    let payload = json!({
        "domain": "labpod.manuscript-provisioning-resource-v1",
        "manuscriptChannel": scope.manuscript_channel.map(|value| value.as_str()),
        "ownerId": scope.owner_id,
        "ownerType": scope.owner_type.as_str(),
        "scope": canonical_scope,
    });
    serde_json::to_string(&payload)
        .map(hash)
        .map_err(|_| "PROVISIONING_MAINLINE_RESOURCE_IDENTITY_ENCODING_FAILED".to_string())
}

fn step_evidence_hash(
    scope: &ProvisioningScopeIdentity,
    step_kind: DurableStepKind,
    step_scope: DurableStepScope,
    observed_identity: &str,
    resource_record_id: Option<&str>,
) -> Result<String, String> {
    let canonical_scope = if scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
        "literature-aggregate"
    } else {
        "primary"
    };
    let payload = json!({
        "domain": "labpod.manuscript-provisioning-effect-v1",
        "observedIdentity": observed_identity,
        "resource": {
            "domain": "labpod.manuscript-provisioning-resource-v1",
            "manuscriptChannel": scope.manuscript_channel.map(|value| value.as_str()),
            "ownerId": scope.owner_id,
            "ownerType": scope.owner_type.as_str(),
            "scope": canonical_scope,
        },
        "resourceRecordId": resource_record_id,
        "stepKind": step_kind.as_str(),
        "stepScope": step_scope.as_str(),
    });
    serde_json::to_string(&payload)
        .map(hash)
        .map_err(|_| "PROVISIONING_MAINLINE_STEP_EVIDENCE_ENCODING_FAILED".to_string())
}

fn operation_chain_has_physical_custody(
    connection: &Connection,
    operation_id: Option<&str>,
    scope: &ProvisioningScopeIdentity,
    step_kind: DurableStepKind,
    step_scope: DurableStepScope,
    expected_path: &str,
) -> Result<bool, String> {
    let expected_hash = step_evidence_hash(
        scope,
        step_kind,
        step_scope,
        &normalized_declared_path(expected_path)?,
        None,
    )?;
    let mut current = operation_id.map(str::to_string);
    let mut seen = HashSet::new();
    for _ in 0..32 {
        let Some(candidate) = current else {
            return Ok(false);
        };
        if !seen.insert(candidate.clone()) {
            return Err("PROVISIONING_MAINLINE_OPERATION_CHAIN_CONFLICT".to_string());
        }
        let attempt = read_operation_attempt(connection, &candidate)
            .map_err(|error| error.code.to_string())?
            .ok_or_else(|| "PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())?;
        if attempt.owner_type != scope.owner_type.as_str()
            || attempt.owner_id != scope.owner_id
            || attempt.scope_kind != scope.scope_kind.as_str()
            || attempt.manuscript_channel.as_deref()
                != scope.manuscript_channel.map(|value| value.as_str())
        {
            return Err("PROVISIONING_MAINLINE_OPERATION_CHAIN_CONFLICT".to_string());
        }
        let steps = read_attempt_step_progress(connection, &candidate)
            .map_err(|error| error.code.to_string())?;
        if steps.iter().any(|step| {
            step.step_kind == step_kind
                && step.step_scope == step_scope
                && step.boundary == DurableStepBoundary::Converged
                && matches!(
                    step.effect_outcome,
                    DurableStepEffectOutcome::Created | DurableStepEffectOutcome::Reused
                )
                && step.observed_identity_hash.as_deref() == Some(expected_hash.as_str())
                && step.resource_record_id.is_none()
        }) {
            return Ok(true);
        }
        current = attempt.previous_operation_id;
    }
    Err("PROVISIONING_MAINLINE_OPERATION_CHAIN_TOO_DEEP".to_string())
}

fn validate_expected_paths(
    scope: &ProvisioningScopeIdentity,
    directory: &str,
    manuscripts: &[MainlineExpectedManuscriptPath],
    placement_hash: &str,
) -> Result<(), String> {
    let directory = normalized_declared_path(directory)?;
    let mut channels = HashSet::new();
    let mut ordered = manuscripts.to_vec();
    ordered.sort_by_key(|item| match item.manuscript_channel.as_str() {
        "primary" => 0,
        "literature_outline" => 1,
        "dedicated_notes" => 2,
        _ => 3,
    });
    let mut paths = vec![directory.clone()];
    for item in &ordered {
        let parsed =
            DurableManuscriptChannel::from_str(&item.manuscript_channel).map_err(command_error)?;
        if !channels.insert(parsed.as_str().to_string()) {
            return Err("PROVISIONING_MAINLINE_PATH_IDENTITY_CONFLICT".to_string());
        }
        let path = normalized_declared_path(&item.path)?;
        let parent = std::path::Path::new(&path)
            .parent()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "PROVISIONING_MAINLINE_PATH_INVALID".to_string())?;
        if normalized_declared_path(parent)? != directory {
            return Err("PROVISIONING_MAINLINE_PATH_IDENTITY_CONFLICT".to_string());
        }
        paths.push(path);
    }
    if channels != expected_channels(scope) {
        return Err("PROVISIONING_MAINLINE_PATH_CHANNEL_CONFLICT".to_string());
    }
    if hash(paths.join("|")) != placement_hash {
        return Err("PROVISIONING_MAINLINE_PLACEMENT_HASH_CONFLICT".to_string());
    }
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn command_error(code: impl AsRef<str>) -> String {
    code.as_ref().to_string()
}

fn parse_scope(input: &MainlineBeginInput) -> Result<ProvisioningScopeIdentity, String> {
    let owner_id = input.owner_id.trim();
    if owner_id.is_empty()
        || owner_id.len() > PROVISIONING_OWNER_ID_MAX_BYTES
        || owner_id.chars().any(char::is_control)
    {
        return Err("PROVISIONING_MAINLINE_IDENTITY_INVALID".to_string());
    }
    let scope = ProvisioningScopeIdentity {
        owner_type: DurablePlanOwnerType::from_str(&input.owner_type).map_err(command_error)?,
        owner_id: owner_id.to_string(),
        scope_kind: DurablePlanScopeKind::from_str(&input.scope_kind).map_err(command_error)?,
        manuscript_channel: input
            .manuscript_channel
            .as_deref()
            .map(DurableManuscriptChannel::from_str)
            .transpose()
            .map_err(command_error)?,
    };
    scope
        .validate()
        .map_err(|_| "PROVISIONING_MAINLINE_SCOPE_CONFLICT".to_string())?;
    if !is_lowercase_sha256(&input.canonical_resource_identity_hash)
        || !is_lowercase_sha256(&input.canonical_placement_identity_hash)
        || input
            .parent_shared_identity_hash
            .as_deref()
            .is_some_and(|value| !is_lowercase_sha256(value))
    {
        return Err("PROVISIONING_MAINLINE_IDENTITY_INVALID".to_string());
    }
    if input.canonical_resource_identity_hash != canonical_resource_identity_hash(&scope)? {
        return Err("PROVISIONING_MAINLINE_RESOURCE_IDENTITY_CONFLICT".to_string());
    }
    validate_expected_paths(
        &scope,
        &input.expected_directory_path,
        &input.expected_manuscript_paths,
        &input.canonical_placement_identity_hash,
    )?;
    Ok(scope)
}

fn descriptor_key(scope: &ProvisioningScopeIdentity) -> DescriptorKey {
    DescriptorKey(
        if scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
            "literature-aggregate-v1".to_string()
        } else if scope.owner_type.as_str() == "literature" {
            "literature-channel-v1".to_string()
        } else {
            "managed-primary-v1".to_string()
        },
    )
}

fn validate_authority(
    window: &WebviewWindow,
    registry: &OwnerAuthorityLeaseRegistry,
    authority: &MainlineAuthorityInput,
) -> Result<(), String> {
    registry
        .validate(window.label(), &authority.token, &authority.requests)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn validate_authority_scope(
    authority: &MainlineAuthorityInput,
    scope: &ProvisioningScopeIdentity,
) -> Result<(), String> {
    let expected_channels: HashSet<String> =
        if scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
            [
                "primary".to_string(),
                "literature_outline".to_string(),
                "dedicated_notes".to_string(),
                "literature-aggregate".to_string(),
            ]
            .into_iter()
            .collect()
        } else {
            let channel = scope
                .manuscript_channel
                .map(|value| value.as_str())
                .unwrap_or("primary")
                .to_string();
            if scope.owner_type == DurablePlanOwnerType::Literature && channel != "primary" {
                ["primary".to_string(), channel].into_iter().collect()
            } else {
                [channel].into_iter().collect()
            }
        };
    let mut managed_root = false;
    let mut owner = false;
    let mut channels = HashSet::new();
    for request in &authority.requests {
        match &request.key {
            AuthorityKey::ManagedRoot if request.mode == AuthorityLeaseMode::Read => {
                managed_root = true;
            }
            AuthorityKey::Project { .. } if request.mode == AuthorityLeaseMode::Read => {}
            AuthorityKey::Owner {
                owner_type,
                owner_id,
            } if request.mode == AuthorityLeaseMode::Read
                && owner_type == scope.owner_type.as_str()
                && owner_id == &scope.owner_id =>
            {
                owner = true;
            }
            AuthorityKey::ChannelScope {
                owner_type,
                owner_id,
                scope: request_scope,
            } if request.mode == AuthorityLeaseMode::Write
                && owner_type == scope.owner_type.as_str()
                && owner_id == &scope.owner_id
                && expected_channels.contains(request_scope) =>
            {
                channels.insert(request_scope.clone());
            }
            _ => return Err("PROVISIONING_MAINLINE_AUTHORITY_SCOPE_CONFLICT".to_string()),
        }
    }
    if !managed_root || !owner || channels != expected_channels {
        return Err("PROVISIONING_MAINLINE_AUTHORITY_SCOPE_CONFLICT".to_string());
    }
    Ok(())
}

fn latest_leaf(
    connection: &Connection,
    scope: &ProvisioningScopeIdentity,
) -> Result<Option<ProvisioningOperationAttempt>, String> {
    let operation_id = connection
        .query_row(
            "SELECT candidate.operation_id
             FROM manuscript_provisioning_operation_attempts candidate
             WHERE candidate.owner_type=?1 AND candidate.owner_id=?2
               AND candidate.scope_kind=?3
               AND candidate.manuscript_channel IS ?4
               AND NOT EXISTS (
                 SELECT 1 FROM manuscript_provisioning_operation_attempts child
                 WHERE child.previous_operation_id=candidate.operation_id
               )
             ORDER BY candidate.started_at DESC, candidate.operation_id DESC
             LIMIT 1",
            params![
                scope.owner_type.as_str(),
                scope.owner_id,
                scope.scope_kind.as_str(),
                scope.manuscript_channel.map(|value| value.as_str()),
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "PROVISIONING_MAINLINE_READ_FAILED".to_string())?;
    operation_id
        .map(|operation_id| {
            read_operation_attempt(connection, &operation_id)
                .map_err(|error| error.code.to_string())?
                .ok_or_else(|| "PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())
        })
        .transpose()
}

fn view(
    connection: &Connection,
    attempt: ProvisioningOperationAttempt,
    resumed: bool,
) -> Result<MainlineOperationView, String> {
    let plan = read_attempt_plan(connection, &attempt.operation_id)
        .map_err(|error| error.code.to_string())?
        .ok_or_else(|| "PROVISIONING_MAINLINE_PLAN_MISSING".to_string())?;
    let steps = read_attempt_step_progress(connection, &attempt.operation_id)
        .map_err(|error| error.code.to_string())?;
    Ok(MainlineOperationView {
        operation_id: attempt.operation_id.clone(),
        root_operation_id: attempt
            .root_operation_id
            .clone()
            .unwrap_or_else(|| attempt.operation_id.clone()),
        intent: attempt.intent,
        operation_status: attempt.operation_status.clone(),
        result_classification: attempt.result_classification,
        next_action: attempt.next_action,
        ready: attempt.operation_status == "terminal-completed",
        resumed,
        canonical_resource_identity_hash: plan.canonical_resource_identity_hash,
        canonical_placement_identity_hash: plan.canonical_placement_identity_hash,
        steps: steps
            .into_iter()
            .map(|step| MainlineStepView {
                step_kind: step.step_kind.as_str().to_string(),
                step_scope: step.step_scope.as_str().to_string(),
                boundary: step.boundary.as_str().to_string(),
                effect_outcome: step.effect_outcome.as_str().to_string(),
                observed_identity_hash: step.observed_identity_hash,
                resource_record_id: step.resource_record_id,
            })
            .collect(),
    })
}

fn identity_matches(
    connection: &Connection,
    operation_id: &str,
    resource: &CanonicalResourceIdentity,
) -> Result<bool, String> {
    let plan = read_attempt_plan(connection, operation_id)
        .map_err(|error| error.code.to_string())?
        .ok_or_else(|| "PROVISIONING_MAINLINE_PLAN_MISSING".to_string())?;
    Ok(
        plan.canonical_resource_identity_hash == resource.resource_identity_hash
            && plan.canonical_placement_identity_hash == resource.placement_identity_hash
            && plan.parent_shared_identity_hash == resource.parent_shared_identity_hash,
    )
}

fn initialize_or_resume(
    connection: &mut Connection,
    runtime: &ProvisioningRuntime,
    input: &MainlineBeginInput,
) -> Result<MainlineOperationView, String> {
    let scope = parse_scope(input)?;
    let resource = CanonicalResourceIdentity {
        resource_identity_hash: input.canonical_resource_identity_hash.clone(),
        placement_identity_hash: input.canonical_placement_identity_hash.clone(),
        parent_shared_identity_hash: input.parent_shared_identity_hash.clone(),
    };
    if let Some(leaf) = latest_leaf(connection, &scope)? {
        if !identity_matches(connection, &leaf.operation_id, &resource)? {
            return Err("PROVISIONING_MAINLINE_IDENTITY_CONFLICT".to_string());
        }
        if leaf.operation_status == "terminal-completed" {
            // A durable terminal is necessary but not sufficient for READY.  Re-read the
            // exact physical/FileRef/Binding identity on every mounted invocation so stale
            // or externally damaged state can never be surfaced as a false-ready result.
            verify_existing_physical_custody(
                connection,
                Some(&leaf.operation_id),
                &scope,
                &input.expected_directory_path,
                &input.expected_manuscript_paths,
            )?;
            verify_ready_paths_match_file_refs(
                connection,
                &scope,
                &input.expected_directory_path,
                &input.expected_manuscript_paths,
            )?;
            return view(connection, leaf, true);
        }
        if leaf.operation_status == "active" {
            verify_existing_physical_custody(
                connection,
                Some(&leaf.operation_id),
                &scope,
                &input.expected_directory_path,
                &input.expected_manuscript_paths,
            )?;
            let claim = read_active_claim_for_operation(connection, &leaf.operation_id)
                .map_err(|error| error.code.to_string())?
                .ok_or_else(|| "PROVISIONING_MAINLINE_ACTIVE_CLAIM_MISSING".to_string())?;
            if claim.claim_owner_token != runtime.mainline_ownership_context().claim_owner_token() {
                return Err("PROVISIONING_MAINLINE_ACTIVE_CLAIM_CONFLICT".to_string());
            }
            return view(connection, leaf, true);
        }
        let intent = match leaf.next_action.as_deref() {
            Some("retry") => ChainedInitializationIntent::ExplicitRetry,
            Some("repair") => ChainedInitializationIntent::ExplicitRepair,
            Some("recover") => return Err("PROVISIONING_MAINLINE_RECOVERY_REQUIRED".to_string()),
            _ => return Err("PROVISIONING_MAINLINE_CONTINUATION_BLOCKED".to_string()),
        };
        verify_existing_physical_custody(
            connection,
            Some(&leaf.operation_id),
            &scope,
            &input.expected_directory_path,
            &input.expected_manuscript_paths,
        )?;
        let child_id = format!(
            "prov-{}",
            hash(format!(
                "labpod.provisioning-mainline-attempt\n{}\n{}\n{}\n{}",
                leaf.operation_id,
                leaf.revision,
                match intent {
                    ChainedInitializationIntent::ExplicitRetry => "retry",
                    ChainedInitializationIntent::ExplicitRepair => "repair",
                },
                resource.resource_identity_hash
            ))
        );
        let request = ChainedAtomicInitializationRequest {
            operation_id: child_id,
            scope,
            intent,
            predecessor_operation_id: leaf.operation_id,
            expected_predecessor_revision: leaf.revision,
            authorization_id: "a3-mounted-mainline-continuation".to_string(),
            descriptor_key: descriptor_key(&parse_scope(input)?),
            canonical_resource: resource,
            occurred_at: now(),
        };
        let operation_id = match initialize_chained_operation_in_connection(
            connection,
            runtime.mainline_ownership_context(),
            &request,
        ) {
            ChainedAtomicInitializationResult::Initialized(authority)
            | ChainedAtomicInitializationResult::AuthoritativeExisting(authority) => {
                authority.operation_id
            }
            ChainedAtomicInitializationResult::TerminalExisting(authority) => {
                authority.operation_id
            }
            ChainedAtomicInitializationResult::RecoveryRequiredExisting(_) => {
                return Err("PROVISIONING_MAINLINE_RECOVERY_REQUIRED".to_string())
            }
            other => return Err(format!("PROVISIONING_MAINLINE_CHAIN_INIT_{other:?}")),
        };
        let attempt = read_operation_attempt(connection, &operation_id)
            .map_err(|error| error.code.to_string())?
            .ok_or_else(|| "PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())?;
        return view(connection, attempt, true);
    }

    verify_existing_physical_custody(
        connection,
        None,
        &scope,
        &input.expected_directory_path,
        &input.expected_manuscript_paths,
    )?;

    let root_id = format!(
        "prov-{}",
        hash(format!(
            "labpod.provisioning-mainline-root\n{}\n{}\n{}\n{}\n{}",
            scope.owner_type.as_str(),
            scope.owner_id,
            scope.scope_kind.as_str(),
            scope
                .manuscript_channel
                .map(|value| value.as_str())
                .unwrap_or(""),
            resource.resource_identity_hash
        ))
    );
    let initialized = initialize_mainline_operation_atomically(
        connection,
        runtime.mainline_ownership_context(),
        &MainlineAtomicInitializationRequest {
            operation_id: root_id,
            scope: scope.clone(),
            descriptor_key: descriptor_key(&scope),
            canonical_resource: resource,
            occurred_at: now(),
        },
    )?;
    view(connection, initialized.attempt, false)
}

fn find_step<'a>(
    steps: &'a mut [DurableStepProgressRow],
    observed: &MainlineObservedStepInput,
) -> Result<&'a mut DurableStepProgressRow, String> {
    let kind = DurableStepKind::from_str(&observed.step_kind).map_err(command_error)?;
    let scope = DurableStepScope::from_str(&observed.step_scope).map_err(command_error)?;
    steps
        .iter_mut()
        .find(|step| step.step_kind == kind && step.step_scope == scope)
        .ok_or_else(|| "PROVISIONING_MAINLINE_STEP_IDENTITY_CONFLICT".to_string())
}

fn file_ref_evidence(connection: &Connection, id: &str) -> Result<Option<FileRefEvidence>, String> {
    connection
        .query_row(
            "SELECT id,owner_type,owner_id,manuscript_channel,resource_kind,
                    file_role,location_mode,path,path_identity_key,deleted_at
             FROM file_refs WHERE id=?1 LIMIT 1",
            [id],
            |row| {
                Ok(FileRefEvidence {
                    id: row.get(0)?,
                    owner_type: row.get(1)?,
                    owner_id: row.get(2)?,
                    manuscript_channel: row.get(3)?,
                    resource_kind: row.get(4)?,
                    file_role: row.get(5)?,
                    location_mode: row.get(6)?,
                    path: row.get(7)?,
                    path_identity_key: row.get(8)?,
                    deleted_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|_| "PROVISIONING_MAINLINE_FILE_REF_READ_FAILED".to_string())
}

fn active_owner_file_refs(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
) -> Result<Vec<FileRefEvidence>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,owner_type,owner_id,manuscript_channel,resource_kind,
                    file_role,location_mode,path,path_identity_key,deleted_at
             FROM file_refs
             WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
        )
        .map_err(|_| "PROVISIONING_MAINLINE_FILE_REF_READ_FAILED".to_string())?;
    let rows = statement
        .query_map(params![owner_type, owner_id], |row| {
            Ok(FileRefEvidence {
                id: row.get(0)?,
                owner_type: row.get(1)?,
                owner_id: row.get(2)?,
                manuscript_channel: row.get(3)?,
                resource_kind: row.get(4)?,
                file_role: row.get(5)?,
                location_mode: row.get(6)?,
                path: row.get(7)?,
                path_identity_key: row.get(8)?,
                deleted_at: row.get(9)?,
            })
        })
        .map_err(|_| "PROVISIONING_MAINLINE_FILE_REF_READ_FAILED".to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "PROVISIONING_MAINLINE_FILE_REF_READ_FAILED".to_string())
}

fn path_matches(file_ref: &FileRefEvidence, expected: &str) -> bool {
    normalized_declared_path(&file_ref.path).ok().as_deref() == Some(expected)
        && normalized_declared_path(&file_ref.path_identity_key)
            .ok()
            .as_deref()
            == Some(expected)
}

fn physical_presence(path: &str, kind: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || (kind == "folder" && !metadata.is_dir())
                || (kind == "file" && !metadata.is_file())
            {
                Err("PROVISIONING_MAINLINE_PHYSICAL_IDENTITY_CONFLICT".to_string())
            } else {
                Ok(true)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("PROVISIONING_MAINLINE_PHYSICAL_READBACK_FAILED".to_string()),
    }
}

fn valid_current_file_ref(
    connection: &Connection,
    id: &str,
    owner_type: &str,
    owner_id: &str,
    channel: &str,
) -> Result<bool, String> {
    Ok(file_ref_evidence(connection, id)?.is_some_and(|file_ref| {
        file_ref.owner_type == owner_type
            && file_ref.owner_id == owner_id
            && file_ref.manuscript_channel == channel
            && file_ref.resource_kind == "file"
            && file_ref.file_role == "manuscript"
            && matches!(file_ref.location_mode.as_str(), "managed" | "external")
            && file_ref.deleted_at.is_none()
    }))
}

fn verify_existing_physical_custody(
    connection: &Connection,
    operation_id: Option<&str>,
    scope: &ProvisioningScopeIdentity,
    directory: &str,
    manuscripts: &[MainlineExpectedManuscriptPath],
) -> Result<(), String> {
    let directory = normalized_declared_path(directory)?;
    let refs = active_owner_file_refs(connection, scope.owner_type.as_str(), &scope.owner_id)?;
    let folder_refs = refs
        .iter()
        .filter(|file_ref| {
            file_ref.manuscript_channel == "primary"
                && file_ref.resource_kind == "folder"
                && file_ref.file_role == "defaultFolder"
                && file_ref.location_mode == "managed"
                && path_matches(file_ref, &directory)
        })
        .collect::<Vec<_>>();
    if folder_refs.len() > 1 {
        return Err("PROVISIONING_MAINLINE_FOLDER_CUSTODY_CONFLICT".to_string());
    }
    // A prior operation may have durably registered a manuscript before its
    // companion folder FileRef.  In that exact known-partial state the
    // manuscript FileRef proves custody of the existing workspace directory;
    // an otherwise unclaimed directory remains a fail-closed conflict.
    let mut has_exact_manuscript_custody = false;
    for expected in manuscripts {
        let path = normalized_declared_path(&expected.path)?;
        let manuscript_refs = refs
            .iter()
            .filter(|file_ref| {
                file_ref.manuscript_channel == expected.manuscript_channel
                    && file_ref.resource_kind == "file"
                    && file_ref.file_role == "manuscript"
                    && file_ref.location_mode == "managed"
                    && path_matches(file_ref, &path)
            })
            .collect::<Vec<_>>();
        if manuscript_refs.len() > 1 {
            return Err("PROVISIONING_MAINLINE_MANUSCRIPT_CUSTODY_CONFLICT".to_string());
        }
        if physical_presence(&path, "file")? && manuscript_refs.len() == 1 {
            has_exact_manuscript_custody = true;
        }
    }
    let directory_exists = physical_presence(&directory, "folder")?;
    let directory_step_scope = if scope.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
        DurableStepScope::LiteratureAggregate
    } else {
        DurableStepScope::Primary
    };
    let has_operation_directory_custody = directory_exists
        && folder_refs.len() != 1
        && !has_exact_manuscript_custody
        && operation_chain_has_physical_custody(
            connection,
            operation_id,
            scope,
            DurableStepKind::EnsureDirectory,
            directory_step_scope,
            &directory,
        )?;
    if directory_exists
        && folder_refs.len() != 1
        && !has_exact_manuscript_custody
        && !has_operation_directory_custody
    {
        return Err("PROVISIONING_MAINLINE_UNKNOWN_PHYSICAL_DIRECTORY".to_string());
    }
    for expected in manuscripts {
        let path = normalized_declared_path(&expected.path)?;
        let manuscript_refs = refs
            .iter()
            .filter(|file_ref| {
                file_ref.manuscript_channel == expected.manuscript_channel
                    && file_ref.resource_kind == "file"
                    && file_ref.file_role == "manuscript"
                    && file_ref.location_mode == "managed"
                    && path_matches(file_ref, &path)
            })
            .collect::<Vec<_>>();
        if manuscript_refs.len() > 1 {
            return Err("PROVISIONING_MAINLINE_MANUSCRIPT_CUSTODY_CONFLICT".to_string());
        }
        if physical_presence(&path, "file")? {
            let Some(manuscript) = manuscript_refs.first() else {
                let step_scope = DurableStepScope::from_str(&expected.manuscript_channel)
                    .map_err(command_error)?;
                if operation_chain_has_physical_custody(
                    connection,
                    operation_id,
                    scope,
                    DurableStepKind::EnsureManuscript,
                    step_scope,
                    &path,
                )? {
                    continue;
                }
                return Err("PROVISIONING_MAINLINE_UNKNOWN_PHYSICAL_MANUSCRIPT".to_string());
            };
            let binding =
                crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
                    connection,
                    scope.owner_type.as_str(),
                    &scope.owner_id,
                    &expected.manuscript_channel,
                )?;
            // An exact active FileRef is sufficient durable custody for a pre-existing
            // manuscript.  Binding may legitimately be the missing companion effect in a
            // known partial.  If a Binding exists, however, every populated slot must agree
            // with the exact identity; conflicting custody always fails closed.
            if let Some(binding) = binding {
                let folder_id = folder_refs.first().map(|file_ref| file_ref.id.as_str());
                let current_conflicts = match binding.current_file_ref_id.as_deref() {
                    Some(value) => !valid_current_file_ref(
                        connection,
                        value,
                        scope.owner_type.as_str(),
                        &scope.owner_id,
                        &expected.manuscript_channel,
                    )?,
                    None => false,
                };
                let slot_conflicts = binding
                    .default_folder_file_ref_id
                    .as_deref()
                    .is_some_and(|value| Some(value) != folder_id)
                    || binding
                        .default_manuscript_file_ref_id
                        .as_deref()
                        .is_some_and(|value| value != manuscript.id)
                    || current_conflicts;
                if binding.deleted_at.is_some() || slot_conflicts {
                    return Err("PROVISIONING_MAINLINE_BINDING_CUSTODY_CONFLICT".to_string());
                }
            }
        }
    }
    Ok(())
}

fn verify_ready_paths_match_file_refs(
    connection: &Connection,
    scope: &ProvisioningScopeIdentity,
    directory: &str,
    manuscripts: &[MainlineExpectedManuscriptPath],
) -> Result<(), String> {
    let directory = normalized_declared_path(directory)?;
    if !physical_presence(&directory, "folder")? {
        return Err("PROVISIONING_MAINLINE_PHYSICAL_DIRECTORY_MISSING".to_string());
    }
    let refs = active_owner_file_refs(connection, scope.owner_type.as_str(), &scope.owner_id)?;
    let folder_refs = refs
        .iter()
        .filter(|file_ref| {
            file_ref.manuscript_channel == "primary"
                && file_ref.resource_kind == "folder"
                && file_ref.file_role == "defaultFolder"
                && file_ref.location_mode == "managed"
                && path_matches(file_ref, &directory)
        })
        .collect::<Vec<_>>();
    if folder_refs.len() != 1 {
        return Err("PROVISIONING_MAINLINE_FOLDER_CUSTODY_CONFLICT".to_string());
    }
    for expected in manuscripts {
        let path = normalized_declared_path(&expected.path)?;
        if !physical_presence(&path, "file")? {
            return Err("PROVISIONING_MAINLINE_PHYSICAL_MANUSCRIPT_MISSING".to_string());
        }
        let manuscript_refs = refs
            .iter()
            .filter(|file_ref| {
                file_ref.manuscript_channel == expected.manuscript_channel
                    && file_ref.resource_kind == "file"
                    && file_ref.file_role == "manuscript"
                    && file_ref.location_mode == "managed"
                    && path_matches(file_ref, &path)
            })
            .collect::<Vec<_>>();
        if manuscript_refs.len() != 1 {
            return Err("PROVISIONING_MAINLINE_MANUSCRIPT_CUSTODY_CONFLICT".to_string());
        }
        let binding = crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
            connection,
            scope.owner_type.as_str(),
            &scope.owner_id,
            &expected.manuscript_channel,
        )?
        .ok_or_else(|| "PROVISIONING_MAINLINE_BINDING_CUSTODY_MISSING".to_string())?;
        let current_is_valid = match binding.current_file_ref_id.as_deref() {
            Some(id) => valid_current_file_ref(
                connection,
                id,
                scope.owner_type.as_str(),
                &scope.owner_id,
                &expected.manuscript_channel,
            )?,
            None => false,
        };
        if binding.deleted_at.is_some()
            || binding.default_folder_file_ref_id.as_deref() != Some(folder_refs[0].id.as_str())
            || binding.default_manuscript_file_ref_id.as_deref()
                != Some(manuscript_refs[0].id.as_str())
            || !current_is_valid
        {
            return Err("PROVISIONING_MAINLINE_BINDING_CUSTODY_CONFLICT".to_string());
        }
    }
    Ok(())
}

fn canonical_physical_identity(path: &str, kind: &str) -> Result<String, String> {
    let path = std::path::Path::new(path);
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "PROVISIONING_MAINLINE_PHYSICAL_READBACK_FAILED".to_string())?;
    if metadata.file_type().is_symlink()
        || (kind == "folder" && !metadata.is_dir())
        || (kind == "file" && !metadata.is_file())
    {
        return Err("PROVISIONING_MAINLINE_PHYSICAL_IDENTITY_CONFLICT".to_string());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "PROVISIONING_MAINLINE_PHYSICAL_READBACK_FAILED".to_string())?;
    Ok(canonical
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase())
}

fn verify_observed_step(
    connection: &Connection,
    plan: &crate::db::manuscript_provisioning_operation_state::step_progress::DurableStepPlanRow,
    observed: &MainlineObservedStepInput,
    expected_directory: &str,
    expected_manuscripts: &[MainlineExpectedManuscriptPath],
) -> Result<(), String> {
    let kind = DurableStepKind::from_str(&observed.step_kind).map_err(command_error)?;
    let step_scope = DurableStepScope::from_str(&observed.step_scope).map_err(command_error)?;
    let expected_observed_identity = match kind {
        DurableStepKind::EnsureDirectory | DurableStepKind::EnsureManuscript => {
            normalized_declared_path(observed.readback_path.as_deref().unwrap_or(""))?
        }
        DurableStepKind::RegisterFolderFileRef | DurableStepKind::RegisterManuscriptFileRef => {
            let id = observed
                .resource_record_id
                .as_deref()
                .ok_or_else(|| "PROVISIONING_MAINLINE_FILE_REF_ID_MISSING".to_string())?;
            let file_ref = file_ref_evidence(connection, id)?
                .ok_or_else(|| "PROVISIONING_MAINLINE_FILE_REF_MISSING".to_string())?;
            normalized_declared_path(&file_ref.path_identity_key)?
        }
        DurableStepKind::EstablishBinding => observed
            .resource_record_id
            .clone()
            .ok_or_else(|| "PROVISIONING_MAINLINE_BINDING_ID_MISSING".to_string())?,
        DurableStepKind::ConvergeDefaultCurrent => {
            let binding =
                crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
                    connection,
                    plan.owner_type.as_str(),
                    &plan.owner_id,
                    observed.step_scope.as_str(),
                )?
                .ok_or_else(|| "PROVISIONING_MAINLINE_BINDING_MISSING".to_string())?;
            [
                binding.default_folder_file_ref_id.as_deref().unwrap_or(""),
                binding
                    .default_manuscript_file_ref_id
                    .as_deref()
                    .unwrap_or(""),
                binding.current_file_ref_id.as_deref().unwrap_or(""),
            ]
            .join("|")
        }
        DurableStepKind::ConvergeOwnerMetadata => {
            format!("{}|{}", plan.owner_type.as_str(), plan.owner_id)
        }
    };
    let expected_evidence_hash = step_evidence_hash(
        &ProvisioningScopeIdentity {
            owner_type: plan.owner_type,
            owner_id: plan.owner_id.clone(),
            scope_kind: plan.scope_kind,
            manuscript_channel: plan.manuscript_channel,
        },
        kind,
        step_scope,
        &expected_observed_identity,
        observed.resource_record_id.as_deref(),
    )?;
    if observed.observed_identity_hash != expected_evidence_hash {
        return Err("PROVISIONING_MAINLINE_OBSERVED_IDENTITY_CONFLICT".to_string());
    }
    match kind {
        DurableStepKind::EnsureDirectory | DurableStepKind::EnsureManuscript => {
            let expected = if kind == DurableStepKind::EnsureDirectory {
                "folder"
            } else {
                "file"
            };
            let readback_path =
                normalized_declared_path(observed.readback_path.as_deref().unwrap_or(""))?;
            if kind == DurableStepKind::EnsureDirectory {
                if readback_path != normalized_declared_path(expected_directory)? {
                    return Err("PROVISIONING_MAINLINE_PHYSICAL_IDENTITY_CONFLICT".to_string());
                }
            } else {
                let step_channel = observed.step_scope.as_str();
                let expected_path = expected_manuscripts
                    .iter()
                    .find(|item| item.manuscript_channel == step_channel)
                    .ok_or_else(|| {
                        "PROVISIONING_MAINLINE_MANUSCRIPT_CHANNEL_MISSING".to_string()
                    })?;
                if readback_path != normalized_declared_path(&expected_path.path)? {
                    return Err("PROVISIONING_MAINLINE_PHYSICAL_IDENTITY_CONFLICT".to_string());
                }
            }
            let _ = canonical_physical_identity(&readback_path, expected)?;
        }
        DurableStepKind::RegisterFolderFileRef | DurableStepKind::RegisterManuscriptFileRef => {
            let id = observed
                .resource_record_id
                .as_deref()
                .ok_or_else(|| "PROVISIONING_MAINLINE_FILE_REF_ID_MISSING".to_string())?;
            let file_ref = file_ref_evidence(connection, id)?
                .ok_or_else(|| "PROVISIONING_MAINLINE_FILE_REF_MISSING".to_string())?;
            let channel = if plan.scope_kind == DurablePlanScopeKind::LiteratureAggregate
                && kind == DurableStepKind::RegisterFolderFileRef
            {
                "primary"
            } else {
                observed.step_scope.as_str()
            };
            let expected_resource = if kind == DurableStepKind::RegisterFolderFileRef {
                "folder"
            } else {
                "file"
            };
            let expected_role = if kind == DurableStepKind::RegisterFolderFileRef {
                "defaultFolder"
            } else {
                "manuscript"
            };
            if file_ref.id != id
                || file_ref.owner_type != plan.owner_type.as_str()
                || file_ref.owner_id != plan.owner_id
                || file_ref.manuscript_channel != channel
                || file_ref.resource_kind != expected_resource
                || file_ref.file_role != expected_role
                || file_ref.location_mode != "managed"
                || file_ref.deleted_at.is_some()
                || file_ref.path_identity_key.trim().is_empty()
            {
                return Err("PROVISIONING_MAINLINE_FILE_REF_IDENTITY_CONFLICT".to_string());
            }
            let expected_path = if kind == DurableStepKind::RegisterFolderFileRef {
                normalized_declared_path(expected_directory)?
            } else {
                normalized_declared_path(
                    &expected_manuscripts
                        .iter()
                        .find(|item| item.manuscript_channel == channel)
                        .ok_or_else(|| {
                            "PROVISIONING_MAINLINE_MANUSCRIPT_CHANNEL_MISSING".to_string()
                        })?
                        .path,
                )?
            };
            if !path_matches(&file_ref, &expected_path) {
                return Err("PROVISIONING_MAINLINE_FILE_REF_IDENTITY_CONFLICT".to_string());
            }
            let _ = canonical_physical_identity(&file_ref.path, expected_resource)?;
        }
        DurableStepKind::EstablishBinding | DurableStepKind::ConvergeDefaultCurrent => {
            let channel = observed.step_scope.as_str();
            let binding =
                crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
                    connection,
                    plan.owner_type.as_str(),
                    &plan.owner_id,
                    channel,
                )?
                .ok_or_else(|| "PROVISIONING_MAINLINE_BINDING_MISSING".to_string())?;
            if binding.deleted_at.is_some()
                || binding.default_folder_file_ref_id.is_none()
                || binding.default_manuscript_file_ref_id.is_none()
                || binding.current_file_ref_id.is_none()
                || (kind == DurableStepKind::EstablishBinding
                    && observed.resource_record_id.as_deref() != Some(binding.id.as_str()))
            {
                return Err("PROVISIONING_MAINLINE_BINDING_IDENTITY_CONFLICT".to_string());
            }
            let folder = file_ref_evidence(
                connection,
                binding.default_folder_file_ref_id.as_deref().unwrap_or(""),
            )?
            .ok_or_else(|| "PROVISIONING_MAINLINE_FOLDER_CUSTODY_MISSING".to_string())?;
            let manuscript = file_ref_evidence(
                connection,
                binding
                    .default_manuscript_file_ref_id
                    .as_deref()
                    .unwrap_or(""),
            )?
            .ok_or_else(|| "PROVISIONING_MAINLINE_MANUSCRIPT_CUSTODY_MISSING".to_string())?;
            let current = file_ref_evidence(
                connection,
                binding.current_file_ref_id.as_deref().unwrap_or(""),
            )?
            .ok_or_else(|| "PROVISIONING_MAINLINE_CURRENT_CUSTODY_MISSING".to_string())?;
            if folder.owner_type != plan.owner_type.as_str()
                || folder.owner_id != plan.owner_id
                || folder.manuscript_channel != "primary"
                || folder.resource_kind != "folder"
                || folder.file_role != "defaultFolder"
                || folder.location_mode != "managed"
                || folder.deleted_at.is_some()
                || manuscript.owner_type != plan.owner_type.as_str()
                || manuscript.owner_id != plan.owner_id
                || manuscript.manuscript_channel != channel
                || manuscript.resource_kind != "file"
                || manuscript.file_role != "manuscript"
                || manuscript.location_mode != "managed"
                || manuscript.deleted_at.is_some()
                || current.owner_type != plan.owner_type.as_str()
                || current.owner_id != plan.owner_id
                || current.manuscript_channel != channel
                || current.resource_kind != "file"
                || current.file_role != "manuscript"
                || !matches!(current.location_mode.as_str(), "managed" | "external")
                || current.deleted_at.is_some()
            {
                return Err("PROVISIONING_MAINLINE_BINDING_CUSTODY_CONFLICT".to_string());
            }
            let _ = canonical_physical_identity(&folder.path, "folder")?;
            let _ = canonical_physical_identity(&manuscript.path, "file")?;
        }
        DurableStepKind::ConvergeOwnerMetadata => {}
    }
    Ok(())
}

fn converge_observed_step(
    connection: &mut Connection,
    operation_id: &str,
    plan_id: &str,
    claim_id: &str,
    claim_owner_token: &str,
    step: &mut DurableStepProgressRow,
    observed: &MainlineObservedStepInput,
) -> Result<(), String> {
    if !is_lowercase_sha256(&observed.observed_identity_hash) {
        return Err("PROVISIONING_MAINLINE_OBSERVED_IDENTITY_INVALID".to_string());
    }
    let effect =
        DurableStepEffectOutcome::from_str(&observed.effect_outcome).map_err(command_error)?;
    if !matches!(
        effect,
        DurableStepEffectOutcome::Created
            | DurableStepEffectOutcome::Reused
            | DurableStepEffectOutcome::Updated
            | DurableStepEffectOutcome::Preserved
    ) {
        return Err("PROVISIONING_MAINLINE_EFFECT_INVALID".to_string());
    }
    if step.boundary == DurableStepBoundary::Converged {
        return if step.observed_identity_hash.as_deref()
            == Some(observed.observed_identity_hash.as_str())
            && step.resource_record_id == observed.resource_record_id
        {
            Ok(())
        } else {
            Err("PROVISIONING_MAINLINE_STEP_EVIDENCE_CONFLICT".to_string())
        };
    }
    let authority = |step: &DurableStepProgressRow| ProgressAuthorityInput {
        operation_id: operation_id.to_string(),
        plan_id: plan_id.to_string(),
        step_id: step.step_id.clone(),
        claim_id: claim_id.to_string(),
        claim_owner_token: claim_owner_token.to_string(),
        expected_progress_revision: step.progress_revision,
        occurred_at: now(),
    };
    if step.boundary == DurableStepBoundary::Intended {
        *step = mark_step_started(connection, &authority(step))
            .map_err(|error| error.code.to_string())?
            .step;
    }
    if step.boundary == DurableStepBoundary::Started {
        *step = record_step_effect_observed(
            connection,
            &authority(step),
            effect,
            &observed.observed_identity_hash,
            observed.resource_record_id.as_deref(),
        )
        .map_err(|error| error.code.to_string())?
        .step;
    }
    if step.boundary == DurableStepBoundary::EffectObserved {
        *step = record_step_readback_verified(connection, &authority(step))
            .map_err(|error| error.code.to_string())?
            .step;
    }
    if step.boundary == DurableStepBoundary::ReadbackVerified {
        *step = converge_step(connection, &authority(step))
            .map_err(|error| error.code.to_string())?
            .step;
    }
    if step.boundary != DurableStepBoundary::Converged {
        return Err("PROVISIONING_MAINLINE_STEP_DID_NOT_CONVERGE".to_string());
    }
    Ok(())
}

fn aggregate_effect(steps: &[DurableStepProgressRow], kinds: &[DurableStepKind]) -> &'static str {
    let matching = steps
        .iter()
        .filter(|step| kinds.contains(&step.step_kind))
        .filter(|step| step.boundary == DurableStepBoundary::Converged)
        .collect::<Vec<_>>();
    if matching.is_empty() {
        "none"
    } else if matching
        .iter()
        .any(|step| step.effect_outcome == DurableStepEffectOutcome::Created)
    {
        "created"
    } else {
        "reused"
    }
}

fn has_durable_effect(steps: &[DurableStepProgressRow]) -> bool {
    steps.iter().any(|step| {
        step.boundary == DurableStepBoundary::Converged
            && matches!(
                step.effect_outcome,
                DurableStepEffectOutcome::Created
                    | DurableStepEffectOutcome::Reused
                    | DurableStepEffectOutcome::Updated
                    | DurableStepEffectOutcome::Preserved
            )
    })
}

fn partial_kind_for(
    scope_kind: DurablePlanScopeKind,
    steps: &[DurableStepProgressRow],
) -> &'static str {
    if scope_kind == DurablePlanScopeKind::LiteratureAggregate {
        "multi-channel"
    } else if steps.iter().any(|step| {
        step.step_kind == DurableStepKind::EstablishBinding
            && step.boundary == DurableStepBoundary::Converged
    }) {
        "binding-written-not-verified"
    } else if steps.iter().any(|step| {
        matches!(
            step.step_kind,
            DurableStepKind::RegisterFolderFileRef | DurableStepKind::RegisterManuscriptFileRef
        ) && step.boundary == DurableStepBoundary::Converged
    }) {
        "file-ref-registered"
    } else {
        "physical-only"
    }
}

fn finish_operation(
    connection: &mut Connection,
    runtime: &ProvisioningRuntime,
    input: &MainlineFinishInput,
) -> Result<MainlineOperationView, String> {
    if input.operation_id.trim().is_empty() {
        return Err("PROVISIONING_MAINLINE_OPERATION_ID_INVALID".to_string());
    }
    let mut attempt = read_operation_attempt(connection, &input.operation_id)
        .map_err(|error| error.code.to_string())?
        .ok_or_else(|| "PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())?;
    let plan = read_attempt_plan(connection, &input.operation_id)
        .map_err(|error| error.code.to_string())?
        .ok_or_else(|| "PROVISIONING_MAINLINE_PLAN_MISSING".to_string())?;
    let finish_scope = ProvisioningScopeIdentity {
        owner_type: plan.owner_type,
        owner_id: plan.owner_id.clone(),
        scope_kind: plan.scope_kind,
        manuscript_channel: plan.manuscript_channel,
    };
    validate_expected_paths(
        &finish_scope,
        &input.expected_directory_path,
        &input.expected_manuscript_paths,
        &plan.canonical_placement_identity_hash,
    )?;
    if attempt.operation_status != "active" {
        if attempt.operation_status == "terminal-completed" {
            verify_existing_physical_custody(
                connection,
                Some(&input.operation_id),
                &finish_scope,
                &input.expected_directory_path,
                &input.expected_manuscript_paths,
            )?;
            verify_ready_paths_match_file_refs(
                connection,
                &finish_scope,
                &input.expected_directory_path,
                &input.expected_manuscript_paths,
            )?;
        }
        return view(connection, attempt, true);
    }
    let claim = read_active_claim_for_operation(connection, &input.operation_id)
        .map_err(|error| error.code.to_string())?
        .ok_or_else(|| "PROVISIONING_MAINLINE_ACTIVE_CLAIM_MISSING".to_string())?;
    if claim.claim_owner_token != runtime.mainline_ownership_context().claim_owner_token() {
        return Err("PROVISIONING_MAINLINE_ACTIVE_CLAIM_CONFLICT".to_string());
    }
    let mut durable_steps = read_attempt_step_progress(connection, &input.operation_id)
        .map_err(|error| error.code.to_string())?;
    let observed_result = input.steps.iter().try_for_each(|observed| {
        verify_observed_step(
            connection,
            &plan,
            observed,
            &input.expected_directory_path,
            &input.expected_manuscript_paths,
        )?;
        let step = find_step(&mut durable_steps, observed)?;
        converge_observed_step(
            connection,
            &input.operation_id,
            &plan.plan_id,
            &claim.claim_id,
            &claim.claim_owner_token,
            step,
            observed,
        )
    });
    if let Err(error) = observed_result {
        let durable_steps = read_attempt_step_progress(connection, &input.operation_id)
            .map_err(|repository_error| repository_error.code.to_string())?;
        let durable_effect = has_durable_effect(&durable_steps);
        let partial_kind = partial_kind_for(plan.scope_kind, &durable_steps);
        let binding_channel = if plan.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
            "literature_outline"
        } else {
            "primary"
        };
        let binding = crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
            connection,
            plan.owner_type.as_str(),
            &plan.owner_id,
            binding_channel,
        )
        .ok()
        .flatten();
        let terminal = terminalize_attempt_release_claim_and_enqueue_audit(
            connection,
            &TerminalAttemptInput {
                operation_id: input.operation_id.clone(),
                claim_id: claim.claim_id.clone(),
                claim_owner_token: claim.claim_owner_token.clone(),
                expected_operation_revision: attempt.revision,
                expected_claim_revision: claim.claim_revision,
                expected_phase: attempt.phase.clone(),
                expected_operation_status: "active".to_string(),
                phase: if durable_effect { "partial" } else { "failed" }.to_string(),
                operation_status: if durable_effect {
                    "terminal-partial"
                } else {
                    "terminal-failed"
                }
                .to_string(),
                result_classification: "retryable".to_string(),
                next_action: "retry".to_string(),
                partial_kind: durable_effect.then(|| partial_kind.to_string()),
                original_cause_code: Some(error),
                folder_effect: aggregate_effect(
                    &durable_steps,
                    &[DurableStepKind::EnsureDirectory],
                )
                .to_string(),
                manuscript_effect: aggregate_effect(
                    &durable_steps,
                    &[DurableStepKind::EnsureManuscript],
                )
                .to_string(),
                file_ref_effect: aggregate_effect(
                    &durable_steps,
                    &[
                        DurableStepKind::RegisterFolderFileRef,
                        DurableStepKind::RegisterManuscriptFileRef,
                    ],
                )
                .to_string(),
                binding_effect: if binding.is_some() { "updated" } else { "none" }.to_string(),
                default_folder_file_ref_id: binding
                    .as_ref()
                    .and_then(|value| value.default_folder_file_ref_id.clone()),
                default_manuscript_file_ref_id: binding
                    .as_ref()
                    .and_then(|value| value.default_manuscript_file_ref_id.clone()),
                binding_id: binding.as_ref().map(|value| value.id.clone()),
                final_verification_outcome: "failed".to_string(),
                inspector_version: Some(MAINLINE_VERSION.to_string()),
                verifier_version: None,
                occurred_at: now(),
            },
        )
        .map_err(|repository_error| repository_error.code.to_string())?;
        return view(connection, terminal.attempt, false);
    }
    durable_steps = read_attempt_step_progress(connection, &input.operation_id)
        .map_err(|error| error.code.to_string())?;
    if input.effect_outcome_unknown {
        attempt = read_operation_attempt(connection, &input.operation_id)
            .map_err(|repository_error| repository_error.code.to_string())?
            .ok_or_else(|| "PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())?;
        let binding_channel = if plan.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
            "literature_outline"
        } else {
            "primary"
        };
        let binding = crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
            connection,
            plan.owner_type.as_str(),
            &plan.owner_id,
            binding_channel,
        )
        .map_err(command_error)?;
        let terminal = terminalize_attempt_retain_claim_and_enqueue_audit(
            connection,
            &TerminalAttemptInput {
                operation_id: input.operation_id.clone(),
                claim_id: claim.claim_id.clone(),
                claim_owner_token: claim.claim_owner_token.clone(),
                expected_operation_revision: attempt.revision,
                expected_claim_revision: claim.claim_revision,
                expected_phase: attempt.phase.clone(),
                expected_operation_status: "active".to_string(),
                phase: if has_durable_effect(&durable_steps) {
                    "partial"
                } else {
                    "failed"
                }
                .to_string(),
                operation_status: "terminal-recovery-required".to_string(),
                result_classification: "provisioning-recovery-required".to_string(),
                next_action: "recover".to_string(),
                partial_kind: Some(partial_kind_for(plan.scope_kind, &durable_steps).to_string()),
                original_cause_code: Some(
                    input.cause_code.clone().unwrap_or_else(|| {
                        "PROVISIONING_MAINLINE_EFFECT_OUTCOME_UNKNOWN".to_string()
                    }),
                ),
                folder_effect: aggregate_effect(
                    &durable_steps,
                    &[DurableStepKind::EnsureDirectory],
                )
                .to_string(),
                manuscript_effect: aggregate_effect(
                    &durable_steps,
                    &[DurableStepKind::EnsureManuscript],
                )
                .to_string(),
                file_ref_effect: aggregate_effect(
                    &durable_steps,
                    &[
                        DurableStepKind::RegisterFolderFileRef,
                        DurableStepKind::RegisterManuscriptFileRef,
                    ],
                )
                .to_string(),
                binding_effect: if binding.is_some() { "updated" } else { "none" }.to_string(),
                default_folder_file_ref_id: binding
                    .as_ref()
                    .and_then(|value| value.default_folder_file_ref_id.clone()),
                default_manuscript_file_ref_id: binding
                    .as_ref()
                    .and_then(|value| value.default_manuscript_file_ref_id.clone()),
                binding_id: binding.as_ref().map(|value| value.id.clone()),
                final_verification_outcome: "not-verified".to_string(),
                inspector_version: Some(MAINLINE_VERSION.to_string()),
                verifier_version: None,
                occurred_at: now(),
            },
        )
        .map_err(|repository_error| repository_error.code.to_string())?;
        return view(connection, terminal.attempt, false);
    }
    let fully_converged = durable_steps
        .iter()
        .all(|step| step.boundary == DurableStepBoundary::Converged);
    let ready_readback = if input.ready && !fully_converged {
        Err("PROVISIONING_MAINLINE_READY_EVIDENCE_INCOMPLETE".to_string())
    } else if input.ready {
        verify_existing_physical_custody(
            connection,
            Some(&input.operation_id),
            &finish_scope,
            &input.expected_directory_path,
            &input.expected_manuscript_paths,
        )
        .and_then(|_| {
            verify_ready_paths_match_file_refs(
                connection,
                &finish_scope,
                &input.expected_directory_path,
                &input.expected_manuscript_paths,
            )
        })
    } else {
        Ok(())
    };
    if let Err(error) = ready_readback {
        attempt = read_operation_attempt(connection, &input.operation_id)
            .map_err(|repository_error| repository_error.code.to_string())?
            .ok_or_else(|| "PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())?;
        let terminal = terminalize_attempt_release_claim_and_enqueue_audit(
            connection,
            &TerminalAttemptInput {
                operation_id: input.operation_id.clone(),
                claim_id: claim.claim_id.clone(),
                claim_owner_token: claim.claim_owner_token.clone(),
                expected_operation_revision: attempt.revision,
                expected_claim_revision: claim.claim_revision,
                expected_phase: attempt.phase.clone(),
                expected_operation_status: "active".to_string(),
                phase: "partial".to_string(),
                operation_status: "terminal-partial".to_string(),
                result_classification: "retryable".to_string(),
                next_action: "retry".to_string(),
                partial_kind: Some("binding-written-not-verified".to_string()),
                original_cause_code: Some(error),
                folder_effect: aggregate_effect(
                    &durable_steps,
                    &[DurableStepKind::EnsureDirectory],
                )
                .to_string(),
                manuscript_effect: aggregate_effect(
                    &durable_steps,
                    &[DurableStepKind::EnsureManuscript],
                )
                .to_string(),
                file_ref_effect: aggregate_effect(
                    &durable_steps,
                    &[
                        DurableStepKind::RegisterFolderFileRef,
                        DurableStepKind::RegisterManuscriptFileRef,
                    ],
                )
                .to_string(),
                binding_effect: "updated".to_string(),
                default_folder_file_ref_id: None,
                default_manuscript_file_ref_id: None,
                binding_id: None,
                final_verification_outcome: "failed".to_string(),
                inspector_version: Some(MAINLINE_VERSION.to_string()),
                verifier_version: None,
                occurred_at: now(),
            },
        )
        .map_err(|repository_error| repository_error.code.to_string())?;
        return view(connection, terminal.attempt, false);
    }
    let durable_effect = has_durable_effect(&durable_steps);
    let partial_kind = partial_kind_for(plan.scope_kind, &durable_steps);
    let binding_channel = if plan.scope_kind == DurablePlanScopeKind::LiteratureAggregate {
        "literature_outline"
    } else {
        "primary"
    };
    let binding = crate::db::manuscript_binding::read_manuscript_binding_record_in_connection(
        connection,
        plan.owner_type.as_str(),
        &plan.owner_id,
        binding_channel,
    )
    .map_err(command_error)?;
    let terminal = TerminalAttemptInput {
        operation_id: input.operation_id.clone(),
        claim_id: claim.claim_id,
        claim_owner_token: claim.claim_owner_token,
        expected_operation_revision: attempt.revision,
        expected_claim_revision: claim.claim_revision,
        expected_phase: attempt.phase,
        expected_operation_status: "active".to_string(),
        phase: if input.ready {
            "completed"
        } else if durable_effect {
            "partial"
        } else {
            "failed"
        }
        .to_string(),
        operation_status: if input.ready {
            "terminal-completed"
        } else if durable_effect {
            "terminal-partial"
        } else {
            "terminal-failed"
        }
        .to_string(),
        result_classification: if input.ready {
            "completed"
        } else {
            "retryable"
        }
        .to_string(),
        next_action: if input.ready { "none" } else { "retry" }.to_string(),
        partial_kind: (!input.ready && durable_effect).then(|| partial_kind.to_string()),
        original_cause_code: if input.ready {
            None
        } else {
            Some(
                input
                    .cause_code
                    .clone()
                    .unwrap_or_else(|| "PROVISIONING_MAINLINE_PARTIAL".to_string()),
            )
        },
        folder_effect: aggregate_effect(&durable_steps, &[DurableStepKind::EnsureDirectory])
            .to_string(),
        manuscript_effect: aggregate_effect(&durable_steps, &[DurableStepKind::EnsureManuscript])
            .to_string(),
        file_ref_effect: aggregate_effect(
            &durable_steps,
            &[
                DurableStepKind::RegisterFolderFileRef,
                DurableStepKind::RegisterManuscriptFileRef,
            ],
        )
        .to_string(),
        binding_effect: if durable_steps.iter().any(|step| {
            step.step_kind == DurableStepKind::EstablishBinding
                && step.boundary == DurableStepBoundary::Converged
        }) {
            "updated"
        } else {
            "none"
        }
        .to_string(),
        default_folder_file_ref_id: binding
            .as_ref()
            .and_then(|binding| binding.default_folder_file_ref_id.clone()),
        default_manuscript_file_ref_id: binding
            .as_ref()
            .and_then(|binding| binding.default_manuscript_file_ref_id.clone()),
        binding_id: binding.as_ref().map(|binding| binding.id.clone()),
        final_verification_outcome: if input.ready { "passed" } else { "not-run" }.to_string(),
        inspector_version: Some(MAINLINE_VERSION.to_string()),
        verifier_version: input.ready.then(|| MAINLINE_VERSION.to_string()),
        occurred_at: now(),
    };
    let terminal = terminalize_attempt_release_claim_and_enqueue_audit(connection, &terminal)
        .map_err(|error| error.code.to_string())?;
    view(connection, terminal.attempt, false)
}

#[tauri::command]
pub(crate) fn provisioning_mainline_begin(
    window: WebviewWindow,
    registry: State<'_, Arc<OwnerAuthorityLeaseRegistry>>,
    runtime: State<'_, Arc<ProvisioningRuntime>>,
    input: MainlineBeginInput,
) -> Result<MainlineOperationView, String> {
    validate_authority(&window, &registry, &input.authority)?;
    validate_authority_scope(&input.authority, &parse_scope(&input)?)?;
    let mut connection = runtime
        .open_mainline_connection()
        .map_err(|error| format!("{error:?}"))?;
    initialize_or_resume(&mut connection, &runtime, &input)
}

#[tauri::command]
pub(crate) fn provisioning_mainline_finish(
    window: WebviewWindow,
    registry: State<'_, Arc<OwnerAuthorityLeaseRegistry>>,
    runtime: State<'_, Arc<ProvisioningRuntime>>,
    input: MainlineFinishInput,
) -> Result<MainlineOperationView, String> {
    validate_authority(&window, &registry, &input.authority)?;
    let mut connection = runtime
        .open_mainline_connection()
        .map_err(|error| format!("{error:?}"))?;
    let plan = read_attempt_plan(&connection, &input.operation_id)
        .map_err(|error| error.code.to_string())?
        .ok_or_else(|| "PROVISIONING_MAINLINE_PLAN_MISSING".to_string())?;
    validate_authority_scope(
        &input.authority,
        &ProvisioningScopeIdentity {
            owner_type: plan.owner_type,
            owner_id: plan.owner_id,
            scope_kind: plan.scope_kind,
            manuscript_channel: plan.manuscript_channel,
        },
    )?;
    finish_operation(&mut connection, &runtime, &input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};
    use uuid::Uuid;

    const OWNER_ID: &str = "a3-output-owner";
    const NOW: &str = "2026-08-12T12:00:00Z";

    struct TempCustody {
        root: PathBuf,
        directory: PathBuf,
        manuscript: PathBuf,
    }

    impl TempCustody {
        fn new(label: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("labpod-a3-mainline-{label}-{}", Uuid::new_v4()));
            let directory = root.join("workspace");
            fs::create_dir_all(&directory).expect("create isolated custody directory");
            let manuscript = directory.join("result-item.md");
            fs::write(&manuscript, b"# user markdown\n\nbyte-preserving\n")
                .expect("write isolated user Markdown");
            Self {
                root,
                directory,
                manuscript,
            }
        }

        fn directory_string(&self) -> String {
            self.directory.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempCustody {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).expect("remove only isolated custody directory");
        }
    }

    fn scope(owner_type: DurablePlanOwnerType) -> ProvisioningScopeIdentity {
        ProvisioningScopeIdentity {
            owner_type,
            owner_id: OWNER_ID.to_string(),
            scope_kind: DurablePlanScopeKind::Channel,
            manuscript_channel: Some(DurableManuscriptChannel::Primary),
        }
    }

    fn literature_scope() -> ProvisioningScopeIdentity {
        ProvisioningScopeIdentity {
            owner_type: DurablePlanOwnerType::Literature,
            owner_id: OWNER_ID.to_string(),
            scope_kind: DurablePlanScopeKind::LiteratureAggregate,
            manuscript_channel: None,
        }
    }

    fn expected(path: &Path) -> Vec<MainlineExpectedManuscriptPath> {
        vec![MainlineExpectedManuscriptPath {
            manuscript_channel: "primary".to_string(),
            path: path.to_string_lossy().into_owned(),
        }]
    }

    fn placement_hash(directory: &Path, manuscripts: &[MainlineExpectedManuscriptPath]) -> String {
        let mut ordered = manuscripts.to_vec();
        ordered.sort_by_key(|item| match item.manuscript_channel.as_str() {
            "primary" => 0,
            "literature_outline" => 1,
            "dedicated_notes" => 2,
            _ => 3,
        });
        let mut paths =
            vec![normalized_declared_path(&directory.to_string_lossy())
                .expect("normalize directory")];
        paths.extend(
            ordered
                .iter()
                .map(|item| normalized_declared_path(&item.path).expect("normalize manuscript")),
        );
        hash(paths.join("|"))
    }

    fn custody_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open custody SQLite");
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE file_refs (
                   id TEXT PRIMARY KEY,
                   owner_type TEXT NOT NULL,
                   owner_id TEXT NOT NULL,
                   manuscript_channel TEXT NOT NULL,
                   resource_kind TEXT NOT NULL,
                   file_role TEXT NOT NULL,
                   location_mode TEXT NOT NULL,
                   file_type TEXT NOT NULL,
                   path TEXT NOT NULL,
                   path_identity_key TEXT NOT NULL,
                   title TEXT NOT NULL,
                   schema_version INTEGER NOT NULL DEFAULT 2,
                   source TEXT NOT NULL DEFAULT 'system',
                   custom_fields TEXT NOT NULL DEFAULT '[]',
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   deleted_at TEXT
                 );
                 CREATE TABLE manuscript_bindings (
                   id TEXT PRIMARY KEY,
                   owner_type TEXT NOT NULL,
                   owner_id TEXT NOT NULL,
                   manuscript_channel TEXT NOT NULL,
                   default_folder_file_ref_id TEXT,
                   default_manuscript_file_ref_id TEXT,
                   current_file_ref_id TEXT,
                   schema_version INTEGER NOT NULL DEFAULT 2,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   deleted_at TEXT,
                   UNIQUE(owner_type,owner_id,manuscript_channel),
                   FOREIGN KEY(default_folder_file_ref_id) REFERENCES file_refs(id),
                   FOREIGN KEY(default_manuscript_file_ref_id) REFERENCES file_refs(id),
                   FOREIGN KEY(current_file_ref_id) REFERENCES file_refs(id)
                 );",
            )
            .expect("create custody evidence schema");
        connection
    }

    fn insert_ref(
        connection: &Connection,
        id: &str,
        owner_type: &str,
        owner_id: &str,
        channel: &str,
        kind: &str,
        role: &str,
        mode: &str,
        path: &Path,
    ) {
        let path =
            normalized_declared_path(&path.to_string_lossy()).expect("normalize FileRef path");
        connection
            .execute(
                "INSERT INTO file_refs (
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?1,?10,?10)",
                params![
                    id,
                    owner_type,
                    owner_id,
                    channel,
                    kind,
                    role,
                    mode,
                    if kind == "folder" {
                        "folder"
                    } else {
                        "markdown"
                    },
                    path,
                    NOW
                ],
            )
            .expect("insert exact FileRef evidence");
    }

    #[test]
    fn a3_ten_channel_paths_are_exact_and_literature_is_one_aggregate() {
        let root = std::env::temp_dir().join(format!("labpod-a3-paths-{}", Uuid::new_v4()));
        let primary_owners = [
            DurablePlanOwnerType::Experiment,
            DurablePlanOwnerType::ExperimentRun,
            DurablePlanOwnerType::Review,
            DurablePlanOwnerType::ResultItem,
            DurablePlanOwnerType::Finding,
            DurablePlanOwnerType::OutputCandidate,
            DurablePlanOwnerType::OutputGap,
            DurablePlanOwnerType::ResearchOutput,
        ];
        for owner_type in primary_owners {
            let directory = root.join(owner_type.as_str());
            let manuscripts = expected(&directory.join("default.md"));
            validate_expected_paths(
                &scope(owner_type),
                &directory.to_string_lossy(),
                &manuscripts,
                &placement_hash(&directory, &manuscripts),
            )
            .expect("primary channel identity must validate");
        }
        let directory = root.join("literature");
        let manuscripts = vec![
            MainlineExpectedManuscriptPath {
                manuscript_channel: "literature_outline".to_string(),
                path: directory
                    .join("literature-outline.md")
                    .to_string_lossy()
                    .into_owned(),
            },
            MainlineExpectedManuscriptPath {
                manuscript_channel: "dedicated_notes".to_string(),
                path: directory
                    .join("dedicated-notes.md")
                    .to_string_lossy()
                    .into_owned(),
            },
        ];
        validate_expected_paths(
            &literature_scope(),
            &directory.to_string_lossy(),
            &manuscripts,
            &placement_hash(&directory, &manuscripts),
        )
        .expect("Literature aggregate must validate both exact child channels");
        let only_outline = vec![manuscripts[0].clone()];
        assert_eq!(
            validate_expected_paths(
                &literature_scope(),
                &directory.to_string_lossy(),
                &only_outline,
                &placement_hash(&directory, &only_outline),
            ),
            Err("PROVISIONING_MAINLINE_PATH_CHANNEL_CONFLICT".to_string())
        );
    }

    #[test]
    fn a3_empty_owner_identity_is_rejected_before_durable_initialization() {
        let input = MainlineBeginInput {
            owner_type: "resultItem".to_string(),
            owner_id: "   ".to_string(),
            scope_kind: "channel".to_string(),
            manuscript_channel: Some("primary".to_string()),
            canonical_resource_identity_hash:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            canonical_placement_identity_hash:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            parent_shared_identity_hash: None,
            expected_directory_path: "C:/LabPod/project/result".to_string(),
            expected_manuscript_paths: vec![MainlineExpectedManuscriptPath {
                manuscript_channel: "primary".to_string(),
                path: "C:/LabPod/project/result/result-item.md".to_string(),
            }],
            authority: MainlineAuthorityInput {
                token: "unused".to_string(),
                requests: Vec::new(),
            },
        };
        assert_eq!(
            parse_scope(&input),
            Err("PROVISIONING_MAINLINE_IDENTITY_INVALID".to_string())
        );
    }

    #[test]
    fn b8_literature_operation_bound_owner_identity_uses_shared_128_byte_limit() {
        let directory = std::env::temp_dir().join(format!(
            "labpod-b8-literature-owner-{}",
            Uuid::new_v4()
        ));
        let manuscripts = vec![
            MainlineExpectedManuscriptPath {
                manuscript_channel: "literature_outline".to_string(),
                path: directory
                    .join("literature-outline.md")
                    .to_string_lossy()
                    .into_owned(),
            },
            MainlineExpectedManuscriptPath {
                manuscript_channel: "dedicated_notes".to_string(),
                path: directory
                    .join("dedicated-notes.md")
                    .to_string_lossy()
                    .into_owned(),
            },
        ];
        let exact_scope = ProvisioningScopeIdentity {
            owner_type: DurablePlanOwnerType::Literature,
            owner_id: format!("literature-{}", "a".repeat(100)),
            scope_kind: DurablePlanScopeKind::LiteratureAggregate,
            manuscript_channel: None,
        };
        let input = MainlineBeginInput {
            owner_type: exact_scope.owner_type.as_str().to_string(),
            owner_id: exact_scope.owner_id.clone(),
            scope_kind: exact_scope.scope_kind.as_str().to_string(),
            manuscript_channel: None,
            canonical_resource_identity_hash: canonical_resource_identity_hash(&exact_scope)
                .expect("hash exact Literature aggregate owner scope"),
            canonical_placement_identity_hash: placement_hash(&directory, &manuscripts),
            parent_shared_identity_hash: None,
            expected_directory_path: directory.to_string_lossy().into_owned(),
            expected_manuscript_paths: manuscripts,
            authority: MainlineAuthorityInput {
                token: "unused-in-parse-scope".to_string(),
                requests: Vec::new(),
            },
        };
        assert_eq!(parse_scope(&input), Ok(exact_scope.clone()));

        let database = crate::provisioning_runtime_non_completed_exit_tests::TempDatabase::new(
            "b8-long-literature-owner",
        );
        let mut connection = database.open();
        connection
            .execute(
                "INSERT INTO literatures (
                   id,title,reading_status,primary_project_id,created_at,updated_at
                 ) VALUES (?1,'B8 operation-bound Literature','unread',NULL,?2,?2)",
                params![&exact_scope.owner_id, NOW],
            )
            .expect("seed the retained projectless Literature owner");
        let ownership = crate::db::manuscript_provisioning_operation_state::claim_ownership::fixed_repository_context_for_test(
            "b8-long-literature-owner-authority",
            1_700_000_000_000,
        );
        let initialized = initialize_mainline_operation_atomically(
            &mut connection,
            &ownership,
            &MainlineAtomicInitializationRequest {
                operation_id: "b8-long-literature-owner-operation".to_string(),
                scope: exact_scope.clone(),
                descriptor_key: DescriptorKey("literature-aggregate-v1".to_string()),
                canonical_resource: CanonicalResourceIdentity {
                    resource_identity_hash: input.canonical_resource_identity_hash.clone(),
                    placement_identity_hash: input.canonical_placement_identity_hash.clone(),
                    parent_shared_identity_hash: None,
                },
                occurred_at: NOW.to_string(),
            },
        )
        .expect("initialize and decode the operation-bound Literature aggregate owner");
        assert_eq!(initialized.plan.owner_id, exact_scope.owner_id);

        let overlong = MainlineBeginInput {
            owner_id: "a".repeat(PROVISIONING_OWNER_ID_MAX_BYTES + 1),
            ..input
        };
        assert_eq!(
            parse_scope(&overlong),
            Err("PROVISIONING_MAINLINE_IDENTITY_INVALID".to_string())
        );
    }

    #[test]
    fn a3_resource_identity_hash_is_recomputed_from_exact_owner_scope() {
        let custody = TempCustody::new("resource-identity");
        let exact_scope = scope(DurablePlanOwnerType::ResultItem);
        let input = MainlineBeginInput {
            owner_type: exact_scope.owner_type.as_str().to_string(),
            owner_id: exact_scope.owner_id.clone(),
            scope_kind: exact_scope.scope_kind.as_str().to_string(),
            manuscript_channel: exact_scope
                .manuscript_channel
                .map(|value| value.as_str().to_string()),
            canonical_resource_identity_hash: "a".repeat(64),
            canonical_placement_identity_hash: placement_hash(
                &custody.directory,
                &expected(&custody.manuscript),
            ),
            parent_shared_identity_hash: None,
            expected_directory_path: custody.directory_string(),
            expected_manuscript_paths: expected(&custody.manuscript),
            authority: MainlineAuthorityInput {
                token: "unused-in-parse-scope".to_string(),
                requests: Vec::new(),
            },
        };
        assert_eq!(
            parse_scope(&input),
            Err("PROVISIONING_MAINLINE_RESOURCE_IDENTITY_CONFLICT".to_string())
        );

        let input = MainlineBeginInput {
            canonical_resource_identity_hash: canonical_resource_identity_hash(&exact_scope)
                .expect("hash exact owner scope"),
            ..input
        };
        assert_eq!(parse_scope(&input), Ok(exact_scope));
    }

    #[test]
    fn a3_forged_observed_identity_hash_is_rejected_before_progress_convergence() {
        let custody = TempCustody::new("forged-evidence");
        let connection = custody_connection();
        insert_ref(
            &connection,
            "folder-a3-forged",
            DurablePlanOwnerType::ResultItem.as_str(),
            OWNER_ID,
            "primary",
            "folder",
            "defaultFolder",
            "managed",
            &custody.directory,
        );
        let plan = crate::db::manuscript_provisioning_operation_state::step_progress::DurableStepPlanRow {
            plan_id: "plan-a3-forged".to_string(),
            operation_id: "operation-a3-forged".to_string(),
            plan_version: 1,
            plan_template_kind: crate::manuscript_provisioning_contract::PlanTemplateKind::ManagedPrimary,
            plan_identity_fingerprint:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            precondition_snapshot_hash:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            fingerprint_profile: crate::db::manuscript_provisioning_operation_state::step_progress::PlanFingerprintProfile::RestrictedJcsSha256V1,
            owner_type: DurablePlanOwnerType::ResultItem,
            owner_id: OWNER_ID.to_string(),
            scope_kind: DurablePlanScopeKind::Channel,
            manuscript_channel: Some(DurableManuscriptChannel::Primary),
            intent: crate::manuscript_provisioning_contract::DurablePlanIntent::CreateDefault,
            canonical_resource_identity_hash:
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string(),
            canonical_placement_identity_hash:
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_string(),
            parent_shared_identity_hash: None,
            step_count: 7,
            planner_version: MAINLINE_VERSION.to_string(),
            created_at: NOW.to_string(),
        };
        let observed = MainlineObservedStepInput {
            step_kind: "ensure-directory".to_string(),
            step_scope: "primary".to_string(),
            effect_outcome: "reused".to_string(),
            observed_identity_hash:
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string(),
            resource_record_id: None,
            readback_path: Some(custody.directory_string()),
        };
        assert_eq!(
            verify_observed_step(
                &connection,
                &plan,
                &observed,
                &custody.directory_string(),
                &expected(&custody.manuscript),
            ),
            Err("PROVISIONING_MAINLINE_OBSERVED_IDENTITY_CONFLICT".to_string())
        );

        let spoof_path = custody.root.join("caller-spoofed-file-ref-path");
        let spoof_path = normalized_declared_path(&spoof_path.to_string_lossy())
            .expect("normalize spoofed FileRef observation");
        let forged_file_ref_hash = step_evidence_hash(
            &scope(DurablePlanOwnerType::ResultItem),
            DurableStepKind::RegisterFolderFileRef,
            DurableStepScope::Primary,
            &spoof_path,
            Some("folder-a3-forged"),
        )
        .expect("build caller-spoofed FileRef evidence hash");
        let forged_file_ref_observation = MainlineObservedStepInput {
            step_kind: "register-folder-fileref".to_string(),
            step_scope: "primary".to_string(),
            effect_outcome: "reused".to_string(),
            observed_identity_hash: forged_file_ref_hash,
            resource_record_id: Some("folder-a3-forged".to_string()),
            readback_path: Some(spoof_path),
        };
        assert_eq!(
            verify_observed_step(
                &connection,
                &plan,
                &forged_file_ref_observation,
                &custody.directory_string(),
                &expected(&custody.manuscript),
            ),
            Err("PROVISIONING_MAINLINE_OBSERVED_IDENTITY_CONFLICT".to_string())
        );
    }

    #[test]
    fn a3_custody_reuses_exact_known_partial_without_rewriting_bytes() {
        let custody = TempCustody::new("known-partial");
        let before = fs::read(&custody.manuscript).expect("read original Markdown");
        let connection = custody_connection();
        let manuscripts = expected(&custody.manuscript);
        assert_eq!(
            verify_existing_physical_custody(
                &connection,
                None,
                &scope(DurablePlanOwnerType::ResultItem),
                &custody.directory_string(),
                &manuscripts,
            ),
            Err("PROVISIONING_MAINLINE_UNKNOWN_PHYSICAL_DIRECTORY".to_string())
        );

        insert_ref(
            &connection,
            "manuscript-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "file",
            "manuscript",
            "managed",
            &custody.manuscript,
        );
        verify_existing_physical_custody(
            &connection,
            None,
            &scope(DurablePlanOwnerType::ResultItem),
            &custody.directory_string(),
            &manuscripts,
        )
        .expect("exact manuscript FileRef proves a known partial workspace");
        assert_eq!(
            fs::read(&custody.manuscript).expect("read reused Markdown"),
            before
        );
        assert_eq!(
            verify_ready_paths_match_file_refs(
                &connection,
                &scope(DurablePlanOwnerType::ResultItem),
                &custody.directory_string(),
                &manuscripts,
            ),
            Err("PROVISIONING_MAINLINE_FOLDER_CUSTODY_CONFLICT".to_string())
        );

        insert_ref(
            &connection,
            "folder-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "folder",
            "defaultFolder",
            "managed",
            &custody.directory,
        );
        connection
            .execute(
                "INSERT INTO manuscript_bindings (
                   id,owner_type,owner_id,manuscript_channel,
                   default_folder_file_ref_id,default_manuscript_file_ref_id,current_file_ref_id,
                   created_at,updated_at
                 ) VALUES ('binding','resultItem',?1,'primary',
                           'folder-ref','manuscript-ref','manuscript-ref',?2,?2)",
                (OWNER_ID, NOW),
            )
            .expect("insert complete Binding");
        verify_ready_paths_match_file_refs(
            &connection,
            &scope(DurablePlanOwnerType::ResultItem),
            &custody.directory_string(),
            &manuscripts,
        )
        .expect("exact physical/FileRef/Binding readback is READY");
        assert_eq!(
            fs::read(&custody.manuscript).expect("read ready Markdown"),
            before
        );
    }

    #[test]
    fn a3_custody_rejects_conflict_and_ready_rechecks_physical_presence() {
        let custody = TempCustody::new("conflict");
        let connection = custody_connection();
        let manuscripts = expected(&custody.manuscript);
        insert_ref(
            &connection,
            "folder-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "folder",
            "defaultFolder",
            "managed",
            &custody.directory,
        );
        assert_eq!(
            verify_existing_physical_custody(
                &connection,
                None,
                &scope(DurablePlanOwnerType::ResultItem),
                &custody.directory_string(),
                &manuscripts,
            ),
            Err("PROVISIONING_MAINLINE_UNKNOWN_PHYSICAL_MANUSCRIPT".to_string())
        );

        insert_ref(
            &connection,
            "manuscript-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "file",
            "manuscript",
            "managed",
            &custody.manuscript,
        );
        connection
            .execute(
                "INSERT INTO manuscript_bindings (
                   id,owner_type,owner_id,manuscript_channel,
                   default_folder_file_ref_id,default_manuscript_file_ref_id,current_file_ref_id,
                   created_at,updated_at
                 ) VALUES ('binding','resultItem',?1,'primary',
                           'folder-ref','manuscript-ref','manuscript-ref',?2,?2)",
                (OWNER_ID, NOW),
            )
            .expect("insert complete Binding");
        fs::remove_file(&custody.manuscript).expect("simulate external file loss");
        assert_eq!(
            verify_ready_paths_match_file_refs(
                &connection,
                &scope(DurablePlanOwnerType::ResultItem),
                &custody.directory_string(),
                &manuscripts,
            ),
            Err("PROVISIONING_MAINLINE_PHYSICAL_MANUSCRIPT_MISSING".to_string())
        );
    }

    #[test]
    fn a3_ready_preserves_valid_independent_current_manuscript() {
        let custody = TempCustody::new("independent-current");
        let independent = custody.directory.join("draft.md");
        fs::write(&independent, b"independent current\n").expect("write independent current");
        let connection = custody_connection();
        insert_ref(
            &connection,
            "folder-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "folder",
            "defaultFolder",
            "managed",
            &custody.directory,
        );
        insert_ref(
            &connection,
            "manuscript-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "file",
            "manuscript",
            "managed",
            &custody.manuscript,
        );
        insert_ref(
            &connection,
            "current-ref",
            "resultItem",
            OWNER_ID,
            "primary",
            "file",
            "manuscript",
            "external",
            &independent,
        );
        connection
            .execute(
                "INSERT INTO manuscript_bindings (
                   id,owner_type,owner_id,manuscript_channel,
                   default_folder_file_ref_id,default_manuscript_file_ref_id,current_file_ref_id,
                   created_at,updated_at
                 ) VALUES ('binding','resultItem',?1,'primary',
                           'folder-ref','manuscript-ref','current-ref',?2,?2)",
                (OWNER_ID, NOW),
            )
            .expect("insert Binding with independent current");
        verify_ready_paths_match_file_refs(
            &connection,
            &scope(DurablePlanOwnerType::ResultItem),
            &custody.directory_string(),
            &expected(&custody.manuscript),
        )
        .expect("valid same-owner/channel independent current is preserved");
    }

    #[test]
    fn a3_operation_chain_custody_accepts_only_exact_converged_physical_evidence() {
        let database = crate::provisioning_runtime_non_completed_exit_tests::TempDatabase::new(
            "a3-operation-chain-custody",
        );
        let custody = TempCustody::new("operation-chain");
        let mut connection = database.open();
        connection
            .execute(
                "INSERT INTO result_items (
                   id,project_id,source_type,source_id,title,result_type,created_at,updated_at
                 ) VALUES (?1,'project-1','manual','source-a3','Result','metric',?2,?2)",
                params![OWNER_ID, NOW],
            )
            .expect("seed ResultItem owner");
        let ownership =
            crate::db::manuscript_provisioning_operation_state::claim_ownership::fixed_repository_context_for_test(
                "a3-mainline-chain-owner",
                1_700_000_000_000,
            );
        let operation_id = "a3-operation-chain-custody";
        let initialized = initialize_mainline_operation_atomically(
            &mut connection,
            &ownership,
            &MainlineAtomicInitializationRequest {
                operation_id: operation_id.to_string(),
                scope: scope(DurablePlanOwnerType::ResultItem),
                descriptor_key: DescriptorKey("managed-primary-v1".to_string()),
                canonical_resource: CanonicalResourceIdentity {
                    resource_identity_hash: "a".repeat(64),
                    placement_identity_hash: "b".repeat(64),
                    parent_shared_identity_hash: None,
                },
                occurred_at: NOW.to_string(),
            },
        )
        .expect("initialize exact A3 operation");
        let directory_hash = step_evidence_hash(
            &scope(DurablePlanOwnerType::ResultItem),
            DurableStepKind::EnsureDirectory,
            DurableStepScope::Primary,
            &normalized_declared_path(&custody.directory_string()).expect("normalize directory"),
            None,
        )
        .expect("hash directory evidence");
        let manuscript_hash = step_evidence_hash(
            &scope(DurablePlanOwnerType::ResultItem),
            DurableStepKind::EnsureManuscript,
            DurableStepScope::Primary,
            &normalized_declared_path(&custody.manuscript.to_string_lossy())
                .expect("normalize manuscript"),
            None,
        )
        .expect("hash manuscript evidence");
        for (kind, evidence_hash) in [
            ("ensure-directory", directory_hash),
            ("ensure-manuscript", manuscript_hash),
        ] {
            connection
                .execute(
                    "UPDATE manuscript_provisioning_step_progress
                     SET boundary='converged',effect_outcome='created',readback_outcome='verified',
                         observed_identity_hash=?1,progress_revision=4,
                         started_at=?2,effect_observed_at=?2,readback_verified_at=?2,
                         converged_at=?2,updated_at=?2
                     WHERE operation_id=?3 AND step_kind=?4 AND step_scope='primary'",
                    params![evidence_hash, NOW, operation_id, kind],
                )
                .expect("seed converged physical custody evidence");
        }
        verify_existing_physical_custody(
            &connection,
            Some(operation_id),
            &scope(DurablePlanOwnerType::ResultItem),
            &custody.directory_string(),
            &expected(&custody.manuscript),
        )
        .expect("exact operation evidence owns physical bytes before FileRef registration");
        assert_eq!(
            verify_existing_physical_custody(
                &connection,
                Some("missing-operation"),
                &scope(DurablePlanOwnerType::ResultItem),
                &custody.directory_string(),
                &expected(&custody.manuscript),
            ),
            Err("PROVISIONING_MAINLINE_ATTEMPT_MISSING".to_string())
        );
        let attempt = read_operation_attempt(&connection, operation_id)
            .expect("read Attempt")
            .expect("Attempt exists");
        let claim = read_active_claim_for_operation(&connection, operation_id)
            .expect("read Claim")
            .expect("Claim exists");
        let terminal = terminalize_attempt_retain_claim_and_enqueue_audit(
            &mut connection,
            &TerminalAttemptInput {
                operation_id: operation_id.to_string(),
                claim_id: claim.claim_id.clone(),
                claim_owner_token: claim.claim_owner_token.clone(),
                expected_operation_revision: attempt.revision,
                expected_claim_revision: claim.claim_revision,
                expected_phase: attempt.phase,
                expected_operation_status: "active".to_string(),
                phase: "partial".to_string(),
                operation_status: "terminal-recovery-required".to_string(),
                result_classification: "provisioning-recovery-required".to_string(),
                next_action: "recover".to_string(),
                partial_kind: Some("physical-only".to_string()),
                original_cause_code: Some(
                    "PROVISIONING_MAINLINE_EFFECT_OUTCOME_UNKNOWN".to_string(),
                ),
                folder_effect: "created".to_string(),
                manuscript_effect: "created".to_string(),
                file_ref_effect: "none".to_string(),
                binding_effect: "none".to_string(),
                default_folder_file_ref_id: None,
                default_manuscript_file_ref_id: None,
                binding_id: None,
                final_verification_outcome: "not-verified".to_string(),
                inspector_version: Some(MAINLINE_VERSION.to_string()),
                verifier_version: None,
                occurred_at: NOW.to_string(),
            },
        )
        .expect("terminalize uncertain effect with retained recovery authority");
        assert_eq!(
            terminal.attempt.operation_status,
            "terminal-recovery-required"
        );
        assert_eq!(terminal.attempt.next_action.as_deref(), Some("recover"));
        assert!(read_active_claim_for_operation(&connection, operation_id)
            .expect("read retained Claim")
            .is_some());
        assert_eq!(initialized.attempt.operation_id, operation_id);
    }

    #[test]
    fn a3_step_evidence_hash_matches_the_typescript_canonical_contract() {
        assert_eq!(
            canonical_resource_identity_hash(&scope(DurablePlanOwnerType::ResultItem))
                .expect("hash canonical cross-boundary resource identity"),
            "9418f8a220864d68aa80daece1729dfccb8c1b49a10ab903f30a63c69af9d159"
        );
        assert_eq!(
            step_evidence_hash(
                &scope(DurablePlanOwnerType::ResultItem),
                DurableStepKind::EnsureDirectory,
                DurableStepScope::Primary,
                "c:/labpod/a3/result-item",
                None,
            )
            .expect("hash canonical cross-boundary evidence"),
            "c993badff78a9529524edcbbde084f4e92d247b34056bd947a1a2ef36e48b2c8"
        );
    }
}
