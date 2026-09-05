use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub(crate) const REVIEW_STRUCTURED_STATE_SCHEMA_VERSION: i64 = 54;

const REVIEW_STRUCTURED_STATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS review_structured_states (
  review_id TEXT PRIMARY KEY CHECK (length(review_id) > 0),
  review_type TEXT NOT NULL CHECK (review_type IN (
    'stage','periodic','experiment_comparison','literature_comparison','custom'
  )),
  descriptor_identity TEXT NOT NULL CHECK (descriptor_identity IN (
    'review/primary/stage/v1',
    'review/primary/periodic/v1',
    'review/primary/experiment_comparison/v1',
    'review/primary/literature_comparison/v1',
    'review/primary/custom/v1'
  )),
  outline_sections_json TEXT NOT NULL CHECK (json_valid(outline_sections_json)),
  structured_revision INTEGER NOT NULL DEFAULT 0 CHECK (structured_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (descriptor_identity = 'review/primary/' || review_type || '/v1')
);

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (54, 'review_structured_state_canonical_authority');
"#;

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(REVIEW_STRUCTURED_STATE_SCHEMA_SQL)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let table_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='review_structured_states'",
        [],
        |row| row.get(0),
    )?;
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('review_structured_states') WHERE name IN (
          'review_id','review_type','descriptor_identity','outline_sections_json',
          'structured_revision','created_at','updated_at'
        )",
        [],
        |row| row.get(0),
    )?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version=54 AND name='review_structured_state_canonical_authority'",
        [],
        |row| row.get(0),
    )?;
    let table_sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='review_structured_states'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let sql = table_sql.unwrap_or_default();
    Ok(table_count == 1
        && columns == 7
        && marker == 1
        && sql.contains("descriptor_identity = 'review/primary/' || review_type || '/v1'")
        && sql.contains("json_valid(outline_sections_json)"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewOutlineSectionRecord {
    pub(crate) key: String,
    pub(crate) content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewStructuredStateRecord {
    pub(crate) review_id: String,
    pub(crate) review_type: String,
    pub(crate) descriptor_identity: String,
    pub(crate) outline_sections: Vec<ReviewOutlineSectionRecord>,
    pub(crate) structured_revision: i64,
    pub(crate) lifecycle_evidence: String,
    pub(crate) lifecycle_status: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisionReviewStructuredStateInput {
    pub(crate) review_id: String,
    pub(crate) review_type: String,
    pub(crate) outline_sections: Vec<ReviewOutlineSectionRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceReviewStructuredStateInput {
    pub(crate) review_id: String,
    pub(crate) expected_structured_revision: i64,
    pub(crate) expected_descriptor_identity: String,
    pub(crate) expected_lifecycle_evidence: String,
    pub(crate) review_type: String,
    pub(crate) outline_sections: Vec<ReviewOutlineSectionRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LifecycleEvidence {
    token: String,
    status: String,
}

fn descriptor_identity(review_type: &str) -> Result<String, String> {
    match review_type {
        "stage" | "periodic" | "experiment_comparison" | "literature_comparison" | "custom" => {
            Ok(format!("review/primary/{review_type}/v1"))
        }
        _ => Err("REVIEW_DESCRIPTOR_IDENTITY_INVALID".into()),
    }
}

fn template_keys(review_type: &str) -> Result<&'static [&'static str], String> {
    match review_type {
        "stage" => Ok(&[
            "stage_summary",
            "key_progress",
            "completed_items",
            "major_problems",
            "cause_analysis",
            "next_plan",
            "other",
        ]),
        "periodic" => Ok(&[
            "period_summary",
            "period_completed",
            "period_pending",
            "major_problems",
            "cause_analysis",
            "next_period_plan",
            "other",
        ]),
        "experiment_comparison" => Ok(&[
            "comparison_summary",
            "comparison_targets",
            "key_differences",
            "main_conclusions",
            "anomalies_and_problems",
            "next_experiment_plan",
            "other",
        ]),
        "literature_comparison" => Ok(&[
            "literature_overview",
            "literature_scope",
            "method_differences",
            "consensus_and_divergence",
            "research_gaps_and_references",
            "next_reading_or_research_plan",
            "other",
        ]),
        "custom" => Ok(&[
            "custom_summary",
            "completed_items",
            "major_problems",
            "cause_analysis",
            "next_plan",
            "other",
        ]),
        _ => Err("REVIEW_DESCRIPTOR_IDENTITY_INVALID".into()),
    }
}

fn validate_state(
    review_id: &str,
    review_type: &str,
    sections: &[ReviewOutlineSectionRecord],
) -> Result<String, String> {
    if review_id.trim().is_empty() {
        return Err("REVIEW_STRUCTURED_OWNER_ID_INVALID".into());
    }
    let expected = template_keys(review_type)?;
    if sections.len() != expected.len()
        || sections
            .iter()
            .zip(expected.iter())
            .any(|(section, expected_key)| section.key != *expected_key)
    {
        return Err("REVIEW_STRUCTURED_STATE_SHAPE_INVALID".into());
    }
    serde_json::to_string(sections)
        .map_err(|error| format!("REVIEW_STRUCTURED_STATE_ENCODING_FAILED:{error}"))
}

fn lifecycle_evidence(
    connection: &Connection,
    review_id: &str,
) -> Result<LifecycleEvidence, String> {
    let pending: Option<(String, i64, String, String, Option<String>)> = connection
        .query_row(
            "SELECT lifecycle_action_id,revision,operation_type,current_stage,committed_planning_revision
             FROM review_lifecycle_actions
             WHERE review_id=?1 AND terminal_result IS NULL
             ORDER BY rowid DESC LIMIT 1",
            [review_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|error| format!("REVIEW_LIFECYCLE_EVIDENCE_READ_FAILED:{error}"))?;
    if let Some((action_id, revision, operation_type, stage, committed_revision)) = pending {
        return Ok(LifecycleEvidence {
            token: format!(
                "review-lifecycle/v1:pending:{action_id}:{revision}:{operation_type}:{stage}:{}",
                committed_revision.unwrap_or_default()
            ),
            status: "transition_pending".into(),
        });
    }
    let committed: Option<(String, i64, String, String)> = connection
        .query_row(
            "SELECT lifecycle_action_id,revision,operation_type,committed_planning_revision
             FROM review_lifecycle_actions
             WHERE review_id=?1 AND committed_planning_revision IS NOT NULL
             ORDER BY rowid DESC LIMIT 1",
            [review_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("REVIEW_LIFECYCLE_EVIDENCE_READ_FAILED:{error}"))?;
    if let Some((action_id, revision, operation_type, committed_revision)) = committed {
        let status = match operation_type.as_str() {
            "review_restore" => "active",
            "review_soft_delete" => "deleted",
            "review_permanent_delete" => "permanently_deleted",
            _ => return Err("REVIEW_LIFECYCLE_EVIDENCE_INVALID".into()),
        };
        return Ok(LifecycleEvidence {
            token: format!(
                "review-lifecycle/v1:committed:{action_id}:{revision}:{operation_type}:{committed_revision}"
            ),
            status: status.into(),
        });
    }
    Ok(LifecycleEvidence {
        token: "review-lifecycle/v1:none".into(),
        status: "active".into(),
    })
}

pub(crate) fn read_state_in_connection(
    connection: &Connection,
    review_id: &str,
) -> Result<Option<ReviewStructuredStateRecord>, String> {
    let stored: Option<(String, String, String, i64, String, String)> = connection
        .query_row(
            "SELECT review_type,descriptor_identity,outline_sections_json,structured_revision,created_at,updated_at
             FROM review_structured_states WHERE review_id=?1",
            [review_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()
        .map_err(|error| format!("REVIEW_STRUCTURED_STATE_READ_FAILED:{error}"))?;
    let Some((review_type, descriptor, sections_json, revision, created_at, updated_at)) = stored
    else {
        return Ok(None);
    };
    let sections: Vec<ReviewOutlineSectionRecord> = serde_json::from_str(&sections_json)
        .map_err(|error| format!("REVIEW_STRUCTURED_STATE_CORRUPT:{error}"))?;
    let encoded = validate_state(review_id, &review_type, &sections)?;
    if encoded != sections_json || descriptor_identity(&review_type)? != descriptor {
        return Err("REVIEW_STRUCTURED_STATE_CORRUPT".into());
    }
    let lifecycle = lifecycle_evidence(connection, review_id)?;
    Ok(Some(ReviewStructuredStateRecord {
        review_id: review_id.into(),
        review_type,
        descriptor_identity: descriptor,
        outline_sections: sections,
        structured_revision: revision,
        lifecycle_evidence: lifecycle.token,
        lifecycle_status: lifecycle.status,
        created_at,
        updated_at,
    }))
}

pub(crate) fn read_many_in_connection(
    connection: &Connection,
    review_ids: &[String],
) -> Result<Vec<ReviewStructuredStateRecord>, String> {
    let mut records = Vec::with_capacity(review_ids.len());
    for review_id in review_ids {
        if let Some(record) = read_state_in_connection(connection, review_id)? {
            records.push(record);
        }
    }
    Ok(records)
}

pub(crate) fn migrate_legacy_in_connection(
    connection: &mut Connection,
    inputs: &[ProvisionReviewStructuredStateInput],
) -> Result<Vec<ReviewStructuredStateRecord>, String> {
    let validated = inputs
        .iter()
        .map(|input| {
            Ok((
                input,
                descriptor_identity(&input.review_type)?,
                validate_state(
                    &input.review_id,
                    &input.review_type,
                    &input.outline_sections,
                )?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("REVIEW_STRUCTURED_MIGRATION_BEGIN_FAILED:{error}"))?;
    let timestamp = Utc::now().to_rfc3339();
    for (input, descriptor, sections_json) in validated {
        let lifecycle = lifecycle_evidence(&transaction, &input.review_id)?;
        if lifecycle.status == "transition_pending" {
            return Err("REVIEW_STRUCTURED_LIFECYCLE_CONFLICT".into());
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO review_structured_states(
                   review_id,review_type,descriptor_identity,outline_sections_json,
                   structured_revision,created_at,updated_at
                 ) VALUES(?1,?2,?3,?4,0,?5,?5)",
                params![
                    input.review_id,
                    input.review_type,
                    descriptor,
                    sections_json,
                    timestamp
                ],
            )
            .map_err(|error| format!("REVIEW_STRUCTURED_MIGRATION_WRITE_FAILED:{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("REVIEW_STRUCTURED_MIGRATION_COMMIT_FAILED:{error}"))?;
    read_many_in_connection(
        connection,
        &inputs
            .iter()
            .map(|input| input.review_id.clone())
            .collect::<Vec<_>>(),
    )
}

pub(crate) fn provision_in_connection(
    connection: &mut Connection,
    input: &ProvisionReviewStructuredStateInput,
) -> Result<ReviewStructuredStateRecord, String> {
    let descriptor = descriptor_identity(&input.review_type)?;
    let sections_json = validate_state(
        &input.review_id,
        &input.review_type,
        &input.outline_sections,
    )?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("REVIEW_STRUCTURED_PROVISION_BEGIN_FAILED:{error}"))?;
    let lifecycle = lifecycle_evidence(&transaction, &input.review_id)?;
    if lifecycle.status != "active" {
        return Err("REVIEW_STRUCTURED_LIFECYCLE_CONFLICT".into());
    }
    let timestamp = Utc::now().to_rfc3339();
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO review_structured_states(
               review_id,review_type,descriptor_identity,outline_sections_json,
               structured_revision,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,0,?5,?5)",
            params![
                input.review_id,
                input.review_type,
                descriptor,
                sections_json,
                timestamp
            ],
        )
        .map_err(|error| format!("REVIEW_STRUCTURED_PROVISION_WRITE_FAILED:{error}"))?;
    if inserted == 0 {
        let existing = read_state_in_connection(&transaction, &input.review_id)?
            .ok_or_else(|| "SECOND_LAYER_NOT_PROVISIONED".to_string())?;
        if existing.review_type != input.review_type
            || existing.descriptor_identity != descriptor
            || existing.outline_sections != input.outline_sections
        {
            return Err("REVIEW_STRUCTURED_PROVISION_IDENTITY_CONFLICT".into());
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("REVIEW_STRUCTURED_PROVISION_COMMIT_FAILED:{error}"))?;
    read_state_in_connection(connection, &input.review_id)?
        .ok_or_else(|| "SECOND_LAYER_NOT_PROVISIONED".to_string())
}

pub(crate) fn replace_in_existing_transaction(
    connection: &Connection,
    input: &ReplaceReviewStructuredStateInput,
    timestamp: &str,
) -> Result<ReviewStructuredStateRecord, String> {
    let descriptor = descriptor_identity(&input.review_type)?;
    let sections_json = validate_state(
        &input.review_id,
        &input.review_type,
        &input.outline_sections,
    )?;
    let lifecycle = lifecycle_evidence(connection, &input.review_id)?;
    if lifecycle.token != input.expected_lifecycle_evidence {
        return Err("REVIEW_STRUCTURED_LIFECYCLE_STALE".into());
    }
    if lifecycle.status != "active" {
        return Err("REVIEW_STRUCTURED_LIFECYCLE_CONFLICT".into());
    }
    let current = read_state_in_connection(connection, &input.review_id)?
        .ok_or_else(|| "SECOND_LAYER_NOT_PROVISIONED".to_string())?;
    if current.structured_revision != input.expected_structured_revision {
        return Err("REVIEW_STRUCTURED_REVISION_STALE".into());
    }
    if current.descriptor_identity != input.expected_descriptor_identity {
        return Err("REVIEW_DESCRIPTOR_IDENTITY_STALE".into());
    }
    let changed = connection
        .execute(
            "UPDATE review_structured_states
             SET review_type=?1,descriptor_identity=?2,outline_sections_json=?3,
                 structured_revision=structured_revision+1,updated_at=?4
             WHERE review_id=?5 AND structured_revision=?6 AND descriptor_identity=?7",
            params![
                input.review_type,
                descriptor,
                sections_json,
                timestamp,
                input.review_id,
                input.expected_structured_revision,
                input.expected_descriptor_identity
            ],
        )
        .map_err(|error| format!("REVIEW_STRUCTURED_WRITE_FAILED:{error}"))?;
    if changed != 1 {
        return Err("REVIEW_STRUCTURED_REVISION_STALE".into());
    }
    let post = read_state_in_connection(connection, &input.review_id)?
        .ok_or_else(|| "SECOND_LAYER_NOT_PROVISIONED".to_string())?;
    if post.review_type != input.review_type
        || post.descriptor_identity != descriptor
        || post.outline_sections != input.outline_sections
        || post.structured_revision != input.expected_structured_revision + 1
        || post.lifecycle_evidence != input.expected_lifecycle_evidence
        || post.lifecycle_status != "active"
        || post.updated_at != timestamp
    {
        return Err("REVIEW_STRUCTURED_WRITE_POST_CONDITION_FAILED".into());
    }
    Ok(post)
}

pub(crate) fn replace_in_connection(
    connection: &mut Connection,
    input: &ReplaceReviewStructuredStateInput,
) -> Result<ReviewStructuredStateRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("REVIEW_STRUCTURED_WRITE_BEGIN_FAILED:{error}"))?;
    let timestamp = Utc::now().to_rfc3339();
    let post = replace_in_existing_transaction(&transaction, input, &timestamp)?;
    transaction
        .commit()
        .map_err(|error| format!("REVIEW_STRUCTURED_WRITE_COMMIT_FAILED:{error}"))?;
    Ok(post)
}

fn open(app_handle: &AppHandle) -> Result<Connection, String> {
    super::open_connection(app_handle)
}

#[tauri::command]
pub(crate) fn migrate_review_structured_states(
    app_handle: AppHandle,
    inputs: Vec<ProvisionReviewStructuredStateInput>,
) -> Result<Vec<ReviewStructuredStateRecord>, String> {
    let mut connection = open(&app_handle)?;
    migrate_legacy_in_connection(&mut connection, &inputs)
}

#[tauri::command]
pub(crate) fn provision_review_structured_state(
    app_handle: AppHandle,
    input: ProvisionReviewStructuredStateInput,
) -> Result<ReviewStructuredStateRecord, String> {
    let mut connection = open(&app_handle)?;
    provision_in_connection(&mut connection, &input)
}

#[tauri::command]
pub(crate) fn read_review_structured_states(
    app_handle: AppHandle,
    review_ids: Vec<String>,
) -> Result<Vec<ReviewStructuredStateRecord>, String> {
    let connection = open(&app_handle)?;
    read_many_in_connection(&connection, &review_ids)
}

#[tauri::command]
pub(crate) fn replace_review_structured_state(
    app_handle: AppHandle,
    input: ReplaceReviewStructuredStateInput,
) -> Result<ReviewStructuredStateRecord, String> {
    let mut connection = open(&app_handle)?;
    replace_in_connection(&mut connection, &input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;
    use std::path::PathBuf;

    fn database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "labpod-review-structured-{label}-{}.sqlite3",
            uuid::Uuid::new_v4()
        ))
    }

    fn open_current(path: &PathBuf) -> Connection {
        let connection = Connection::open(path).expect("open review structured test database");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable foreign keys");
        schema::run_migrations(&connection).expect("initialize current schema");
        connection
    }

    fn sections(review_type: &str, content: &str) -> Vec<ReviewOutlineSectionRecord> {
        template_keys(review_type)
            .expect("known review type")
            .iter()
            .map(|key| ReviewOutlineSectionRecord {
                key: (*key).into(),
                content: content.into(),
            })
            .collect()
    }

    fn seed(
        review_id: &str,
        review_type: &str,
        content: &str,
    ) -> ProvisionReviewStructuredStateInput {
        ProvisionReviewStructuredStateInput {
            review_id: review_id.into(),
            review_type: review_type.into(),
            outline_sections: sections(review_type, content),
        }
    }

    fn replace_input(
        current: &ReviewStructuredStateRecord,
        review_type: &str,
        content: &str,
    ) -> ReplaceReviewStructuredStateInput {
        ReplaceReviewStructuredStateInput {
            review_id: current.review_id.clone(),
            expected_structured_revision: current.structured_revision,
            expected_descriptor_identity: current.descriptor_identity.clone(),
            expected_lifecycle_evidence: current.lifecycle_evidence.clone(),
            review_type: review_type.into(),
            outline_sections: sections(review_type, content),
        }
    }

    #[test]
    fn f3_4_five_review_types_support_idempotent_provision_full_replace_clear_and_restart() {
        for review_type in [
            "stage",
            "periodic",
            "experiment_comparison",
            "literature_comparison",
            "custom",
        ] {
            let path = database_path(review_type);
            let mut connection = open_current(&path);
            let review_id = format!("review-{review_type}");
            let input = seed(&review_id, review_type, "initial");
            let created = provision_in_connection(&mut connection, &input).expect("provision");
            assert_eq!(created.structured_revision, 0);
            assert_eq!(
                created.descriptor_identity,
                format!("review/primary/{review_type}/v1")
            );
            assert_eq!(created.lifecycle_status, "active");

            let repeated =
                provision_in_connection(&mut connection, &input).expect("idempotent provision");
            assert_eq!(repeated, created);
            let replaced = replace_in_connection(
                &mut connection,
                &replace_input(&created, review_type, "replacement"),
            )
            .expect("full replacement");
            assert_eq!(replaced.structured_revision, 1);
            assert!(replaced
                .outline_sections
                .iter()
                .all(|item| item.content == "replacement"));
            let cleared =
                replace_in_connection(&mut connection, &replace_input(&replaced, review_type, ""))
                    .expect("CLEAR replacement");
            assert_eq!(cleared.structured_revision, 2);
            assert!(cleared
                .outline_sections
                .iter()
                .all(|item| item.content.is_empty()));

            drop(connection);
            let reopened = Connection::open(&path).expect("reopen durable database");
            let readback =
                read_many_in_connection(&reopened, &[review_id]).expect("restart readback");
            assert_eq!(readback, vec![cleared]);
            drop(reopened);
            std::fs::remove_file(path).expect("remove review structured test database");
        }
    }

    #[test]
    fn f3_4_descriptor_revision_and_lifecycle_conflicts_are_zero_mutation() {
        let path = database_path("cas-lifecycle");
        let mut connection = open_current(&path);
        let created = provision_in_connection(&mut connection, &seed("review-cas", "stage", "A"))
            .expect("provision CAS fixture");

        let mut stale_revision = replace_input(&created, "stage", "stale");
        stale_revision.expected_structured_revision = 99;
        assert_eq!(
            replace_in_connection(&mut connection, &stale_revision).unwrap_err(),
            "REVIEW_STRUCTURED_REVISION_STALE"
        );
        let mut stale_descriptor = replace_input(&created, "stage", "stale");
        stale_descriptor.expected_descriptor_identity = "review/primary/custom/v1".into();
        assert_eq!(
            replace_in_connection(&mut connection, &stale_descriptor).unwrap_err(),
            "REVIEW_DESCRIPTOR_IDENTITY_STALE"
        );
        assert_eq!(
            read_state_in_connection(&connection, "review-cas").unwrap().unwrap(),
            created
        );

        let changed =
            replace_in_connection(&mut connection, &replace_input(&created, "periodic", "B"))
                .expect("atomic descriptor and state type change");
        assert_eq!(changed.review_type, "periodic");
        assert_eq!(changed.descriptor_identity, "review/primary/periodic/v1");
        assert_eq!(changed.structured_revision, 1);
        assert_eq!(changed.outline_sections, sections("periodic", "B"));

        connection.execute(
            "INSERT INTO review_lifecycle_actions(
               lifecycle_action_id,operation_type,review_id,project_id,
               expected_review_source_state,expected_review_updated_at,target_review_updated_at,
               target_review_deleted_at,expected_planning_epoch,expected_planning_revision,
               planned_committed_planning_revision,planning_effect_id,exact_recycle_entry_id,
               operation_log_effect_id,recycle_effect_id,current_stage,created_at,updated_at
             ) VALUES(
               'delete-action','review_soft_delete','review-cas','project-1',
               'active','2026-08-10T00:00:00Z','2026-08-10T00:01:00Z',
               '2026-08-10T00:01:00Z','epoch-1','1','2','planning-delete','recycle-1',
               'log-delete','recycle-delete','prepared','2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
             )",
            [],
        ).expect("seed pending delete authority");
        assert_eq!(
            replace_in_connection(
                &mut connection,
                &replace_input(&changed, "periodic", "pending")
            )
            .unwrap_err(),
            "REVIEW_STRUCTURED_LIFECYCLE_STALE"
        );
        assert_eq!(
            read_state_in_connection(&connection, "review-cas")
                .unwrap()
                .unwrap()
                .structured_revision,
            1
        );

        connection
            .execute(
                "UPDATE review_lifecycle_actions SET
               revision=1,current_stage='completed',terminal_result='completed',
               committed_planning_epoch='epoch-1',committed_planning_revision='2',
               terminal_at='2026-08-10T00:02:00Z',updated_at='2026-08-10T00:02:00Z'
             WHERE lifecycle_action_id='delete-action'",
                [],
            )
            .expect("commit delete lifecycle authority");
        let deleted = read_state_in_connection(&connection, "review-cas").unwrap().unwrap();
        assert_eq!(deleted.lifecycle_status, "deleted");
        assert_eq!(
            replace_in_connection(
                &mut connection,
                &replace_input(&deleted, "periodic", "deleted")
            )
            .unwrap_err(),
            "REVIEW_STRUCTURED_LIFECYCLE_CONFLICT"
        );
        assert_eq!(
            read_state_in_connection(&connection, "review-cas")
                .unwrap()
                .unwrap()
                .structured_revision,
            1
        );

        connection.execute(
            "INSERT INTO review_lifecycle_actions(
               lifecycle_action_id,revision,operation_type,review_id,project_id,
               expected_review_source_state,expected_review_updated_at,expected_review_deleted_at,
               target_review_updated_at,target_review_deleted_at,expected_planning_epoch,
               expected_planning_revision,planned_committed_planning_revision,
               committed_planning_epoch,committed_planning_revision,planning_effect_id,
               source_delete_action_id,exact_recycle_entry_id,operation_log_effect_id,recycle_effect_id,
               current_stage,terminal_result,created_at,updated_at,terminal_at
             ) VALUES(
               'restore-action',1,'review_restore','review-cas','project-1',
               'deleted','2026-08-10T00:02:00Z','2026-08-10T00:01:00Z',
               '2026-08-10T00:03:00Z',NULL,'epoch-1','2','3','epoch-1','3',
               'planning-restore','delete-action','recycle-1','log-restore','recycle-restore',
               'completed','completed','2026-08-10T00:03:00Z','2026-08-10T00:03:00Z','2026-08-10T00:03:00Z'
             )",
            [],
        ).expect("seed committed restore authority");
        let restored = read_state_in_connection(&connection, "review-cas").unwrap().unwrap();
        assert_eq!(restored.lifecycle_status, "active");
        let after_restore = replace_in_connection(
            &mut connection,
            &replace_input(&restored, "periodic", "restored"),
        )
        .expect("write after authoritative restore");
        assert_eq!(after_restore.structured_revision, 2);

        let invalid = ProvisionReviewStructuredStateInput {
            review_id: "invalid-review".into(),
            review_type: "unknown".into(),
            outline_sections: Vec::new(),
        };
        assert_eq!(
            provision_in_connection(&mut connection, &invalid).unwrap_err(),
            "REVIEW_DESCRIPTOR_IDENTITY_INVALID"
        );
        drop(connection);
        std::fs::remove_file(path).expect("remove CAS lifecycle database");
    }

    #[test]
    fn f3_4_v53_upgrade_and_fresh_v54_initialization_are_exact_and_idempotent() {
        let fresh = Connection::open_in_memory().expect("open fresh database");
        schema::run_migrations(&fresh).expect("fresh migration chain");
        assert_eq!(
            fresh
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            REVIEW_STRUCTURED_STATE_SCHEMA_VERSION
        );
        assert!(schema_is_current(&fresh).unwrap());
        assert_eq!(
            fresh
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            REVIEW_STRUCTURED_STATE_SCHEMA_VERSION
        );
        assert_eq!(
            fresh
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            fresh
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );

        fresh
            .execute_batch(
                "DROP TABLE review_structured_states;
             DELETE FROM schema_migrations WHERE version=54;
             PRAGMA user_version=53;",
            )
            .expect("construct exact v53 predecessor fixture");
        assert!(!schema_is_current(&fresh).unwrap());
        schema::run_migrations(&fresh).expect("exactly one v53 to v54 upgrade");
        schema::run_migrations(&fresh).expect("idempotent current migration readback");
        assert!(schema_is_current(&fresh).unwrap());
        assert_eq!(
            fresh
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            REVIEW_STRUCTURED_STATE_SCHEMA_VERSION
        );
        assert_eq!(
            fresh.query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=54 AND name='review_structured_state_canonical_authority'",
                [],
                |row| row.get::<_, i64>(0),
            ).unwrap(),
            1
        );
    }
}
