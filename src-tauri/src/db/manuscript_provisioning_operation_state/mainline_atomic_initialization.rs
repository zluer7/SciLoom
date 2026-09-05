use super::claim_ownership::ClaimOwnershipRepositoryContext;
use super::durable_precondition::{DurablePreconditionBuilder, DurablePreconditionRequest};
use super::step_progress::PlanFingerprintProfile;
use super::step_progress_repository::{
    create_attempt_claim_plan_and_steps_in_transaction, AtomicDurableAttemptInput,
    AtomicDurableAttemptResult, DurableStepPlanInput, DurableStepSkeletonInput,
};
use crate::manuscript_provisioning_contract::{
    canonical_family_descriptor, CanonicalResourceIdentity, DescriptorKey, DurablePlanIntent,
    ProvisioningScopeIdentity,
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PLAN_VERSION: i64 = 1;
const STEP_VERSION: i64 = 1;
const PLANNER_VERSION: &str = "lp12-a3-mainline-v1";
const PLAN_FINGERPRINT_DOMAIN: &str = "labpod.provisioning-plan-identity";
const PLAN_ID_DOMAIN: &str = "labpod.provisioning-plan-id";
const STEP_ID_DOMAIN: &str = "labpod.provisioning-step-id";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MainlineAtomicInitializationRequest {
    pub operation_id: String,
    pub scope: ProvisioningScopeIdentity,
    pub descriptor_key: DescriptorKey,
    pub canonical_resource: CanonicalResourceIdentity,
    pub occurred_at: String,
}

fn sha256(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

/// Mainline-only root initializer. The durable precondition token is minted
/// and consumed in the same IMMEDIATE transaction; callers can never provide
/// or cache a precondition hash.
pub(crate) fn initialize_mainline_operation_atomically(
    connection: &mut Connection,
    ownership_context: &ClaimOwnershipRepositoryContext,
    request: &MainlineAtomicInitializationRequest,
) -> Result<AtomicDurableAttemptResult, String> {
    request
        .scope
        .validate()
        .map_err(|_| "PROVISIONING_MAINLINE_SCOPE_CONFLICT".to_string())?;
    if request.operation_id.is_empty()
        || request.operation_id.len() > 128
        || !request
            .operation_id
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.'))
        || !super::step_progress::is_utc_timestamp(&request.occurred_at)
        || !super::step_progress::is_lowercase_sha256(
            &request.canonical_resource.resource_identity_hash,
        )
        || !super::step_progress::is_lowercase_sha256(
            &request.canonical_resource.placement_identity_hash,
        )
        || request
            .canonical_resource
            .parent_shared_identity_hash
            .as_deref()
            .is_some_and(|value| !super::step_progress::is_lowercase_sha256(value))
    {
        return Err("PROVISIONING_MAINLINE_IDENTITY_INVALID".to_string());
    }
    let descriptor = canonical_family_descriptor(&request.scope, &request.descriptor_key)
        .map_err(|_| "PROVISIONING_MAINLINE_DESCRIPTOR_CONFLICT".to_string())?;
    let steps_json = descriptor
        .canonical_steps
        .iter()
        .enumerate()
        .map(|(ordinal, step)| {
            json!({
                "kind": step.kind.as_str(),
                "ordinal": ordinal,
                "scope": step.scope.as_str(),
                "version": STEP_VERSION,
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "canonicalPlacementIdentityHash": request.canonical_resource.placement_identity_hash,
        "canonicalResourceIdentityHash": request.canonical_resource.resource_identity_hash,
        "descriptorKey": request.descriptor_key.0,
        "domain": PLAN_FINGERPRINT_DOMAIN,
        "intent": DurablePlanIntent::CreateDefault.as_str(),
        "manuscriptChannel": request.scope.manuscript_channel.map(|value| value.as_str()),
        "operationId": request.operation_id,
        "ownerId": request.scope.owner_id,
        "ownerType": request.scope.owner_type.as_str(),
        "parentSharedIdentityHash": request.canonical_resource.parent_shared_identity_hash,
        "planTemplateKind": descriptor.plan_template.as_str(),
        "planVersion": PLAN_VERSION,
        "plannerVersion": PLANNER_VERSION,
        "scopeKind": request.scope.scope_kind.as_str(),
        "steps": steps_json,
    });
    let canonical = serde_json::to_string(&payload)
        .map_err(|_| "PROVISIONING_MAINLINE_PLAN_ENCODING_FAILED".to_string())?;
    let fingerprint = sha256(canonical);
    let plan_id = sha256(format!(
        "{PLAN_ID_DOMAIN}\n{}\n{}",
        request.operation_id, fingerprint
    ));
    let steps = descriptor
        .canonical_steps
        .iter()
        .cloned()
        .enumerate()
        .map(|(ordinal, definition)| DurableStepSkeletonInput {
            step_id: sha256(format!(
                "{STEP_ID_DOMAIN}\n{plan_id}\n{ordinal}\n{}\n{}",
                definition.kind.as_str(),
                definition.scope.as_str()
            )),
            step_ordinal: ordinal as i64,
            step_kind: definition.kind,
            step_scope: definition.scope,
            step_version: STEP_VERSION,
        })
        .collect::<Vec<_>>();

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "PROVISIONING_MAINLINE_REPOSITORY_BUSY".to_string())?;
    let precondition = DurablePreconditionBuilder::build_in_transaction(
        &transaction,
        &DurablePreconditionRequest {
            operation_id: request.operation_id.clone(),
            scope: request.scope.clone(),
            intent: DurablePlanIntent::CreateDefault,
            predecessor_operation_id: None,
        },
    )
    .map_err(|error| error.as_str().to_string())?;
    let precondition_snapshot_hash = precondition
        .canonical_hash_for_plan_insert(
            &request.operation_id,
            &request.scope,
            DurablePlanIntent::CreateDefault,
        )
        .map_err(|error| error.as_str().to_string())?
        .to_string();
    let input = AtomicDurableAttemptInput {
        operation_id: request.operation_id.clone(),
        claim_id: format!("claim-{}", Uuid::new_v4()),
        #[cfg(test)]
        claim_owner_token: ownership_context.claim_owner_token().to_string(),
        owner_type: request.scope.owner_type,
        owner_id: request.scope.owner_id.clone(),
        scope_kind: request.scope.scope_kind,
        manuscript_channel: request.scope.manuscript_channel,
        aggregate_operation_id: None,
        intent: DurablePlanIntent::CreateDefault,
        trigger_kind: "owner-create".to_string(),
        occurred_at: request.occurred_at.clone(),
        plan: DurableStepPlanInput {
            plan_id,
            plan_version: PLAN_VERSION,
            plan_template_kind: descriptor.plan_template,
            plan_identity_fingerprint: fingerprint,
            precondition_snapshot_hash,
            fingerprint_profile: PlanFingerprintProfile::RestrictedJcsSha256V1,
            canonical_resource_identity_hash: request
                .canonical_resource
                .resource_identity_hash
                .clone(),
            canonical_placement_identity_hash: request
                .canonical_resource
                .placement_identity_hash
                .clone(),
            parent_shared_identity_hash: request
                .canonical_resource
                .parent_shared_identity_hash
                .clone(),
            declared_step_count: steps.len() as i64,
            planner_version: PLANNER_VERSION.to_string(),
        },
        steps,
    };
    let result =
        create_attempt_claim_plan_and_steps_in_transaction(&transaction, ownership_context, &input)
            .map_err(|error| error.code.to_string())?;
    transaction
        .commit()
        .map_err(|_| "PROVISIONING_MAINLINE_COMMIT_FAILED".to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manuscript_provisioning_contract::{
        DurableManuscriptChannel, DurablePlanOwnerType, DurablePlanScopeKind,
    };
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    const NOW: &str = "2026-08-12T12:00:00Z";
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct TempDatabase {
        directory: PathBuf,
        path: PathBuf,
    }

    impl TempDatabase {
        fn new(label: &str) -> Self {
            let directory =
                std::env::temp_dir().join(format!("labpod-a3-root-{label}-{}", Uuid::new_v4()));
            fs::create_dir_all(&directory).expect("create isolated database directory");
            let path = directory.join("fixture.sqlite3");
            crate::db::initialize_database_at(&path).expect("initialize exact v41 SQLite");
            Self { directory, path }
        }

        fn open(&self) -> Connection {
            let connection = Connection::open(&self.path).expect("open exact v41 SQLite");
            connection
                .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;")
                .expect("configure exact v41 SQLite");
            connection
        }
    }

    impl Drop for TempDatabase {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.directory).expect("remove only isolated database directory");
        }
    }

    fn request(
        operation_id: &str,
        scope: ProvisioningScopeIdentity,
        descriptor: &str,
    ) -> MainlineAtomicInitializationRequest {
        MainlineAtomicInitializationRequest {
            operation_id: operation_id.to_string(),
            scope,
            descriptor_key: DescriptorKey(descriptor.to_string()),
            canonical_resource: CanonicalResourceIdentity {
                resource_identity_hash: HASH_A.to_string(),
                placement_identity_hash: HASH_B.to_string(),
                parent_shared_identity_hash: None,
            },
            occurred_at: NOW.to_string(),
        }
    }

    #[test]
    fn a3_root_initialization_atomically_creates_exact_managed_plan() {
        let database = TempDatabase::new("managed");
        let mut connection = database.open();
        connection
            .execute(
                "INSERT INTO result_items (
                   id,project_id,source_type,source_id,title,result_type,created_at,updated_at
                 ) VALUES ('result-a3','project-1','manual','source-a3','Result','metric',?1,?1)",
                [NOW],
            )
            .expect("seed ResultItem owner");
        let ownership = super::super::claim_ownership::fixed_repository_context_for_test(
            "a3-mainline-owner",
            1_700_000_000_000,
        );
        let initialized = initialize_mainline_operation_atomically(
            &mut connection,
            &ownership,
            &request(
                "a3-root-managed",
                ProvisioningScopeIdentity {
                    owner_type: DurablePlanOwnerType::ResultItem,
                    owner_id: "result-a3".to_string(),
                    scope_kind: DurablePlanScopeKind::Channel,
                    manuscript_channel: Some(DurableManuscriptChannel::Primary),
                },
                "managed-primary-v1",
            ),
        )
        .expect("initialize managed root operation");
        assert_eq!(initialized.attempt.operation_id, "a3-root-managed");
        assert_eq!(initialized.plan.planner_version, PLANNER_VERSION);
        assert_eq!(initialized.steps.len(), 7);
        assert!(initialized.steps.iter().all(|step| step.is_required));
        let claims: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_active_claims WHERE operation_id='a3-root-managed'",
                [],
                |row| row.get(0),
            )
            .expect("count active claim");
        assert_eq!(claims, 1);
    }

    #[test]
    fn a3_literature_root_is_one_operation_with_two_child_projections() {
        let database = TempDatabase::new("literature");
        let mut connection = database.open();
        connection
            .execute(
                "INSERT INTO literatures (
                   id,title,reading_status,primary_project_id,created_at,updated_at
                 ) VALUES ('literature-a3','Literature','unread','project-1',?1,?1)",
                [NOW],
            )
            .expect("seed Literature owner");
        let ownership = super::super::claim_ownership::fixed_repository_context_for_test(
            "a3-literature-owner",
            1_700_000_000_000,
        );
        let initialized = initialize_mainline_operation_atomically(
            &mut connection,
            &ownership,
            &request(
                "a3-root-literature",
                ProvisioningScopeIdentity {
                    owner_type: DurablePlanOwnerType::Literature,
                    owner_id: "literature-a3".to_string(),
                    scope_kind: DurablePlanScopeKind::LiteratureAggregate,
                    manuscript_channel: None,
                },
                "literature-aggregate-v1",
            ),
        )
        .expect("initialize Literature aggregate root operation");
        assert_eq!(initialized.steps.len(), 11);
        let attempts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_operation_attempts WHERE operation_id='a3-root-literature'",
                [],
                |row| row.get(0),
            )
            .expect("count aggregate attempt");
        let projections: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM manuscript_provisioning_literature_child_states
                 WHERE aggregate_operation_id='a3-root-literature'",
                [],
                |row| row.get(0),
            )
            .expect("count Literature child projections");
        assert_eq!(attempts, 1);
        assert_eq!(projections, 2);
    }
}
