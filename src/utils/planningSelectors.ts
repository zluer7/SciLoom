import type {
  BaseEntity,
  EntityId,
  ExperimentSummary,
  PlanningData,
  ProjectExportContext,
  Review,
  RouteNode,
  Task,
  TimeBucket
} from "../types/planning";
import { isTaskIdeaOrPending } from "./planningIdeaState";

function isDeleted(entity: BaseEntity) {
  return Boolean(entity.deletedAt);
}

function isArchived(entity: BaseEntity & { status?: string }) {
  return Boolean(entity.archivedAt) || entity.status === "archived";
}

export function getVisibleItems<T extends BaseEntity & { status?: string }>(
  items: T[],
  options: { includeArchived?: boolean; includeDeleted?: boolean } = {}
): T[] {
  return items.filter((item) => {
    if (!options.includeDeleted && isDeleted(item)) {
      return false;
    }

    if (!options.includeArchived && isArchived(item)) {
      return false;
    }

    return true;
  });
}

export function getRouteNodesByProjectId(
  data: PlanningData,
  projectId: EntityId,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): RouteNode[] {
  return getVisibleItems(data.routeNodes, options)
    .filter((routeNode) => routeNode.projectId === projectId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export const getRouteNodesByProject = getRouteNodesByProjectId;

export function getTasksByProjectId(
  data: PlanningData,
  projectId: EntityId,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): Task[] {
  return getVisibleItems(data.tasks, options)
    .filter((task) => task.projectId === projectId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export const getTasksByProject = getTasksByProjectId;

export function getTasksByRouteNodeId(
  data: PlanningData,
  routeNodeId: EntityId,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): Task[] {
  return getVisibleItems(data.tasks, options)
    .filter((task) => task.routeNodeId === routeNodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export const getTasksByRouteNode = getTasksByRouteNodeId;

export function getTasksByTimeBucket(
  data: PlanningData,
  timeBucket: TimeBucket,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): Task[] {
  return getVisibleItems(data.tasks, options)
    .filter((task) => task.timeBucket === timeBucket)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function getTodayTasks(data: PlanningData): Task[] {
  return getTasksByTimeBucket(data, "today");
}

export function getThisWeekTasks(data: PlanningData): Task[] {
  return getTasksByTimeBucket(data, "this_week");
}

export function getThisMonthTasks(data: PlanningData): Task[] {
  return getTasksByTimeBucket(data, "this_month");
}

export function getLongTermTasks(data: PlanningData): Task[] {
  return getTasksByTimeBucket(data, "long_term");
}

export function getUnscheduledTasks(data: PlanningData): Task[] {
  return getVisibleItems(data.tasks)
    .filter(
      (task) =>
        task.timeBucket === "none" ||
        task.captureState === "unscheduled" ||
        (!task.scheduledDate && !task.dueDate)
    )
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function isIdeaOrPendingTask(task: Task): boolean {
  return isTaskIdeaOrPending(task);
}

export function getIdeaOrPendingTasks(data: PlanningData): Task[] {
  return getVisibleItems(data.tasks)
    .filter(isIdeaOrPendingTask)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export const getIdeaTasks = getIdeaOrPendingTasks;

export function getBlockedTasks(data: PlanningData): Task[] {
  return getVisibleItems(data.tasks)
    .filter((task) => task.status === "blocked")
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function getCompletedTasks(
  data: PlanningData,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): Task[] {
  return getVisibleItems(data.tasks, options)
    .filter((task) => task.status === "done")
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function getReviewsByProjectId(
  data: PlanningData,
  projectId: EntityId,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): Review[] {
  return getVisibleItems(data.reviews, options).filter((review) => review.projectId === projectId);
}

export const getReviewsByProject = getReviewsByProjectId;

export function getExperimentSummariesByProjectId(
  data: PlanningData,
  projectId: EntityId,
  options?: { includeArchived?: boolean; includeDeleted?: boolean }
): ExperimentSummary[] {
  return getVisibleItems(data.experimentSummaries, options).filter(
    (experimentSummary) => experimentSummary.projectId === projectId
  );
}

export const getExperimentSummariesByProject = getExperimentSummariesByProjectId;

export function getProjectsByDirection(data: PlanningData, directionId: EntityId) {
  return getVisibleItems(data.projects)
    .filter((project) => project.directionId === directionId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function getProjectOverview(data: PlanningData, projectId: EntityId) {
  const context = getProjectExportContext(data, projectId);
  if (!context) {
    return undefined;
  }

  return {
    project: context.project,
    direction: context.direction,
    routeNodeCount: context.routeNodes.length,
    taskCount: context.tasks.length,
    blockedTaskCount: context.tasks.filter((task) => task.status === "blocked").length,
    completedTaskCount: context.tasks.filter((task) => task.status === "done").length,
    reviewCount: context.reviews.length,
    experimentSummaryCount: context.experimentSummaries.length
  };
}

export function getProjectExportContext(
  data: PlanningData,
  projectId: EntityId
): ProjectExportContext | undefined {
  const project = getVisibleItems(data.projects).find((item) => item.id === projectId);
  if (!project) {
    return undefined;
  }

  const routeNodes = getRouteNodesByProjectId(data, projectId);
  const tasks = getTasksByProjectId(data, projectId);
  const reviews = getReviewsByProjectId(data, projectId);
  const experimentSummaries = getExperimentSummariesByProjectId(data, projectId);
  const routeNodeIds = new Set(routeNodes.map((routeNode) => routeNode.id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const experimentIds = new Set(experimentSummaries.map((experiment) => experiment.id));
  const entityLinks = data.entityLinks.filter(
    (link) =>
      routeNodeIds.has(link.sourceId) ||
      routeNodeIds.has(link.targetId) ||
      taskIds.has(link.sourceId) ||
      taskIds.has(link.targetId) ||
      experimentIds.has(link.sourceId) ||
      experimentIds.has(link.targetId) ||
      link.sourceId === projectId ||
      link.targetId === projectId
  );

  return {
    project,
    direction: data.researchDirections.find((direction) => direction.id === project.directionId),
    routeNodes,
    tasks,
    reviews,
    experimentSummaries,
    entityLinks
  };
}
