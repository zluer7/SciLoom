import type {
  ProjectResearchTraceTargetType,
  ResearchTraceEventPreference
} from "../types/projectResearchTrace";
import { invoke } from "@tauri-apps/api/core";
import { toSQLiteRecord } from "../repositories/sqliteRepository";

const TABLE_NAME = "research_trace_event_preferences";

function clonePreference(
  preference: ResearchTraceEventPreference
): ResearchTraceEventPreference {
  return { ...preference };
}

function createPreferenceId(
  projectId: string,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
) {
  return `research-trace-preference:${projectId}:${targetType}:${targetId}`;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toPreference(record: Record<string, unknown>): ResearchTraceEventPreference {
  return {
    id: asString(record.id),
    projectId: asString(record.project_id),
    targetType: asString(record.target_type) as ProjectResearchTraceTargetType,
    targetId: asString(record.target_id),
    visibility: asString(record.visibility) as ResearchTraceEventPreference["visibility"],
    note: asOptionalString(record.note),
    createdAt: asString(record.created_at),
    updatedAt: asString(record.updated_at),
    deletedAt: asNullableString(record.deleted_at)
  };
}

async function listActiveRecords(): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("db_list_records", {
    tableName: TABLE_NAME
  });
}

async function savePreference(preference: ResearchTraceEventPreference): Promise<void> {
  await invoke("db_save_record", {
    tableName: TABLE_NAME,
    record: toSQLiteRecord(TABLE_NAME, preference)
  });
}

export async function listResearchTracePreferences(
  projectId: string
): Promise<ResearchTraceEventPreference[]> {
  const records = await listActiveRecords();
  return records
    .map(toPreference)
    .filter((preference) => preference.projectId === projectId && !preference.deletedAt)
    .map(clonePreference);
}

export async function getResearchTracePreference(
  projectId: string,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
): Promise<ResearchTraceEventPreference | null> {
  const record = await invoke<Record<string, unknown> | null>("db_get_record", {
    tableName: TABLE_NAME,
    id: createPreferenceId(projectId, targetType, targetId)
  });

  if (!record) {
    return null;
  }

  const preference = toPreference(record);
  return clonePreference(preference);
}

export async function upsertResearchTracePreference(
  input: Omit<ResearchTraceEventPreference, "id" | "createdAt" | "updatedAt" | "deletedAt"> & {
    now?: string;
  }
): Promise<ResearchTraceEventPreference> {
  const timestamp = input.now ?? new Date().toISOString();
  const id = createPreferenceId(input.projectId, input.targetType, input.targetId);
  const existingRecord =
    (await invoke<Record<string, unknown> | null>("db_get_record", {
      tableName: TABLE_NAME,
      id
    })) ??
    (await invoke<Record<string, unknown> | null>("db_get_deleted_record", {
      tableName: TABLE_NAME,
      id
    }));

  if (existingRecord) {
    const existing = toPreference(existingRecord);
    const updated: ResearchTraceEventPreference = {
      ...existing,
      visibility: input.visibility,
      note: input.note,
      updatedAt: timestamp,
      deletedAt: null
    };
    await savePreference(updated);
    return clonePreference(updated);
  }

  const created: ResearchTraceEventPreference = {
    id,
    projectId: input.projectId,
    targetType: input.targetType,
    targetId: input.targetId,
    visibility: input.visibility,
    note: input.note,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null
  };
  await savePreference(created);
  return clonePreference(created);
}

export async function deleteResearchTracePreference(
  projectId: string,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
): Promise<void> {
  const id = createPreferenceId(projectId, targetType, targetId);
  const timestamp = new Date().toISOString();
  await invoke("db_soft_delete_record", {
    tableName: TABLE_NAME,
    id,
    updatedAt: timestamp,
    deletedAt: timestamp
  });
  await invoke("db_hard_delete_record", {
    tableName: TABLE_NAME,
    id
  });
}

export async function clearResearchTracePreferenceRepositoryForTests() {
  const records = [
    ...(await listActiveRecords()),
    ...(await invoke<Record<string, unknown>[]>("db_list_deleted_records", {
      tableName: TABLE_NAME
    }))
  ];
  for (const record of records) {
    const id = asString(record.id);
    if (!id) {
      continue;
    }
    await invoke("db_soft_delete_record", {
      tableName: TABLE_NAME,
      id,
      updatedAt: new Date().toISOString(),
      deletedAt: new Date().toISOString()
    });
    await invoke("db_hard_delete_record", {
      tableName: TABLE_NAME,
      id
    });
  }
}

export const projectResearchTracePreferenceRepository = {
  listResearchTracePreferences,
  getResearchTracePreference,
  upsertResearchTracePreference,
  deleteResearchTracePreference,
  clearResearchTracePreferenceRepositoryForTests
};

export type ProjectResearchTracePreferenceRepository =
  typeof projectResearchTracePreferenceRepository;
