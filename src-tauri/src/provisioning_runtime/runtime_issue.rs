use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeIssueKind {
    ActiveOperation,
    StaleCandidate,
    CrashCandidate,
    Retryable,
    RepairRequired,
    RecoveryRequired,
    LifecycleDecisionRequired,
    Blocked,
    AuditPending,
    AuditFailed,
    UnresolvedRetained,
    StartupScanFailed,
    OperationStateUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiteratureChildIssueSummary {
    pub manuscript_channel: String,
    pub operation_id: Option<String>,
    pub revision: i64,
    pub phase: Option<String>,
    pub operation_status: Option<String>,
    pub result_classification: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeIssueCandidate {
    pub business_issue: bool,
    pub operation_id: String,
    pub scope_kind: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: Option<String>,
    pub phase: String,
    pub operation_status: String,
    pub result_classification: Option<String>,
    pub next_action: Option<String>,
    pub updated_at: String,
    pub stale_kind: Option<RuntimeIssueKind>,
    pub literature_children: Vec<LiteratureChildIssueSummary>,
    pub audit_status: Option<String>,
    pub safe_error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeIssueAuthority {
    DurableOperationState,
    RuntimeDerived,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeIssue {
    pub key: String,
    pub kind: RuntimeIssueKind,
    pub authority: RuntimeIssueAuthority,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: Option<String>,
    pub scope_kind: String,
    pub operation_id: Option<String>,
    pub phase: Option<String>,
    pub result_classification: Option<String>,
    pub next_action: Option<String>,
    pub updated_at: String,
    pub safe_error_code: Option<String>,
    pub literature_children: Vec<LiteratureChildIssueSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeIssueSummary {
    pub issues: Vec<RuntimeIssue>,
    pub business_issue_count: usize,
    pub audit_issue_count: usize,
}

fn issue_priority(kind: RuntimeIssueKind) -> u8 {
    match kind {
        RuntimeIssueKind::Blocked | RuntimeIssueKind::LifecycleDecisionRequired => 0,
        RuntimeIssueKind::RecoveryRequired => 1,
        RuntimeIssueKind::RepairRequired => 2,
        RuntimeIssueKind::Retryable => 3,
        RuntimeIssueKind::StaleCandidate | RuntimeIssueKind::CrashCandidate => 4,
        RuntimeIssueKind::ActiveOperation => 5,
        RuntimeIssueKind::UnresolvedRetained => 6,
        RuntimeIssueKind::AuditFailed => 7,
        RuntimeIssueKind::AuditPending => 8,
        RuntimeIssueKind::StartupScanFailed | RuntimeIssueKind::OperationStateUnavailable => 9,
    }
}

fn main_kind(candidate: &RuntimeIssueCandidate) -> RuntimeIssueKind {
    match candidate.result_classification.as_deref() {
        Some("lifecycle-decision-required") => RuntimeIssueKind::LifecycleDecisionRequired,
        Some("blocked") => RuntimeIssueKind::Blocked,
        Some("provisioning-recovery-required") => RuntimeIssueKind::RecoveryRequired,
        Some("repair-required") => RuntimeIssueKind::RepairRequired,
        Some("retryable") => RuntimeIssueKind::Retryable,
        _ if candidate.operation_status == "active" => candidate
            .stale_kind
            .unwrap_or(RuntimeIssueKind::ActiveOperation),
        _ => RuntimeIssueKind::UnresolvedRetained,
    }
}

fn issue_key(kind: RuntimeIssueKind, candidate: &RuntimeIssueCandidate) -> String {
    format!(
        "{kind:?}|{}|{}|{}|{}|{}",
        candidate.owner_type,
        candidate.owner_id,
        candidate.scope_kind,
        candidate
            .manuscript_channel
            .as_deref()
            .unwrap_or("aggregate"),
        candidate.operation_id
    )
}

fn make_issue(kind: RuntimeIssueKind, candidate: &RuntimeIssueCandidate) -> RuntimeIssue {
    RuntimeIssue {
        key: issue_key(kind, candidate),
        kind,
        authority: RuntimeIssueAuthority::RuntimeDerived,
        owner_type: candidate.owner_type.clone(),
        owner_id: candidate.owner_id.clone(),
        manuscript_channel: candidate.manuscript_channel.clone(),
        scope_kind: candidate.scope_kind.clone(),
        operation_id: Some(candidate.operation_id.clone()),
        phase: Some(candidate.phase.clone()),
        result_classification: candidate.result_classification.clone(),
        next_action: candidate.next_action.clone(),
        updated_at: candidate.updated_at.clone(),
        safe_error_code: candidate.safe_error_code.clone(),
        literature_children: candidate.literature_children.clone(),
    }
}

fn compare_issues(left: &RuntimeIssue, right: &RuntimeIssue) -> Ordering {
    issue_priority(left.kind)
        .cmp(&issue_priority(right.kind))
        .then_with(|| right.updated_at.cmp(&left.updated_at))
        .then_with(|| left.owner_type.cmp(&right.owner_type))
        .then_with(|| left.owner_id.cmp(&right.owner_id))
        .then_with(|| {
            left.manuscript_channel
                .as_deref()
                .unwrap_or("aggregate")
                .cmp(right.manuscript_channel.as_deref().unwrap_or("aggregate"))
        })
        .then_with(|| left.operation_id.cmp(&right.operation_id))
        .then_with(|| left.key.cmp(&right.key))
}

pub(crate) fn normalize_runtime_issues(
    candidates: Vec<RuntimeIssueCandidate>,
) -> RuntimeIssueSummary {
    let mut main_by_operation: HashMap<String, RuntimeIssue> = HashMap::new();
    let mut audit_by_operation: HashMap<String, RuntimeIssue> = HashMap::new();
    for candidate in candidates {
        if candidate.scope_kind == "literature-child" {
            continue;
        }
        if candidate.business_issue {
            let kind = main_kind(&candidate);
            let main = make_issue(kind, &candidate);
            match main_by_operation.get(&candidate.operation_id) {
                Some(existing) if issue_priority(existing.kind) <= issue_priority(kind) => {}
                _ => {
                    main_by_operation.insert(candidate.operation_id.clone(), main);
                }
            }
        }
        let audit_kind = match candidate.audit_status.as_deref() {
            Some("pending") => Some(RuntimeIssueKind::AuditPending),
            Some("failed") => Some(RuntimeIssueKind::AuditFailed),
            _ => None,
        };
        if let Some(audit_kind) = audit_kind {
            audit_by_operation.insert(
                candidate.operation_id.clone(),
                make_issue(audit_kind, &candidate),
            );
        }
    }
    let business_issue_count = main_by_operation.len();
    let audit_issue_count = audit_by_operation.len();
    let mut issues = main_by_operation
        .into_values()
        .chain(audit_by_operation.into_values())
        .collect::<Vec<_>>();
    issues.sort_by(compare_issues);
    RuntimeIssueSummary {
        issues,
        business_issue_count,
        audit_issue_count,
    }
}
