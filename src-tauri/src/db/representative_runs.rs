use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use tauri::AppHandle;

const EXPERIMENT_NOT_FOUND: &str = "REPRESENTATIVE_EXPERIMENT_NOT_FOUND";
const EXPERIMENT_DELETED: &str = "REPRESENTATIVE_EXPERIMENT_DELETED";
const RUN_NOT_FOUND: &str = "REPRESENTATIVE_RUN_NOT_FOUND";
const RUN_DELETED: &str = "REPRESENTATIVE_RUN_DELETED";
const RUN_PARENT_MISMATCH: &str = "REPRESENTATIVE_RUN_PARENT_MISMATCH";
const RUN_PROJECT_MISMATCH: &str = "REPRESENTATIVE_RUN_PROJECT_MISMATCH";
const RUN_ALREADY_SELECTED: &str = "REPRESENTATIVE_RUN_ALREADY_SELECTED";
const RUN_RELATION_NOT_FOUND: &str = "REPRESENTATIVE_RUN_RELATION_NOT_FOUND";
const RUN_ORDER_INVALID: &str = "REPRESENTATIVE_RUN_ORDER_INVALID";
const RUN_DUPLICATE_ORDER_INPUT: &str = "REPRESENTATIVE_RUN_DUPLICATE_ORDER_INPUT";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepresentativeRunInput {
    pub relation_id: String,
    pub experiment_id: String,
    pub run_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRepresentativeRunInput {
    pub experiment_id: String,
    pub run_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRepresentativeRunOrderInput {
    pub experiment_id: String,
    pub ordered_run_ids: Vec<String>,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepresentativeRelationOwnerType {
    Experiment,
    ExperimentRun,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRepresentativeRunRelationsInput {
    pub owner_type: RepresentativeRelationOwnerType,
    pub owner_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepresentativeRunRelationRow {
    pub id: String,
    pub experiment_id: String,
    pub run_id: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepresentativeRunStructuredOutline {
    pub condition_summary: Option<String>,
    pub variable_parameter_summary: Option<String>,
    pub method_summary: Option<String>,
    pub result_summary: Option<String>,
    pub conclusion: Option<String>,
    pub summary_other: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepresentativeRunAggregateItem {
    pub relation_id: String,
    pub run_id: String,
    pub display_title: String,
    pub rating: Option<String>,
    pub sort_order: i64,
    pub structured_outline: RepresentativeRunStructuredOutline,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepresentativeRunAggregate {
    pub experiment_id: String,
    pub representative_run_count: usize,
    pub representative_runs: Vec<RepresentativeRunAggregateItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRepresentativeRunOrderResult {
    pub representative_runs: Vec<RepresentativeRunRelationRow>,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRepresentativeRunRelationsResult {
    pub removed_count: usize,
    pub relation_ids: Vec<String>,
    pub experiment_ids: Vec<String>,
    pub run_ids: Vec<String>,
}

fn database_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("REPRESENTATIVE_RUN_DATABASE_ERROR: {context}: {error}")
}

fn validate_experiment_active(
    connection: &Connection,
    experiment_id: &str,
) -> Result<String, String> {
    let experiment = connection
        .query_row(
            "SELECT project_id, deleted_at FROM experiments WHERE id = ?1",
            [experiment_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| database_error("validate Experiment", error))?;
    let Some((project_id, deleted_at)) = experiment else {
        return Err(EXPERIMENT_NOT_FOUND.to_string());
    };
    if deleted_at.is_some() {
        return Err(EXPERIMENT_DELETED.to_string());
    }
    Ok(project_id)
}

fn validate_run_for_experiment(
    connection: &Connection,
    experiment_id: &str,
    experiment_project_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let run = connection
        .query_row(
            "SELECT experiment_id, project_id, deleted_at FROM experiment_runs WHERE id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| database_error("validate ExperimentRun", error))?;
    let Some((run_experiment_id, run_project_id, deleted_at)) = run else {
        return Err(RUN_NOT_FOUND.to_string());
    };
    if deleted_at.is_some() {
        return Err(RUN_DELETED.to_string());
    }
    if run_experiment_id != experiment_id {
        return Err(RUN_PARENT_MISMATCH.to_string());
    }
    if run_project_id != experiment_project_id {
        return Err(RUN_PROJECT_MISMATCH.to_string());
    }
    super::assert_experiment_run_writable(connection, run_id).map_err(|error| {
        match error.as_str() {
            "EXPERIMENT_RUN_NOT_FOUND" => RUN_NOT_FOUND.to_string(),
            "EXPERIMENT_RUN_DELETED" => RUN_DELETED.to_string(),
            "EXPERIMENT_RUN_PROJECT_MISMATCH" => RUN_PROJECT_MISMATCH.to_string(),
            "EXPERIMENT_RUN_PARENT_DELETED" => EXPERIMENT_DELETED.to_string(),
            "EXPERIMENT_RUN_PARENT_NOT_FOUND" => EXPERIMENT_NOT_FOUND.to_string(),
            _ => error,
        }
    })
}

fn begin_immediate(connection: &mut Connection) -> Result<Transaction<'_>, String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| database_error("configure busy timeout", error))?;
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("begin immediate transaction", error))
}

fn relation_rows(
    connection: &Connection,
    experiment_id: &str,
) -> Result<Vec<RepresentativeRunRelationRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, experiment_id, run_id, sort_order, created_at, updated_at
             FROM experiment_representative_runs
             WHERE experiment_id = ?1
             ORDER BY sort_order ASC",
        )
        .map_err(|error| database_error("prepare relation list", error))?;
    let rows = statement
        .query_map([experiment_id], |row| {
            Ok(RepresentativeRunRelationRow {
                id: row.get(0)?,
                experiment_id: row.get(1)?,
                run_id: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| database_error("query relation list", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("collect relation list", error))?;
    Ok(rows)
}

fn rewrite_contiguous_order(
    transaction: &Transaction<'_>,
    experiment_id: &str,
    ordered_run_ids: &[String],
    occurred_at: &str,
) -> Result<(), String> {
    if ordered_run_ids.is_empty() {
        return Ok(());
    }
    let offset = ordered_run_ids.len() as i64 + 1;
    transaction
        .execute(
            "UPDATE experiment_representative_runs
             SET sort_order = sort_order + ?1, updated_at = ?2
             WHERE experiment_id = ?3",
            params![offset, occurred_at, experiment_id],
        )
        .map_err(|error| database_error("shift representative order", error))?;
    for (sort_order, run_id) in ordered_run_ids.iter().enumerate() {
        let changed = transaction
            .execute(
                "UPDATE experiment_representative_runs
                 SET sort_order = ?1, updated_at = ?2
                 WHERE experiment_id = ?3 AND run_id = ?4",
                params![sort_order as i64, occurred_at, experiment_id, run_id],
            )
            .map_err(|error| database_error("write representative order", error))?;
        if changed != 1 {
            return Err(RUN_ORDER_INVALID.to_string());
        }
    }
    Ok(())
}

pub(crate) fn list_representative_runs_in_connection(
    connection: &Connection,
    experiment_id: &str,
) -> Result<Vec<RepresentativeRunRelationRow>, String> {
    validate_experiment_active(connection, experiment_id)?;
    relation_rows(connection, experiment_id)
}

pub(crate) fn add_representative_run_in_connection(
    connection: &mut Connection,
    input: &AddRepresentativeRunInput,
) -> Result<RepresentativeRunRelationRow, String> {
    let transaction = begin_immediate(connection)?;
    let project_id = validate_experiment_active(&transaction, &input.experiment_id)?;
    validate_run_for_experiment(
        &transaction,
        &input.experiment_id,
        &project_id,
        &input.run_id,
    )?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM experiment_representative_runs
               WHERE experiment_id = ?1 AND run_id = ?2
             )",
            params![input.experiment_id, input.run_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("check representative duplicate", error))?;
    if exists {
        return Err(RUN_ALREADY_SELECTED.to_string());
    }
    let next_order: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM experiment_representative_runs WHERE experiment_id = ?1",
            [&input.experiment_id],
            |row| row.get(0),
        )
        .map_err(|error| database_error("resolve append order", error))?;
    transaction
        .execute(
            "INSERT INTO experiment_representative_runs (
               id, experiment_id, run_id, sort_order, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                input.relation_id,
                input.experiment_id,
                input.run_id,
                next_order,
                input.occurred_at,
            ],
        )
        .map_err(|error| database_error("insert representative relation", error))?;
    let row = transaction
        .query_row(
            "SELECT id, experiment_id, run_id, sort_order, created_at, updated_at
             FROM experiment_representative_runs WHERE id = ?1",
            [&input.relation_id],
            |row| {
                Ok(RepresentativeRunRelationRow {
                    id: row.get(0)?,
                    experiment_id: row.get(1)?,
                    run_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|error| database_error("read inserted representative relation", error))?;
    transaction
        .commit()
        .map_err(|error| database_error("commit representative add", error))?;
    Ok(row)
}

pub(crate) fn remove_representative_run_in_connection(
    connection: &mut Connection,
    input: &RemoveRepresentativeRunInput,
) -> Result<RepresentativeRunRelationRow, String> {
    let transaction = begin_immediate(connection)?;
    let project_id = validate_experiment_active(&transaction, &input.experiment_id)?;
    validate_run_for_experiment(
        &transaction,
        &input.experiment_id,
        &project_id,
        &input.run_id,
    )?;
    let relation = relation_rows(&transaction, &input.experiment_id)?
        .into_iter()
        .find(|row| row.run_id == input.run_id)
        .ok_or_else(|| RUN_RELATION_NOT_FOUND.to_string())?;
    transaction
        .execute(
            "DELETE FROM experiment_representative_runs
             WHERE experiment_id = ?1 AND run_id = ?2",
            params![input.experiment_id, input.run_id],
        )
        .map_err(|error| database_error("remove representative relation", error))?;
    let remaining = relation_rows(&transaction, &input.experiment_id)?
        .into_iter()
        .map(|row| row.run_id)
        .collect::<Vec<_>>();
    rewrite_contiguous_order(
        &transaction,
        &input.experiment_id,
        &remaining,
        &input.occurred_at,
    )?;
    transaction
        .commit()
        .map_err(|error| database_error("commit representative remove", error))?;
    Ok(relation)
}

pub(crate) fn set_representative_run_order_in_connection(
    connection: &mut Connection,
    input: &SetRepresentativeRunOrderInput,
) -> Result<SetRepresentativeRunOrderResult, String> {
    let transaction = begin_immediate(connection)?;
    let project_id = validate_experiment_active(&transaction, &input.experiment_id)?;
    let unique = input.ordered_run_ids.iter().collect::<HashSet<_>>();
    if unique.len() != input.ordered_run_ids.len() {
        return Err(RUN_DUPLICATE_ORDER_INPUT.to_string());
    }
    let current = relation_rows(&transaction, &input.experiment_id)?;
    let current_ids = current
        .iter()
        .map(|row| row.run_id.as_str())
        .collect::<HashSet<_>>();
    let requested_ids = input
        .ordered_run_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if current_ids != requested_ids || current.len() != input.ordered_run_ids.len() {
        return Err(RUN_ORDER_INVALID.to_string());
    }
    for run_id in &input.ordered_run_ids {
        validate_run_for_experiment(&transaction, &input.experiment_id, &project_id, run_id)?;
    }
    let current_order = current
        .iter()
        .map(|row| row.run_id.as_str())
        .collect::<Vec<_>>();
    let requested_order = input
        .ordered_run_ids
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if current_order == requested_order {
        transaction
            .commit()
            .map_err(|error| database_error("commit representative no-op reorder", error))?;
        return Ok(SetRepresentativeRunOrderResult {
            representative_runs: current,
            changed: false,
        });
    }
    rewrite_contiguous_order(
        &transaction,
        &input.experiment_id,
        &input.ordered_run_ids,
        &input.occurred_at,
    )?;
    let rows = relation_rows(&transaction, &input.experiment_id)?;
    transaction
        .commit()
        .map_err(|error| database_error("commit representative reorder", error))?;
    Ok(SetRepresentativeRunOrderResult {
        representative_runs: rows,
        changed: true,
    })
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let normalized = value.trim().to_string();
        (!normalized.is_empty()).then_some(normalized)
    })
}

pub(crate) fn get_representative_run_aggregate_in_connection(
    connection: &Connection,
    experiment_id: &str,
) -> Result<RepresentativeRunAggregate, String> {
    validate_experiment_active(connection, experiment_id)?;
    let mut statement = connection
        .prepare(
            "SELECT relation.id, run.id, run.title, run.rating, relation.sort_order,
                    run.condition_summary, run.variable_parameter_summary,
                    run.method_summary, run.result_summary, run.conclusion, run.summary_other
             FROM experiment_representative_runs AS relation
             JOIN experiment_runs AS run ON run.id = relation.run_id
             WHERE relation.experiment_id = ?1 AND run.deleted_at IS NULL
             ORDER BY relation.sort_order ASC",
        )
        .map_err(|error| database_error("prepare representative aggregate", error))?;
    let representative_runs = statement
        .query_map([experiment_id], |row| {
            let title: String = row.get(2)?;
            Ok(RepresentativeRunAggregateItem {
                relation_id: row.get(0)?,
                run_id: row.get(1)?,
                display_title: title.trim().to_string(),
                rating: normalize_optional(row.get(3)?),
                sort_order: row.get(4)?,
                structured_outline: RepresentativeRunStructuredOutline {
                    condition_summary: normalize_optional(row.get(5)?),
                    variable_parameter_summary: normalize_optional(row.get(6)?),
                    method_summary: normalize_optional(row.get(7)?),
                    result_summary: normalize_optional(row.get(8)?),
                    conclusion: normalize_optional(row.get(9)?),
                    summary_other: normalize_optional(row.get(10)?),
                },
            })
        })
        .map_err(|error| database_error("query representative aggregate", error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database_error("collect representative aggregate", error))?;
    Ok(RepresentativeRunAggregate {
        experiment_id: experiment_id.to_string(),
        representative_run_count: representative_runs.len(),
        representative_runs,
    })
}

pub(crate) fn cleanup_representative_run_relations_in_connection(
    connection: &mut Connection,
    input: &CleanupRepresentativeRunRelationsInput,
) -> Result<CleanupRepresentativeRunRelationsResult, String> {
    let transaction = begin_immediate(connection)?;
    let (sql, owner_id) = match input.owner_type {
        RepresentativeRelationOwnerType::Experiment => (
            "SELECT id, experiment_id, run_id FROM experiment_representative_runs WHERE experiment_id = ?1 ORDER BY sort_order",
            input.owner_id.as_str(),
        ),
        RepresentativeRelationOwnerType::ExperimentRun => (
            "SELECT id, experiment_id, run_id FROM experiment_representative_runs WHERE run_id = ?1 ORDER BY experiment_id, sort_order",
            input.owner_id.as_str(),
        ),
    };
    let affected = {
        let mut statement = transaction
            .prepare(sql)
            .map_err(|error| database_error("prepare representative cleanup", error))?;
        let rows = statement
            .query_map([owner_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| database_error("query representative cleanup", error))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| database_error("collect representative cleanup", error))?;
        rows
    };
    match input.owner_type {
        RepresentativeRelationOwnerType::Experiment => {
            transaction
                .execute(
                    "DELETE FROM experiment_representative_runs WHERE experiment_id = ?1",
                    [&input.owner_id],
                )
                .map_err(|error| database_error("cleanup Experiment relations", error))?;
        }
        RepresentativeRelationOwnerType::ExperimentRun => {
            transaction
                .execute(
                    "DELETE FROM experiment_representative_runs WHERE run_id = ?1",
                    [&input.owner_id],
                )
                .map_err(|error| database_error("cleanup ExperimentRun relations", error))?;
            let experiment_ids = affected
                .iter()
                .map(|(_, experiment_id, _)| experiment_id.clone())
                .collect::<HashSet<_>>();
            for experiment_id in experiment_ids {
                let remaining = relation_rows(&transaction, &experiment_id)?
                    .into_iter()
                    .map(|row| row.run_id)
                    .collect::<Vec<_>>();
                rewrite_contiguous_order(
                    &transaction,
                    &experiment_id,
                    &remaining,
                    &input.occurred_at,
                )?;
            }
        }
    }
    let result = CleanupRepresentativeRunRelationsResult {
        removed_count: affected.len(),
        relation_ids: affected.iter().map(|(id, _, _)| id.clone()).collect(),
        experiment_ids: affected
            .iter()
            .map(|(_, id, _)| id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect(),
        run_ids: affected
            .iter()
            .map(|(_, _, id)| id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect(),
    };
    transaction
        .commit()
        .map_err(|error| database_error("commit representative cleanup", error))?;
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_list_representative_runs(
    app_handle: AppHandle,
    experiment_id: String,
) -> Result<Vec<RepresentativeRunRelationRow>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_representative_runs_in_connection(&connection, &experiment_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_add_representative_run(
    app_handle: AppHandle,
    input: AddRepresentativeRunInput,
) -> Result<RepresentativeRunRelationRow, String> {
    let mut connection = super::open_connection(&app_handle)?;
    add_representative_run_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_remove_representative_run(
    app_handle: AppHandle,
    input: RemoveRepresentativeRunInput,
) -> Result<RepresentativeRunRelationRow, String> {
    let mut connection = super::open_connection(&app_handle)?;
    remove_representative_run_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_set_representative_run_order(
    app_handle: AppHandle,
    input: SetRepresentativeRunOrderInput,
) -> Result<SetRepresentativeRunOrderResult, String> {
    let mut connection = super::open_connection(&app_handle)?;
    set_representative_run_order_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_get_representative_run_aggregate(
    app_handle: AppHandle,
    experiment_id: String,
) -> Result<RepresentativeRunAggregate, String> {
    let connection = super::open_connection(&app_handle)?;
    get_representative_run_aggregate_in_connection(&connection, &experiment_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_cleanup_representative_run_relations(
    app_handle: AppHandle,
    input: CleanupRepresentativeRunRelationsInput,
) -> Result<CleanupRepresentativeRunRelationsResult, String> {
    let mut connection = super::open_connection(&app_handle)?;
    cleanup_representative_run_relations_in_connection(&mut connection, &input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn setup() -> Connection {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        schema::run_migrations(&connection).expect("migrate database");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary, created_local_date,
                   created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES
                   ('experiment-a', 'project-a', 'A', '', 'unknown', '', '', '',
                    '2026-07-17', '0900', 'experiment-a', '2026-07-17T01:00:00Z', '2026-07-17T01:00:00Z'),
                   ('experiment-b', 'project-a', 'B', '', 'unknown', '', '', '',
                    '2026-07-17', '0901', 'experiment-b', '2026-07-17T01:01:00Z', '2026-07-17T01:01:00Z');
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, run_label, status,
                   condition_summary, variable_parameter_summary, method_summary,
                   result_summary, conclusion, summary_other, rating, tags,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES
                   ('run-a1', 'experiment-a', 'project-a', '  Run A1  ', 'A1', 'completed',
                    '  条件 α  ', '', '  方法 A  ', '  结果 A  ', '  结论 A  ', '  其他 A  ',
                    'high', '[\"tag\"]', '2026-07-17', '0910', 'run-a1', '2026-07-17T01:10:00Z', '2026-07-17T01:10:00Z'),
                   ('run-a2', 'experiment-a', 'project-a', 'Run A2', 'A2', 'draft',
                    '', '  参数 β  ', '', '', '', '', 'low', '[]',
                     '2026-07-17', '0920', 'run-a2', '2026-07-17T01:20:00Z', '2026-07-17T01:20:00Z'),
                   ('run-b1', 'experiment-b', 'project-a', 'Run B1', 'B1', 'completed',
                    '', '', '', '', '', '', 'high', '[]',
                     '2026-07-17', '0930', 'run-b1', '2026-07-17T01:30:00Z', '2026-07-17T01:30:00Z');",
            )
            .expect("seed experiments and runs");
        connection
    }

    fn add_input(relation_id: &str, run_id: &str) -> AddRepresentativeRunInput {
        AddRepresentativeRunInput {
            relation_id: relation_id.to_string(),
            experiment_id: "experiment-a".to_string(),
            run_id: run_id.to_string(),
            occurred_at: "2026-07-17T02:00:00Z".to_string(),
        }
    }

    fn setup_file(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "labpod-representative-runs-{label}-{}-{nonce}.sqlite3",
            std::process::id()
        ));
        let connection = Connection::open(&path).expect("open file database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        schema::run_migrations(&connection).expect("migrate file database");
        connection
            .execute_batch(
                "INSERT INTO experiments (
                   id, project_id, experiment_name, machine_object, fault_type,
                   sensor_config, data_path, result_summary, created_local_date,
                   created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES ('experiment-a', 'project-a', 'A', '', 'unknown', '', '', '',
                   '2026-07-17', '0900', 'experiment-a', '2026-07-17T01:00:00Z', '2026-07-17T01:00:00Z');
                 INSERT INTO experiment_runs (
                   id, experiment_id, project_id, title, run_label, status,
                   condition_summary, variable_parameter_summary, method_summary,
                   result_summary, conclusion, summary_other, rating, tags,
                   created_local_date, created_local_time, workspace_title_identity, created_at, updated_at
                 ) VALUES
                   ('run-a1', 'experiment-a', 'project-a', 'Run A1', 'A1', 'completed',
                    '', '', '', '', '', '', 'high', '[]', '2026-07-17', '0910', 'run-a1',
                    '2026-07-17T01:10:00Z', '2026-07-17T01:10:00Z'),
                   ('run-a2', 'experiment-a', 'project-a', 'Run A2', 'A2', 'draft',
                    '', '', '', '', '', '', 'low', '[]', '2026-07-17', '0920', 'run-a2',
                    '2026-07-17T01:20:00Z', '2026-07-17T01:20:00Z');",
            )
            .expect("seed file database");
        drop(connection);
        path
    }

    fn open_file(path: &PathBuf) -> Connection {
        let connection = Connection::open(path).expect("open concurrent connection");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable concurrent foreign keys");
        connection
    }

    fn assert_contiguous(path: &PathBuf) {
        let connection = open_file(path);
        let orders = relation_rows(&connection, "experiment-a")
            .expect("read final relation order")
            .into_iter()
            .map(|row| row.sort_order)
            .collect::<Vec<_>>();
        assert_eq!(orders, (0..orders.len() as i64).collect::<Vec<_>>());
        let unique_count: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT run_id) FROM experiment_representative_runs",
                [],
                |row| row.get(0),
            )
            .expect("count unique runs");
        assert_eq!(unique_count as usize, orders.len());
    }

    #[test]
    fn add_list_remove_and_reorder_are_explicit_and_contiguous() {
        let mut connection = setup();
        add_representative_run_in_connection(&mut connection, &add_input("rel-a1", "run-a1"))
            .expect("add first run");
        add_representative_run_in_connection(&mut connection, &add_input("rel-a2", "run-a2"))
            .expect("add second run");
        let rows = list_representative_runs_in_connection(&connection, "experiment-a")
            .expect("list relations");
        assert_eq!(
            rows.iter()
                .map(|row| (&row.run_id, row.sort_order))
                .collect::<Vec<_>>(),
            vec![(&"run-a1".to_string(), 0), (&"run-a2".to_string(), 1)]
        );

        set_representative_run_order_in_connection(
            &mut connection,
            &SetRepresentativeRunOrderInput {
                experiment_id: "experiment-a".to_string(),
                ordered_run_ids: vec!["run-a2".to_string(), "run-a1".to_string()],
                occurred_at: "2026-07-17T02:10:00Z".to_string(),
            },
        )
        .expect("reorder relations");
        let unchanged = set_representative_run_order_in_connection(
            &mut connection,
            &SetRepresentativeRunOrderInput {
                experiment_id: "experiment-a".to_string(),
                ordered_run_ids: vec!["run-a2".to_string(), "run-a1".to_string()],
                occurred_at: "2026-07-17T02:11:00Z".to_string(),
            },
        )
        .expect("accept no-op order");
        assert!(!unchanged.changed);
        remove_representative_run_in_connection(
            &mut connection,
            &RemoveRepresentativeRunInput {
                experiment_id: "experiment-a".to_string(),
                run_id: "run-a2".to_string(),
                occurred_at: "2026-07-17T02:20:00Z".to_string(),
            },
        )
        .expect("remove first relation");
        let rows = list_representative_runs_in_connection(&connection, "experiment-a")
            .expect("list compacted relations");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].run_id, "run-a1");
        assert_eq!(rows[0].sort_order, 0);
    }

    #[test]
    fn relation_writes_reject_duplicate_parent_mismatch_and_invalid_order() {
        let mut connection = setup();
        add_representative_run_in_connection(&mut connection, &add_input("rel-a1", "run-a1"))
            .expect("add relation");
        assert_eq!(
            add_representative_run_in_connection(&mut connection, &add_input("rel-copy", "run-a1"))
                .unwrap_err(),
            "REPRESENTATIVE_RUN_ALREADY_SELECTED"
        );
        assert_eq!(
            add_representative_run_in_connection(&mut connection, &add_input("rel-b1", "run-b1"))
                .unwrap_err(),
            "REPRESENTATIVE_RUN_PARENT_MISMATCH"
        );
        assert_eq!(
            set_representative_run_order_in_connection(
                &mut connection,
                &SetRepresentativeRunOrderInput {
                    experiment_id: "experiment-a".to_string(),
                    ordered_run_ids: vec![],
                    occurred_at: "2026-07-17T02:10:00Z".to_string(),
                },
            )
            .unwrap_err(),
            "REPRESENTATIVE_RUN_ORDER_INVALID"
        );
        assert_eq!(
            set_representative_run_order_in_connection(
                &mut connection,
                &SetRepresentativeRunOrderInput {
                    experiment_id: "experiment-a".to_string(),
                    ordered_run_ids: vec!["run-a1".to_string(), "run-a1".to_string()],
                    occurred_at: "2026-07-17T02:11:00Z".to_string(),
                },
            )
            .unwrap_err(),
            "REPRESENTATIVE_RUN_DUPLICATE_ORDER_INPUT"
        );
        assert_eq!(
            add_representative_run_in_connection(
                &mut connection,
                &AddRepresentativeRunInput {
                    relation_id: "rel-missing-experiment".to_string(),
                    experiment_id: "missing-experiment".to_string(),
                    run_id: "run-a2".to_string(),
                    occurred_at: "2026-07-17T02:12:00Z".to_string(),
                },
            )
            .unwrap_err(),
            "REPRESENTATIVE_EXPERIMENT_NOT_FOUND"
        );
        assert_eq!(
            add_representative_run_in_connection(
                &mut connection,
                &add_input("rel-missing-run", "missing-run")
            )
            .unwrap_err(),
            "REPRESENTATIVE_RUN_NOT_FOUND"
        );
        assert_eq!(
            remove_representative_run_in_connection(
                &mut connection,
                &RemoveRepresentativeRunInput {
                    experiment_id: "experiment-a".to_string(),
                    run_id: "run-a2".to_string(),
                    occurred_at: "2026-07-17T02:13:00Z".to_string(),
                },
            )
            .unwrap_err(),
            "REPRESENTATIVE_RUN_RELATION_NOT_FOUND"
        );
        connection
            .execute("UPDATE experiment_runs SET deleted_at = '2026-07-17T02:14:00Z' WHERE id = 'run-a2'", [])
            .expect("soft delete candidate Run");
        assert_eq!(
            add_representative_run_in_connection(
                &mut connection,
                &add_input("rel-deleted-run", "run-a2")
            )
            .unwrap_err(),
            "REPRESENTATIVE_RUN_DELETED"
        );
        connection
            .execute("UPDATE experiment_runs SET deleted_at = NULL, project_id = 'project-other' WHERE id = 'run-a2'", [])
            .expect("create project mismatch");
        assert_eq!(
            add_representative_run_in_connection(
                &mut connection,
                &add_input("rel-project-mismatch", "run-a2")
            )
            .unwrap_err(),
            "REPRESENTATIVE_RUN_PROJECT_MISMATCH"
        );
        connection
            .execute(
                "UPDATE experiment_runs SET project_id = 'project-a' WHERE id = 'run-a2'",
                [],
            )
            .expect("restore project consistency");
        connection
            .execute("UPDATE experiments SET deleted_at = '2026-07-17T03:00:00Z' WHERE id = 'experiment-a'", [])
            .expect("soft delete Experiment");
        assert_eq!(
            get_representative_run_aggregate_in_connection(&connection, "experiment-a")
                .unwrap_err(),
            "REPRESENTATIVE_EXPERIMENT_DELETED"
        );
    }

    #[test]
    fn aggregate_is_whitelisted_normalized_status_independent_and_soft_delete_aware() {
        let mut connection = setup();
        add_representative_run_in_connection(&mut connection, &add_input("rel-a1", "run-a1"))
            .expect("add relation");
        add_representative_run_in_connection(&mut connection, &add_input("rel-a2", "run-a2"))
            .expect("add draft relation");

        let aggregate = get_representative_run_aggregate_in_connection(&connection, "experiment-a")
            .expect("read aggregate");
        assert_eq!(aggregate.representative_run_count, 2);
        assert_eq!(aggregate.representative_runs[0].display_title, "Run A1");
        assert_eq!(
            aggregate.representative_runs[0]
                .structured_outline
                .condition_summary
                .as_deref(),
            Some("条件 α")
        );
        assert_eq!(
            aggregate.representative_runs[0]
                .structured_outline
                .variable_parameter_summary,
            None
        );
        assert_eq!(
            aggregate.representative_runs[1].rating.as_deref(),
            Some("low")
        );

        connection.execute("UPDATE experiment_runs SET deleted_at = '2026-07-17T03:00:00Z' WHERE id = 'run-a1'", []).expect("soft delete run");
        let paused = get_representative_run_aggregate_in_connection(&connection, "experiment-a")
            .expect("read paused aggregate");
        assert_eq!(
            paused
                .representative_runs
                .iter()
                .map(|row| row.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["run-a2"]
        );
        let retained = list_representative_runs_in_connection(&connection, "experiment-a")
            .expect("list retained relation");
        assert_eq!(retained.len(), 2);
        connection
            .execute(
                "UPDATE experiment_runs SET deleted_at = NULL WHERE id = 'run-a1'",
                [],
            )
            .expect("restore run");
        let restored = get_representative_run_aggregate_in_connection(&connection, "experiment-a")
            .expect("read restored aggregate");
        assert_eq!(restored.representative_runs[0].run_id, "run-a1");
    }

    #[test]
    fn lifecycle_cleanup_bypasses_deleted_guard_and_only_removes_metadata() {
        let mut connection = setup();
        add_representative_run_in_connection(&mut connection, &add_input("rel-a1", "run-a1"))
            .expect("add relation");
        connection.execute("UPDATE experiment_runs SET deleted_at = '2026-07-17T03:00:00Z' WHERE id = 'run-a1'", []).expect("soft delete run");
        let result = cleanup_representative_run_relations_in_connection(
            &mut connection,
            &CleanupRepresentativeRunRelationsInput {
                owner_type: RepresentativeRelationOwnerType::ExperimentRun,
                owner_id: "run-a1".to_string(),
                occurred_at: "2026-07-17T03:10:00Z".to_string(),
            },
        )
        .expect("cleanup relation metadata");
        assert_eq!(result.removed_count, 1);
        assert!(
            list_representative_runs_in_connection(&connection, "experiment-a")
                .expect("list after cleanup")
                .is_empty()
        );
        let run_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM experiment_runs WHERE id = 'run-a1'",
                [],
                |row| row.get(0),
            )
            .expect("count run");
        assert_eq!(run_count, 1);
    }

    #[test]
    fn hard_database_deletes_cascade_only_relation_metadata() {
        let mut connection = setup();
        add_representative_run_in_connection(&mut connection, &add_input("rel-a1", "run-a1"))
            .expect("add relation");
        add_representative_run_in_connection(&mut connection, &add_input("rel-a2", "run-a2"))
            .expect("add second relation");
        connection
            .execute("DELETE FROM experiment_runs WHERE id = 'run-a1'", [])
            .expect("hard delete run metadata");
        let relation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM experiment_representative_runs",
                [],
                |row| row.get(0),
            )
            .expect("count cascaded relations");
        assert_eq!(relation_count, 1);
        let remaining_order: i64 = connection
            .query_row(
                "SELECT sort_order FROM experiment_representative_runs WHERE run_id = 'run-a2'",
                [],
                |row| row.get(0),
            )
            .expect("read compacted cascaded relation");
        assert_eq!(remaining_order, 0);
        let experiment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM experiments WHERE id = 'experiment-a'",
                [],
                |row| row.get(0),
            )
            .expect("count retained Experiment");
        assert_eq!(experiment_count, 1);
    }

    #[test]
    fn reorder_failure_rolls_back_every_sort_position() {
        let mut connection = setup();
        add_representative_run_in_connection(&mut connection, &add_input("rel-a1", "run-a1"))
            .expect("add first relation");
        add_representative_run_in_connection(&mut connection, &add_input("rel-a2", "run-a2"))
            .expect("add second relation");
        connection
            .execute_batch(
                "CREATE TRIGGER force_representative_reorder_failure
                 BEFORE UPDATE OF sort_order ON experiment_representative_runs
                 WHEN NEW.run_id = 'run-a1' AND NEW.sort_order = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced representative reorder failure');
                 END;",
            )
            .expect("install rollback trigger");
        let error = set_representative_run_order_in_connection(
            &mut connection,
            &SetRepresentativeRunOrderInput {
                experiment_id: "experiment-a".to_string(),
                ordered_run_ids: vec!["run-a2".to_string(), "run-a1".to_string()],
                occurred_at: "2026-07-17T03:30:00Z".to_string(),
            },
        )
        .expect_err("forced failure rolls back reorder");
        assert!(
            error.starts_with("REPRESENTATIVE_RUN_DATABASE_ERROR:"),
            "{error}"
        );
        let order = relation_rows(&connection, "experiment-a")
            .expect("read rolled-back order")
            .into_iter()
            .map(|row| (row.run_id, row.sort_order))
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            vec![("run-a1".to_string(), 0), ("run-a2".to_string(), 1)]
        );
    }

    #[test]
    fn concurrent_add_order_remove_and_cleanup_keep_unique_contiguous_state() {
        let same_path = setup_file("same-add");
        let same_barrier = Arc::new(Barrier::new(3));
        let same_handles = ["same-1", "same-2"].map(|relation_id| {
            let path = same_path.clone();
            let barrier = Arc::clone(&same_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                add_representative_run_in_connection(
                    &mut connection,
                    &AddRepresentativeRunInput {
                        relation_id: relation_id.to_string(),
                        experiment_id: "experiment-a".to_string(),
                        run_id: "run-a1".to_string(),
                        occurred_at: "2026-07-17T04:00:00Z".to_string(),
                    },
                )
            })
        });
        same_barrier.wait();
        let same_results = same_handles.map(|handle| handle.join().expect("join same-add worker"));
        assert_eq!(
            same_results.iter().filter(|result| result.is_ok()).count(),
            1
        );
        assert_eq!(
            same_results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.as_str() == RUN_ALREADY_SELECTED)
                .count(),
            1
        );
        assert_contiguous(&same_path);
        std::fs::remove_file(&same_path).expect("remove same-add database");

        let different_path = setup_file("different-add");
        let different_barrier = Arc::new(Barrier::new(3));
        let different_handles =
            [("different-1", "run-a1"), ("different-2", "run-a2")].map(|(relation_id, run_id)| {
                let path = different_path.clone();
                let barrier = Arc::clone(&different_barrier);
                thread::spawn(move || {
                    let mut connection = open_file(&path);
                    barrier.wait();
                    add_representative_run_in_connection(
                        &mut connection,
                        &AddRepresentativeRunInput {
                            relation_id: relation_id.to_string(),
                            experiment_id: "experiment-a".to_string(),
                            run_id: run_id.to_string(),
                            occurred_at: "2026-07-17T04:10:00Z".to_string(),
                        },
                    )
                })
            });
        different_barrier.wait();
        for handle in different_handles {
            handle
                .join()
                .expect("join different-add worker")
                .expect("different add succeeds");
        }
        assert_contiguous(&different_path);
        std::fs::remove_file(&different_path).expect("remove different-add database");

        let order_path = setup_file("add-order");
        {
            let mut connection = open_file(&order_path);
            add_representative_run_in_connection(&mut connection, &add_input("order-a1", "run-a1"))
                .expect("seed representative relation");
        }
        let order_barrier = Arc::new(Barrier::new(3));
        let add_handle = {
            let path = order_path.clone();
            let barrier = Arc::clone(&order_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                add_representative_run_in_connection(
                    &mut connection,
                    &add_input("order-a2", "run-a2"),
                )
                .map(|_| ())
            })
        };
        let reorder_handle = {
            let path = order_path.clone();
            let barrier = Arc::clone(&order_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                set_representative_run_order_in_connection(
                    &mut connection,
                    &SetRepresentativeRunOrderInput {
                        experiment_id: "experiment-a".to_string(),
                        ordered_run_ids: vec!["run-a1".to_string()],
                        occurred_at: "2026-07-17T04:20:00Z".to_string(),
                    },
                )
                .map(|_| ())
            })
        };
        order_barrier.wait();
        add_handle
            .join()
            .expect("join add worker")
            .expect("add succeeds");
        let reorder_result = reorder_handle.join().expect("join reorder worker");
        assert!(
            reorder_result.is_ok()
                || matches!(reorder_result, Err(ref error) if error == RUN_ORDER_INVALID)
        );
        assert_contiguous(&order_path);
        std::fs::remove_file(&order_path).expect("remove add-order database");

        let remove_path = setup_file("remove-order");
        {
            let mut connection = open_file(&remove_path);
            add_representative_run_in_connection(
                &mut connection,
                &add_input("remove-a1", "run-a1"),
            )
            .expect("seed first remove-order relation");
            add_representative_run_in_connection(
                &mut connection,
                &add_input("remove-a2", "run-a2"),
            )
            .expect("seed second remove-order relation");
        }
        let remove_barrier = Arc::new(Barrier::new(3));
        let remove_handle = {
            let path = remove_path.clone();
            let barrier = Arc::clone(&remove_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                remove_representative_run_in_connection(
                    &mut connection,
                    &RemoveRepresentativeRunInput {
                        experiment_id: "experiment-a".to_string(),
                        run_id: "run-a1".to_string(),
                        occurred_at: "2026-07-17T04:25:00Z".to_string(),
                    },
                )
            })
        };
        let remove_reorder_handle = {
            let path = remove_path.clone();
            let barrier = Arc::clone(&remove_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                set_representative_run_order_in_connection(
                    &mut connection,
                    &SetRepresentativeRunOrderInput {
                        experiment_id: "experiment-a".to_string(),
                        ordered_run_ids: vec!["run-a2".to_string(), "run-a1".to_string()],
                        occurred_at: "2026-07-17T04:25:00Z".to_string(),
                    },
                )
            })
        };
        remove_barrier.wait();
        remove_handle
            .join()
            .expect("join remove worker")
            .expect("remove succeeds");
        let remove_reorder_result = remove_reorder_handle
            .join()
            .expect("join remove reorder worker");
        assert!(
            remove_reorder_result.is_ok()
                || matches!(remove_reorder_result, Err(ref error) if error == RUN_ORDER_INVALID)
        );
        assert_contiguous(&remove_path);
        std::fs::remove_file(&remove_path).expect("remove remove-order database");

        let cleanup_path = setup_file("cleanup-write");
        let cleanup_barrier = Arc::new(Barrier::new(3));
        let cleanup_add = {
            let path = cleanup_path.clone();
            let barrier = Arc::clone(&cleanup_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                add_representative_run_in_connection(
                    &mut connection,
                    &add_input("cleanup-a1", "run-a1"),
                )
            })
        };
        let cleanup_write = {
            let path = cleanup_path.clone();
            let barrier = Arc::clone(&cleanup_barrier);
            thread::spawn(move || {
                let mut connection = open_file(&path);
                barrier.wait();
                cleanup_representative_run_relations_in_connection(
                    &mut connection,
                    &CleanupRepresentativeRunRelationsInput {
                        owner_type: RepresentativeRelationOwnerType::ExperimentRun,
                        owner_id: "run-a1".to_string(),
                        occurred_at: "2026-07-17T04:30:00Z".to_string(),
                    },
                )
            })
        };
        cleanup_barrier.wait();
        cleanup_add
            .join()
            .expect("join cleanup add")
            .expect("cleanup-race add succeeds");
        cleanup_write
            .join()
            .expect("join cleanup worker")
            .expect("cleanup succeeds");
        assert_contiguous(&cleanup_path);
        std::fs::remove_file(&cleanup_path).expect("remove cleanup-write database");
    }
}
