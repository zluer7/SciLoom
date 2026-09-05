import type { RouteNode } from "../types/planning";
import type {
  RouteResearchProgressItem,
  RouteResearchProgressStatus,
  RoutesResearchProgressData
} from "../types/routesResearchProgress";

export type ResolveRoutesResearchProgressInput = {
  projectId: string;
  routes: RouteNode[];
  locale?: string;
};

type DateResolution =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "valid"; value: string };

type StatusResolution = RouteResearchProgressStatus | "concept" | undefined;

type ResearchProgressCandidate = {
  route: RouteNode;
  status: RouteResearchProgressStatus;
  startDate?: string;
  endDate?: string;
  primaryDate: string;
  completionSortKey: number;
};

const conceptCaptureStates = new Set(["idea", "pending", "someday"]);
const missingEndDateSortKey = "9999-12-31";
const missingOrderIndexSortKey = Number.MAX_SAFE_INTEGER;

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveOrderIndex(route: RouteNode) {
  return Number.isFinite(route.orderIndex) ? route.orderIndex : missingOrderIndexSortKey;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

export function normalizeResearchProgressDate(value: unknown): DateResolution {
  if (value === undefined || value === null) {
    return { state: "missing" };
  }
  if (typeof value !== "string") {
    return { state: "invalid" };
  }

  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    return { state: "invalid" };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return { state: "invalid" };
  }

  return { state: "valid", value: normalized };
}

function isArchivedOrDeleted(route: RouteNode) {
  return (
    route.status === "archived" ||
    route.captureState === "archived" ||
    Boolean(route.archivedAt) ||
    Boolean(route.deletedAt)
  );
}

function resolveResearchProgressStatus(route: RouteNode): StatusResolution {
  if (conceptCaptureStates.has(route.captureState)) {
    return "concept";
  }

  switch (route.status) {
    case "active":
    case "paused":
      return "active";
    case "completed":
      return "completed";
    case "planned":
    case "adjusted":
      return "planned";
    default:
      return undefined;
  }
}

function dateOnlyToUtcKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

function strictTimestampToUtcKey(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    normalized
  );
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] ? Number(match[8]) : 0;
  const offsetMinute = match[9] ? Number(match[9]) : 0;
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }
  const key = Date.parse(normalized);
  return Number.isFinite(key) ? key : undefined;
}

function resolveCompletionSortKey(route: RouteNode, endDate?: string) {
  return (
    strictTimestampToUtcKey(route.completedAt) ??
    (endDate ? dateOnlyToUtcKey(endDate) : undefined) ??
    strictTimestampToUtcKey(route.updatedAt) ??
    Number.NEGATIVE_INFINITY
  );
}

function compareTimelineCandidates(
  left: ResearchProgressCandidate,
  right: ResearchProgressCandidate
) {
  return (
    compareText(left.primaryDate, right.primaryDate) ||
    compareText(
      left.endDate ?? missingEndDateSortKey,
      right.endDate ?? missingEndDateSortKey
    ) ||
    resolveOrderIndex(left.route) - resolveOrderIndex(right.route) ||
    compareText(left.route.title, right.route.title) ||
    compareText(left.route.id, right.route.id)
  );
}

function compareCompletedCandidates(
  left: ResearchProgressCandidate,
  right: ResearchProgressCandidate
) {
  return (
    right.completionSortKey - left.completionSortKey ||
    resolveOrderIndex(left.route) - resolveOrderIndex(right.route) ||
    compareText(left.route.title, right.route.title) ||
    compareText(left.route.id, right.route.id)
  );
}

export function formatRouteResearchProgressTimeText(
  startDate: string | undefined,
  endDate: string | undefined,
  locale = "zh-CN"
) {
  const isEnglish = locale.toLowerCase().startsWith("en");
  if (startDate && endDate) {
    return isEnglish
      ? `${startDate} to ${endDate}`
      : `${startDate} 至 ${endDate}`;
  }
  if (startDate) {
    return isEnglish ? `From ${startDate}` : `${startDate} 起`;
  }
  return isEnglish ? `Until ${endDate}` : `截至 ${endDate}`;
}

function createDto(
  candidate: ResearchProgressCandidate,
  projectId: string,
  locale?: string
): RouteResearchProgressItem {
  const { route, status, startDate, endDate, primaryDate } = candidate;
  return {
    routeId: route.id,
    projectId,
    title: route.title,
    status,
    startDate,
    endDate,
    timeText: formatRouteResearchProgressTimeText(startDate, endDate, locale),
    sortDate: primaryDate,
    colorState: status
  };
}

export function resolveRoutesResearchProgress(
  input: ResolveRoutesResearchProgressInput
): RoutesResearchProgressData {
  const activeCandidates: ResearchProgressCandidate[] = [];
  const completedCandidates: ResearchProgressCandidate[] = [];
  const plannedCandidates: ResearchProgressCandidate[] = [];

  for (const route of input.routes) {
    if (route.projectId !== input.projectId) {
      continue;
    }
    if (isArchivedOrDeleted(route)) {
      continue;
    }

    const statusResolution = resolveResearchProgressStatus(route);
    if (!statusResolution) {
      continue;
    }

    const startResolution = normalizeResearchProgressDate(route.startDate);
    const endResolution = normalizeResearchProgressDate(route.endDate);
    if (startResolution.state === "invalid" || endResolution.state === "invalid") {
      continue;
    }

    const startDate = startResolution.state === "valid" ? startResolution.value : undefined;
    const endDate = endResolution.state === "valid" ? endResolution.value : undefined;
    if ((!startDate && !endDate) || (startDate && endDate && startDate > endDate)) {
      continue;
    }

    const status: RouteResearchProgressStatus =
      statusResolution === "concept" ? "planned" : statusResolution;
    const candidate: ResearchProgressCandidate = {
      route,
      status,
      startDate,
      endDate,
      primaryDate: startDate ?? endDate!,
      completionSortKey: resolveCompletionSortKey(route, endDate)
    };

    if (status === "active") {
      activeCandidates.push(candidate);
    } else if (status === "completed") {
      completedCandidates.push(candidate);
    } else {
      plannedCandidates.push(candidate);
    }
  }

  activeCandidates.sort(compareTimelineCandidates);
  completedCandidates.sort(compareCompletedCandidates);
  plannedCandidates.sort(compareTimelineCandidates);

  const selected = activeCandidates.slice(0, 5);
  if (selected.length < 3) {
    const completedLimit = Math.min(2, 3 - selected.length);
    selected.push(...completedCandidates.slice(0, completedLimit));
  }
  if (selected.length < 3) {
    selected.push(...plannedCandidates.slice(0, 3 - selected.length));
  }

  selected.sort(compareTimelineCandidates);

  return {
    projectId: input.projectId,
    items: selected.map((candidate) => createDto(candidate, input.projectId, input.locale))
  };
}

export const routesResearchProgressSelectorService = {
  resolveRoutesResearchProgress
};

export type RoutesResearchProgressSelectorService =
  typeof routesResearchProgressSelectorService;
