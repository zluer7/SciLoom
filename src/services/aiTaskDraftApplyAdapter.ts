import type {
  AIActionDraft,
  AIActionDraftApplyResult,
  AITaskCreateDraftPayload
} from "../types/aiDraft";
import type { Priority, TaskStatus, TaskType, TimeBucket } from "../types/planning";
import { planningService } from "./planningService";

type CreateTaskService = typeof planningService.createTask;
type GetProjectService = typeof planningService.getProjectById;
type GetRouteNodeService = typeof planningService.getRouteNodeById;

export interface ApplyAITaskDraftOptions {
  draft: AIActionDraft<"task_create">;
  appliedAt?: string;
  createTask?: CreateTaskService;
  getProjectById?: GetProjectService;
  getRouteNodeById?: GetRouteNodeService;
}

const PRIORITIES = new Set<Priority>(["high", "medium", "low"]);
const TASK_STATUSES = new Set<Exclude<TaskStatus, "done" | "archived">>([
  "todo",
  "doing",
  "delayed",
  "blocked",
  "cancelled"
]);
const TASK_TYPES = new Set<TaskType>([
  "reading",
  "experiment",
  "coding",
  "writing",
  "analysis",
  "meeting",
  "idea",
  "review",
  "other"
]);
const TIME_BUCKETS = new Set<TimeBucket>([
  "today",
  "this_week",
  "this_month",
  "long_term",
  "none"
]);

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failedResult(
  draftId: string,
  appliedAt: string,
  errorCode: string,
  message: string
): AIActionDraftApplyResult {
  return {
    success: false,
    result: "failed",
    message,
    errorCode,
    errorMessage: message,
    sourceDraftId: draftId,
    appliedAt
  };
}

function taskPayload(draft: AIActionDraft<"task_create">): AITaskCreateDraftPayload | undefined {
  const payload: unknown = draft.proposedPayload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as AITaskCreateDraftPayload)
    : undefined;
}

export async function applyAITaskDraft({
  draft,
  appliedAt = new Date().toISOString(),
  createTask = planningService.createTask,
  getProjectById = planningService.getProjectById,
  getRouteNodeById = planningService.getRouteNodeById
}: ApplyAITaskDraftOptions): Promise<AIActionDraftApplyResult> {
  const payload = taskPayload(draft);
  if (!payload) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_task_payload",
      "task_create requires a structured proposedPayload."
    );
  }
  const projectId = textValue(payload.projectId);
  const title = textValue(payload.title);
  if (!projectId || !title) {
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "invalid_task_payload",
      "task_create requires non-empty projectId and title."
    );
  }

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      return failedResult(
        draft.draftInstanceId,
        appliedAt,
        "project_not_found",
        `Task creation target Project was not found: ${projectId}.`
      );
    }
    const routeNodeId = textValue(payload.routeNodeId);
    if (routeNodeId) {
      const routeNode = await getRouteNodeById(routeNodeId);
      if (!routeNode || routeNode.projectId !== projectId) {
        return failedResult(
          draft.draftInstanceId,
          appliedAt,
          "route_node_not_found",
          `Task creation target RouteNode was not found in Project ${projectId}: ${routeNodeId}.`
        );
      }
    }
    const task = await createTask({
      projectId,
      routeNodeId,
      title,
      description: textValue(payload.description),
      priority: payload.priority && PRIORITIES.has(payload.priority) ? payload.priority : "medium",
      status: payload.status && TASK_STATUSES.has(payload.status) ? payload.status : "todo",
      taskType: payload.taskType && TASK_TYPES.has(payload.taskType) ? payload.taskType : "other",
      timeBucket:
        payload.timeBucket && TIME_BUCKETS.has(payload.timeBucket) ? payload.timeBucket : "none",
      scheduledDate: textValue(payload.scheduledDate),
      dueDate: textValue(payload.dueDate),
      tags: Array.isArray(payload.tags)
        ? payload.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [],
      captureState: "pending",
      orderIndex: 0
    });

    return {
      success: true,
      result: "written",
      message: `Created Task ${task.id} from AI draft ${draft.draftInstanceId}. Source references retained on the draft: ${draft.sourceRefs.length}.`,
      createdEntity: {
        module: "task",
        entityType: "task",
        entityId: task.id,
        label: task.title
      },
      sourceDraftId: draft.draftInstanceId,
      appliedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown task creation error.";
    return failedResult(
      draft.draftInstanceId,
      appliedAt,
      "task_create_failed",
      `Task creation failed: ${message}`
    );
  }
}
