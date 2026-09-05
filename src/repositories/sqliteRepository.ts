import { invoke } from "@tauri-apps/api/core";
import type {
  AuditableEntity,
  CreateEntityInput,
  EntityId,
  UpdateEntityInput
} from "../types/common";
import type { EntityRepositoryConfig, Repository } from "./types";
import { createRepositoryEntityId } from "./entityId";
import {
  assertCreatedLocalTimeNotPatched,
  assertCreatedLocalTimeRecord
} from "../services/experimentCreatedLocalTime";
import {
  assertFrozenWorkspaceTitleIdentity,
  assertWorkspaceTitleIdentityNotPatched
} from "../services/experimentWorkspacePathService";

type SQLiteRecord = Record<string, unknown>;

const fieldMappings: Record<string, Record<string, string>> = {
  milestones: {
    projectId: "project_id",
    timeScale: "time_scale",
    startDate: "start_date",
    endDate: "end_date",
    expectedOutput: "expected_output"
  },
  tasks: {
    projectId: "project_id",
    milestoneId: "milestone_id",
    taskType: "task_type",
    startDate: "start_date",
    dueDate: "due_date",
    estimatedHours: "estimated_hours",
    actualHours: "actual_hours",
    acceptanceCriteria: "acceptance_criteria"
  },
  experiments: {
    createdLocalDate: "created_local_date",
    createdLocalTime: "created_local_time",
    workspaceTitleIdentity: "workspace_title_identity",
    projectId: "project_id",
    routeId: "route_id",
    taskId: "task_id",
    purposeAndQuestion: "purpose_and_question",
    conditionSummary: "condition_summary",
    methodSummary: "method_summary",
    conclusionAndNextSteps: "conclusion_and_next_steps",
    other: "other",
    experimentName: "experiment_name",
    machineObject: "machine_object",
    faultType: "fault_type",
    sensorConfig: "sensor_config",
    dataPath: "data_path",
    samplingRate: "sampling_rate",
    resultSummary: "result_summary",
    problemNotes: "problem_notes",
    nextAction: "next_action",
    usableForPaper: "usable_for_paper",
    usableForReport: "usable_for_report",
    usableForPatent: "usable_for_patent",
    schemaVersion: "schema_version",
    conditionItems: "condition_items",
    methodSteps: "method_steps",
    customFields: "custom_fields",
    migratedFromLegacy: "migrated_from_legacy"
  },
  experiment_runs: {
    createdLocalDate: "created_local_date",
    createdLocalTime: "created_local_time",
    workspaceTitleIdentity: "workspace_title_identity",
    experimentId: "experiment_id",
    projectId: "project_id",
    routeId: "route_id",
    taskId: "task_id",
    runLabel: "run_label",
    startedAt: "started_at",
    completedAt: "completed_at",
    conditionSummary: "condition_summary",
    variableParameterSummary: "variable_parameter_summary",
    methodSummary: "method_summary",
    resultSummary: "result_summary",
    summaryOther: "summary_other",
    schemaVersion: "schema_version",
    conditionItems: "condition_items",
    methodSteps: "method_steps",
    customFields: "custom_fields"
  },
  result_metrics: {
    runId: "run_id",
    experimentId: "experiment_id",
    metricGroup: "metric_group",
    higherIsBetter: "higher_is_better",
    valueType: "value_type",
    baselineValue: "baseline_value",
    targetValue: "target_value",
    orderIndex: "order_index",
    schemaVersion: "schema_version",
    customFields: "custom_fields"
  },
  file_refs: {
    ownerType: "owner_type",
    ownerId: "owner_id",
    manuscriptChannel: "manuscript_channel",
    resourceKind: "resource_kind",
    fileRole: "file_role",
    locationMode: "location_mode",
    fileType: "file_type",
    pathIdentityKey: "path_identity_key",
    candidateRequestId: "candidate_request_id",
    candidateOccurredAt: "candidate_occurred_at",
    schemaVersion: "schema_version",
    customFields: "custom_fields"
  },
  manuscript_bindings: {
    ownerType: "owner_type",
    ownerId: "owner_id",
    manuscriptChannel: "manuscript_channel",
    defaultFolderFileRefId: "default_folder_file_ref_id",
    defaultManuscriptFileRefId: "default_manuscript_file_ref_id",
    currentFileRefId: "current_file_ref_id",
    schemaVersion: "schema_version"
  },
  result_items: {
    projectId: "project_id",
    routeId: "route_id",
    taskId: "task_id",
    experimentId: "experiment_id",
    experimentRunId: "experiment_run_id",
    sourceType: "source_type",
    sourceId: "source_id",
    resultType: "result_type",
    structuredSummary: "structured_summary",
    value: "value_json",
    fileRefId: "file_ref_id",
    isAsset: "is_asset",
    assetMarkedAt: "asset_marked_at",
    assetReason: "asset_reason",
    assetQuality: "asset_quality",
    usableFor: "usable_for",
    schemaVersion: "schema_version",
    customFields: "custom_fields"
  },
  findings: {
    projectId: "project_id",
    routeId: "route_id",
    taskId: "task_id",
    experimentId: "experiment_id",
    findingType: "finding_type",
    structuredSummary: "structured_summary",
    schemaVersion: "schema_version",
    customFields: "custom_fields"
  },
  output_candidates: {
    projectId: "project_id",
    routeId: "route_id",
    taskId: "task_id",
    candidateType: "candidate_type",
    structuredSummary: "structured_summary",
    schemaVersion: "schema_version",
    customFields: "custom_fields"
  },
  output_gaps: {
    projectId: "project_id",
    gapType: "gap_type",
    structuredSummary: "structured_summary",
    relatedTaskId: "related_task_id",
    relatedRouteNodeId: "related_route_node_id",
    resolvedAt: "resolved_at",
    schemaVersion: "schema_version",
    customFields: "custom_fields"
  },
  output_gap_feedback_cards: {
    projectId: "project_id",
    outputGapId: "output_gap_id",
    type: "card_type",
    archivedAt: "archived_at"
  },
  research_trace_event_preferences: {
    projectId: "project_id",
    targetType: "target_type",
    targetId: "target_id"
  },
  output_conversion_relations: {
    projectId: "project_id",
    sourceType: "source_type",
    sourceId: "source_id",
    targetType: "target_type",
    targetId: "target_id",
    relationType: "relation_type",
    schemaVersion: "schema_version"
  },
  output_source_links: {
    projectId: "project_id",
    ownerType: "owner_type",
    ownerId: "owner_id",
    sourceType: "source_type",
    sourceId: "source_id",
    sourceTitleSnapshot: "source_title_snapshot",
    sourceSummarySnapshot: "source_summary_snapshot",
    sourceNote: "source_note",
    relationType: "relation_type",
    orderIndex: "order_index",
    schemaVersion: "schema_version"
  },
  literatures: {
    publicationType: "publication_type",
    pdfPath: "pdf_path",
    localFilePath: "local_file_path",
    bibtexKey: "bibtex_key",
    citationKey: "citation_key",
    externalIds: "external_ids",
    readingStatus: "reading_status",
    primaryProjectId: "primary_project_id",
    isArchived: "is_archived",
    archivedAt: "archived_at",
    schemaVersion: "schema_version",
    customFields: "custom_fields",
    aiMetadata: "ai_metadata"
  },
  literature_links: {
    literatureId: "literature_id",
    targetType: "target_type",
    targetId: "target_id",
    projectId: "project_id",
    relationType: "relation_type",
    schemaVersion: "schema_version",
    customFields: "custom_fields",
    aiMetadata: "ai_metadata"
  },
  outputs: {
    projectId: "project_id",
    taskId: "task_id",
    experimentId: "experiment_id",
    outputName: "output_name",
    outputType: "output_type",
    structuredSummary: "structured_summary",
    usableForPaper: "usable_for_paper"
  },
  operation_logs: {
    operationType: "operation_type",
    riskLevel: "risk_level",
    relatedEntities: "related_entities",
    impactSummary: "impact_summary",
    confirmation: "confirmation",
    feedback: "feedback",
    isRecoverable: "is_recoverable",
    recycleEntryId: "recycle_entry_id",
    actorId: "actor_id",
    actorLabel: "actor_label",
    refreshKeys: "refresh_keys",
    schemaVersion: "schema_version",
    lifecycleActionId: "lifecycle_action_id",
    effectType: "effect_type"
  },
  recycle_entries: {
    entityType: "entity_type",
    entityId: "entity_id",
    entityDeletedAt: "entity_deleted_at",
    deletedBy: "deleted_by",
    operationLogId: "operation_log_id",
    canRestore: "can_restore",
    cannotRestoreReason: "cannot_restore_reason",
    knownImpactSummary: "known_impact_summary",
    restoreStatus: "restore_status",
    refreshKeys: "refresh_keys",
    schemaVersion: "schema_version",
    createdByLifecycleActionId: "created_by_lifecycle_action_id",
    terminalLifecycleActionId: "terminal_lifecycle_action_id"
  }
};

const jsonFields: Record<string, string[]> = {
  experiments: [
    "tags",
    "conditionItems",
    "methodSteps",
    "variables",
    "materials",
    "customFields",
    "legacy"
  ],
  experiment_runs: [
    "tags",
    "conditionItems",
    "methodSteps",
    "variables",
    "materials",
    "customFields",
    "legacy"
  ],
  result_metrics: ["tags", "customFields"],
  file_refs: ["customFields"],
  result_items: ["tags", "structuredSummary", "value", "usableFor", "customFields"],
  findings: ["structuredSummary", "tags", "customFields"],
  output_candidates: ["structuredSummary", "tags", "customFields"],
  output_gaps: ["structuredSummary", "customFields"],
  literatures: ["authors", "keywords", "externalIds", "tags", "customFields", "aiMetadata"],
  literature_links: ["tags", "customFields", "aiMetadata"],
  outputs: ["structuredSummary", "provenance"],
  operation_logs: [
    "target",
    "relatedEntities",
    "impactSummary",
    "confirmation",
    "feedback",
    "warnings",
    "errors",
    "skipped",
    "refreshKeys"
  ],
  recycle_entries: ["knownImpactSummary", "refreshKeys"]
};

const booleanFields: Record<string, string[]> = {
  experiments: [
    "usableForPaper",
    "usableForReport",
    "usableForPatent",
    "migratedFromLegacy"
  ],
  result_metrics: ["higherIsBetter"],
  result_items: ["isAsset"],
  literatures: ["isArchived"],
  operation_logs: ["isRecoverable"],
  recycle_entries: ["canRestore"]
};

const auditMapping: Record<string, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at"
};

export function toSQLiteRecord<T extends AuditableEntity>(
  tableName: string,
  item: Partial<T>
) {
  const mapping = { ...auditMapping, ...(fieldMappings[tableName] ?? {}) };
  return Object.entries(item).reduce<SQLiteRecord>((record, [key, value]) => {
    const column = mapping[key] ?? key;
    if (value === undefined) {
      record[column] = null;
    } else if ((jsonFields[tableName] ?? []).includes(key)) {
      record[column] = JSON.stringify(value);
    } else if (Array.isArray(value)) {
      record[column] = JSON.stringify(value);
    } else if (typeof value === "boolean") {
      record[column] = value ? 1 : 0;
    } else {
      record[column] = value;
    }
    return record;
  }, {});
}

export function fromSQLiteRecord<T extends AuditableEntity>(tableName: string, record: SQLiteRecord) {
  const mapping = { ...auditMapping, ...(fieldMappings[tableName] ?? {}) };
  const reverseMapping = Object.entries(mapping).reduce<Record<string, string>>(
    (fields, [camel, snake]) => {
      fields[snake] = camel;
      return fields;
    },
    {}
  );

  const item = Object.entries(record).reduce<Record<string, unknown>>((item, [key, value]) => {
    const field = reverseMapping[key] ?? key;
    if ((jsonFields[tableName] ?? []).includes(field) && typeof value === "string") {
      try {
        item[field] = JSON.parse(value) as unknown;
      } catch {
        item[field] = value;
      }
    } else if ((booleanFields[tableName] ?? []).includes(field)) {
      item[field] = Boolean(value);
    } else if (value !== null) {
      item[field] = value;
    }
    return item;
  }, {});
  if (tableName === "experiments" || tableName === "experiment_runs") {
    assertCreatedLocalTimeRecord(item, tableName === "experiments" ? "Experiment" : "ExperimentRun");
    assertFrozenWorkspaceTitleIdentity(
      item.workspaceTitleIdentity,
      tableName === "experiments" ? "experiment" : "experimentRun"
    );
  }
  return item as T;
}

export function createSQLiteRepository<T extends AuditableEntity>(
  config: EntityRepositoryConfig<T>
): Repository<T> {
  async function softDelete(id: EntityId) {
    if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
      throw new Error("Experiment/ExperimentRun lifecycle must use experimentRunLifecycleService.");
    }
    return invoke<boolean>("db_soft_delete_record", {
      tableName: config.tableName,
      id,
      updatedAt: new Date().toISOString(),
      deletedAt: new Date().toISOString()
    });
  }

  return {
    async list() {
      const records = await invoke<SQLiteRecord[]>("db_list_records", {
        tableName: config.tableName
      });
      return records.map((record) => fromSQLiteRecord<T>(config.tableName, record));
    },

    async getById(id) {
      const record = await invoke<SQLiteRecord | null>("db_get_record", {
        tableName: config.tableName,
        id
      });
      return record ? fromSQLiteRecord<T>(config.tableName, record) : undefined;
    },

    async create(input: CreateEntityInput<T>, options = {}) {
      if (
        (config.tableName === "experiments" || config.tableName === "experiment_runs") &&
        !options.createdAt
      ) {
        throw new Error("Experiment creation must provide the service-owned createdAt instant.");
      }
      const timestamp = options.createdAt ?? new Date().toISOString();
      const item = {
        ...input,
        id: options.id ?? createRepositoryEntityId(config.idPrefix),
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      } as T;
      if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
        assertCreatedLocalTimeRecord(
          item as T & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
        assertFrozenWorkspaceTitleIdentity(
          (item as T & Record<string, unknown>).workspaceTitleIdentity,
          config.tableName === "experiments" ? "experiment" : "experimentRun"
        );
      }
      await invoke("db_save_record", {
        tableName: config.tableName,
        record: toSQLiteRecord(config.tableName, item)
      });
      return item;
    },

    async createIfAbsent(input: CreateEntityInput<T>, options) {
      if (config.tableName !== "literatures") {
        throw new Error("Atomic create-if-absent is bounded to Literature creation.");
      }
      const timestamp = options.createdAt ?? new Date().toISOString();
      const item = {
        ...input,
        id: options.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      } as T;
      const created = await invoke<boolean>("db_insert_record_if_absent", {
        tableName: config.tableName,
        record: toSQLiteRecord(config.tableName, item)
      });
      if (created) return { created: true, entity: item };
      const existing = await this.getById(options.id);
      if (!existing) {
        throw new Error("The operation-bound Literature identity exists but is not active/readable.");
      }
      return { created: false, entity: existing };
    },

    async update(id, input: UpdateEntityInput<T>) {
      return this.updateWithExpectedUpdatedAt?.(id, input, {});
    },

    async updateWithExpectedUpdatedAt(id, input: UpdateEntityInput<T>, options) {
      if (
        options.expectedUpdatedAt &&
        config.tableName !== "experiment_runs" &&
        config.tableName !== "literatures"
      ) {
        throw new Error("Atomic updatedAt guards are bounded to ExperimentRun and Literature updates.");
      }
      if (options.nextUpdatedAt && !options.expectedUpdatedAt) {
        throw new Error("A service-owned next updatedAt token requires one exact expected token.");
      }
      if (
        options.nextUpdatedAt &&
        options.expectedUpdatedAt &&
        options.nextUpdatedAt <= options.expectedUpdatedAt
      ) {
        throw new Error("The service-owned next updatedAt token must be strictly newer.");
      }
      const existing = await this.getById(id);
      if (!existing) {
        return undefined;
      }
      if (options.expectedUpdatedAt && existing.updatedAt !== options.expectedUpdatedAt) {
        return undefined;
      }

      if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
        assertCreatedLocalTimeNotPatched(
          input as UpdateEntityInput<T> & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
        assertWorkspaceTitleIdentityNotPatched(
          input as UpdateEntityInput<T> & Record<string, unknown>,
          config.tableName === "experiments" ? "Experiment" : "ExperimentRun"
        );
      }
      if (
        config.tableName === "experiment_runs" &&
        (Object.prototype.hasOwnProperty.call(input, "experimentId") ||
          Object.prototype.hasOwnProperty.call(input, "projectId"))
      ) {
        throw new Error("ExperimentRun parent and project are immutable in ordinary repository updates.");
      }

      const currentInstant = new Date().toISOString();
      const priorInstant = options.expectedUpdatedAt ?? existing.updatedAt;
      const strictlyNewerInstant = options.nextUpdatedAt ?? (currentInstant > priorInstant
        ? currentInstant
        : new Date(new Date(priorInstant).getTime() + 1).toISOString());
      const updatedItem = {
        ...existing,
        ...input,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: strictlyNewerInstant
      } as T;

      if (config.tableName === "experiment_runs" || config.tableName === "literatures") {
        const changed = await invoke<boolean>("db_update_record", {
          tableName: config.tableName,
          id,
          record: toSQLiteRecord(config.tableName, {
            ...input,
            updatedAt: updatedItem.updatedAt
          }),
          expectedUpdatedAt: options.expectedUpdatedAt
        });
        if (!changed) return undefined;
      } else {
        await invoke("db_save_record", {
          tableName: config.tableName,
          record: toSQLiteRecord(config.tableName, updatedItem)
        });
      }
      return updatedItem;
    },

    softDelete,
    async listDeleted() {
      const records = await invoke<SQLiteRecord[]>("db_list_deleted_records", {
        tableName: config.tableName
      });
      return records.map((record) => fromSQLiteRecord<T>(config.tableName, record));
    },

    async getDeletedById(id) {
      const record = await invoke<SQLiteRecord | null>("db_get_deleted_record", {
        tableName: config.tableName,
        id
      });
      return record ? fromSQLiteRecord<T>(config.tableName, record) : undefined;
    },

    async restore(id) {
      if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
        throw new Error("Experiment/ExperimentRun lifecycle must use experimentRunLifecycleService.");
      }
      const restored = await invoke<SQLiteRecord | null>("db_restore_record", {
        tableName: config.tableName,
        id,
        updatedAt: new Date().toISOString()
      });
      return restored ? fromSQLiteRecord<T>(config.tableName, restored) : undefined;
    },

    async hardDelete(id) {
      if (config.tableName === "experiments" || config.tableName === "experiment_runs") {
        throw new Error("Experiment/ExperimentRun lifecycle must use experimentRunLifecycleService.");
      }
      return invoke<boolean>("db_hard_delete_record", {
        tableName: config.tableName,
        id
      });
    },
    remove: softDelete
  };
}
