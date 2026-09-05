import type { RouteNode, RouteNodeStatus } from "../types/planning";
import type {
  ProjectRouteGanttData,
  ProjectRouteGanttDateCompleteness,
  ProjectRouteGanttDisplayMode,
  ProjectRouteGanttHiddenSummary,
  ProjectRouteGanttItem,
  ProjectRouteGanttStatus,
  ProjectRouteGanttWarning
} from "../types/projectRouteGantt";
import { isRouteConcept } from "../utils/planningIdeaState";
import { planningService } from "./planningService";
import { resolveProjectRouteGanttTicks } from "./projectRouteGanttTickResolver";

export type BuildProjectRouteGanttDataInput = {
  projectId: string;
  projectTitle?: string;
  projectExists?: boolean;
  routes: RouteNode[];
};

const statusLabels: Record<ProjectRouteGanttStatus, string> = {
  completed: "已完成",
  active: "正在执行",
  planned: "计划中",
  idea: "构想"
};

function emptyHiddenSummary(): ProjectRouteGanttHiddenSummary {
  return {
    hiddenByDisplaySwitch: 0,
    hiddenIdeaWithoutDate: 0,
    hiddenNoDate: 0,
    hiddenInvalidDateRange: 0
  };
}

function normalizeGanttDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return undefined;
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : undefined;
}

function isArchivedOrDeletedRoute(route: RouteNode) {
  return (
    route.status === "archived" ||
    route.captureState === "archived" ||
    Boolean(route.archivedAt) ||
    Boolean(route.deletedAt)
  );
}

function resolveDateCompleteness(
  startDate?: string,
  endDate?: string
): ProjectRouteGanttDateCompleteness | undefined {
  if (startDate && endDate) {
    return "complete";
  }
  if (startDate) {
    return "startOnly";
  }
  if (endDate) {
    return "endOnly";
  }
  return undefined;
}

function resolveDisplayMode(
  dateCompleteness: ProjectRouteGanttDateCompleteness
): ProjectRouteGanttDisplayMode {
  switch (dateCompleteness) {
    case "complete":
      return "solid";
    case "startOnly":
      return "fadeRight";
    case "endOnly":
      return "fadeLeft";
  }
}

function buildTimeLabel(
  dateCompleteness: ProjectRouteGanttDateCompleteness,
  startDate?: string,
  endDate?: string
) {
  switch (dateCompleteness) {
    case "complete":
      return `${startDate} 至 ${endDate}`;
    case "startOnly":
      return `${startDate} 起`;
    case "endOnly":
      return `截至 ${endDate}`;
  }
}

function resolveStatus(
  route: RouteNode,
  warnings: ProjectRouteGanttWarning[]
): ProjectRouteGanttStatus {
  if (isRouteConcept(route)) {
    return "idea";
  }

  switch (route.status) {
    case "completed":
      return "completed";
    case "active":
      return "active";
    case "planned":
      return "planned";
    case "paused":
      warnings.push({
        routeId: route.id,
        code: "unknownStatus",
        message: "Route status paused is mapped to active for the first Project route gantt DTO."
      });
      return "active";
    case "adjusted":
      warnings.push({
        routeId: route.id,
        code: "unknownStatus",
        message: "Route status adjusted is mapped to planned for the first Project route gantt DTO."
      });
      return "planned";
    case "archived":
      return "planned";
    default: {
      const unknownStatus = route.status as RouteNodeStatus | string;
      warnings.push({
        routeId: route.id,
        code: "unknownStatus",
        message: `Route status ${unknownStatus} is mapped to planned for the first Project route gantt DTO.`
      });
      return "planned";
    }
  }
}

function sortVisibleItems(items: ProjectRouteGanttItem[]) {
  const fallbackDate = "9999-12-31";
  const timeReference = (item: ProjectRouteGanttItem) =>
    item.startDate ?? item.endDate ?? fallbackDate;
  const endDateReference = (item: ProjectRouteGanttItem) => item.endDate ?? fallbackDate;
  const startPresenceRank = (item: ProjectRouteGanttItem) => (item.startDate ? 0 : 1);

  return [...items].sort((left, right) => {
    const leftTime = timeReference(left);
    const rightTime = timeReference(right);

    return (
      leftTime.localeCompare(rightTime) ||
      startPresenceRank(left) - startPresenceRank(right) ||
      endDateReference(left).localeCompare(endDateReference(right)) ||
      left.orderIndex - right.orderIndex ||
      left.title.localeCompare(right.title) ||
      left.routeId.localeCompare(right.routeId)
    );
  });
}

function resolveRange(items: ProjectRouteGanttItem[]) {
  const dates = items.flatMap((item) => [item.startDate, item.endDate].filter(Boolean));
  if (dates.length === 0) {
    return {};
  }

  const sortedDates = [...dates].sort();
  return {
    rangeStart: sortedDates[0],
    rangeEnd: sortedDates[sortedDates.length - 1]
  };
}

function createItem(
  route: RouteNode,
  dateCompleteness: ProjectRouteGanttDateCompleteness,
  status: ProjectRouteGanttStatus,
  startDate?: string,
  endDate?: string
): ProjectRouteGanttItem {
  return {
    routeId: route.id,
    projectId: route.projectId,
    title: route.title,
    status,
    statusLabel: statusLabels[status],
    startDate,
    endDate,
    dateCompleteness,
    displayMode: resolveDisplayMode(dateCompleteness),
    timeLabel: buildTimeLabel(dateCompleteness, startDate, endDate),
    orderIndex: route.orderIndex,
    originalStatus: route.status,
    captureState: route.captureState
  };
}

export function buildProjectRouteGanttData(
  input: BuildProjectRouteGanttDataInput
): ProjectRouteGanttData {
  const hiddenSummary = emptyHiddenSummary();
  const warnings: ProjectRouteGanttWarning[] = [];
  const visibleItems: ProjectRouteGanttItem[] = [];

  if (input.projectExists === false) {
    warnings.push({
      code: "missingProject",
      message: `Project was not found: ${input.projectId}.`
    });
  }

  for (const route of input.routes) {
    if (route.projectId !== input.projectId) {
      continue;
    }

    if (isArchivedOrDeletedRoute(route)) {
      continue;
    }

    if (route.showInGantt === false) {
      hiddenSummary.hiddenByDisplaySwitch += 1;
      continue;
    }

    const startDate = normalizeGanttDate(route.startDate);
    const endDate = normalizeGanttDate(route.endDate);

    if (startDate && endDate && startDate > endDate) {
      hiddenSummary.hiddenInvalidDateRange += 1;
      warnings.push({
        routeId: route.id,
        code: "invalidDateRange",
        message: `Route startDate ${startDate} is later than endDate ${endDate}.`
      });
      continue;
    }

    const dateCompleteness = resolveDateCompleteness(startDate, endDate);
    if (!dateCompleteness) {
      if (isRouteConcept(route)) {
        hiddenSummary.hiddenIdeaWithoutDate += 1;
      } else {
        hiddenSummary.hiddenNoDate += 1;
      }
      continue;
    }

    visibleItems.push(
      createItem(route, dateCompleteness, resolveStatus(route, warnings), startDate, endDate)
    );
  }

  const sortedVisibleItems = sortVisibleItems(visibleItems);
  const { rangeStart, rangeEnd } = resolveRange(sortedVisibleItems);
  const defaultVerticalAnchorRouteId = sortedVisibleItems.find(
    (item) => item.status === "active"
  )?.routeId;
  const timeTicks = resolveProjectRouteGanttTicks({ rangeStart, rangeEnd });

  return {
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    rangeStart,
    rangeEnd,
    timeTicks,
    tickGranularity: timeTicks[0]?.granularity,
    defaultVerticalAnchorRouteId,
    visibleItems: sortedVisibleItems,
    hiddenSummary,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

export async function getProjectRouteGanttData(projectId: string): Promise<ProjectRouteGanttData> {
  const [project, routes] = await Promise.all([
    planningService.getProjectById(projectId),
    planningService.queryRouteNodes({
      projectId,
      includeArchived: true,
      includeDeleted: true
    })
  ]);

  return buildProjectRouteGanttData({
    projectId,
    projectTitle: project?.title,
    projectExists: Boolean(project),
    routes
  });
}

export const projectRouteGanttSelectorService = {
  buildProjectRouteGanttData,
  getProjectRouteGanttData
};

export type ProjectRouteGanttSelectorService = typeof projectRouteGanttSelectorService;
