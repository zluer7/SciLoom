import type { EntityId } from "../types";
import type {
  ActorType,
  BaseEntity,
  ChangeAction,
  ChangeLog,
  EntityLink,
  EntityType,
  PlanningData,
  Priority,
  Project,
  ProjectStatus,
  ResearchRoutine,
  Review,
  ReviewType,
  RouteNode,
  RouteCheckpoint,
  RouteCheckpointStatus,
  RouteNodeStatus,
  RoutineCheckIn,
  RoutineFrequency,
  RoutineTargetType,
  Task,
  TaskCheckpoint,
  TaskCheckpointStatus,
  TaskStatus,
  TimeBucket,
  UpdateEntityInput
} from "../types/planning";
import { entityLinkService } from "./entityLinkService";
import {
  normalizeReviewType,
  reconcileReviewOutlineSections
} from "./reviewCoreContractService";
import {
  provisionReviewStructuredState,
  readReviewStructuredStates,
  replaceReviewStructuredState,
  type ReviewStructuredStateRecord
} from "./reviewStructuredStateService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createWriteFeedbackResult, toWriteFeedbackMessage } from "./writeFeedbackService";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";
import type {
  AffectedEntity,
  AffectedScope,
  RefreshKey,
  WriteFeedbackResult,
  WriteFeedbackStatus
} from "../types/writeFeedback";
import type { ReviewManuscriptProvisioningResult } from "../types/provisioning";
import {
  PLANNING_SCHEMA_VERSION,
  archiveTask as archivePlanningTask,
  createProject as createPlanningProject,
  createResearchRoutine as createPlanningResearchRoutine,
  createRouteCheckpoint as createPlanningRouteCheckpoint,
  createRoutineCheckIn as createPlanningRoutineCheckIn,
  createTaskCheckpoint as createPlanningTaskCheckpoint,
  createReview as createPlanningReview,
  createRouteNode as createPlanningRouteNode,
  createTask as createPlanningTask,
  deleteResearchRoutine as deletePlanningResearchRoutine,
  deleteProject as deletePlanningProject,
  deleteRouteCheckpoint as deletePlanningRouteCheckpoint,
  deleteTaskCheckpoint as deletePlanningTaskCheckpoint,
  deleteRouteNode as deletePlanningRouteNode,
  deleteTask as deletePlanningTask,
  getPlanningFirstLayerData,
  getPlanningData,
  normalizeRouteDate,
  replaceReviewSummarizesTargetLinks,
  updateProject as updatePlanningProject,
  updateResearchRoutine as updatePlanningResearchRoutine,
  updateReview as updatePlanningReview,
  updateRouteCheckpoint as updatePlanningRouteCheckpoint,
  updateTaskCheckpoint as updatePlanningTaskCheckpoint,
  updateRouteNode as updatePlanningRouteNode,
  updateTask as updatePlanningTask,
  type PlanningPersistedReview
} from "./planningRepository";
import { experimentService } from "./experimentService";
import { experimentRunService } from "./experimentRunService";
import { literatureService } from "./literatureService";
import {
  isReviewFormalLinkTargetType,
  queryReviewTargetSummariesFromSnapshot,
  uniqueReviewTargets,
  validateReviewTargetContractInSnapshot,
  type ReviewLinkTargetType,
  type ReviewTargetInput,
  type ReviewTargetSnapshotSummary,
  type ReviewTargetSnapshotSummaryMap,
  type ReviewTargetSummary
} from "./reviewTargetEntityLinkService";
import { ensureReviewManuscriptProvisioning } from "./reviewManuscriptProvisioningService";
import { softDeleteReview } from "./reviewDeleteSafetyService";

type CreateProjectInput = Parameters<typeof createPlanningProject>[0];
type CreateRouteNodeInput = Parameters<typeof createPlanningRouteNode>[0];
type CreateRouteCheckpointInput = Parameters<typeof createPlanningRouteCheckpoint>[0];
type CreateTaskCheckpointInput = Parameters<typeof createPlanningTaskCheckpoint>[0];
type CreateResearchRoutineInput = Parameters<typeof createPlanningResearchRoutine>[0];
type CreateRoutineCheckInInput = Parameters<typeof createPlanningRoutineCheckIn>[0];
type CreateTaskInput = Parameters<typeof createPlanningTask>[0];
type BaseCreateReviewInput = Parameters<typeof createPlanningReview>[0];

export type ReviewTargetType = ReviewLinkTargetType;
export type { ReviewTargetInput, ReviewTargetSummary };

export type CreateReviewInput = BaseCreateReviewInput & {
  targets?: ReviewTargetInput[];
};

export type ValidatedCreateReviewInput = Omit<
  CreateReviewInput,
  "targets" | "reviewType" | "outlineSections"
> & {
  targets: ReviewTargetInput[];
  reviewType: Review["reviewType"];
  outlineSections: Review["outlineSections"];
};

export type CreateReviewResult = Review & {
  provisioning: ReviewManuscriptProvisioningResult;
};

export type UpdateReviewInput = UpdateEntityInput<Review> & {
  targets?: ReviewTargetInput[];
};

export class ReviewDurableConcernError extends Error {
  constructor(
    readonly code: "REVIEW_SECOND_LAYER_PROVISION_FAILED" | "REVIEW_EDIT_PARTIALLY_APPLIED",
    readonly reviewId: EntityId,
    readonly firstLayerCommitted: boolean,
    cause: unknown
  ) {
    super(code);
    this.name = "ReviewDurableConcernError";
    Object.defineProperty(this, "cause", { configurable: true, value: cause });
  }
}

function composeReviewStructuredState(
  review: Review | PlanningPersistedReview,
  state: ReviewStructuredStateRecord
): Review {
  return {
    ...review,
    reviewType: state.reviewType,
    outlineSections: state.outlineSections,
    structuredRevision: state.structuredRevision,
    descriptorIdentity: state.descriptorIdentity,
    structuredLifecycleEvidence: state.lifecycleEvidence,
    structuredLifecycleStatus: state.lifecycleStatus
  };
}

export type ProjectQueryOptions = {
  directionId?: EntityId;
  status?: ProjectStatus;
  priority?: Priority;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  search?: string;
};

export type RouteNodeQueryOptions = {
  projectId?: EntityId;
  parentNodeId?: EntityId;
  status?: RouteNodeStatus;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  search?: string;
};

export type RouteCheckpointQueryOptions = {
  routeNodeId?: EntityId;
  routeNodeIds?: EntityId[];
  status?: RouteCheckpointStatus;
  includeDeleted?: boolean;
  search?: string;
};

export type TaskCheckpointQueryOptions = {
  taskId?: EntityId;
  taskIds?: EntityId[];
  status?: TaskCheckpointStatus;
  includeDeleted?: boolean;
  search?: string;
};

export type ResearchRoutineQueryOptions = {
  projectId?: EntityId;
  projectIds?: EntityId[];
  frequency?: RoutineFrequency;
  targetType?: RoutineTargetType;
  isActive?: boolean;
  includeDeleted?: boolean;
  includeGlobal?: boolean;
  search?: string;
};

export type RoutineCheckInQueryOptions = {
  routineId?: EntityId;
  routineIds?: EntityId[];
  projectId?: EntityId;
  periodKey?: string;
  includeDeleted?: boolean;
  search?: string;
};

export type TaskQueryOptions = {
  projectId?: EntityId;
  routeNodeId?: EntityId;
  status?: TaskStatus;
  priority?: Priority;
  timeBucket?: TimeBucket;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  search?: string;
};

export type ReviewQueryOptions = {
  projectId?: EntityId;
  reviewType?: ReviewType;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  search?: string;
};

export type ReviewFirstLayerQueryOptions = Omit<ReviewQueryOptions, "reviewType">;
export type ReviewFirstLayerIdentity = PlanningPersistedReview;
export type ReviewCatalogEntry = PlanningPersistedReview & {
  reviewType?: ReviewType;
  structuredStateStatus: "available" | "not_provisioned";
};

export type ArchiveOptions = {
  note?: string;
};

export type RestoreRouteNodeOptions = {
  status?: RouteNodeStatus;
  note?: string;
};

export type RestoreTaskOptions = {
  status?: TaskStatus;
  note?: string;
};

export type RestoreReviewOptions = {
  note?: string;
};

export type CompleteTaskOptions = {
  completionNote?: string;
  patch?: UpdateEntityInput<Task>;
};

export type ReopenTaskOptions = {
  status?: TaskStatus;
  note?: string;
  patch?: UpdateEntityInput<Task>;
};

export type PostponeTaskOptions = {
  dueDate?: string;
  scheduledDate?: string;
  reason?: string;
  patch?: UpdateEntityInput<Task>;
};

function now() {
  return new Date().toISOString();
}

function publishPlanningWriteFeedback(feedback: WriteFeedbackResult | undefined, reason: string) {
  if (!feedback) return;
  publishWriteFeedbackRefresh(feedback, {
    source: "service.write",
    reason
  });
}

function publishProjectWriteFeedback(
  operation: string,
  projectId: EntityId,
  project: Project | undefined,
  relation: AffectedEntity["relation"] = "updated"
) {
  publishPlanningWriteFeedback(
    createWriteFeedbackResult({
      status: project ? "success" : "skipped",
      operation,
      data: project,
      affectedEntities: [
        {
          type: "project",
          id: projectId,
          relation: project ? relation : "skipped",
          label: project?.title
        }
      ],
      affectedScopes: [
        {
          module: "project",
          projectId,
          reason: `${operation} changed Project metadata.`
        },
        {
          module: "planning",
          projectId,
          reason: "Planning project options may need to reload."
        },
        {
          module: "global",
          projectId,
          reason: "Pages with project selectors may need to reload."
        }
      ],
      refreshKeys: ["project.changed", "global.changed"],
      warnings: project ? [] : ["Project write did not return a project."],
      skipped: project ? [] : ["project_not_found"]
    }),
    operation
  );
}

function createRouteNodeWriteFeedback(
  operation: string,
  routeNodeId: EntityId,
  routeNode: RouteNode | undefined,
  relation: AffectedEntity["relation"] = "updated",
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
  } = {}
): WriteFeedbackResult<RouteNode | undefined> {
  const warnings = [...(options.warnings ?? [])];
  const skipped = [...(options.skipped ?? [])];
  const status =
    options.status ??
    (!routeNode ? "skipped" : warnings.length > 0 || skipped.length > 0 ? "partial" : "success");

  return createWriteFeedbackResult({
    status,
    operation,
    data: routeNode,
    affectedEntities: [
      {
        type: "routeNode",
        id: routeNodeId,
        relation: routeNode ? relation : "skipped",
        label: routeNode?.title
      }
    ],
    affectedScopes: [
      {
        module: "route",
        projectId: routeNode?.projectId,
        routeNodeId,
        reason: `${operation} changed RouteNode metadata.`
      },
      {
        module: "planning",
        projectId: routeNode?.projectId,
        routeNodeId,
        reason: "Planning route views may need to reload."
      },
      {
        module: "ai",
        projectId: routeNode?.projectId,
        routeNodeId,
        reason: "AI context can include route progress state."
      }
    ],
    refreshKeys: ["route.changed", "reviewContext.changed", "aiContext.changed"],
    warnings: routeNode ? warnings : [...warnings, "RouteNode write did not return a route node."],
    skipped: routeNode ? skipped : [...skipped, "route_node_not_found"],
    messages: [
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    partial: status === "partial" || warnings.length > 0 || skipped.length > 0
  });
}

function publishRouteNodeWriteFeedback(
  operation: string,
  routeNodeId: EntityId,
  routeNode: RouteNode | undefined,
  relation: AffectedEntity["relation"] = "updated",
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
  } = {}
) {
  publishPlanningWriteFeedback(
    createRouteNodeWriteFeedback(operation, routeNodeId, routeNode, relation, options),
    operation
  );
}

function createRouteCheckpointWriteFeedback(
  operation: string,
  checkpointId: EntityId,
  checkpoint: RouteCheckpoint | undefined,
  relation: AffectedEntity["relation"] = "updated",
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
  } = {}
): WriteFeedbackResult<RouteCheckpoint | undefined> {
  const warnings = [...(options.warnings ?? [])];
  const skipped = [...(options.skipped ?? [])];
  const status =
    options.status ??
    (!checkpoint ? "skipped" : warnings.length > 0 || skipped.length > 0 ? "partial" : "success");

  return createWriteFeedbackResult({
    status,
    operation,
    data: checkpoint,
    affectedEntities: [
      {
        type: "routeCheckpoint",
        id: checkpointId,
        relation: checkpoint ? relation : "skipped",
        label: checkpoint?.title
      },
      ...(checkpoint
        ? [
            {
              type: "routeNode",
              id: checkpoint.routeNodeId,
              relation: "updated" as const
            }
          ]
        : [])
    ],
    affectedScopes: [
      {
        module: "route",
        routeNodeId: checkpoint?.routeNodeId,
        reason: `${operation} changed RouteCheckpoint progress.`
      },
      {
        module: "planning",
        routeNodeId: checkpoint?.routeNodeId,
        reason: "Route progress summaries may need to reload."
      },
      {
        module: "ai",
        routeNodeId: checkpoint?.routeNodeId,
        reason: "AI context can include route checkpoint progress."
      }
    ],
    refreshKeys: ["route.changed", "reviewContext.changed", "aiContext.changed"],
    warnings: checkpoint ? warnings : [...warnings, "RouteCheckpoint write did not return data."],
    skipped: checkpoint ? skipped : [...skipped, "route_checkpoint_not_found"],
    messages: [
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    partial: status === "partial" || warnings.length > 0 || skipped.length > 0
  });
}

function createTaskCheckpointWriteFeedback(
  operation: string,
  checkpointId: EntityId,
  checkpoint: TaskCheckpoint | undefined,
  relation: AffectedEntity["relation"] = "updated",
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
  } = {}
): WriteFeedbackResult<TaskCheckpoint | undefined> {
  const warnings = [...(options.warnings ?? [])];
  const skipped = [...(options.skipped ?? [])];
  const status =
    options.status ??
    (!checkpoint ? "skipped" : warnings.length > 0 || skipped.length > 0 ? "partial" : "success");

  return createWriteFeedbackResult({
    status,
    operation,
    data: checkpoint,
    affectedEntities: [
      {
        type: "taskCheckpoint",
        id: checkpointId,
        relation: checkpoint ? relation : "skipped",
        label: checkpoint?.title
      },
      ...(checkpoint
        ? [
            {
              type: "task",
              id: checkpoint.taskId,
              relation: "updated" as const
            }
          ]
        : [])
    ],
    affectedScopes: [
      {
        module: "task",
        taskId: checkpoint?.taskId,
        reason: `${operation} changed TaskCheckpoint progress.`
      },
      {
        module: "review",
        taskId: checkpoint?.taskId,
        reason: "Review context can include Task checkpoint progress."
      },
      {
        module: "ai",
        taskId: checkpoint?.taskId,
        reason: "AI context can include Task checkpoint progress summary."
      }
    ],
    refreshKeys: ["task.changed", "reviewContext.changed", "aiContext.changed"],
    warnings: checkpoint ? warnings : [...warnings, "TaskCheckpoint write did not return data."],
    skipped: checkpoint ? skipped : [...skipped, "task_checkpoint_not_found"],
    messages: [
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    partial: status === "partial" || warnings.length > 0 || skipped.length > 0
  });
}

function createResearchRoutineWriteFeedback(
  operation: string,
  routineId: EntityId,
  routine: ResearchRoutine | undefined,
  relation: AffectedEntity["relation"] = "updated",
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
  } = {}
): WriteFeedbackResult<ResearchRoutine | undefined> {
  const warnings = [...(options.warnings ?? [])];
  const skipped = [...(options.skipped ?? [])];
  const status =
    options.status ??
    (!routine ? "skipped" : warnings.length > 0 || skipped.length > 0 ? "partial" : "success");

  return createWriteFeedbackResult({
    status,
    operation,
    data: routine,
    affectedEntities: [
      {
        type: "researchRoutine",
        id: routineId,
        relation: routine ? relation : "skipped",
        label: routine?.title
      }
    ],
    affectedScopes: [
      {
        module: "task",
        projectId: routine?.projectId,
        reason: `${operation} changed a ResearchRoutine summary source.`
      },
      {
        module: "review",
        projectId: routine?.projectId,
        reason: "Review context can include routine current-period summaries."
      },
      {
        module: "ai",
        projectId: routine?.projectId,
        reason: "AI context can read routine summaries through selector/context only."
      }
    ],
    refreshKeys: [
      "routine.changed",
      "task.changed",
      "reviewContext.changed",
      "aiContext.changed"
    ] as RefreshKey[],
    warnings: routine ? warnings : [...warnings, "ResearchRoutine write did not return data."],
    skipped: routine ? skipped : [...skipped, "research_routine_not_found"],
    messages: [
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    partial: status === "partial" || warnings.length > 0 || skipped.length > 0
  });
}

function createRoutineCheckInWriteFeedback(
  operation: string,
  checkInId: EntityId,
  checkIn: RoutineCheckIn | undefined,
  routine: ResearchRoutine | undefined,
  relation: AffectedEntity["relation"] = "updated",
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
  } = {}
): WriteFeedbackResult<RoutineCheckIn | undefined> {
  const warnings = [...(options.warnings ?? [])];
  const skipped = [...(options.skipped ?? [])];
  const status =
    options.status ??
    (!checkIn ? "skipped" : warnings.length > 0 || skipped.length > 0 ? "partial" : "success");

  return createWriteFeedbackResult({
    status,
    operation,
    data: checkIn,
    affectedEntities: [
      {
        type: "routineCheckIn",
        id: checkInId,
        relation: checkIn ? relation : "skipped",
        label: checkIn?.title
      },
      ...(checkIn
        ? [
            {
              type: "researchRoutine",
              id: checkIn.routineId,
              relation: "updated" as const,
              label: routine?.title
            }
          ]
        : [])
    ],
    affectedScopes: [
      {
        module: "task",
        projectId: checkIn?.projectId ?? routine?.projectId,
        reason: `${operation} changed a RoutineCheckIn current-period summary source.`
      },
      {
        module: "review",
        projectId: checkIn?.projectId ?? routine?.projectId,
        reason: "Review context can include routine check-in summaries."
      },
      {
        module: "ai",
        projectId: checkIn?.projectId ?? routine?.projectId,
        reason: "AI context can read routine summaries through selector/context only."
      }
    ],
    refreshKeys: [
      "routine.checkin.changed",
      "routine.changed",
      "task.changed",
      "reviewContext.changed",
      "aiContext.changed"
    ] as RefreshKey[],
    warnings: checkIn ? warnings : [...warnings, "RoutineCheckIn write did not return data."],
    skipped: checkIn ? skipped : [...skipped, "routine_check_in_not_found"],
    messages: [
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    partial: status === "partial" || warnings.length > 0 || skipped.length > 0
  });
}

function taskSourceOutputGapId(task?: Task) {
  const sourceOutputGapId = task?.customFields?.sourceOutputGapId;
  return typeof sourceOutputGapId === "string" && sourceOutputGapId.trim()
    ? sourceOutputGapId.trim()
    : undefined;
}

function createTaskWriteFeedback(
  operation: string,
  taskId: EntityId,
  task: Task | undefined,
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
    relation?: AffectedEntity["relation"];
  } = {}
): WriteFeedbackResult<Task | undefined> {
  const warnings = [...(options.warnings ?? [])];
  const skipped = [...(options.skipped ?? [])];
  const outputGapId = taskSourceOutputGapId(task);
  const status =
    options.status ??
    (!task ? "skipped" : warnings.length > 0 || skipped.length > 0 ? "partial" : "success");
  const refreshKeys: RefreshKey[] = [
    "task.changed",
    "route.changed",
    "reviewContext.changed",
    "aiContext.changed",
    ...(outputGapId ? (["output.gap.changed"] as RefreshKey[]) : [])
  ];
  return createWriteFeedbackResult({
    status,
    operation,
    data: task,
    affectedEntities: [
      task
        ? {
            type: "task",
            id: task.id,
            relation: options.relation ?? "updated",
            label: task.title
          }
        : {
            type: "task",
            id: taskId,
            relation: "skipped"
          },
      ...(outputGapId
        ? [
            {
              type: "outputGap",
              id: outputGapId,
              relation: "linked"
            }
          ]
        : [])
    ],
    affectedScopes: [
      {
        module: "task",
        projectId: task?.projectId,
        routeNodeId: task?.routeNodeId,
        taskId,
        reason: `${operation} changed or inspected a Task.`
      },
      ...(outputGapId
        ? [
            {
              module: "outputConversion",
              projectId: task?.projectId,
              routeNodeId: task?.routeNodeId,
              taskId,
              outputGapId,
              reason: `${operation} may affect an OutputGap linked from Task custom fields.`
            }
          ]
        : []),
      {
        module: "review",
        projectId: task?.projectId,
        routeNodeId: task?.routeNodeId,
        taskId,
        reason: "Review context can include Task status, timing, and result notes."
      },
      {
        module: "ai",
        projectId: task?.projectId,
        routeNodeId: task?.routeNodeId,
        taskId,
        reason: "AI context can include Task status and execution state."
      }
    ],
    refreshKeys,
    messages: [
      ...warnings.map((warning) => toWriteFeedbackMessage(warning, "warning")),
      ...skipped.map((skip) => toWriteFeedbackMessage(`Skipped: ${skip}`, "warning", skip))
    ],
    warnings,
    skipped,
    partial: status === "partial" || warnings.length > 0 || skipped.length > 0
  });
}

function publishTaskWriteFeedback(
  operation: string,
  taskId: EntityId,
  task: Task | undefined,
  options: {
    warnings?: string[];
    skipped?: string[];
    status?: WriteFeedbackStatus;
    relation?: AffectedEntity["relation"];
  } = {}
) {
  publishPlanningWriteFeedback(
    createTaskWriteFeedback(operation, taskId, task, options),
    operation
  );
}

function affectedEntityForReviewTarget(target: ReviewTargetInput): AffectedEntity {
  return {
    type: target.targetType,
    id: target.targetId,
    relation: "linked"
  };
}

function publishReviewWriteFeedback(
  operation: string,
  reviewId: EntityId,
  review: Review | undefined,
  options: {
    targets?: ReviewTargetInput[];
    relation?: AffectedEntity["relation"];
    warnings?: string[];
    skipped?: string[];
  } = {}
) {
  const targetEntities = (options.targets ?? []).map(
    affectedEntityForReviewTarget
  );
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation,
      data: review,
      primaryEntity: {
        type: "review",
        id: reviewId,
        relation: review ? options.relation ?? "updated" : "skipped",
        label: review?.title
      },
      affectedEntities: targetEntities,
      affectedScopes: [
        {
          module: "review",
          projectId: review?.projectId,
          reviewId,
          reason: `${operation} changed Review target or period metadata.`
        },
        {
          module: "ai",
          projectId: review?.projectId,
          reviewId,
          reason: "AI context can include Review target and period metadata."
        }
      ],
      refreshKeys: ["review.changed", "reviewContext.changed", "aiContext.changed"],
      warnings: options.warnings,
      skipped: options.skipped
    }),
    operation
  );
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function matchesSearch(entity: BaseEntity, search?: string) {
  if (!search) {
    return true;
  }

  const query = search.toLowerCase();
  return [entity.title, entity.description, ...(entity.tags ?? [])]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function appendChangeLog(
  data: PlanningData,
  entityType: EntityType,
  entityId: EntityId,
  action: ChangeAction,
  note?: string,
  createdBy: ActorType = "system"
): PlanningData {
  const timestamp = now();
  const changeLog: ChangeLog = {
    id: createId("change"),
    entityType,
    entityId,
    action,
    note,
    createdBy,
    createdAt: timestamp,
    schemaVersion: PLANNING_SCHEMA_VERSION
  };

  return {
    ...data,
    changeLogs: [...data.changeLogs, changeLog],
    exportedAt: timestamp
  };
}

function softDeleteEntity<T extends BaseEntity>(items: T[], id: EntityId): [T[], T | undefined] {
  const timestamp = now();
  let deleted: T | undefined;
  const updatedItems = items.map((item) => {
    if (item.id !== id || item.deletedAt) {
      return item;
    }

    deleted = {
      ...item,
      deletedAt: timestamp,
      updatedAt: timestamp
    };
    return deleted;
  });

  return [updatedItems, deleted];
}

function isArchivedProject(project: Project) {
  return project.status === "archived" || Boolean(project.archivedAt);
}

function isArchivedRouteNode(routeNode: RouteNode) {
  return (
    routeNode.status === "archived" ||
    routeNode.captureState === "archived" ||
    Boolean(routeNode.archivedAt)
  );
}

function isArchivedTask(task: Task) {
  return task.status === "archived" || task.captureState === "archived" || Boolean(task.archivedAt);
}

function isArchivedReview(review: Pick<Review, "archivedAt">) {
  return Boolean(review.archivedAt);
}

function isRouteCheckpointStatus(value: unknown): value is RouteCheckpointStatus {
  return (
    value === "completed" ||
    value === "active" ||
    value === "blocked" ||
    value === "abandoned" ||
    value === "planned"
  );
}

function isTaskCheckpointStatus(value: unknown): value is TaskCheckpointStatus {
  return (
    value === "completed" ||
    value === "active" ||
    value === "blocked" ||
    value === "abandoned" ||
    value === "planned"
  );
}

function isRoutineFrequency(value: unknown): value is RoutineFrequency {
  return value === "daily" || value === "weekly" || value === "monthly";
}

function isRoutineTargetType(value: unknown): value is RoutineTargetType {
  return value === "count" || value === "description";
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function toDate(value: string | Date) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid routine period date: ${String(value)}.`);
  }
  return date;
}

export function getRoutinePeriodKey(
  value: string | Date,
  frequency: RoutineFrequency
): string {
  const date = toDate(value);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  if (frequency === "daily") {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  if (frequency === "monthly") {
    return `${year}-${pad2(month)}`;
  }

  const utc = new Date(Date.UTC(year, date.getMonth(), day));
  const dayNumber = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNumber);
  const isoYear = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

function isVisible<T extends BaseEntity>(
  entity: T,
  includeDeleted?: boolean,
  includeArchived?: boolean,
  isArchived?: (entity: T) => boolean
) {
  if (!includeDeleted && entity.deletedAt) {
    return false;
  }

  if (!includeArchived && isArchived?.(entity)) {
    return false;
  }

  return true;
}

function putReviewTargetSnapshotSummary(
  summaries: ReviewTargetSnapshotSummaryMap,
  targetType: keyof ReviewTargetSnapshotSummaryMap,
  targetId: EntityId,
  summary: ReviewTargetSnapshotSummary
) {
  summaries[targetType] = {
    ...(summaries[targetType] ?? {}),
    [targetId]: summary
  };
}

async function resolveLiteratureProjectId(literatureId: EntityId, reviewProjectId: EntityId) {
  const literature = await literatureService.getLiteratureById(literatureId);
  if (!literature) {
    return undefined;
  }
  if (literature.primaryProjectId) {
    return literature.primaryProjectId;
  }
  const links = await literatureService.queryLiteratureLinks({ literatureId });
  const projectLink = links.find(
    (link) =>
      link.projectId === reviewProjectId ||
      (link.targetType === "project" && link.targetId === reviewProjectId)
  );
  return projectLink ? reviewProjectId : undefined;
}

async function buildReviewTargetSnapshotSummaries(
  review: Pick<Review, "projectId">,
  targets: Array<ReviewTargetInput | { targetType: string; targetId: EntityId }>
): Promise<ReviewTargetSnapshotSummaryMap> {
  const summaries: ReviewTargetSnapshotSummaryMap = {};
  const project = await getProjectById(review.projectId);
  if (project) {
    putReviewTargetSnapshotSummary(summaries, "project", project.id, {
      title: project.title,
      status: project.status,
      summary: project.description,
      projectId: project.id
    });
  }

  for (const target of targets) {
    if (!isReviewFormalLinkTargetType(target.targetType)) {
      continue;
    }
    if (target.targetType === "routeNode") {
      const routeNode = await getRouteNodeById(target.targetId);
      if (routeNode) {
        putReviewTargetSnapshotSummary(summaries, "routeNode", routeNode.id, {
          title: routeNode.title,
          status: routeNode.status,
          summary: routeNode.description,
          projectId: routeNode.projectId
        });
      }
    } else if (target.targetType === "task") {
      const task = await getTaskById(target.targetId);
      if (task) {
        putReviewTargetSnapshotSummary(summaries, "task", task.id, {
          title: task.title,
          status: task.status,
          summary: task.description,
          projectId: task.projectId
        });
      }
    } else if (target.targetType === "experiment") {
      const experiment = await experimentService.getExperimentById(target.targetId);
      if (experiment) {
        putReviewTargetSnapshotSummary(summaries, "experiment", experiment.id, {
          title: experiment.title,
          status: experiment.status,
          summary: experiment.purposeAndQuestion || experiment.resultSummary || experiment.conclusionAndNextSteps,
          projectId: experiment.projectId
        });
      }
    } else if (target.targetType === "experimentRun") {
      const run = await experimentRunService.getRunById(target.targetId);
      if (run) {
        const parent = await experimentService.getExperimentById(run.experimentId);
        putReviewTargetSnapshotSummary(summaries, "experimentRun", run.id, {
          title: run.title,
          status: run.status,
          summary: run.resultSummary ?? run.conclusion ?? run.conditionSummary,
          projectId: parent?.projectId ?? run.projectId ?? undefined,
          experimentId: run.experimentId
        });
      }
    } else if (target.targetType === "literature") {
      const literature = await literatureService.getLiteratureById(target.targetId);
      if (literature) {
        const projectId = await resolveLiteratureProjectId(literature.id, review.projectId);
        putReviewTargetSnapshotSummary(summaries, "literature", literature.id, {
          title: literature.title,
          status: literature.readingStatus,
          summary: literature.abstract,
          projectId
        });
      }
    }
  }

  return summaries;
}

async function validateReviewTargetsForReview(
  review: Pick<
    Review,
    "projectId" | "reviewType" | "periodStart" | "periodEnd" | "periodLabel"
  >,
  targets: Array<ReviewTargetInput | { targetType: string; targetId: EntityId }>
): Promise<ReviewTargetInput[]> {
  const summaries = await buildReviewTargetSnapshotSummaries(review, targets);
  return validateReviewTargetContractInSnapshot(review, targets, summaries).normalizedTargets;
}

async function queryReviewTargetInputs(reviewId: EntityId): Promise<ReviewTargetInput[]> {
  const data = await getPlanningFirstLayerData();
  return uniqueReviewTargets(
    data.entityLinks
      .filter(
        (link) =>
          link.sourceType === "review" &&
          link.sourceId === reviewId &&
          link.relationType === "summarizes" &&
          isReviewFormalLinkTargetType(link.targetType)
      )
      .map((link) => ({
        targetType: link.targetType as ReviewTargetType,
        targetId: link.targetId,
        relationType: "summarizes" as const,
        description: link.description
      }))
  );
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const project = await createPlanningProject(input);
  publishProjectWriteFeedback("planning.createProject", project.id, project, "created");
  return project;
}

export async function updateProject(
  projectId: EntityId,
  patch: UpdateEntityInput<Project>
): Promise<Project | undefined> {
  const project = await updatePlanningProject(projectId, patch);
  publishProjectWriteFeedback("planning.updateProject", projectId, project, "updated");
  return project;
}

export async function deleteProject(projectId: EntityId, options: ArchiveOptions = {}): Promise<boolean> {
  return deletePlanningProject(projectId, { note: options.note });
}

export async function getProjectById(projectId: EntityId): Promise<Project | undefined> {
  const data = await getPlanningFirstLayerData();
  return data.projects.find((project) => project.id === projectId && !project.deletedAt);
}

export async function queryProjects(options: ProjectQueryOptions = {}): Promise<Project[]> {
  const data = await getPlanningFirstLayerData();
  return data.projects.filter(
    (project) =>
      isVisible(project, options.includeDeleted, options.includeArchived, isArchivedProject) &&
      (!options.directionId || project.directionId === options.directionId) &&
      (!options.status || project.status === options.status) &&
      (!options.priority || project.priority === options.priority) &&
      matchesSearch(project, options.search)
  );
}

function validateRouteDateRange(startDate?: string, endDate?: string) {
  if (startDate && endDate && startDate > endDate) {
    throw new Error("RouteNode startDate cannot be later than endDate.");
  }
}

function normalizeRouteNodeInput(input: CreateRouteNodeInput): CreateRouteNodeInput {
  const title = input.title.trim();
  if (!title) {
    throw new Error("RouteNode title is required.");
  }

  const startDate = normalizeRouteDate(input.startDate);
  const endDate = normalizeRouteDate(input.endDate);
  validateRouteDateRange(startDate, endDate);

  return {
    ...input,
    title,
    description: input.description?.trim() || undefined,
    objective: input.objective?.trim() || undefined,
    expectedOutput: input.expectedOutput?.trim() || undefined,
    timeLabel: input.timeLabel?.trim() || undefined,
    resultNote: input.resultNote?.trim() || undefined,
    startDate,
    endDate,
    showInGantt: input.showInGantt !== false
  };
}

function normalizeRouteNodePatch(
  patch: UpdateEntityInput<RouteNode>,
  existing: RouteNode
): UpdateEntityInput<RouteNode> {
  const normalized: UpdateEntityInput<RouteNode> = { ...patch };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error("RouteNode title is required.");
    }
    normalized.title = title;
  }

  if (patch.description !== undefined) {
    normalized.description = patch.description.trim() || undefined;
  }
  if (patch.objective !== undefined) {
    normalized.objective = patch.objective.trim() || undefined;
  }
  if (patch.expectedOutput !== undefined) {
    normalized.expectedOutput = patch.expectedOutput.trim() || undefined;
  }
  if (patch.timeLabel !== undefined) {
    normalized.timeLabel = patch.timeLabel.trim() || undefined;
  }
  if (patch.resultNote !== undefined) {
    normalized.resultNote = patch.resultNote.trim() || undefined;
  }

  const hasStartDate = Object.prototype.hasOwnProperty.call(patch, "startDate");
  const hasEndDate = Object.prototype.hasOwnProperty.call(patch, "endDate");
  if (hasStartDate) {
    normalized.startDate = normalizeRouteDate(patch.startDate);
  }
  if (hasEndDate) {
    normalized.endDate = normalizeRouteDate(patch.endDate);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "showInGantt")) {
    normalized.showInGantt = patch.showInGantt !== false;
  }

  validateRouteDateRange(
    hasStartDate ? normalized.startDate : existing.startDate,
    hasEndDate ? normalized.endDate : existing.endDate
  );

  return normalized;
}

export async function createRouteNode(input: CreateRouteNodeInput): Promise<RouteNode> {
  const routeNode = await createPlanningRouteNode(normalizeRouteNodeInput(input));
  publishRouteNodeWriteFeedback("planning.createRouteNode", routeNode.id, routeNode, "created");
  return routeNode;
}

export async function updateRouteNode(
  routeNodeId: EntityId,
  patch: UpdateEntityInput<RouteNode>
): Promise<RouteNode | undefined> {
  const existing = await getRouteNodeById(routeNodeId);
  if (!existing) {
    publishRouteNodeWriteFeedback("planning.updateRouteNode", routeNodeId, undefined, "updated");
    return undefined;
  }

  const routeNode = await updatePlanningRouteNode(
    routeNodeId,
    normalizeRouteNodePatch(patch, existing)
  );
  publishRouteNodeWriteFeedback("planning.updateRouteNode", routeNodeId, routeNode, "updated");
  return routeNode;
}

function normalizeRouteCheckpointInput(
  input: CreateRouteCheckpointInput
): CreateRouteCheckpointInput {
  const title = input.title.trim();
  if (!title) {
    throw new Error("RouteCheckpoint title is required.");
  }
  if (!input.routeNodeId?.trim()) {
    throw new Error("RouteCheckpoint routeNodeId is required.");
  }
  const status = input.status ?? "planned";
  if (!isRouteCheckpointStatus(status)) {
    throw new Error(`RouteCheckpoint status is not supported: ${String(status)}.`);
  }

  return {
    ...input,
    title,
    description: input.description?.trim() || undefined,
    acceptanceCriteria: input.acceptanceCriteria?.trim() || undefined,
    dueDate: input.dueDate?.trim() || undefined,
    feedback: input.feedback?.trim() || undefined,
    status,
    orderIndex: input.orderIndex ?? 0
  };
}

function normalizeRouteCheckpointPatch(
  patch: UpdateEntityInput<RouteCheckpoint>
): UpdateEntityInput<RouteCheckpoint> {
  const nextPatch: UpdateEntityInput<RouteCheckpoint> = { ...patch };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error("RouteCheckpoint title is required.");
    }
    nextPatch.title = title;
  }
  if (patch.status !== undefined && !isRouteCheckpointStatus(patch.status)) {
    throw new Error(`RouteCheckpoint status is not supported: ${String(patch.status)}.`);
  }
  if (patch.routeNodeId !== undefined && !patch.routeNodeId.trim()) {
    throw new Error("RouteCheckpoint routeNodeId is required.");
  }
  if (patch.description !== undefined) {
    nextPatch.description = patch.description.trim() || undefined;
  }
  if (patch.acceptanceCriteria !== undefined) {
    nextPatch.acceptanceCriteria = patch.acceptanceCriteria.trim() || undefined;
  }
  if (patch.dueDate !== undefined) {
    nextPatch.dueDate = patch.dueDate.trim() || undefined;
  }
  if (patch.feedback !== undefined) {
    nextPatch.feedback = patch.feedback.trim() || undefined;
  }
  return nextPatch;
}

export async function createRouteCheckpoint(
  input: CreateRouteCheckpointInput
): Promise<RouteCheckpoint> {
  const normalized = normalizeRouteCheckpointInput(input);
  const routeNode = await getRouteNodeById(normalized.routeNodeId);
  if (!routeNode) {
    throw new Error(`RouteNode not found: ${normalized.routeNodeId}.`);
  }

  const checkpoint = await createPlanningRouteCheckpoint(normalized);
  publishPlanningWriteFeedback(
    createRouteCheckpointWriteFeedback(
      "planning.createRouteCheckpoint",
      checkpoint.id,
      checkpoint,
      "created"
    ),
    "planning.createRouteCheckpoint"
  );
  return checkpoint;
}

export async function updateRouteCheckpoint(
  checkpointId: EntityId,
  patch: UpdateEntityInput<RouteCheckpoint>
): Promise<RouteCheckpoint | undefined> {
  const normalized = normalizeRouteCheckpointPatch(patch);
  if (normalized.routeNodeId !== undefined) {
    const routeNode = await getRouteNodeById(normalized.routeNodeId);
    if (!routeNode) {
      throw new Error(`RouteNode not found: ${normalized.routeNodeId}.`);
    }
  }

  const checkpoint = await updatePlanningRouteCheckpoint(checkpointId, normalized);
  publishPlanningWriteFeedback(
    createRouteCheckpointWriteFeedback(
      "planning.updateRouteCheckpoint",
      checkpointId,
      checkpoint,
      "updated"
    ),
    "planning.updateRouteCheckpoint"
  );
  return checkpoint;
}

export async function deleteRouteCheckpoint(checkpointId: EntityId): Promise<boolean> {
  const deleted = await deletePlanningRouteCheckpoint(checkpointId);
  const checkpoint = deleted ? { id: checkpointId } : undefined;
  publishPlanningWriteFeedback(
    createWriteFeedbackResult({
      status: deleted ? "success" : "skipped",
      operation: "planning.deleteRouteCheckpoint",
      affectedEntities: [
        {
          type: "routeCheckpoint",
          id: checkpointId,
          relation: deleted ? "deleted" : "skipped"
        }
      ],
      affectedScopes: [
        {
          module: "route",
          reason: "RouteCheckpoint was soft deleted."
        }
      ],
      refreshKeys: ["route.changed", "reviewContext.changed", "aiContext.changed"],
      skipped: checkpoint ? [] : ["route_checkpoint_not_found"]
    }),
    "planning.deleteRouteCheckpoint"
  );
  return deleted;
}

export async function archiveRouteNode(
  routeNodeId: EntityId,
  options: ArchiveOptions = {}
): Promise<RouteNode | undefined> {
  return updatePlanningRouteNode(routeNodeId, {
    status: "archived",
    captureState: "archived",
    archivedAt: now(),
    customFields: options.note ? { archiveNote: options.note } : undefined
  });
}

export async function restoreRouteNode(
  routeNodeId: EntityId,
  options: RestoreRouteNodeOptions = {}
): Promise<RouteNode | undefined> {
  return updatePlanningRouteNode(routeNodeId, {
    status: options.status ?? "planned",
    captureState: "pending",
    archivedAt: undefined
  });
}

export async function deleteRouteNode(routeNodeId: EntityId): Promise<boolean> {
  return deletePlanningRouteNode(routeNodeId);
}

export async function getRouteNodeById(routeNodeId: EntityId): Promise<RouteNode | undefined> {
  const data = await getPlanningFirstLayerData();
  return data.routeNodes.find((routeNode) => routeNode.id === routeNodeId && !routeNode.deletedAt);
}

export async function queryRouteNodes(options: RouteNodeQueryOptions = {}): Promise<RouteNode[]> {
  const data = await getPlanningFirstLayerData();
  return data.routeNodes.filter(
    (routeNode) =>
      isVisible(routeNode, options.includeDeleted, options.includeArchived, isArchivedRouteNode) &&
      (!options.projectId || routeNode.projectId === options.projectId) &&
      (!options.parentNodeId || routeNode.parentNodeId === options.parentNodeId) &&
      (!options.status || routeNode.status === options.status) &&
      matchesSearch(routeNode, options.search)
  );
}

export async function queryRouteCheckpointsByRouteNode(
  routeNodeId: EntityId,
  options: Omit<RouteCheckpointQueryOptions, "routeNodeId" | "routeNodeIds"> = {}
): Promise<RouteCheckpoint[]> {
  return queryRouteCheckpoints({
    ...options,
    routeNodeId
  });
}

export async function queryRouteCheckpointsByRouteNodes(
  routeNodeIds: EntityId[],
  options: Omit<RouteCheckpointQueryOptions, "routeNodeId" | "routeNodeIds"> = {}
): Promise<Record<EntityId, RouteCheckpoint[]>> {
  const uniqueRouteNodeIds = [...new Set(routeNodeIds.filter(Boolean))];
  const checkpoints = await queryRouteCheckpoints({
    ...options,
    routeNodeIds: uniqueRouteNodeIds
  });
  return Object.fromEntries(
    uniqueRouteNodeIds.map((routeNodeId) => [
      routeNodeId,
      checkpoints.filter((checkpoint) => checkpoint.routeNodeId === routeNodeId)
    ])
  );
}

export async function queryRouteCheckpoints(
  options: RouteCheckpointQueryOptions = {}
): Promise<RouteCheckpoint[]> {
  const data = await getPlanningFirstLayerData();
  const routeNodeIdSet = new Set(options.routeNodeIds ?? []);
  return data.routeCheckpoints
    .filter(
      (checkpoint) =>
        isVisible(checkpoint, options.includeDeleted, true) &&
        (!options.routeNodeId || checkpoint.routeNodeId === options.routeNodeId) &&
        (routeNodeIdSet.size === 0 || routeNodeIdSet.has(checkpoint.routeNodeId)) &&
        (!options.status || checkpoint.status === options.status) &&
        matchesSearch(checkpoint, options.search)
    )
    .sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        (left.dueDate ?? "").localeCompare(right.dueDate ?? "") ||
        left.title.localeCompare(right.title)
    );
}

function normalizeTaskCheckpointInput(
  input: CreateTaskCheckpointInput
): CreateTaskCheckpointInput {
  const title = input.title.trim();
  if (!title) {
    throw new Error("TaskCheckpoint title is required.");
  }
  if (!input.taskId?.trim()) {
    throw new Error("TaskCheckpoint taskId is required.");
  }
  const status = input.status ?? "planned";
  if (!isTaskCheckpointStatus(status)) {
    throw new Error(`TaskCheckpoint status is not supported: ${String(status)}.`);
  }

  return {
    ...input,
    title,
    description: input.description?.trim() || undefined,
    acceptanceCriteria: input.acceptanceCriteria?.trim() || undefined,
    dueDate: input.dueDate?.trim() || undefined,
    feedback: input.feedback?.trim() || undefined,
    status,
    orderIndex: input.orderIndex ?? 0
  };
}

function normalizeTaskCheckpointPatch(
  patch: UpdateEntityInput<TaskCheckpoint>
): UpdateEntityInput<TaskCheckpoint> {
  const nextPatch: UpdateEntityInput<TaskCheckpoint> = { ...patch };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error("TaskCheckpoint title is required.");
    }
    nextPatch.title = title;
  }
  if (patch.status !== undefined && !isTaskCheckpointStatus(patch.status)) {
    throw new Error(`TaskCheckpoint status is not supported: ${String(patch.status)}.`);
  }
  if (patch.taskId !== undefined && !patch.taskId.trim()) {
    throw new Error("TaskCheckpoint taskId is required.");
  }
  if (patch.description !== undefined) {
    nextPatch.description = patch.description.trim() || undefined;
  }
  if (patch.acceptanceCriteria !== undefined) {
    nextPatch.acceptanceCriteria = patch.acceptanceCriteria.trim() || undefined;
  }
  if (patch.dueDate !== undefined) {
    nextPatch.dueDate = patch.dueDate.trim() || undefined;
  }
  if (patch.feedback !== undefined) {
    nextPatch.feedback = patch.feedback.trim() || undefined;
  }
  return nextPatch;
}

export async function createTaskCheckpoint(
  input: CreateTaskCheckpointInput
): Promise<WriteFeedbackResult<TaskCheckpoint | undefined>> {
  const normalized = normalizeTaskCheckpointInput(input);
  const task = await getTaskById(normalized.taskId);
  if (!task) {
    throw new Error(`Task not found: ${normalized.taskId}.`);
  }

  const checkpoint = await createPlanningTaskCheckpoint(normalized);
  const feedback = createTaskCheckpointWriteFeedback(
    "planning.createTaskCheckpoint",
    checkpoint.id,
    checkpoint,
    "created"
  );
  publishPlanningWriteFeedback(feedback, "planning.createTaskCheckpoint");
  return feedback;
}

export async function updateTaskCheckpoint(
  checkpointId: EntityId,
  patch: UpdateEntityInput<TaskCheckpoint>
): Promise<WriteFeedbackResult<TaskCheckpoint | undefined>> {
  const normalized = normalizeTaskCheckpointPatch(patch);
  if (normalized.taskId !== undefined) {
    const task = await getTaskById(normalized.taskId);
    if (!task) {
      throw new Error(`Task not found: ${normalized.taskId}.`);
    }
  }

  const checkpoint = await updatePlanningTaskCheckpoint(checkpointId, normalized);
  const feedback = createTaskCheckpointWriteFeedback(
    "planning.updateTaskCheckpoint",
    checkpointId,
    checkpoint,
    "updated"
  );
  publishPlanningWriteFeedback(feedback, "planning.updateTaskCheckpoint");
  return feedback;
}

export async function deleteTaskCheckpoint(
  checkpointId: EntityId
): Promise<WriteFeedbackResult<TaskCheckpoint | undefined>> {
  const existing = await getTaskCheckpointById(checkpointId);
  const deleted = await deletePlanningTaskCheckpoint(checkpointId);
  const feedback = createTaskCheckpointWriteFeedback(
    "planning.deleteTaskCheckpoint",
    checkpointId,
    deleted ? existing : undefined,
    "deleted",
    {
      status: deleted ? "success" : "skipped",
      skipped: deleted ? [] : ["task_checkpoint_not_found"]
    }
  );
  publishPlanningWriteFeedback(feedback, "planning.deleteTaskCheckpoint");
  return feedback;
}

async function getTaskCheckpointById(
  checkpointId: EntityId
): Promise<TaskCheckpoint | undefined> {
  const data = await getPlanningData();
  return data.taskCheckpoints.find(
    (checkpoint) => checkpoint.id === checkpointId && !checkpoint.deletedAt
  );
}

export async function queryTaskCheckpointsByTask(
  taskId: EntityId,
  options: Omit<TaskCheckpointQueryOptions, "taskId" | "taskIds"> = {}
): Promise<TaskCheckpoint[]> {
  return queryTaskCheckpoints({
    ...options,
    taskId
  });
}

export async function queryTaskCheckpointsByTasks(
  taskIds: EntityId[],
  options: Omit<TaskCheckpointQueryOptions, "taskId" | "taskIds"> = {}
): Promise<Record<EntityId, TaskCheckpoint[]>> {
  const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))];
  const checkpoints = await queryTaskCheckpoints({
    ...options,
    taskIds: uniqueTaskIds
  });
  return Object.fromEntries(
    uniqueTaskIds.map((taskId) => [
      taskId,
      checkpoints.filter((checkpoint) => checkpoint.taskId === taskId)
    ])
  );
}

export async function queryTaskCheckpoints(
  options: TaskCheckpointQueryOptions = {}
): Promise<TaskCheckpoint[]> {
  const data = await getPlanningFirstLayerData();
  const taskIdSet = new Set(options.taskIds ?? []);
  return data.taskCheckpoints
    .filter(
      (checkpoint) =>
        isVisible(checkpoint, options.includeDeleted, true) &&
        (!options.taskId || checkpoint.taskId === options.taskId) &&
        (taskIdSet.size === 0 || taskIdSet.has(checkpoint.taskId)) &&
        (!options.status || checkpoint.status === options.status) &&
        matchesSearch(checkpoint, options.search)
    )
    .sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        (left.dueDate ?? "").localeCompare(right.dueDate ?? "") ||
        left.title.localeCompare(right.title)
    );
}

function normalizeResearchRoutineInput(
  input: CreateResearchRoutineInput
): CreateResearchRoutineInput {
  const title = input.title.trim();
  if (!title) {
    throw new Error("ResearchRoutine title is required.");
  }
  if (input.projectId !== undefined && !input.projectId.trim()) {
    throw new Error("ResearchRoutine projectId cannot be empty.");
  }
  const frequency = input.frequency ?? "daily";
  if (!isRoutineFrequency(frequency)) {
    throw new Error(`ResearchRoutine frequency is not supported: ${String(frequency)}.`);
  }
  const targetType = input.targetType ?? "count";
  if (!isRoutineTargetType(targetType)) {
    throw new Error(`ResearchRoutine targetType is not supported: ${String(targetType)}.`);
  }
  const targetCount =
    targetType === "count" ? Math.max(1, Math.floor(input.targetCount ?? 1)) : input.targetCount;

  return {
    ...input,
    title,
    description: input.description?.trim() || undefined,
    projectId: input.projectId?.trim() || undefined,
    frequency,
    targetType,
    targetCount,
    targetDescription: input.targetDescription?.trim() || undefined,
    isActive: input.isActive ?? true,
    startDate: input.startDate?.trim() || undefined,
    endDate: input.endDate?.trim() || undefined,
    orderIndex: input.orderIndex ?? 0
  };
}

function normalizeResearchRoutinePatch(
  patch: UpdateEntityInput<ResearchRoutine>
): UpdateEntityInput<ResearchRoutine> {
  const nextPatch: UpdateEntityInput<ResearchRoutine> = { ...patch };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error("ResearchRoutine title is required.");
    }
    nextPatch.title = title;
  }
  if (patch.projectId !== undefined) {
    nextPatch.projectId = patch.projectId.trim() || undefined;
  }
  if (patch.frequency !== undefined && !isRoutineFrequency(patch.frequency)) {
    throw new Error(`ResearchRoutine frequency is not supported: ${String(patch.frequency)}.`);
  }
  if (patch.targetType !== undefined && !isRoutineTargetType(patch.targetType)) {
    throw new Error(`ResearchRoutine targetType is not supported: ${String(patch.targetType)}.`);
  }
  if (patch.targetCount !== undefined) {
    nextPatch.targetCount = Math.max(1, Math.floor(patch.targetCount));
  }
  if (patch.description !== undefined) {
    nextPatch.description = patch.description.trim() || undefined;
  }
  if (patch.targetDescription !== undefined) {
    nextPatch.targetDescription = patch.targetDescription.trim() || undefined;
  }
  if (patch.startDate !== undefined) {
    nextPatch.startDate = patch.startDate.trim() || undefined;
  }
  if (patch.endDate !== undefined) {
    nextPatch.endDate = patch.endDate.trim() || undefined;
  }
  return nextPatch;
}

async function validateRoutineProject(projectId?: EntityId) {
  if (!projectId) {
    return;
  }
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`ResearchRoutine project was not found: ${projectId}.`);
  }
}

export async function createResearchRoutine(
  input: CreateResearchRoutineInput
): Promise<WriteFeedbackResult<ResearchRoutine | undefined>> {
  const normalized = normalizeResearchRoutineInput(input);
  await validateRoutineProject(normalized.projectId);
  const routine = await createPlanningResearchRoutine(normalized);
  const feedback = createResearchRoutineWriteFeedback(
    "planning.createResearchRoutine",
    routine.id,
    routine,
    "created"
  );
  publishPlanningWriteFeedback(feedback, "planning.createResearchRoutine");
  return feedback;
}

export async function updateResearchRoutine(
  routineId: EntityId,
  patch: UpdateEntityInput<ResearchRoutine>
): Promise<WriteFeedbackResult<ResearchRoutine | undefined>> {
  const normalized = normalizeResearchRoutinePatch(patch);
  await validateRoutineProject(normalized.projectId);
  const routine = await updatePlanningResearchRoutine(routineId, normalized);
  const feedback = createResearchRoutineWriteFeedback(
    "planning.updateResearchRoutine",
    routineId,
    routine,
    "updated"
  );
  publishPlanningWriteFeedback(feedback, "planning.updateResearchRoutine");
  return feedback;
}

export async function deleteResearchRoutine(
  routineId: EntityId
): Promise<WriteFeedbackResult<ResearchRoutine | undefined>> {
  const existing = await getResearchRoutineById(routineId);
  const deleted = await deletePlanningResearchRoutine(routineId);
  const feedback = createResearchRoutineWriteFeedback(
    "planning.deleteResearchRoutine",
    routineId,
    deleted ? existing : undefined,
    "deleted",
    {
      status: deleted ? "success" : "skipped",
      skipped: deleted ? [] : ["research_routine_not_found"]
    }
  );
  publishPlanningWriteFeedback(feedback, "planning.deleteResearchRoutine");
  return feedback;
}

export async function getResearchRoutineById(
  routineId: EntityId
): Promise<ResearchRoutine | undefined> {
  const data = await getPlanningData();
  return data.researchRoutines.find((routine) => routine.id === routineId && !routine.deletedAt);
}

export async function queryResearchRoutines(
  options: ResearchRoutineQueryOptions = {}
): Promise<ResearchRoutine[]> {
  const data = await getPlanningFirstLayerData();
  const projectIdSet = new Set(options.projectIds ?? []);
  return data.researchRoutines
    .filter(
      (routine) =>
        isVisible(routine, options.includeDeleted, true) &&
        (!options.projectId ||
          routine.projectId === options.projectId ||
          (options.includeGlobal && routine.projectId === undefined)) &&
        (projectIdSet.size === 0 ||
          (routine.projectId !== undefined && projectIdSet.has(routine.projectId)) ||
          (options.includeGlobal && routine.projectId === undefined)) &&
        (!options.frequency || routine.frequency === options.frequency) &&
        (!options.targetType || routine.targetType === options.targetType) &&
        (options.isActive === undefined || routine.isActive === options.isActive) &&
        matchesSearch(routine, options.search)
    )
    .sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        (left.startDate ?? "").localeCompare(right.startDate ?? "") ||
        left.title.localeCompare(right.title)
    );
}

function normalizeRoutineCheckInInput(
  input: CreateRoutineCheckInInput,
  routine: ResearchRoutine
): CreateRoutineCheckInInput {
  if (!input.routineId?.trim()) {
    throw new Error("RoutineCheckIn routineId is required.");
  }
  const checkedAt = input.checkedAt?.trim() || now();
  const count = Math.max(1, Math.floor(input.count ?? 1));
  return {
    ...input,
    routineId: input.routineId.trim(),
    projectId: input.projectId?.trim() || routine.projectId,
    title: input.title?.trim() || `Check-in: ${routine.title}`,
    description: input.description?.trim() || undefined,
    checkedAt,
    periodKey: input.periodKey?.trim() || getRoutinePeriodKey(checkedAt, routine.frequency),
    count,
    note: input.note?.trim() || undefined
  };
}

function normalizeRoutineCheckInPatch(
  patch: UpdateEntityInput<RoutineCheckIn>,
  routine: ResearchRoutine
): UpdateEntityInput<RoutineCheckIn> {
  const nextPatch: UpdateEntityInput<RoutineCheckIn> = { ...patch };
  if (patch.title !== undefined) {
    nextPatch.title = patch.title.trim() || `Check-in: ${routine.title}`;
  }
  if (patch.routineId !== undefined && !patch.routineId.trim()) {
    throw new Error("RoutineCheckIn routineId is required.");
  }
  if (patch.routineId !== undefined) {
    nextPatch.routineId = patch.routineId.trim();
  }
  if (patch.projectId !== undefined) {
    nextPatch.projectId = patch.projectId.trim() || routine.projectId;
  }
  if (patch.description !== undefined) {
    nextPatch.description = patch.description.trim() || undefined;
  }
  if (patch.checkedAt !== undefined) {
    const checkedAt = patch.checkedAt.trim();
    if (!checkedAt) {
      throw new Error("RoutineCheckIn checkedAt is required.");
    }
    nextPatch.checkedAt = checkedAt;
    if (patch.periodKey === undefined) {
      nextPatch.periodKey = getRoutinePeriodKey(checkedAt, routine.frequency);
    }
  }
  if (patch.periodKey !== undefined) {
    nextPatch.periodKey = patch.periodKey.trim() || undefined;
  }
  if (patch.count !== undefined) {
    nextPatch.count = Math.max(1, Math.floor(patch.count));
  }
  if (patch.note !== undefined) {
    nextPatch.note = patch.note.trim() || undefined;
  }
  return nextPatch;
}

export async function createRoutineCheckIn(
  input: CreateRoutineCheckInInput
): Promise<WriteFeedbackResult<RoutineCheckIn | undefined>> {
  const routine = await getResearchRoutineById(input.routineId);
  if (!routine) {
    throw new Error(`ResearchRoutine not found: ${input.routineId}.`);
  }
  const normalized = normalizeRoutineCheckInInput(input, routine);
  const checkIn = await createPlanningRoutineCheckIn(normalized);
  const feedback = createRoutineCheckInWriteFeedback(
    "planning.createRoutineCheckIn",
    checkIn.id,
    checkIn,
    routine,
    "created"
  );
  publishPlanningWriteFeedback(feedback, "planning.createRoutineCheckIn");
  return feedback;
}

export async function getRoutineCheckInById(
  checkInId: EntityId
): Promise<RoutineCheckIn | undefined> {
  const data = await getPlanningData();
  return data.routineCheckIns.find((checkIn) => checkIn.id === checkInId && !checkIn.deletedAt);
}

export async function queryRoutineCheckIns(
  options: RoutineCheckInQueryOptions = {}
): Promise<RoutineCheckIn[]> {
  const data = await getPlanningFirstLayerData();
  const routineIdSet = new Set(options.routineIds ?? []);
  return data.routineCheckIns
    .filter(
      (checkIn) =>
        isVisible(checkIn, options.includeDeleted, true) &&
        (!options.routineId || checkIn.routineId === options.routineId) &&
        (routineIdSet.size === 0 || routineIdSet.has(checkIn.routineId)) &&
        (!options.projectId || checkIn.projectId === options.projectId) &&
        (!options.periodKey || checkIn.periodKey === options.periodKey) &&
        matchesSearch(checkIn, options.search)
    )
    .sort(
      (left, right) =>
        right.checkedAt.localeCompare(left.checkedAt) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.title.localeCompare(right.title)
    );
}

export async function queryRoutineCheckInsByRoutine(
  routineId: EntityId,
  options: Omit<RoutineCheckInQueryOptions, "routineId" | "routineIds"> = {}
): Promise<RoutineCheckIn[]> {
  return queryRoutineCheckIns({
    ...options,
    routineId
  });
}

export async function queryRoutineCheckInsByRoutines(
  routineIds: EntityId[],
  options: Omit<RoutineCheckInQueryOptions, "routineId" | "routineIds"> = {}
): Promise<Record<EntityId, RoutineCheckIn[]>> {
  const uniqueRoutineIds = [...new Set(routineIds.filter(Boolean))];
  const checkIns = await queryRoutineCheckIns({
    ...options,
    routineIds: uniqueRoutineIds
  });
  return Object.fromEntries(
    uniqueRoutineIds.map((routineId) => [
      routineId,
      checkIns.filter((checkIn) => checkIn.routineId === routineId)
    ])
  );
}

async function validateTaskProjectRoute(
  projectId: EntityId,
  routeNodeId?: EntityId
): Promise<void> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`Task project was not found: ${projectId}.`);
  }
  if (!routeNodeId) {
    return;
  }

  const routeNode = await getRouteNodeById(routeNodeId);
  if (!routeNode) {
    throw new Error(`Task route was not found: ${routeNodeId}.`);
  }
  if (routeNode.projectId !== projectId) {
    throw new Error(
      `Task route ${routeNodeId} does not belong to project ${projectId}.`
    );
  }
}

async function validateTaskPatchProjectRoute(
  task: Task,
  patch: UpdateEntityInput<Task>
): Promise<void> {
  const projectId = patch.projectId ?? task.projectId;
  const routeNodeId = Object.prototype.hasOwnProperty.call(patch, "routeNodeId")
    ? patch.routeNodeId
    : task.routeNodeId;
  await validateTaskProjectRoute(projectId, routeNodeId);
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  await validateTaskProjectRoute(input.projectId, input.routeNodeId);
  const created = await createPlanningTask({
    ...input,
    completedAt:
      input.status === "done" ? input.completedAt ?? now() : input.completedAt
  });
  publishTaskWriteFeedback("planning.createTask", created.id, created);
  return created;
}

export async function updateTask(
  taskId: EntityId,
  patch: UpdateEntityInput<Task>
): Promise<Task | undefined> {
  const task = await getTaskById(taskId);
  if (!task) {
    publishTaskWriteFeedback("planning.updateTask", taskId, undefined, {
      status: "skipped",
      skipped: ["task_not_found"]
    });
    return undefined;
  }

  await validateTaskPatchProjectRoute(task, patch);
  const normalizedPatch: UpdateEntityInput<Task> = { ...patch };
  if (patch.status === "done" && task.status !== "done" && patch.completedAt === undefined) {
    normalizedPatch.completedAt = now();
  } else if (
    patch.status !== undefined &&
    patch.status !== "done" &&
    task.status === "done" &&
    patch.completedAt === undefined
  ) {
    normalizedPatch.completedAt = undefined;
  }

  const updated = await updatePlanningTask(taskId, normalizedPatch);
  publishTaskWriteFeedback("planning.updateTask", taskId, updated, {
    status: updated ? undefined : "skipped",
    skipped: updated ? [] : ["task_not_found"]
  });
  return updated;
}

export async function archiveTask(
  taskId: EntityId,
  options: ArchiveOptions = {}
): Promise<Task | undefined> {
  const archived = await archivePlanningTask(taskId);
  if (archived && options.note) {
    await updatePlanningTask(taskId, {
      customFields: {
        ...(archived.customFields ?? {}),
        archiveNote: options.note
      }
    });
  }
  return archived;
}

export async function restoreTask(
  taskId: EntityId,
  options: RestoreTaskOptions = {}
): Promise<Task | undefined> {
  return updatePlanningTask(taskId, {
    status: options.status ?? "todo",
    captureState: "pending",
    archivedAt: undefined
  });
}

export async function deleteTask(
  taskId: EntityId
): Promise<WriteFeedbackResult<Task | undefined>> {
  const existing = await getTaskById(taskId);
  const deleted = await deletePlanningTask(taskId);
  const feedback = createTaskWriteFeedback(
    "planning.deleteTask",
    taskId,
    deleted ? existing : undefined,
    {
      status: deleted ? "success" : "skipped",
      skipped: deleted ? [] : ["task_not_found"],
      relation: "deleted"
    }
  );
  publishPlanningWriteFeedback(feedback, "planning.deleteTask");
  return feedback;
}

export async function completeTask(
  taskId: EntityId,
  options: CompleteTaskOptions = {}
): Promise<Task | undefined> {
  const task = await getTaskById(taskId);
  if (!task) {
    publishTaskWriteFeedback("planning.completeTask", taskId, undefined, {
      status: "skipped",
      skipped: ["task_not_found"]
    });
    return undefined;
  }

  const patch: UpdateEntityInput<Task> = {
    ...(options.patch ?? {}),
    status: "done",
    completedAt: now(),
    resultNote: options.completionNote ?? options.patch?.resultNote
  };
  await validateTaskPatchProjectRoute(task, patch);
  const completed = await updatePlanningTask(taskId, patch);
  publishTaskWriteFeedback("planning.completeTask", taskId, completed, {
    status: completed ? undefined : "skipped",
    skipped: completed ? [] : ["task_complete_failed"]
  });
  return completed;
}

export async function reopenTask(
  taskId: EntityId,
  options: ReopenTaskOptions = {}
): Promise<Task | undefined> {
  const task = await getTaskById(taskId);
  if (!task) {
    publishTaskWriteFeedback("planning.reopenTask", taskId, undefined, {
      status: "skipped",
      skipped: ["task_not_found"]
    });
    return undefined;
  }

  const reopenedStatus = options.status ?? "todo";
  if (
    reopenedStatus !== "todo" &&
    reopenedStatus !== "doing" &&
    reopenedStatus !== "blocked"
  ) {
    throw new Error(`Task reopen status is not supported: ${reopenedStatus}.`);
  }
  const patch: UpdateEntityInput<Task> = {
    ...(options.patch ?? {}),
    status: reopenedStatus,
    completedAt: undefined,
    archivedAt: undefined,
    customFields: options.note
      ? {
          ...(task.customFields ?? {}),
          ...(options.patch?.customFields ?? {}),
          reopenNote: options.note,
          reopenedAt: now()
        }
      : options.patch?.customFields ?? task.customFields
  };
  await validateTaskPatchProjectRoute(task, patch);
  const reopened = await updatePlanningTask(taskId, patch);
  publishTaskWriteFeedback("planning.reopenTask", taskId, reopened, {
    status: reopened ? undefined : "skipped",
    skipped: reopened ? [] : ["task_reopen_failed"]
  });
  return reopened;
}

export async function postponeTask(
  taskId: EntityId,
  options: PostponeTaskOptions
): Promise<Task | undefined> {
  const task = await getTaskById(taskId);
  if (!task) {
    publishTaskWriteFeedback("planning.postponeTask", taskId, undefined, {
      status: "skipped",
      skipped: ["task_not_found"]
    });
    return undefined;
  }

  const patch: UpdateEntityInput<Task> = {
    ...(options.patch ?? {}),
    status: "delayed",
    completedAt: undefined,
    dueDate: options.dueDate ?? options.patch?.dueDate ?? task.dueDate,
    scheduledDate:
      options.scheduledDate ?? options.patch?.scheduledDate ?? task.scheduledDate,
    customFields: {
      ...(task.customFields ?? {}),
      ...(options.patch?.customFields ?? {}),
      postponedAt: now(),
      postponedReason: options.reason
    }
  };
  await validateTaskPatchProjectRoute(task, patch);
  const postponed = await updatePlanningTask(taskId, patch);
  publishTaskWriteFeedback("planning.postponeTask", taskId, postponed, {
    status: postponed ? undefined : "skipped",
    skipped: postponed ? [] : ["task_postpone_failed"]
  });
  return postponed;
}

export async function getTaskById(taskId: EntityId): Promise<Task | undefined> {
  const data = await getPlanningFirstLayerData();
  return data.tasks.find((task) => task.id === taskId && !task.deletedAt);
}

export async function queryTasks(options: TaskQueryOptions = {}): Promise<Task[]> {
  const data = await getPlanningFirstLayerData();
  return data.tasks.filter(
    (task) =>
      isVisible(task, options.includeDeleted, options.includeArchived, isArchivedTask) &&
      (!options.projectId || task.projectId === options.projectId) &&
      (!options.routeNodeId || task.routeNodeId === options.routeNodeId) &&
      (!options.status || task.status === options.status) &&
      (!options.priority || task.priority === options.priority) &&
      (!options.timeBucket || task.timeBucket === options.timeBucket) &&
      matchesSearch(task, options.search)
  );
}

export async function ensureReviewTargetLink(
  reviewId: EntityId,
  target: ReviewTargetInput
): Promise<EntityLink> {
  const review = await getReviewById(reviewId);
  if (!review) {
    throw new Error(`Review not found: ${reviewId}`);
  }

  const nextTargets = await validateReviewTargetsForReview(review, [
    ...(await queryReviewTargetInputs(reviewId)),
    target
  ]);
  const links = await replaceReviewSummarizesTargetLinks(reviewId, nextTargets);
  const link = links.find(
    (item) =>
      item.targetType === target.targetType &&
      item.targetId === target.targetId &&
      item.relationType === "summarizes"
  );
  if (!link) {
    throw new Error(`Review target link was not written: ${target.targetType}:${target.targetId}.`);
  }
  return link;
}

export async function queryReviewTargets(reviewId: EntityId): Promise<ReviewTargetSummary[]> {
  const review = await getReviewById(reviewId);
  if (!review) {
    return [];
  }
  const data = await getPlanningFirstLayerData();
  const linkTargets = data.entityLinks
    .filter(
      (link) =>
        link.sourceType === "review" &&
        link.sourceId === reviewId &&
        link.relationType === "summarizes" &&
        isReviewFormalLinkTargetType(link.targetType)
    )
    .map((link) => ({
      targetType: link.targetType as ReviewTargetType,
      targetId: link.targetId
    }));
  const summaries = await buildReviewTargetSnapshotSummaries(review, linkTargets);
  return queryReviewTargetSummariesFromSnapshot(review, data.entityLinks, summaries);
}

export async function replaceReviewTargets(
  reviewId: EntityId,
  targets: ReviewTargetInput[]
): Promise<ReviewTargetSummary[]> {
  const review = await getReviewById(reviewId);
  if (!review) {
    throw new Error(`Review not found: ${reviewId}`);
  }
  const normalizedTargets = await validateReviewTargetsForReview(review, targets);
  await replaceReviewSummarizesTargetLinks(reviewId, normalizedTargets);
  publishReviewWriteFeedback("planning.replaceReviewTargets", reviewId, review, {
    targets: normalizedTargets
  });
  return queryReviewTargets(reviewId);
}

/**
 * Canonical, non-mutating Review CREATE prevalidation. Business-local callers
 * use the same normalization and target rules as the formal create service so
 * invalid Standard Results cannot reach a write boundary.
 */
export async function validateReviewCreateInput(
  input: CreateReviewInput
): Promise<ValidatedCreateReviewInput> {
  const { targets, ...reviewInput } = input;
  const reviewType = normalizeReviewType(reviewInput.reviewType);
  const mergedInput = {
    ...reviewInput,
    reviewType,
    outlineSections: reconcileReviewOutlineSections(
      reviewType,
      reviewInput.outlineSections
    )
  };
  const reviewTargets = await validateReviewTargetsForReview(mergedInput, targets ?? []);
  return { ...mergedInput, targets: reviewTargets };
}

export async function createReview(input: CreateReviewInput): Promise<CreateReviewResult> {
  const { targets: reviewTargets, ...mergedInput } = await validateReviewCreateInput(input);
  const firstLayerReview = await createPlanningReview(mergedInput);
  let structuredState: ReviewStructuredStateRecord;
  try {
    structuredState = await provisionReviewStructuredState({
      reviewId: firstLayerReview.id,
      reviewType: mergedInput.reviewType,
      outlineSections: mergedInput.outlineSections
    });
  } catch (error) {
    throw new ReviewDurableConcernError(
      "REVIEW_SECOND_LAYER_PROVISION_FAILED",
      firstLayerReview.id,
      true,
      error
    );
  }
  const review = composeReviewStructuredState(firstLayerReview, structuredState);
  await replaceReviewSummarizesTargetLinks(review.id, reviewTargets);
  const provisioning = await ensureReviewManuscriptProvisioning(review.id, {
    reviewRecordState: "created"
  });
  const result: CreateReviewResult = { ...review, provisioning };
  publishReviewWriteFeedback("planning.createReview", review.id, result, {
    targets: reviewTargets,
    relation: "created",
    warnings: provisioning.completionState === "complete"
      ? []
      : [
          `Review record was created, but manuscript provisioning is ${provisioning.completionState}.`,
          ...provisioning.errors.map((error) => `${error.code}: ${error.message}`)
        ]
  });
  return result;
}

export async function createReviewWithTargets(input: CreateReviewInput): Promise<CreateReviewResult> {
  return createReview(input);
}

export async function updateReview(
  reviewId: EntityId,
  patch: UpdateReviewInput
): Promise<Review | undefined> {
  const existing = await getReviewById(reviewId);
  if (!existing) {
    publishReviewWriteFeedback("planning.updateReview", reviewId, undefined, {
      skipped: ["review_not_found"]
    });
    return undefined;
  }

  const {
    targets,
    reviewType: requestedReviewType,
    outlineSections: requestedOutlineSections,
    structuredRevision: _structuredRevision,
    descriptorIdentity: _descriptorIdentity,
    structuredLifecycleEvidence: _structuredLifecycleEvidence,
    structuredLifecycleStatus: _structuredLifecycleStatus,
    ...firstLayerPatch
  } = patch;
  const reviewType = normalizeReviewType(requestedReviewType ?? existing.reviewType);
  const outlineSections = reconcileReviewOutlineSections(
    reviewType,
    requestedOutlineSections ?? existing.outlineSections
  );
  const nextReview = {
    ...existing,
    ...firstLayerPatch,
    reviewType,
    outlineSections
  };
  const reviewTargets = await validateReviewTargetsForReview(
    nextReview,
    targets ?? (await queryReviewTargetInputs(reviewId))
  );
  let firstLayerCommitted = false;
  let updated: Review = existing;
  if (Object.keys(firstLayerPatch).length > 0) {
    const firstLayerUpdated = await updatePlanningReview(reviewId, firstLayerPatch);
    if (!firstLayerUpdated) return undefined;
    updated = firstLayerUpdated;
    firstLayerCommitted = true;
  }

  if (targets !== undefined) {
    await replaceReviewSummarizesTargetLinks(reviewId, reviewTargets);
    firstLayerCommitted = true;
  }

  const structuredChanged =
    reviewType !== existing.reviewType ||
    JSON.stringify(outlineSections) !== JSON.stringify(existing.outlineSections);
  if (structuredChanged) {
    if (
      existing.structuredRevision === undefined ||
      !existing.descriptorIdentity ||
      !existing.structuredLifecycleEvidence
    ) {
      throw new ReviewDurableConcernError(
        "REVIEW_EDIT_PARTIALLY_APPLIED",
        reviewId,
        firstLayerCommitted,
        new Error("REVIEW_STRUCTURED_EXPECTED_EVIDENCE_MISSING")
      );
    }
    try {
      const state = await replaceReviewStructuredState({
        reviewId,
        reviewType,
        outlineSections,
        expectedStructuredRevision: existing.structuredRevision,
        expectedDescriptorIdentity: existing.descriptorIdentity,
        expectedLifecycleEvidence: existing.structuredLifecycleEvidence
      });
      updated = composeReviewStructuredState(updated, state);
    } catch (error) {
      throw new ReviewDurableConcernError(
        "REVIEW_EDIT_PARTIALLY_APPLIED",
        reviewId,
        firstLayerCommitted,
        error
      );
    }
  }

  const durableReadback = await getReviewById(reviewId);
  const result = durableReadback ?? updated;
  publishReviewWriteFeedback("planning.updateReview", reviewId, result, {
    targets: reviewTargets
  });
  return result;
}

export async function archiveReview(
  reviewId: EntityId,
  options: ArchiveOptions = {}
): Promise<Review | undefined> {
  const review = await getReviewById(reviewId);
  if (!review) {
    publishReviewWriteFeedback("planning.archiveReview", reviewId, undefined, {
      skipped: ["review_not_found"]
    });
    return undefined;
  }

  const archived = await updatePlanningReview(reviewId, {
    archivedAt: now(),
    customFields: options.note
      ? {
          ...(review.customFields ?? {}),
          archiveNote: options.note
        }
      : review.customFields
  });
  publishReviewWriteFeedback("planning.archiveReview", reviewId, archived ?? review, {
    relation: archived ? "updated" : "skipped",
    warnings: archived ? [] : ["Review archive update failed."]
  });
  return archived;
}

export async function restoreReview(
  reviewId: EntityId,
  _options: RestoreReviewOptions = {}
): Promise<Review | undefined> {
  const existing = await getReviewById(reviewId);
  const restored = await updatePlanningReview(reviewId, {
    archivedAt: undefined
  });
  publishReviewWriteFeedback("planning.restoreReview", reviewId, restored ?? existing, {
    relation: restored ? "updated" : "skipped",
    skipped: restored ? [] : ["review_not_found"]
  });
  return restored;
}

export async function deleteReview(reviewId: EntityId, options: ArchiveOptions = {}): Promise<boolean> {
  const feedback = await softDeleteReview(reviewId, { confirmedByUser: true });
  if (options.note && feedback.status !== "success") {
    console.warn("Review delete note was not applied because delete was skipped.", options.note);
  }
  return feedback.status === "success";
}

export async function getReviewById(reviewId: EntityId): Promise<Review | undefined> {
  const data = await getPlanningFirstLayerData();
  const firstLayer = data.reviews.find((review) => review.id === reviewId && !review.deletedAt);
  if (!firstLayer) return undefined;
  const [structuredState] = await readReviewStructuredStates([reviewId]);
  if (!structuredState) throw new Error("SECOND_LAYER_NOT_PROVISIONED");
  return composeReviewStructuredState(firstLayer, structuredState);
}

export async function queryReviewFirstLayerIdentities(
  options: ReviewFirstLayerQueryOptions = {}
): Promise<ReviewFirstLayerIdentity[]> {
  const data = await getPlanningFirstLayerData();
  return data.reviews.filter(
    (review) =>
      isVisible(review, options.includeDeleted, options.includeArchived, isArchivedReview) &&
      (!options.projectId || review.projectId === options.projectId) &&
      matchesSearch(review, options.search)
  );
}

export async function queryReviewCatalog(
  options: ReviewFirstLayerQueryOptions = {}
): Promise<ReviewCatalogEntry[]> {
  const identities = await queryReviewFirstLayerIdentities(options);
  const states = await readReviewStructuredStates(identities.map((review) => review.id));
  const stateById = new Map(states.map((state) => [state.reviewId, state]));
  return identities.map((review) => {
    const state = stateById.get(review.id);
    return state
      ? {
          ...review,
          reviewType: state.reviewType,
          structuredStateStatus: "available" as const
        }
      : {
          ...review,
          structuredStateStatus: "not_provisioned" as const
        };
  });
}

export async function queryReviews(options: ReviewQueryOptions = {}): Promise<Review[]> {
  const data = await getPlanningData();
  return data.reviews.filter(
    (review) =>
      isVisible(review, options.includeDeleted, options.includeArchived, isArchivedReview) &&
      (!options.projectId || review.projectId === options.projectId) &&
      (!options.reviewType || review.reviewType === options.reviewType) &&
      matchesSearch(review, options.search)
  );
}

export const planningService = {
  createProject,
  updateProject,
  deleteProject,
  getProjectById,
  queryProjects,
  createRouteNode,
  updateRouteNode,
  createRouteCheckpoint,
  updateRouteCheckpoint,
  deleteRouteCheckpoint,
  queryRouteCheckpoints,
  queryRouteCheckpointsByRouteNode,
  queryRouteCheckpointsByRouteNodes,
  createTaskCheckpoint,
  updateTaskCheckpoint,
  deleteTaskCheckpoint,
  queryTaskCheckpoints,
  queryTaskCheckpointsByTask,
  queryTaskCheckpointsByTasks,
  createResearchRoutine,
  updateResearchRoutine,
  deleteResearchRoutine,
  getResearchRoutineById,
  queryResearchRoutines,
  createRoutineCheckIn,
  getRoutineCheckInById,
  queryRoutineCheckIns,
  queryRoutineCheckInsByRoutine,
  queryRoutineCheckInsByRoutines,
  getRoutinePeriodKey,
  archiveRouteNode,
  restoreRouteNode,
  deleteRouteNode,
  getRouteNodeById,
  queryRouteNodes,
  createTask,
  updateTask,
  archiveTask,
  restoreTask,
  deleteTask,
  completeTask,
  reopenTask,
  postponeTask,
  getTaskById,
  queryTasks,
  createReview,
  validateReviewCreateInput,
  updateReview,
  archiveReview,
  restoreReview,
  deleteReview,
  getReviewById,
  queryReviewFirstLayerIdentities,
  queryReviewCatalog,
  queryReviews,
  createReviewWithTargets,
  ensureReviewTargetLink,
  queryReviewTargets,
  replaceReviewTargets
};

export type PlanningService = typeof planningService;
