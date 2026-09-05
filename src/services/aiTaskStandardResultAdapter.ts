import type {
  AIStandardResultAction,
  AIStandardResultEffectReceipt,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { Priority, Task, TaskStatus, TaskType, TimeBucket, UpdateEntityInput } from "../types/planning";
import { planningService } from "./planningService";
import {
  canonicalAIStandardResultFingerprint,
  readAIStandardResultBlockingValidationIssues
} from "./aiStandardResultService";

const PRIORITIES = new Set<Priority>(["high", "medium", "low"]);
const STATUSES = new Set<Exclude<TaskStatus, "done" | "archived">>([
  "todo", "doing", "delayed", "blocked", "cancelled"
]);
const TOLERANT_STATUS_ALIASES = new Map<string, Exclude<TaskStatus, "done" | "archived">>([
  ["planned", "todo"],
  ["pending", "todo"],
  ["active", "doing"],
  ["in_progress", "doing"],
  ["paused", "delayed"]
]);
const TASK_TYPES = new Set<TaskType>([
  "reading", "experiment", "coding", "writing", "analysis", "meeting", "idea", "review", "other"
]);
const TIME_BUCKETS = new Set<TimeBucket>([
  "today", "this_week", "this_month", "long_term", "none"
]);

const EDITABLE_FIELDS = new Set([
  "title",
  "description",
  "routeNodeId",
  "priority",
  "status",
  "taskType",
  "timeBucket",
  "scheduledDate",
  "dueDate",
  "timeLabel",
  "acceptanceCriteria",
  "blockedReason",
  "tags"
]);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

type TaskServices = Pick<
  typeof planningService,
  "createTask" | "updateTask" | "getTaskById" | "getProjectById" | "getRouteNodeById"
>;

export type AITaskStandardResultValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
};

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedRequiredText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > maxChars || value.includes("\0")) {
    issues.push(issue("TASK_FIELD_INVALID", `${field} must contain 1-${maxChars} characters.`, field));
    return undefined;
  }
  return value.trim();
}

function boundedOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedRequiredText(value, field, maxChars, issues);
}

function optionalDate(
  value: unknown,
  field: string,
  issues: AIStandardResultValidationIssue[]
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    issues.push(issue("TASK_DATE_INVALID", `${field} must be a valid YYYY-MM-DD date.`, field));
    return undefined;
  }
  return value;
}

function taskSnapshotFingerprint(task: Task): string {
  return canonicalAIStandardResultFingerprint({
    id: task.id,
    projectId: task.projectId,
    routeNodeId: task.routeNodeId ?? null,
    title: task.title,
    description: task.description ?? null,
    priority: task.priority,
    status: task.status,
    taskType: task.taskType,
    timeBucket: task.timeBucket,
    scheduledDate: task.scheduledDate ?? null,
    dueDate: task.dueDate ?? null,
    timeLabel: task.timeLabel ?? null,
    acceptanceCriteria: task.acceptanceCriteria ?? null,
    blockedReason: task.blockedReason ?? null,
    tags: [...task.tags],
    updatedAt: task.updatedAt,
    deletedAt: task.deletedAt ?? null
  });
}

function normalizePayload(
  action: "CREATE" | "UPDATE",
  value: unknown,
  existingTask: Task | undefined,
  issues: AIStandardResultValidationIssue[]
): Record<string, unknown> {
  const payload = asRecord(value);
  if (!payload) {
    issues.push(issue("TASK_PAYLOAD_INVALID", "The visible Task payload must be one JSON object."));
    return {};
  }
  for (const key of Object.keys(payload)) {
    if (!EDITABLE_FIELDS.has(key)) {
      issues.push(issue("TASK_FIELD_UNSUPPORTED", `${key} is not an editable Task field.`, key));
    }
  }
  if (action === "UPDATE" && Object.keys(payload).length === 0) {
    issues.push(issue("TASK_UPDATE_EMPTY", "Task UPDATE requires at least one visible field change."));
  }
  const normalized: Record<string, unknown> = {};
  if (action === "CREATE" || hasOwn(payload, "title")) {
    const title = boundedRequiredText(payload.title, "title", 200, issues);
    if (title !== undefined) normalized.title = title;
  }
  for (const [field, limit] of [
    ["description", 4_000],
    ["routeNodeId", 200],
    ["timeLabel", 200],
    ["acceptanceCriteria", 2_000],
    ["blockedReason", 1_000]
  ] as const) {
    if (hasOwn(payload, field)) {
      normalized[field] = boundedOptionalText(payload[field], field, limit, issues);
    }
  }
  if (action === "CREATE" || hasOwn(payload, "priority")) {
    const value = payload.priority ?? "medium";
    if (typeof value !== "string" || !PRIORITIES.has(value as Priority)) {
      issues.push(issue("TASK_ENUM_INVALID", "priority is unsupported.", "priority"));
    } else normalized.priority = value;
  }
  if (action === "CREATE" || hasOwn(payload, "status")) {
    const value = payload.status ?? "todo";
    const normalizedStatus = typeof value === "string"
      ? TOLERANT_STATUS_ALIASES.get(value) ?? value
      : value;
    if (
      typeof normalizedStatus !== "string" ||
      !STATUSES.has(normalizedStatus as Exclude<TaskStatus, "done" | "archived">)
    ) {
      issues.push(issue("TASK_ENUM_INVALID", "status cannot complete/archive a Task and must be a supported active status.", "status"));
    } else normalized.status = normalizedStatus;
  }
  if (action === "CREATE" || hasOwn(payload, "taskType")) {
    const value = payload.taskType ?? "other";
    if (typeof value !== "string" || !TASK_TYPES.has(value as TaskType)) {
      issues.push(issue("TASK_ENUM_INVALID", "taskType is unsupported.", "taskType"));
    } else normalized.taskType = value;
  }
  if (action === "CREATE" || hasOwn(payload, "timeBucket")) {
    const value = payload.timeBucket ?? "none";
    if (typeof value !== "string" || !TIME_BUCKETS.has(value as TimeBucket)) {
      issues.push(issue("TASK_ENUM_INVALID", "timeBucket is unsupported.", "timeBucket"));
    } else normalized.timeBucket = value;
  }
  for (const field of ["scheduledDate", "dueDate"] as const) {
    if (hasOwn(payload, field)) normalized[field] = optionalDate(payload[field], field, issues);
  }
  if (hasOwn(payload, "tags")) {
    if (
      !Array.isArray(payload.tags) || payload.tags.length > 12 ||
      payload.tags.some((tag) => typeof tag !== "string" || !tag.trim() || Array.from(tag.trim()).length > 60)
    ) {
      issues.push(issue("TASK_TAGS_INVALID", "tags must contain at most 12 non-empty values of at most 60 characters.", "tags"));
    } else {
      normalized.tags = [...new Set(payload.tags.map((tag) => (tag as string).trim()))];
    }
  }
  const resultingStatus = (normalized.status ?? existingTask?.status ?? "todo") as TaskStatus;
  const resultingBlockedReason = normalized.blockedReason ?? existingTask?.blockedReason;
  if (resultingStatus === "blocked" && (typeof resultingBlockedReason !== "string" || !resultingBlockedReason.trim())) {
    issues.push(issue("TASK_BLOCK_REASON_REQUIRED", "blockedReason is required when status is blocked.", "blockedReason"));
  }
  const scheduledDate = normalized.scheduledDate ?? existingTask?.scheduledDate;
  const dueDate = normalized.dueDate ?? existingTask?.dueDate;
  if (typeof scheduledDate === "string" && typeof dueDate === "string" && dueDate < scheduledDate) {
    issues.push(issue("TASK_DATE_ORDER_INVALID", "dueDate cannot be earlier than scheduledDate.", "dueDate"));
  }
  return normalized;
}

export async function validateAITaskStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  services?: TaskServices;
}): Promise<AITaskStandardResultValidation> {
  const services = input.services ?? planningService;
  const issues: AIStandardResultValidationIssue[] = [];
  if (input.target.projectId !== input.expectedProjectId) {
    issues.push(issue("TASK_SCOPE_MISMATCH", "The proposed Task scope crosses the reviewed Project.", "target.projectId"));
  }
  if (input.action === "DELETE_SUGGESTION") {
    const targetId = input.target.entityId;
    const task = targetId ? await services.getTaskById(targetId) : undefined;
    if (!task || task.projectId !== input.expectedProjectId || task.status === "archived" || task.deletedAt) {
      issues.push(issue("TASK_TARGET_UNAVAILABLE", "The delete suggestion target is unavailable in the reviewed Project."));
    }
    const payload = asRecord(input.payload);
    const reason = boundedRequiredText(payload?.reason, "reason", 1_000, issues);
    return {
      executable: false,
      normalizedPayload: reason ? { reason } : {},
      validationIssues: readAIStandardResultBlockingValidationIssues(issues).length > 0
        ? issues
        : [issue("DELETE_SUGGESTION_INFORMATIONAL_ONLY", "DELETE_SUGGESTION has no AI executor; use the existing Task deletion flow.")],
      ...(task ? { targetSnapshotFingerprint: taskSnapshotFingerprint(task) } : {})
    };
  }
  if (input.action === "NEW_MANUSCRIPT") {
    return {
      executable: false,
      normalizedPayload: asRecord(input.payload) ?? {},
      validationIssues: [issue("NEW_MANUSCRIPT_RESERVED", "NEW_MANUSCRIPT is recognized but not executable in LP13-B1-A6.")]
    };
  }
  if (input.action !== "CREATE" && input.action !== "UPDATE") {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [issue("TASK_ACTION_UNSUPPORTED", "The Task action is unsupported.")]
    };
  }
  const project = await services.getProjectById(input.expectedProjectId);
  if (!project || project.deletedAt) {
    issues.push(issue("TASK_PROJECT_UNAVAILABLE", "The reviewed Project is unavailable."));
  }
  let task: Task | undefined;
  if (input.action === "UPDATE") {
    task = input.target.entityId ? await services.getTaskById(input.target.entityId) : undefined;
    if (!task) {
      issues.push(issue("TASK_TARGET_UNAVAILABLE", "The canonical Task target is missing or deleted."));
    } else if (task.projectId !== input.expectedProjectId) {
      issues.push(issue("TASK_SCOPE_MISMATCH", "The canonical Task target moved outside the reviewed Project."));
    } else if (task.status === "archived" || task.deletedAt) {
      issues.push(issue("TASK_TARGET_LIFECYCLE_UNSUPPORTED", "Deleted or archived Tasks cannot be updated from a Standard Result."));
    }
  }
  const normalizedPayload = normalizePayload(input.action, input.payload, task, issues);
  const routeNodeId = normalizedPayload.routeNodeId;
  if (typeof routeNodeId === "string") {
    const route = await services.getRouteNodeById(routeNodeId);
    if (!route || route.deletedAt || route.projectId !== input.expectedProjectId) {
      issues.push(issue("TASK_ROUTE_SCOPE_MISMATCH", "routeNodeId is unavailable in the reviewed Project.", "routeNodeId"));
    }
  }
  const currentTargetFingerprint = task ? taskSnapshotFingerprint(task) : undefined;
  if (
    input.expectedTargetSnapshotFingerprint &&
    currentTargetFingerprint !== input.expectedTargetSnapshotFingerprint
  ) {
    issues.push(issue("TASK_TARGET_STALE", "The canonical Task changed after Parse Draft; re-parse is required."));
  }
  return {
    executable: readAIStandardResultBlockingValidationIssues(issues).length === 0,
    normalizedPayload,
    validationIssues: issues,
    ...(currentTargetFingerprint ? { targetSnapshotFingerprint: currentTargetFingerprint } : {})
  };
}

function canonicalTaskReadback(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    projectId: task.projectId,
    routeNodeId: task.routeNodeId ?? null,
    title: task.title,
    description: task.description ?? null,
    priority: task.priority,
    status: task.status,
    taskType: task.taskType,
    timeBucket: task.timeBucket,
    scheduledDate: task.scheduledDate ?? null,
    dueDate: task.dueDate ?? null,
    tags: [...task.tags],
    updatedAt: task.updatedAt
  };
}

export async function invokeAITaskStandardResultEffect(input: {
  action: "CREATE" | "UPDATE";
  target: AIStandardResultTarget;
  normalizedPayload: Record<string, unknown>;
  services?: TaskServices;
}): Promise<AIStandardResultEffectReceipt> {
  const services = input.services ?? planningService;
  if (input.action === "CREATE") {
    const payload = input.normalizedPayload;
    const task = await services.createTask({
      projectId: input.target.projectId,
      title: payload.title as string,
      description: payload.description as string | undefined,
      routeNodeId: payload.routeNodeId as string | undefined,
      priority: payload.priority as Priority,
      status: payload.status as Exclude<TaskStatus, "done" | "archived">,
      taskType: payload.taskType as TaskType,
      timeBucket: payload.timeBucket as TimeBucket,
      scheduledDate: payload.scheduledDate as string | undefined,
      dueDate: payload.dueDate as string | undefined,
      timeLabel: payload.timeLabel as string | undefined,
      acceptanceCriteria: payload.acceptanceCriteria as string | undefined,
      blockedReason: payload.blockedReason as string | undefined,
      tags: (payload.tags as string[] | undefined) ?? [],
      captureState: "pending",
      orderIndex: 0
    });
    const readback = await services.getTaskById(task.id);
    if (!readback || readback.projectId !== input.target.projectId) {
      throw new Error("The canonical Task CREATE readback did not match its reviewed Project.");
    }
    return {
      module: "task",
      entityType: "task",
      entityId: readback.id,
      operation: "CREATE",
      service: "planningService.createTask",
      canonicalReadback: canonicalTaskReadback(readback)
    };
  }
  const entityId = input.target.entityId;
  if (!entityId) throw new Error("Task UPDATE requires a canonical target identity.");
  const updated = await services.updateTask(entityId, input.normalizedPayload as UpdateEntityInput<Task>);
  const readback = updated ? await services.getTaskById(entityId) : undefined;
  if (!readback || readback.projectId !== input.target.projectId) {
    throw new Error("The canonical Task UPDATE readback did not match its reviewed target.");
  }
  return {
    module: "task",
    entityType: "task",
    entityId: readback.id,
    operation: "UPDATE",
    service: "planningService.updateTask",
    canonicalReadback: canonicalTaskReadback(readback)
  };
}
