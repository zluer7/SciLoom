use super::open_connection;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const OWNER_NOT_FOUND: &str = "LIFECYCLE_OWNER_NOT_FOUND";
const OWNER_NOT_DELETED: &str = "LIFECYCLE_OWNER_NOT_DELETED";
const OWNER_CHANGED: &str = "LIFECYCLE_OWNER_CHANGED";
const RUNS_EXIST: &str = "LIFECYCLE_RUNS_EXIST";
const METRICS_EXIST: &str = "LIFECYCLE_METRICS_EXIST";
const SOURCE_DEPS: &str = "LIFECYCLE_SOURCE_DEPENDENCIES_EXIST";
const BUSINESS_DEPS: &str = "LIFECYCLE_BUSINESS_DEPENDENCIES_EXIST";
const BINDING_INVALID: &str = "LIFECYCLE_BINDING_INVALID";
const FILE_REF_INVALID: &str = "LIFECYCLE_FILE_REF_INVALID";
const PREFLIGHT_EXPIRED: &str = "LIFECYCLE_PREFLIGHT_EXPIRED";
const PREFLIGHT_CONSUMED: &str = "LIFECYCLE_PREFLIGHT_CONSUMED";
const POST_COMMIT_VERIFY_FAILED: &str = "LIFECYCLE_POST_COMMIT_VERIFY_FAILED";
const PREFLIGHT_TOKEN_TTL_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOwnerInput {
    owner_type: String,
    owner_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleMutationInput {
    owner_type: String,
    owner_id: String,
    occurred_at: String,
    operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardMetadataDeleteInput {
    preflight_token: String,
    occurred_at: String,
    operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleTokenIssueInput {
    owner_type: String,
    owner_id: String,
    expected_state_digest: String,
    session_digest: String,
    external_dependency_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleIssuedToken {
    preflight_token: String,
    expires_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct StoredLifecycleToken {
    owner_type: String,
    owner_id: String,
    state_digest: String,
    session_digest: String,
    external_dependency_digest: String,
    expires_at_unix_ms: u64,
    consumed: bool,
}

#[derive(Default)]
pub(crate) struct LifecycleTokenStore {
    records: Mutex<HashMap<String, StoredLifecycleToken>>,
    nonce: AtomicU64,
}

impl LifecycleTokenStore {
    fn issue(
        &self,
        input: &LifecycleTokenIssueInput,
        state_digest: String,
        now_ms: u64,
    ) -> Result<LifecycleIssuedToken, String> {
        let nonce = self.nonce.fetch_add(1, Ordering::Relaxed);
        let token = digest(&[
            "experiment-run-lifecycle-preflight".into(),
            std::process::id().to_string(),
            now_ms.to_string(),
            nonce.to_string(),
            input.owner_type.clone(),
            input.owner_id.clone(),
            state_digest.clone(),
            input.session_digest.clone(),
            input.external_dependency_digest.clone(),
        ]);
        let expires_at_unix_ms = now_ms.saturating_add(PREFLIGHT_TOKEN_TTL_MS);
        let mut records = self
            .records
            .lock()
            .map_err(|_| "LIFECYCLE_TRANSACTION_FAILED: token store poisoned".to_string())?;
        records.retain(|_, record| !record.consumed && record.expires_at_unix_ms >= now_ms);
        records.insert(
            token.clone(),
            StoredLifecycleToken {
                owner_type: input.owner_type.clone(),
                owner_id: input.owner_id.clone(),
                state_digest,
                session_digest: input.session_digest.clone(),
                external_dependency_digest: input.external_dependency_digest.clone(),
                expires_at_unix_ms,
                consumed: false,
            },
        );
        Ok(LifecycleIssuedToken {
            preflight_token: token,
            expires_at_unix_ms,
        })
    }

    fn consume(&self, token: &str, now_ms: u64) -> Result<StoredLifecycleToken, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "LIFECYCLE_TRANSACTION_FAILED: token store poisoned".to_string())?;
        let record = records
            .get_mut(token)
            .ok_or_else(|| PREFLIGHT_CONSUMED.to_string())?;
        if record.consumed {
            return Err(PREFLIGHT_CONSUMED.into());
        }
        record.consumed = true;
        if now_ms > record.expires_at_unix_ms {
            return Err(PREFLIGHT_EXPIRED.into());
        }
        Ok(record.clone())
    }
}

fn unix_time_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: system clock: {error}"))?
        .as_millis();
    u64::try_from(millis)
        .map_err(|_| "LIFECYCLE_TRANSACTION_FAILED: system clock overflow".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCount {
    kind: String,
    count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecyclePreflight {
    owner_type: String,
    owner_id: String,
    deleted: bool,
    owner_revision: String,
    deleted_at: Option<String>,
    blocking_dependencies: Vec<DependencyCount>,
    cleanable_relations: Vec<DependencyCount>,
    binding_ids: Vec<String>,
    file_ref_ids: Vec<String>,
    representative_relation_ids: Vec<String>,
    binding_count: usize,
    file_ref_count: usize,
    metric_count: i64,
    representative_relation_count: usize,
    physical_file_action_count: u8,
    state_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleMutationResult {
    status: String,
    owner_type: String,
    owner_id: String,
    changed: bool,
    operation_log_id: Option<String>,
    physical_file_action_count: u8,
}

fn owner_table(owner_type: &str) -> Result<&'static str, String> {
    match owner_type {
        "experiment" => Ok("experiments"),
        "experimentRun" => Ok("experiment_runs"),
        _ => Err(OWNER_NOT_FOUND.into()),
    }
}

fn count(connection: &Connection, sql: &str, owner_id: &str) -> Result<i64, String> {
    connection
        .query_row(sql, [owner_id], |row| row.get(0))
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))
}

fn ids(
    connection: &Connection,
    sql: &str,
    owner_type: &str,
    owner_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let rows = statement
        .query_map(params![owner_type, owner_id], |row| row.get(0))
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))
}

fn digest(parts: &[String]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in parts.join("\u{0}").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn dependency(kind: &str, value: i64) -> Option<DependencyCount> {
    (value > 0).then(|| DependencyCount {
        kind: kind.into(),
        count: value,
    })
}

fn preflight_in_connection(
    connection: &Connection,
    owner_type: &str,
    owner_id: &str,
) -> Result<LifecyclePreflight, String> {
    let table = owner_table(owner_type)?;
    let owner: Option<(String, Option<String>)> = connection
        .query_row(
            &format!("SELECT updated_at,deleted_at FROM {table} WHERE id=?1"),
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let Some((owner_revision, deleted_at)) = owner else {
        return Err(OWNER_NOT_FOUND.into());
    };

    let binding_ids = ids(
        connection,
        "SELECT id FROM manuscript_bindings WHERE owner_type=?1 AND owner_id=?2 ORDER BY id",
        owner_type,
        owner_id,
    )?;
    let file_ref_ids = ids(
        connection,
        "SELECT id FROM file_refs WHERE owner_type=?1 AND owner_id=?2 ORDER BY id",
        owner_type,
        owner_id,
    )?;
    if binding_ids.len() > 1 {
        return Err(BINDING_INVALID.into());
    }
    let invalid_binding: i64 = connection.query_row(
        "SELECT COUNT(*) FROM manuscript_bindings b WHERE b.owner_type=?1 AND b.owner_id=?2 AND (b.manuscript_channel<>'primary' OR (b.default_folder_file_ref_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_refs f WHERE f.id=b.default_folder_file_ref_id AND f.owner_type=b.owner_type AND f.owner_id=b.owner_id)) OR (b.default_manuscript_file_ref_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_refs f WHERE f.id=b.default_manuscript_file_ref_id AND f.owner_type=b.owner_type AND f.owner_id=b.owner_id)) OR (b.current_file_ref_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_refs f WHERE f.id=b.current_file_ref_id AND f.owner_type=b.owner_type AND f.owner_id=b.owner_id)))",
        params![owner_type, owner_id], |row| row.get(0)
    ).map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    if invalid_binding > 0 {
        return Err(BINDING_INVALID.into());
    }
    let invalid_file_refs = count(connection,
        &format!("SELECT COUNT(*) FROM file_refs WHERE owner_id=?1 AND owner_type<>'{owner_type}' AND id IN (SELECT default_folder_file_ref_id FROM manuscript_bindings WHERE owner_type='{owner_type}' AND owner_id=?1 UNION SELECT default_manuscript_file_ref_id FROM manuscript_bindings WHERE owner_type='{owner_type}' AND owner_id=?1 UNION SELECT current_file_ref_id FROM manuscript_bindings WHERE owner_type='{owner_type}' AND owner_id=?1)"),
        owner_id)?;
    if invalid_file_refs > 0 {
        return Err(FILE_REF_INVALID.into());
    }

    let representative_relation_ids = if owner_type == "experiment" {
        ids(
            connection,
            "SELECT id FROM experiment_representative_runs WHERE experiment_id=?2 ORDER BY id",
            owner_type,
            owner_id,
        )?
    } else {
        ids(
            connection,
            "SELECT id FROM experiment_representative_runs WHERE run_id=?2 ORDER BY id",
            owner_type,
            owner_id,
        )?
    };
    let metric_count = if owner_type == "experimentRun" {
        count(
            connection,
            "SELECT COUNT(*) FROM result_metrics WHERE run_id=?1",
            owner_id,
        )?
    } else {
        count(
            connection,
            "SELECT COUNT(*) FROM result_metrics WHERE experiment_id=?1",
            owner_id,
        )?
    };
    let run_count = if owner_type == "experiment" {
        count(
            connection,
            "SELECT COUNT(*) FROM experiment_runs WHERE experiment_id=?1",
            owner_id,
        )?
    } else {
        0
    };
    let result_items = if owner_type == "experiment" {
        count(connection, "SELECT COUNT(*) FROM result_items WHERE experiment_id=?1 OR (source_type='experiment' AND source_id=?1)", owner_id)?
    } else {
        count(connection, "SELECT COUNT(*) FROM result_items WHERE experiment_run_id=?1 OR (source_type IN ('experimentRun','experiment_run') AND source_id=?1)", owner_id)?
    };
    let file_ref_result_item_inbound: i64 = connection.query_row(
        "SELECT COUNT(*) FROM result_items WHERE file_ref_id IN (SELECT id FROM file_refs WHERE owner_type=?1 AND owner_id=?2)",
        params![owner_type, owner_id],
        |row| row.get(0),
    ).map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let file_ref_binding_inbound: i64 = connection.query_row(
        "SELECT COUNT(*) FROM manuscript_bindings b
         WHERE NOT (b.owner_type=?1 AND b.owner_id=?2)
           AND (b.default_folder_file_ref_id IN (SELECT id FROM file_refs WHERE owner_type=?1 AND owner_id=?2)
             OR b.default_manuscript_file_ref_id IN (SELECT id FROM file_refs WHERE owner_type=?1 AND owner_id=?2)
             OR b.current_file_ref_id IN (SELECT id FROM file_refs WHERE owner_type=?1 AND owner_id=?2))",
        params![owner_type, owner_id],
        |row| row.get(0),
    ).map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let file_ref_inbound_references = file_ref_result_item_inbound + file_ref_binding_inbound;
    let findings = if owner_type == "experiment" {
        count(
            connection,
            "SELECT COUNT(*) FROM findings WHERE experiment_id=?1",
            owner_id,
        )?
    } else {
        0
    };
    let outputs = if owner_type == "experiment" {
        count(
            connection,
            "SELECT COUNT(*) FROM outputs WHERE experiment_id=?1",
            owner_id,
        )?
    } else {
        0
    };
    let output_source_links = count(connection,
        &format!("SELECT COUNT(*) FROM output_source_links WHERE (owner_type='{owner_type}' AND owner_id=?1) OR (source_type='{owner_type}' AND source_id=?1)"), owner_id)?;
    let conversion_relations = count(connection,
        &format!("SELECT COUNT(*) FROM output_conversion_relations WHERE (source_type='{owner_type}' AND source_id=?1) OR (target_type='{owner_type}' AND target_id=?1)"), owner_id)?;
    let literature_links = count(connection,
        &format!("SELECT COUNT(*) FROM literature_links WHERE target_type='{owner_type}' AND target_id=?1"), owner_id)?;
    let trace_preferences = count(connection,
        &format!("SELECT COUNT(*) FROM research_trace_event_preferences WHERE target_type='{owner_type}' AND target_id=?1"), owner_id)?;
    let run_switch_recoveries = if owner_type == "experimentRun" {
        count(
            connection,
            "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries
             WHERE run_id=?1 AND phase NOT IN ('resolved','cancelled_safe')",
            owner_id,
        )?
    } else {
        count(
            connection,
            "SELECT COUNT(*) FROM experiment_run_manuscript_switch_recoveries
             WHERE experiment_id=?1 AND phase NOT IN ('resolved','cancelled_safe')",
            owner_id,
        )?
    };
    let experiment_switch_recoveries = if owner_type == "experiment" {
        count(
            connection,
            "SELECT COUNT(*) FROM experiment_manuscript_switch_recoveries
             WHERE experiment_id=?1 AND phase NOT IN ('resolved','cancelled_safe')",
            owner_id,
        )?
    } else {
        0
    };
    let save_as_operations = if owner_type == "experiment" {
        count(
            connection,
            "SELECT COUNT(*) FROM manuscript_save_as_operations
             WHERE owner_type='experiment' AND owner_id=?1 AND channel='primary'
               AND stage NOT IN ('completed','pre_d1_closed')",
            owner_id,
        )?
    } else {
        0
    };

    let mut blocking_dependencies = Vec::new();
    if let Some(item) = dependency("runs", run_count) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("metrics", metric_count) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("resultItems", result_items) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("fileRefInboundReferences", file_ref_inbound_references) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("findings", findings) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("researchOutputs", outputs) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("outputSourceLinks", output_source_links) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("outputConversionRelations", conversion_relations) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("literatureLinks", literature_links) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("researchTracePreferences", trace_preferences) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("manuscriptSwitchRecoveries", run_switch_recoveries) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency(
        "experimentManuscriptSwitchRecoveries",
        experiment_switch_recoveries,
    ) {
        blocking_dependencies.push(item);
    }
    if let Some(item) = dependency("experimentManuscriptSaveAsOperations", save_as_operations) {
        blocking_dependencies.push(item);
    }
    let cleanable_relations = [
        DependencyCount {
            kind: "manuscriptBindings".into(),
            count: binding_ids.len() as i64,
        },
        DependencyCount {
            kind: "fileRefs".into(),
            count: file_ref_ids.len() as i64,
        },
        DependencyCount {
            kind: "representativeRelations".into(),
            count: representative_relation_ids.len() as i64,
        },
    ]
    .into_iter()
    .filter(|item| item.count > 0)
    .collect::<Vec<_>>();
    let mut state_parts = vec![
        owner_type.into(),
        owner_id.into(),
        owner_revision.clone(),
        deleted_at.clone().unwrap_or_default(),
    ];
    state_parts.extend(
        blocking_dependencies
            .iter()
            .map(|item| format!("{}:{}", item.kind, item.count)),
    );
    state_parts.extend(binding_ids.iter().map(|id| format!("b:{id}")));
    state_parts.extend(file_ref_ids.iter().map(|id| format!("f:{id}")));
    state_parts.extend(
        representative_relation_ids
            .iter()
            .map(|id| format!("r:{id}")),
    );
    let state_digest = digest(&state_parts);
    Ok(LifecyclePreflight {
        owner_type: owner_type.into(),
        owner_id: owner_id.into(),
        deleted: deleted_at.is_some(),
        owner_revision,
        deleted_at,
        blocking_dependencies,
        cleanable_relations,
        binding_count: binding_ids.len(),
        file_ref_count: file_ref_ids.len(),
        metric_count,
        representative_relation_count: representative_relation_ids.len(),
        binding_ids,
        file_ref_ids,
        representative_relation_ids,
        physical_file_action_count: 0,
        state_digest,
    })
}

struct LifecycleLogDetails<'a> {
    previous_state: &'a str,
    new_state: &'a str,
    representative_cleanup_count: usize,
    binding_cleanup_count: usize,
    file_ref_cleanup_count: usize,
    preflight_correlation_id: Option<&'a str>,
}

fn write_log(
    transaction: &Transaction<'_>,
    input: &LifecycleMutationInput,
    operation: &str,
    details: LifecycleLogDetails<'_>,
) -> Result<String, String> {
    let log_id = format!("operation-log-{}", input.operation_id);
    let target =
        serde_json::json!({"entityType":input.owner_type,"entityId":input.owner_id}).to_string();
    let feedback = serde_json::json!({"status":"success","lifecycle":{
        "ownerType":input.owner_type,
        "ownerId":input.owner_id,
        "previousLifecycleState":details.previous_state,
        "newLifecycleState":details.new_state,
        "blockingDependencyCode":serde_json::Value::Null,
        "representativeCleanupCount":details.representative_cleanup_count,
        "bindingCleanupCount":details.binding_cleanup_count,
        "fileRefCleanupCount":details.file_ref_cleanup_count,
        "physicalFileActionCount":0,
        "correlationId":input.operation_id,
        "preflightCorrelationId":details.preflight_correlation_id
    }})
    .to_string();
    transaction.execute(
        "INSERT INTO operation_logs (id,operation_type,source,module,status,risk_level,target,summary,related_entities,feedback,warnings,errors,skipped,is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at,deleted_at) VALUES (?1,?2,'user','experiment','success','high',?3,?4,'[]',?5,'[]','[]','[]',0,'local-user','Local user','[\"experiment.changed\",\"experimentRun.changed\",\"fileRef.changed\",\"operationLog.changed\"]',1,?6,?6,NULL)",
        params![log_id, operation, target, format!("{} metadata lifecycle committed.", input.owner_type), feedback, input.occurred_at],
    ).map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    Ok(log_id)
}

fn mutate_owner(
    connection: &mut Connection,
    input: &LifecycleMutationInput,
    restore: bool,
) -> Result<LifecycleMutationResult, String> {
    let table = owner_table(&input.owner_type)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let exists: Option<Option<String>> = transaction
        .query_row(
            &format!("SELECT deleted_at FROM {table} WHERE id=?1"),
            [&input.owner_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let Some(deleted_at) = exists else {
        return Err(OWNER_NOT_FOUND.into());
    };
    if !restore && deleted_at.is_some() {
        transaction
            .rollback()
            .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
        return Ok(LifecycleMutationResult {
            status: "success".into(),
            owner_type: input.owner_type.clone(),
            owner_id: input.owner_id.clone(),
            changed: false,
            operation_log_id: None,
            physical_file_action_count: 0,
        });
    }
    if restore && deleted_at.is_none() {
        return Err(OWNER_NOT_DELETED.into());
    }
    let changed = if restore {
        transaction.execute(&format!("UPDATE {table} SET deleted_at=NULL,updated_at=?1 WHERE id=?2 AND deleted_at IS NOT NULL"), params![input.occurred_at,input.owner_id])
    } else {
        transaction.execute(&format!("UPDATE {table} SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND deleted_at IS NULL"), params![input.occurred_at,input.owner_id])
    }.map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    if changed != 1 {
        return Err(OWNER_CHANGED.into());
    }
    let log_id = write_log(
        &transaction,
        input,
        if restore { "restore" } else { "delete" },
        LifecycleLogDetails {
            previous_state: if restore { "deleted" } else { "active" },
            new_state: if restore { "active" } else { "deleted" },
            representative_cleanup_count: 0,
            binding_cleanup_count: 0,
            file_ref_cleanup_count: 0,
            preflight_correlation_id: None,
        },
    )?;
    transaction
        .commit()
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    Ok(LifecycleMutationResult {
        status: "success".into(),
        owner_type: input.owner_type.clone(),
        owner_id: input.owner_id.clone(),
        changed: true,
        operation_log_id: Some(log_id),
        physical_file_action_count: 0,
    })
}

fn validate_hard_delete_preflight(preflight: &LifecyclePreflight) -> Result<(), String> {
    if !preflight.deleted {
        return Err(OWNER_NOT_DELETED.into());
    }
    if preflight
        .blocking_dependencies
        .iter()
        .any(|item| item.kind == "runs")
    {
        return Err(RUNS_EXIST.into());
    }
    if preflight.metric_count > 0 {
        return Err(METRICS_EXIST.into());
    }
    if preflight.blocking_dependencies.iter().any(|item| {
        matches!(
            item.kind.as_str(),
            "resultItems"
                | "fileRefInboundReferences"
                | "outputSourceLinks"
                | "outputConversionRelations"
                | "literatureLinks"
        )
    }) {
        return Err(SOURCE_DEPS.into());
    }
    if !preflight.blocking_dependencies.is_empty() {
        return Err(BUSINESS_DEPS.into());
    }
    Ok(())
}

fn confirm_hard_delete_in_connection(
    connection: &mut Connection,
    input: &LifecycleMutationInput,
    expected_state_digest: &str,
    preflight_correlation_id: Option<&str>,
) -> Result<LifecycleMutationResult, String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let preflight = preflight_in_connection(&transaction, &input.owner_type, &input.owner_id)?;
    validate_hard_delete_preflight(&preflight)?;
    if preflight.state_digest != expected_state_digest {
        return Err(OWNER_CHANGED.into());
    }
    transaction
        .execute(
            if input.owner_type == "experiment" {
                "DELETE FROM experiment_representative_runs WHERE experiment_id=?1"
            } else {
                "DELETE FROM experiment_representative_runs WHERE run_id=?1"
            },
            [&input.owner_id],
        )
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    if input.owner_type == "experiment" {
        transaction
            .execute(
                "DELETE FROM experiment_manuscript_switch_recoveries
                 WHERE experiment_id=?1 AND phase IN ('resolved','cancelled_safe')",
                [&input.owner_id],
            )
            .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM manuscript_bindings WHERE owner_type=?1 AND owner_id=?2",
            params![input.owner_type, input.owner_id],
        )
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    transaction
        .execute(
            "DELETE FROM file_refs WHERE owner_type=?1 AND owner_id=?2",
            params![input.owner_type, input.owner_id],
        )
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    if input.owner_type == "experiment" {
        transaction
            .execute(
                "DELETE FROM manuscript_save_as_operations
                 WHERE owner_type='experiment' AND owner_id=?1 AND channel='primary'
                   AND stage IN ('completed','pre_d1_closed')",
                [&input.owner_id],
            )
            .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    }
    let table = owner_table(&input.owner_type)?;
    let changed = transaction
        .execute(
            &format!("DELETE FROM {table} WHERE id=?1 AND deleted_at IS NOT NULL"),
            [&input.owner_id],
        )
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    if changed != 1 {
        return Err(OWNER_CHANGED.into());
    }
    let log_id = write_log(
        &transaction,
        input,
        "hard_delete",
        LifecycleLogDetails {
            previous_state: "deleted",
            new_state: "hardDeleted",
            representative_cleanup_count: preflight.representative_relation_count,
            binding_cleanup_count: preflight.binding_count,
            file_ref_cleanup_count: preflight.file_ref_count,
            preflight_correlation_id,
        },
    )?;
    transaction
        .commit()
        .map_err(|error| format!("LIFECYCLE_TRANSACTION_FAILED: {error}"))?;
    let owner_remaining: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE id=?1"),
            [&input.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("{POST_COMMIT_VERIFY_FAILED}: {error}"))?;
    let representative_remaining: i64 = connection
        .query_row(
            if input.owner_type == "experiment" {
                "SELECT COUNT(*) FROM experiment_representative_runs WHERE experiment_id=?1"
            } else {
                "SELECT COUNT(*) FROM experiment_representative_runs WHERE run_id=?1"
            },
            [&input.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("{POST_COMMIT_VERIFY_FAILED}: {error}"))?;
    let binding_remaining: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM manuscript_bindings WHERE owner_type=?1 AND owner_id=?2",
            params![input.owner_type, input.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("{POST_COMMIT_VERIFY_FAILED}: {error}"))?;
    let file_ref_remaining: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM file_refs WHERE owner_type=?1 AND owner_id=?2",
            params![input.owner_type, input.owner_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("{POST_COMMIT_VERIFY_FAILED}: {error}"))?;
    let log_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE id=?1 AND status='success'",
            [&log_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("{POST_COMMIT_VERIFY_FAILED}: {error}"))?;
    if owner_remaining != 0
        || representative_remaining != 0
        || binding_remaining != 0
        || file_ref_remaining != 0
        || log_count != 1
    {
        return Err(POST_COMMIT_VERIFY_FAILED.into());
    }
    Ok(LifecycleMutationResult {
        status: "success".into(),
        owner_type: input.owner_type.clone(),
        owner_id: input.owner_id.clone(),
        changed: true,
        operation_log_id: Some(log_id),
        physical_file_action_count: 0,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_inspect_experiment_run_lifecycle(
    app_handle: AppHandle,
    input: LifecycleOwnerInput,
) -> Result<LifecyclePreflight, String> {
    let connection = open_connection(&app_handle)?;
    preflight_in_connection(&connection, &input.owner_type, &input.owner_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_issue_experiment_run_lifecycle_preflight_token(
    app_handle: AppHandle,
    token_store: State<'_, LifecycleTokenStore>,
    input: LifecycleTokenIssueInput,
) -> Result<LifecycleIssuedToken, String> {
    let connection = open_connection(&app_handle)?;
    let preflight = preflight_in_connection(&connection, &input.owner_type, &input.owner_id)?;
    validate_hard_delete_preflight(&preflight)?;
    if preflight.state_digest != input.expected_state_digest {
        return Err(OWNER_CHANGED.into());
    }
    token_store.issue(&input, preflight.state_digest, unix_time_ms()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_soft_delete_experiment_run_metadata(
    app_handle: AppHandle,
    input: LifecycleMutationInput,
) -> Result<LifecycleMutationResult, String> {
    let mut connection = open_connection(&app_handle)?;
    mutate_owner(&mut connection, &input, false)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_restore_experiment_run_metadata(
    app_handle: AppHandle,
    input: LifecycleMutationInput,
) -> Result<LifecycleMutationResult, String> {
    let mut connection = open_connection(&app_handle)?;
    mutate_owner(&mut connection, &input, true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_confirm_experiment_run_hard_metadata_delete(
    app_handle: AppHandle,
    token_store: State<'_, LifecycleTokenStore>,
    input: HardMetadataDeleteInput,
) -> Result<LifecycleMutationResult, String> {
    let token = token_store.consume(&input.preflight_token, unix_time_ms()?)?;
    let _client_evidence_binding = (&token.session_digest, &token.external_dependency_digest);
    let mut connection = open_connection(&app_handle)?;
    let mutation = LifecycleMutationInput {
        owner_type: token.owner_type,
        owner_id: token.owner_id,
        occurred_at: input.occurred_at,
        operation_id: input.operation_id,
    };
    confirm_hard_delete_in_connection(
        &mut connection,
        &mutation,
        &token.state_digest,
        Some(&input.preflight_token),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn setup() -> Connection {
        let connection = Connection::open_in_memory().expect("open lifecycle database");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable foreign keys");
        run_migrations(&connection).expect("migrate lifecycle database");
        connection
    }

    fn shared_database(label: &str) -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!(
            "labpod-e1-{label}-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let connection = Connection::open(&path).expect("open shared lifecycle database");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable foreign keys");
        run_migrations(&connection).expect("migrate shared lifecycle database");
        (path, connection)
    }

    fn open_shared(path: &PathBuf) -> Connection {
        let connection = Connection::open(path).expect("open lifecycle worker");
        connection
            .busy_timeout(Duration::from_secs(5))
            .expect("set worker timeout");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable worker foreign keys");
        connection
    }

    fn hard_input(
        owner_type: &str,
        owner_id: &str,
        occurred_at: &str,
        operation_id: &str,
    ) -> LifecycleMutationInput {
        LifecycleMutationInput {
            owner_type: owner_type.into(),
            owner_id: owner_id.into(),
            occurred_at: occurred_at.into(),
            operation_id: operation_id.into(),
        }
    }

    fn seed(connection: &Connection) {
        connection.execute_batch(
            "INSERT INTO experiments (id,project_id,title,purpose_and_question,status,tags,usable_for_paper,usable_for_report,usable_for_patent,schema_version,source,condition_items,method_steps,variables,materials,custom_fields,experiment_name,machine_object,fault_type,sensor_config,data_path,result_summary,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at,deleted_at) VALUES ('exp','project','Experiment','Purpose','planned','[]',0,0,0,2,'user','[]','[]','[]','[]','[]','Experiment','','unknown','','','', '2026-07-18','1200','experiment','2026-07-18T04:00:00Z','2026-07-18T04:00:00Z',NULL);
             INSERT INTO experiment_runs (id,experiment_id,project_id,title,status,tags,schema_version,source,condition_items,method_steps,variables,materials,custom_fields,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at,deleted_at) VALUES ('run','exp','project','Run','planned','[]',2,'user','[]','[]','[]','[]','[]','2026-07-18','1201','run','2026-07-18T04:01:00Z','2026-07-18T04:01:00Z',NULL);"
        ).expect("seed owners");
    }

    #[test]
    fn soft_delete_is_idempotent_and_restore_preserves_metadata_identity() {
        let mut connection = setup();
        seed(&connection);
        let before: (String,String,String) = connection.query_row("SELECT created_at,created_local_date,workspace_title_identity FROM experiment_runs WHERE id='run'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        let input = LifecycleMutationInput {
            owner_type: "experimentRun".into(),
            owner_id: "run".into(),
            occurred_at: "2026-07-18T05:00:00Z".into(),
            operation_id: "delete-run".into(),
        };
        assert!(
            mutate_owner(&mut connection, &input, false)
                .unwrap()
                .changed
        );
        assert!(
            !mutate_owner(&mut connection, &input, false)
                .unwrap()
                .changed
        );
        let restore = LifecycleMutationInput {
            occurred_at: "2026-07-18T06:00:00Z".into(),
            operation_id: "restore-run".into(),
            ..input
        };
        assert!(
            mutate_owner(&mut connection, &restore, true)
                .unwrap()
                .changed
        );
        let after: (String,String,String) = connection.query_row("SELECT created_at,created_local_date,workspace_title_identity FROM experiment_runs WHERE id='run'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(before, after);
        let logs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM operation_logs WHERE target LIKE '%run%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(logs, 2);
        let delete_feedback: String = connection
            .query_row(
                "SELECT feedback FROM operation_logs WHERE id='operation-log-delete-run'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let delete_feedback: serde_json::Value = serde_json::from_str(&delete_feedback).unwrap();
        assert_eq!(
            delete_feedback["lifecycle"]["previousLifecycleState"],
            "active"
        );
        assert_eq!(delete_feedback["lifecycle"]["newLifecycleState"], "deleted");
        assert_eq!(delete_feedback["lifecycle"]["bindingCleanupCount"], 0);
    }

    #[test]
    fn hard_run_delete_is_blocked_by_metric_then_cleans_only_owner_metadata() {
        let mut connection = setup();
        seed(&connection);
        connection.execute_batch("INSERT INTO result_metrics (id,run_id,name,value,tags,schema_version,source,custom_fields,created_at,updated_at,deleted_at) VALUES ('metric','run','m','1','[]',2,'user','[]','x','x',NULL); UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run';").unwrap();
        let blocked = preflight_in_connection(&connection, "experimentRun", "run").unwrap();
        assert_eq!(blocked.metric_count, 1);
        connection
            .execute("DELETE FROM result_metrics WHERE id='metric'", [])
            .unwrap();
        let ready = preflight_in_connection(&connection, "experimentRun", "run").unwrap();
        let state = ready.state_digest;
        let input = hard_input("experimentRun", "run", "2026-07-18T07:00:00Z", "hard-run");
        assert!(
            confirm_hard_delete_in_connection(&mut connection, &input, &state, None)
                .unwrap()
                .changed
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM experiments WHERE id='exp'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn hard_delete_preflight_blocks_inbound_result_item_file_ref_dependency() {
        let connection = setup();
        seed(&connection);
        connection.execute_batch(
            "INSERT INTO file_refs (id,owner_type,owner_id,manuscript_channel,file_type,path,path_identity_key,title,created_at,updated_at)
             VALUES ('run-file','experimentRun','run','primary','other','C:/run.txt','c:/run.txt','Run file','x','x');
             INSERT INTO result_items (id,project_id,source_type,source_id,title,result_type,status,structured_summary,file_ref_id,tags,schema_version,custom_fields,created_at,updated_at)
             VALUES ('external-result','project','task','task-outside','External result','other','pending_review','[]','run-file','[]',1,'[]','x','x');
             UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run';"
        ).unwrap();
        let preflight = preflight_in_connection(&connection, "experimentRun", "run").unwrap();
        assert_eq!(
            preflight
                .blocking_dependencies
                .iter()
                .find(|item| item.kind == "fileRefInboundReferences")
                .map(|item| item.count),
            Some(1)
        );
        assert_eq!(
            validate_hard_delete_preflight(&preflight).unwrap_err(),
            SOURCE_DEPS
        );
    }

    #[test]
    fn hard_delete_preflight_blocks_foreign_binding_file_ref_dependency() {
        let connection = setup();
        seed(&connection);
        connection.execute_batch(
            "INSERT INTO file_refs (id,owner_type,owner_id,manuscript_channel,file_type,path,path_identity_key,title,created_at,updated_at)
             VALUES ('run-file','experimentRun','run','primary','other','C:/run.txt','c:/run.txt','Run file','x','x');
             INSERT INTO manuscript_bindings (id,owner_type,owner_id,manuscript_channel,current_file_ref_id,created_at,updated_at)
             VALUES ('foreign-binding','review','review-outside','primary','run-file','x','x');
             UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run';"
        ).unwrap();
        let preflight = preflight_in_connection(&connection, "experimentRun", "run").unwrap();
        assert_eq!(
            preflight
                .blocking_dependencies
                .iter()
                .find(|item| item.kind == "fileRefInboundReferences")
                .map(|item| item.count),
            Some(1)
        );
        assert_eq!(
            validate_hard_delete_preflight(&preflight).unwrap_err(),
            SOURCE_DEPS
        );
    }

    #[test]
    fn rust_preflight_token_is_opaque_expiring_and_single_use() {
        let store = LifecycleTokenStore::default();
        let input = LifecycleTokenIssueInput {
            owner_type: "experimentRun".into(),
            owner_id: "run".into(),
            expected_state_digest: "state".into(),
            session_digest: "sessions".into(),
            external_dependency_digest: "links".into(),
        };
        let issued = store.issue(&input, "state".into(), 100).unwrap();
        assert_ne!(issued.preflight_token, "state");
        assert_eq!(
            store
                .consume(&issued.preflight_token, 101)
                .unwrap()
                .owner_id,
            "run"
        );
        assert_eq!(
            store.consume(&issued.preflight_token, 102).unwrap_err(),
            PREFLIGHT_CONSUMED
        );

        let expired = store.issue(&input, "state".into(), 200).unwrap();
        assert_eq!(
            store
                .consume(&expired.preflight_token, 200 + PREFLIGHT_TOKEN_TTL_MS + 1)
                .unwrap_err(),
            PREFLIGHT_EXPIRED
        );
        assert_eq!(
            store.consume(&expired.preflight_token, 201).unwrap_err(),
            PREFLIGHT_CONSUMED
        );
    }

    #[test]
    fn experiment_hard_delete_counts_deleted_runs_as_blockers() {
        let mut connection = setup();
        seed(&connection);
        connection.execute_batch("UPDATE experiments SET deleted_at='deleted' WHERE id='exp'; UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run';").unwrap();
        let preflight = preflight_in_connection(&connection, "experiment", "exp").unwrap();
        assert_eq!(
            preflight
                .blocking_dependencies
                .iter()
                .find(|item| item.kind == "runs")
                .map(|item| item.count),
            Some(1)
        );
        let state = preflight.state_digest;
        let input = hard_input("experiment", "exp", "2026-07-18T08:00:00Z", "hard-exp");
        assert_eq!(
            confirm_hard_delete_in_connection(&mut connection, &input, &state, None).unwrap_err(),
            RUNS_EXIST
        );
    }

    #[test]
    fn experiment_hard_delete_blocks_unresolved_save_as_and_formal_switch_recovery() {
        let connection = setup();
        seed(&connection);
        connection.execute_batch(
            r#"
            DELETE FROM experiment_runs WHERE id='run';
            UPDATE experiments SET deleted_at='deleted' WHERE id='exp';
            INSERT INTO manuscript_save_as_operations (
              operation_id,revision,operation_generation,producer_process_generation,
              owner_type,owner_id,channel,source_window_role,
              source_path_identity_key,source_revision,source_runtime_generation,
              snapshot_sha256,snapshot_byte_length,encoding_contract_version,newline_contract_version,
              target_display_path,target_path_identity_key,target_location_mode,
              target_parent_path_identity_key,target_parent_physical_identity_hash,
              stage,d1_commit_state,d2_commit_state,reconciliation_state,
              claim_token,claim_revision,claim_process_generation,created_at,updated_at
            ) VALUES (
              'save-as-pending',0,1,'process',
              'experiment','exp','primary','current',
              'source','source-revision',1,
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0,'utf-8-v1','none-v1',
              'C:/copy.md','c:/copy.md','external',
              'c:/','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              'pre_d1_claimed','not_started','not_started','not_required',
              'claim',0,'process','2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z'
            );
            INSERT INTO file_refs(id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,path_identity_key,file_type,path,title,source,custom_fields,created_at,updated_at)
            VALUES ('exp-old','experiment','exp','primary','file','manuscript','managed','old','markdown','C:/old.md','old','user','[]','x','x'),
                   ('exp-default','experiment','exp','primary','file','manuscript','managed','default','markdown','C:/default.md','default','user','[]','x','x'),
                   ('exp-target','experiment','exp','primary','file','manuscript','external','target','markdown','C:/target.md','target','user','[]','x','x');
            INSERT INTO manuscript_bindings(id,owner_type,owner_id,manuscript_channel,current_file_ref_id,default_manuscript_file_ref_id,created_at,updated_at)
            VALUES ('exp-binding','experiment','exp','primary','exp-old','exp-default','x','x');
            INSERT INTO experiment_manuscript_switch_recoveries(
              operation_id,owner_type,experiment_id,project_id,manuscript_channel,phase,binding_id,expected_owner_updated_at,expected_binding_updated_at,
              old_current_file_ref_id,old_current_file_ref_updated_at,old_current_path_identity,old_current_location_mode,
              default_file_ref_id,default_file_ref_updated_at,default_path_identity,default_location_mode,
              target_file_ref_id,target_file_ref_updated_at,target_path_identity,target_location_mode,
              outline_replacements_json,experiment_title_snapshot,project_title_snapshot,tags_json,deterministic_writeback_version,recorded_at,
              writeback_digest,writeback_byte_length,old_current_pre_revision,old_current_pre_digest,old_current_expected_post_digest,
              target_physical_revision,target_digest,target_byte_length,old_current_file_name,target_file_name,default_file_name,correlation_id,created_at,updated_at)
            VALUES ('switch-pending','experiment','exp','project','primary','prepared','exp-binding','x','x',
              'exp-old','x','old','managed','exp-default','x','default','managed','exp-target','x','target','external',
              '[]','Experiment','Project','[]',1,'x','digest',0,'pre','pre-digest','post-digest','target-rev','target-digest',0,
              'old.md','target.md','default.md','correlation','x','x');
            "#,
        ).unwrap();
        let preflight = preflight_in_connection(&connection, "experiment", "exp").unwrap();
        assert_eq!(
            preflight.blocking_dependencies.iter()
                .find(|item| item.kind == "experimentManuscriptSaveAsOperations")
                .map(|item| item.count),
            Some(1)
        );
        assert_eq!(
            preflight.blocking_dependencies.iter()
                .find(|item| item.kind == "experimentManuscriptSwitchRecoveries")
                .map(|item| item.count),
            Some(1)
        );
        assert_eq!(validate_hard_delete_preflight(&preflight).unwrap_err(), BUSINESS_DEPS);
    }

    #[test]
    fn hard_run_delete_cleans_binding_file_refs_and_representative_relation_atomically() {
        let mut connection = setup();
        seed(&connection);
        connection.execute_batch(
            "INSERT INTO file_refs (id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,location_mode,path_identity_key,file_type,path,title,schema_version,source,custom_fields,created_at,updated_at,deleted_at) VALUES ('folder','experimentRun','run','primary','folder','defaultFolder','managed','folder','folder','C:/data/run','folder',2,'user','[]','x','x',NULL),('manuscript','experimentRun','run','primary','file','manuscript','managed','file','markdown','C:/data/run/experiment-run.md','manuscript',2,'user','[]','x','x',NULL);
             INSERT INTO manuscript_bindings (id,owner_type,owner_id,manuscript_channel,default_folder_file_ref_id,default_manuscript_file_ref_id,current_file_ref_id,schema_version,created_at,updated_at,deleted_at) VALUES ('binding','experimentRun','run','primary','folder','manuscript','manuscript',1,'x','x',NULL);
             INSERT INTO experiment_representative_runs (id,experiment_id,run_id,sort_order,created_at,updated_at) VALUES ('representative','exp','run',0,'x','x');
             UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run';"
        ).unwrap();
        let ready = preflight_in_connection(&connection, "experimentRun", "run").unwrap();
        assert_eq!(
            (
                ready.binding_count,
                ready.file_ref_count,
                ready.representative_relation_count
            ),
            (1, 2, 1)
        );
        let state = ready.state_digest;
        let input = hard_input("experimentRun", "run", "2026-07-18T09:00:00Z", "hard-clean");
        confirm_hard_delete_in_connection(&mut connection, &input, &state, Some("preflight-token"))
            .unwrap();
        for table in [
            "experiment_runs",
            "manuscript_bindings",
            "file_refs",
            "experiment_representative_runs",
        ] {
            let remaining: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(remaining, 0, "{table}");
        }
        let feedback: String = connection
            .query_row(
                "SELECT feedback FROM operation_logs WHERE id='operation-log-hard-clean'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let feedback: serde_json::Value = serde_json::from_str(&feedback).unwrap();
        let lifecycle = &feedback["lifecycle"];
        assert_eq!(lifecycle["previousLifecycleState"], "deleted");
        assert_eq!(lifecycle["newLifecycleState"], "hardDeleted");
        assert_eq!(lifecycle["representativeCleanupCount"], 1);
        assert_eq!(lifecycle["bindingCleanupCount"], 1);
        assert_eq!(lifecycle["fileRefCleanupCount"], 2);
        assert_eq!(lifecycle["physicalFileActionCount"], 0);
        assert_eq!(lifecycle["preflightCorrelationId"], "preflight-token");
    }

    #[test]
    fn concurrent_soft_delete_has_one_log_and_one_noop_without_waiting() {
        let (path, anchor) = shared_database("soft-delete");
        seed(&anchor);
        let barrier = Arc::new(Barrier::new(3));
        let handles = ["a", "b"].map(|suffix| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let mut connection = open_shared(&path);
                barrier.wait();
                mutate_owner(
                    &mut connection,
                    &LifecycleMutationInput {
                        owner_type: "experimentRun".into(),
                        owner_id: "run".into(),
                        occurred_at: format!("2026-07-18T10:00:0{suffix}Z"),
                        operation_id: format!("delete-{suffix}"),
                    },
                    false,
                )
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap().unwrap());
        assert_eq!(results.iter().filter(|result| result.changed).count(), 1);
        assert_eq!(
            anchor
                .query_row(
                    "SELECT COUNT(*) FROM operation_logs WHERE operation_type='delete'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(anchor);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_hard_delete_and_metric_create_never_leave_an_orphan_metric() {
        let (path, anchor) = shared_database("hard-metric");
        seed(&anchor);
        anchor
            .execute(
                "UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run'",
                [],
            )
            .unwrap();
        let ready = preflight_in_connection(&anchor, "experimentRun", "run").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let hard = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let state = ready.state_digest.clone();
            thread::spawn(move || {
                let mut connection = open_shared(&path);
                barrier.wait();
                confirm_hard_delete_in_connection(
                    &mut connection,
                    &hard_input("experimentRun", "run", "2026-07-18T11:00:00Z", "hard-race"),
                    &state,
                    None,
                )
            })
        };
        let metric = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let connection = open_shared(&path);
                barrier.wait();
                connection.execute("INSERT INTO result_metrics (id,run_id,name,value,tags,schema_version,source,custom_fields,created_at,updated_at,deleted_at) VALUES ('race-metric','run','m','1','[]',2,'user','[]','x','x',NULL)", [])
            })
        };
        barrier.wait();
        let hard_result = hard.join().unwrap();
        let metric_result = metric.join().unwrap();
        assert!(
            hard_result.is_ok()
                || matches!(hard_result, Err(ref code) if code == METRICS_EXIST || code == OWNER_CHANGED)
        );
        if let Err(error) = metric_result {
            assert!(
                error.to_string().contains("FOREIGN KEY constraint failed"),
                "{error}"
            );
        }
        let orphan: i64 = anchor.query_row("SELECT COUNT(*) FROM result_metrics m LEFT JOIN experiment_runs r ON r.id=m.run_id WHERE r.id IS NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(orphan, 0);
        drop(anchor);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_restore_and_hard_delete_have_one_consistent_owner_outcome() {
        let (path, anchor) = shared_database("restore-hard");
        seed(&anchor);
        anchor
            .execute(
                "UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run'",
                [],
            )
            .unwrap();
        let ready = preflight_in_connection(&anchor, "experimentRun", "run").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let restore = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let mut connection = open_shared(&path);
                barrier.wait();
                mutate_owner(
                    &mut connection,
                    &LifecycleMutationInput {
                        owner_type: "experimentRun".into(),
                        owner_id: "run".into(),
                        occurred_at: "2026-07-18T12:00:00Z".into(),
                        operation_id: "restore-race".into(),
                    },
                    true,
                )
            })
        };
        let hard = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let state = ready.state_digest;
            thread::spawn(move || {
                let mut connection = open_shared(&path);
                barrier.wait();
                confirm_hard_delete_in_connection(
                    &mut connection,
                    &hard_input(
                        "experimentRun",
                        "run",
                        "2026-07-18T12:00:01Z",
                        "hard-restore-race",
                    ),
                    &state,
                    None,
                )
            })
        };
        barrier.wait();
        let restore_result = restore.join().unwrap();
        let hard_result = hard.join().unwrap();
        assert!(!(restore_result.is_ok() && hard_result.is_ok()));
        let owner_count: i64 = anchor
            .query_row(
                "SELECT COUNT(*) FROM experiment_runs WHERE id='run'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(owner_count == 0 || owner_count == 1);
        if owner_count == 1 {
            let deleted: Option<String> = anchor
                .query_row(
                    "SELECT deleted_at FROM experiment_runs WHERE id='run'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(deleted.is_none());
        }
        drop(anchor);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_hard_delete_and_representative_mutation_never_leave_orphan_relation() {
        let (path, anchor) = shared_database("hard-representative");
        seed(&anchor);
        anchor
            .execute(
                "UPDATE experiment_runs SET deleted_at='deleted' WHERE id='run'",
                [],
            )
            .unwrap();
        let ready = preflight_in_connection(&anchor, "experimentRun", "run").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let hard = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let state = ready.state_digest;
            thread::spawn(move || {
                let mut connection = open_shared(&path);
                barrier.wait();
                confirm_hard_delete_in_connection(
                    &mut connection,
                    &hard_input(
                        "experimentRun",
                        "run",
                        "2026-07-18T13:00:00Z",
                        "hard-representative",
                    ),
                    &state,
                    None,
                )
            })
        };
        let relation = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let connection = open_shared(&path);
                barrier.wait();
                connection.execute("INSERT INTO experiment_representative_runs (id,experiment_id,run_id,sort_order,created_at,updated_at) VALUES ('race-relation','exp','run',0,'x','x')",[])
            })
        };
        barrier.wait();
        let hard_result = hard.join().unwrap();
        let relation_result = relation.join().unwrap();
        assert!(hard_result.is_ok() || matches!(hard_result,Err(ref code) if code==OWNER_CHANGED));
        if let Err(error) = relation_result {
            assert!(
                error.to_string().contains("FOREIGN KEY constraint failed"),
                "{error}"
            );
        }
        let orphan:i64=anchor.query_row("SELECT COUNT(*) FROM experiment_representative_runs rr LEFT JOIN experiment_runs r ON r.id=rr.run_id WHERE r.id IS NULL",[],|row|row.get(0)).unwrap();
        assert_eq!(orphan, 0);
        drop(anchor);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_experiment_hard_delete_and_run_create_never_leave_orphan_run() {
        let (path, anchor) = shared_database("experiment-hard-run");
        seed(&anchor);
        anchor.execute_batch("DELETE FROM experiment_runs; UPDATE experiments SET deleted_at='deleted' WHERE id='exp';").unwrap();
        let ready = preflight_in_connection(&anchor, "experiment", "exp").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let hard = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let state = ready.state_digest;
            thread::spawn(move || {
                let mut connection = open_shared(&path);
                barrier.wait();
                confirm_hard_delete_in_connection(
                    &mut connection,
                    &hard_input(
                        "experiment",
                        "exp",
                        "2026-07-18T14:00:00Z",
                        "hard-experiment",
                    ),
                    &state,
                    None,
                )
            })
        };
        let run = {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let connection = open_shared(&path);
                barrier.wait();
                connection.execute("INSERT INTO experiment_runs (id,experiment_id,project_id,title,status,tags,schema_version,source,condition_items,method_steps,variables,materials,custom_fields,created_local_date,created_local_time,workspace_title_identity,created_at,updated_at,deleted_at) VALUES ('race-run','exp','project','Run','planned','[]',2,'user','[]','[]','[]','[]','[]','2026-07-18','1400','run','x','x',NULL)",[])
            })
        };
        barrier.wait();
        let hard_result = hard.join().unwrap();
        let run_result = run.join().unwrap();
        assert!(hard_result.is_ok() || matches!(hard_result,Err(ref code) if code==RUNS_EXIST));
        if let Err(error) = run_result {
            assert!(
                error.to_string().contains("FOREIGN KEY constraint failed"),
                "{error}"
            );
        }
        let orphan:i64=anchor.query_row("SELECT COUNT(*) FROM experiment_runs r LEFT JOIN experiments e ON e.id=r.experiment_id WHERE e.id IS NULL",[],|row|row.get(0)).unwrap();
        assert_eq!(orphan, 0);
        drop(anchor);
        std::fs::remove_file(path).unwrap();
    }
}
