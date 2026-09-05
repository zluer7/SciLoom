export const schemaVersion = 1;

export const schemaNotes = [
  "SQLite will store research metadata, task links, and external file paths.",
  "Large experiment data files must remain outside the database.",
  "Business entity tables use deleted_at for soft deletion; canonical relation metadata may be hard-removed.",
  "SQLite columns use snake_case and must be mapped to frontend camelCase types."
];

export type SQLiteColumn = {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL";
  nullable?: boolean;
};

export type SQLiteTableSchema = {
  name: string;
  columns: SQLiteColumn[];
};

const auditColumns: SQLiteColumn[] = [
  { name: "id", type: "TEXT" },
  { name: "created_at", type: "TEXT" },
  { name: "updated_at", type: "TEXT" },
  { name: "deleted_at", type: "TEXT", nullable: true }
];

export const sqliteTables: SQLiteTableSchema[] = [
  {
    name: "managed_root_settings",
    columns: [
      ...auditColumns,
      { name: "configured_root", type: "TEXT" },
      { name: "schema_version", type: "INTEGER" }
    ]
  },
  {
    name: "milestones",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "title", type: "TEXT" },
      { name: "description", type: "TEXT" },
      { name: "time_scale", type: "TEXT" },
      { name: "start_date", type: "TEXT" },
      { name: "end_date", type: "TEXT" },
      { name: "expected_output", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "progress", type: "INTEGER" }
    ]
  },
  {
    name: "tasks",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "milestone_id", type: "TEXT", nullable: true },
      { name: "title", type: "TEXT" },
      { name: "description", type: "TEXT" },
      { name: "task_type", type: "TEXT" },
      { name: "priority", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "start_date", type: "TEXT", nullable: true },
      { name: "due_date", type: "TEXT", nullable: true },
      { name: "estimated_hours", type: "REAL", nullable: true },
      { name: "actual_hours", type: "REAL", nullable: true },
      { name: "acceptance_criteria", type: "TEXT" },
      { name: "blocker", type: "TEXT", nullable: true },
      { name: "review", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "experiments",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "route_id", type: "TEXT", nullable: true },
      { name: "task_id", type: "TEXT", nullable: true },
      { name: "title", type: "TEXT" },
      { name: "purpose_and_question", type: "TEXT", nullable: true },
      { name: "condition_summary", type: "TEXT", nullable: true },
      { name: "method_summary", type: "TEXT", nullable: true },
      { name: "conclusion_and_next_steps", type: "TEXT", nullable: true },
      { name: "other", type: "TEXT", nullable: true },
      { name: "status", type: "TEXT" },
      { name: "rating", type: "TEXT", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "usable_for_paper", type: "INTEGER" },
      { name: "usable_for_report", type: "INTEGER" },
      { name: "usable_for_patent", type: "INTEGER" },
      { name: "schema_version", type: "INTEGER" },
      { name: "source", type: "TEXT" },
      { name: "condition_items", type: "TEXT" },
      { name: "method_steps", type: "TEXT" },
      { name: "variables", type: "TEXT" },
      { name: "materials", type: "TEXT" },
      { name: "custom_fields", type: "TEXT" },
      { name: "legacy", type: "TEXT", nullable: true },
      { name: "migrated_from_legacy", type: "INTEGER", nullable: true },
      { name: "experiment_name", type: "TEXT" },
      { name: "machine_object", type: "TEXT" },
      { name: "fault_type", type: "TEXT" },
      { name: "speed", type: "REAL", nullable: true },
      { name: "load", type: "REAL", nullable: true },
      { name: "sensor_config", type: "TEXT" },
      { name: "data_path", type: "TEXT" },
      { name: "sampling_rate", type: "REAL", nullable: true },
      { name: "duration", type: "REAL", nullable: true },
      { name: "result_summary", type: "TEXT" },
      { name: "problem_notes", type: "TEXT", nullable: true },
      { name: "next_action", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "experiment_runs",
    columns: [
      ...auditColumns,
      { name: "experiment_id", type: "TEXT" },
      { name: "project_id", type: "TEXT", nullable: true },
      { name: "route_id", type: "TEXT", nullable: true },
      { name: "task_id", type: "TEXT", nullable: true },
      { name: "title", type: "TEXT" },
      { name: "run_label", type: "TEXT", nullable: true },
      { name: "status", type: "TEXT" },
      { name: "started_at", type: "TEXT", nullable: true },
      { name: "completed_at", type: "TEXT", nullable: true },
      { name: "condition_summary", type: "TEXT", nullable: true },
      { name: "method_summary", type: "TEXT", nullable: true },
      { name: "result_summary", type: "TEXT", nullable: true },
      { name: "conclusion", type: "TEXT", nullable: true },
      { name: "rating", type: "TEXT", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "schema_version", type: "INTEGER" },
      { name: "source", type: "TEXT" },
      { name: "condition_items", type: "TEXT" },
      { name: "method_steps", type: "TEXT" },
      { name: "variables", type: "TEXT" },
      { name: "materials", type: "TEXT" },
      { name: "custom_fields", type: "TEXT" },
      { name: "legacy", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "experiment_representative_runs",
    columns: [
      { name: "id", type: "TEXT" },
      { name: "experiment_id", type: "TEXT" },
      { name: "run_id", type: "TEXT" },
      { name: "sort_order", type: "INTEGER" },
      { name: "created_at", type: "TEXT" },
      { name: "updated_at", type: "TEXT" }
    ]
  },
  {
    name: "result_metrics",
    columns: [
      ...auditColumns,
      { name: "run_id", type: "TEXT" },
      { name: "experiment_id", type: "TEXT", nullable: true },
      { name: "name", type: "TEXT" },
      { name: "value", type: "TEXT" },
      { name: "unit", type: "TEXT", nullable: true },
      { name: "description", type: "TEXT", nullable: true },
      { name: "metric_group", type: "TEXT", nullable: true },
      { name: "higher_is_better", type: "INTEGER", nullable: true },
      { name: "value_type", type: "TEXT", nullable: true },
      { name: "baseline_value", type: "TEXT", nullable: true },
      { name: "target_value", type: "TEXT", nullable: true },
      { name: "order_index", type: "INTEGER", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "schema_version", type: "INTEGER" },
      { name: "source", type: "TEXT" },
      { name: "custom_fields", type: "TEXT" }
    ]
  },
  {
    name: "file_refs",
    columns: [
      ...auditColumns,
      { name: "owner_type", type: "TEXT" },
      { name: "owner_id", type: "TEXT" },
      { name: "manuscript_channel", type: "TEXT" },
      { name: "resource_kind", type: "TEXT" },
      { name: "file_role", type: "TEXT" },
      { name: "location_mode", type: "TEXT" },
      { name: "file_type", type: "TEXT" },
      { name: "path", type: "TEXT" },
      { name: "path_identity_key", type: "TEXT" },
      { name: "title", type: "TEXT" },
      { name: "description", type: "TEXT", nullable: true },
      { name: "candidate_request_id", type: "TEXT", nullable: true },
      { name: "candidate_occurred_at", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" },
      { name: "source", type: "TEXT" },
      { name: "custom_fields", type: "TEXT" },
      { name: "revision", type: "INTEGER" },
      { name: "permanent_delete_status", type: "TEXT", nullable: true },
      { name: "permanent_delete_lifecycle_action_id", type: "TEXT", nullable: true },
      { name: "permanently_deleted_at", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "manuscript_bindings",
    columns: [
      ...auditColumns,
      { name: "owner_type", type: "TEXT" },
      { name: "owner_id", type: "TEXT" },
      { name: "manuscript_channel", type: "TEXT" },
      { name: "default_folder_file_ref_id", type: "TEXT", nullable: true },
      { name: "default_manuscript_file_ref_id", type: "TEXT", nullable: true },
      { name: "current_file_ref_id", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" },
      { name: "revision", type: "INTEGER" }
    ]
  },
  {
    name: "result_items",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "route_id", type: "TEXT", nullable: true },
      { name: "task_id", type: "TEXT", nullable: true },
      { name: "experiment_id", type: "TEXT", nullable: true },
      { name: "experiment_run_id", type: "TEXT", nullable: true },
      { name: "source_type", type: "TEXT" },
      { name: "source_id", type: "TEXT" },
      { name: "title", type: "TEXT" },
      { name: "result_type", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "structured_summary", type: "TEXT" },
      { name: "summary", type: "TEXT", nullable: true },
      { name: "value_json", type: "TEXT", nullable: true },
      { name: "unit", type: "TEXT", nullable: true },
      { name: "file_ref_id", type: "TEXT", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "is_asset", type: "INTEGER" },
      { name: "asset_marked_at", type: "TEXT", nullable: true },
      { name: "asset_reason", type: "TEXT", nullable: true },
      { name: "asset_quality", type: "TEXT", nullable: true },
      { name: "usable_for", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" },
      { name: "custom_fields", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "findings",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "route_id", type: "TEXT", nullable: true },
      { name: "task_id", type: "TEXT", nullable: true },
      { name: "experiment_id", type: "TEXT", nullable: true },
      { name: "title", type: "TEXT" },
      { name: "summary", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "structured_summary", type: "TEXT" },
      { name: "finding_type", type: "TEXT", nullable: true },
      { name: "confidence", type: "TEXT", nullable: true },
      { name: "maturity", type: "TEXT", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "schema_version", type: "INTEGER" },
      { name: "custom_fields", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "output_candidates",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "route_id", type: "TEXT", nullable: true },
      { name: "task_id", type: "TEXT", nullable: true },
      { name: "title", type: "TEXT" },
      { name: "description", type: "TEXT", nullable: true },
      { name: "candidate_type", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "structured_summary", type: "TEXT" },
      { name: "maturity", type: "TEXT", nullable: true },
      { name: "priority", type: "TEXT", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "schema_version", type: "INTEGER" },
      { name: "custom_fields", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "output_gaps",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "title", type: "TEXT" },
      { name: "description", type: "TEXT", nullable: true },
      { name: "gap_type", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "structured_summary", type: "TEXT" },
      { name: "priority", type: "TEXT", nullable: true },
      { name: "related_task_id", type: "TEXT", nullable: true },
      { name: "related_route_node_id", type: "TEXT", nullable: true },
      { name: "resolved_at", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" },
      { name: "custom_fields", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "output_gap_feedback_cards",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "output_gap_id", type: "TEXT" },
      { name: "card_type", type: "TEXT" },
      { name: "title", type: "TEXT" },
      { name: "description", type: "TEXT", nullable: true },
      { name: "status", type: "TEXT" },
      { name: "priority", type: "TEXT" },
      { name: "archived_at", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "research_trace_event_preferences",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "target_type", type: "TEXT" },
      { name: "target_id", type: "TEXT" },
      { name: "visibility", type: "TEXT" },
      { name: "note", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "output_conversion_relations",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT", nullable: true },
      { name: "source_type", type: "TEXT" },
      { name: "source_id", type: "TEXT" },
      { name: "target_type", type: "TEXT" },
      { name: "target_id", type: "TEXT" },
      { name: "relation_type", type: "TEXT" },
      { name: "note", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" }
    ]
  },
  {
    name: "output_source_links",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "owner_type", type: "TEXT" },
      { name: "owner_id", type: "TEXT" },
      { name: "source_type", type: "TEXT" },
      { name: "source_id", type: "TEXT", nullable: true },
      { name: "source_title_snapshot", type: "TEXT" },
      { name: "source_summary_snapshot", type: "TEXT", nullable: true },
      { name: "source_note", type: "TEXT", nullable: true },
      { name: "relation_type", type: "TEXT" },
      { name: "order_index", type: "INTEGER" },
      { name: "schema_version", type: "INTEGER" }
    ]
  },
  {
    name: "literatures",
    columns: [
      ...auditColumns,
      { name: "title", type: "TEXT" },
      { name: "authors", type: "TEXT" },
      { name: "year", type: "INTEGER", nullable: true },
      { name: "venue", type: "TEXT", nullable: true },
      { name: "publication_type", type: "TEXT", nullable: true },
      { name: "abstract", type: "TEXT", nullable: true },
      { name: "keywords", type: "TEXT", nullable: true },
      { name: "doi", type: "TEXT", nullable: true },
      { name: "url", type: "TEXT", nullable: true },
      { name: "pdf_path", type: "TEXT", nullable: true },
      { name: "local_file_path", type: "TEXT", nullable: true },
      { name: "bibtex_key", type: "TEXT", nullable: true },
      { name: "citation_key", type: "TEXT", nullable: true },
      { name: "external_ids", type: "TEXT", nullable: true },
      { name: "reading_status", type: "TEXT" },
      { name: "importance", type: "TEXT", nullable: true },
      { name: "primary_project_id", type: "TEXT", nullable: true },
      { name: "tags", type: "TEXT" },
      { name: "is_archived", type: "INTEGER", nullable: true },
      { name: "archived_at", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" },
      { name: "source", type: "TEXT", nullable: true },
      { name: "custom_fields", type: "TEXT", nullable: true },
      { name: "ai_metadata", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "literature_links",
    columns: [
      ...auditColumns,
      { name: "literature_id", type: "TEXT" },
      { name: "target_type", type: "TEXT" },
      { name: "target_id", type: "TEXT" },
      { name: "project_id", type: "TEXT", nullable: true },
      { name: "relation_type", type: "TEXT" },
      { name: "role", type: "TEXT", nullable: true },
      { name: "description", type: "TEXT", nullable: true },
      { name: "note", type: "TEXT", nullable: true },
      { name: "strength", type: "TEXT", nullable: true },
      { name: "confidence", type: "TEXT", nullable: true },
      { name: "schema_version", type: "INTEGER" },
      { name: "tags", type: "TEXT", nullable: true },
      { name: "custom_fields", type: "TEXT", nullable: true },
      { name: "ai_metadata", type: "TEXT", nullable: true }
    ]
  },
  {
    name: "outputs",
    columns: [
      ...auditColumns,
      { name: "project_id", type: "TEXT" },
      { name: "task_id", type: "TEXT", nullable: true },
      { name: "experiment_id", type: "TEXT", nullable: true },
      { name: "output_name", type: "TEXT" },
      { name: "output_type", type: "TEXT" },
      { name: "status", type: "TEXT" },
      { name: "structured_summary", type: "TEXT" },
      { name: "usable_for_paper", type: "INTEGER" },
      { name: "description", type: "TEXT" },
      { name: "provenance", type: "TEXT", nullable: true }
    ]
  }
];
