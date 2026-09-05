import type {
  PlanningProjectPlanRouteEntry,
  PlanningProjectPlanTaskEntry
} from "../../services/planningPageAdapterService";
import type {
  Experiment,
  ExperimentRating,
  ExperimentRun,
  ExperimentRunStatus,
  ExperimentStatus
} from "../../types/experiment";
import type {
  Literature,
  LiteratureImportance,
  LiteratureReadingStatus
} from "../../types/literature";
import type { TaskStatus } from "../../types/planning";
import type { WorkStatus } from "../../types";

export type ReviewRelationTimeFilter =
  | "all"
  | "this_month"
  | "this_quarter"
  | "unscheduled";

type ReviewRelationFilterBase = {
  showSelectedOnly: boolean;
};

export type ReviewRouteRelationFilter = ReviewRelationFilterBase & {
  status: "" | WorkStatus;
  time: ReviewRelationTimeFilter;
  keyword: string;
};

export type ReviewTaskRelationFilter = ReviewRelationFilterBase & {
  status: "" | TaskStatus;
  time: ReviewRelationTimeFilter;
  priority: "" | "high" | "medium" | "low";
};

export type ReviewExperimentRelationFilter = ReviewRelationFilterBase & {
  status: "" | ExperimentStatus;
  rating: "" | ExperimentRating | "unrated";
  tag: string;
};

export type ReviewRunRelationFilter = ReviewRelationFilterBase & {
  status: "" | ExperimentRunStatus;
  time: ReviewRelationTimeFilter;
  tag: string;
};

export type ReviewLiteratureRelationFilter = ReviewRelationFilterBase & {
  readingStatus: "" | LiteratureReadingStatus;
  importance: "" | LiteratureImportance | "unset";
  keyword: string;
};

export type ReviewRelationFilters = {
  routeNode: ReviewRouteRelationFilter;
  task: ReviewTaskRelationFilter;
  experiment: ReviewExperimentRelationFilter;
  experimentRun: ReviewRunRelationFilter;
  literature: ReviewLiteratureRelationFilter;
};

export type ReviewRelationFilterKey = keyof ReviewRelationFilters;

export function createDefaultReviewRelationFilters(): ReviewRelationFilters {
  return {
    routeNode: {
      status: "",
      time: "all",
      keyword: "",
      showSelectedOnly: false
    },
    task: {
      status: "",
      time: "all",
      priority: "",
      showSelectedOnly: false
    },
    experiment: {
      status: "",
      rating: "",
      tag: "",
      showSelectedOnly: false
    },
    experimentRun: {
      status: "",
      time: "all",
      tag: "",
      showSelectedOnly: false
    },
    literature: {
      readingStatus: "",
      importance: "",
      keyword: "",
      showSelectedOnly: false
    }
  };
}

export function resetReviewRelationFilter(
  filters: ReviewRelationFilters,
  key: ReviewRelationFilterKey
): ReviewRelationFilters {
  const defaults = createDefaultReviewRelationFilters();
  return { ...filters, [key]: defaults[key] };
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function includesKeyword(keyword: string, values: unknown[]) {
  const normalizedKeyword = normalizeSearchValue(keyword);
  if (!normalizedKeyword) {
    return true;
  }
  return values.some((value) => normalizeSearchValue(value).includes(normalizedKeyword));
}

function parseDate(value?: string) {
  if (!value) {
    return null;
  }
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeRangeForFilter(filter: ReviewRelationTimeFilter, now: Date) {
  if (filter === "all" || filter === "unscheduled") {
    return null;
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (filter === "this_month") {
    start.setDate(1);
    end.setMonth(start.getMonth() + 1, 1);
  } else {
    start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1);
    end.setMonth(start.getMonth() + 3, 1);
  }
  end.setMilliseconds(-1);
  return { start, end };
}

export function matchesReviewRelationTime(
  startValue: string | undefined,
  endValue: string | undefined,
  filter: ReviewRelationTimeFilter,
  now = new Date()
) {
  if (filter === "all") {
    return true;
  }
  const parsedStart = parseDate(startValue);
  const parsedEnd = parseDate(endValue);
  if (filter === "unscheduled") {
    return !parsedStart && !parsedEnd;
  }
  if (!parsedStart && !parsedEnd) {
    return false;
  }
  const objectStart = parsedStart ?? parsedEnd!;
  const objectEnd = parsedEnd ?? parsedStart!;
  const range = timeRangeForFilter(filter, now);
  if (!range) {
    return true;
  }
  const normalizedStart = objectStart <= objectEnd ? objectStart : objectEnd;
  const normalizedEnd = objectStart <= objectEnd ? objectEnd : objectStart;
  return normalizedStart <= range.end && normalizedEnd >= range.start;
}

function selectedOnlyMatch(
  id: string,
  selectedIds: ReadonlySet<string>,
  showSelectedOnly: boolean
) {
  return !showSelectedOnly || selectedIds.has(id);
}

export function filterReviewRouteOptions(
  options: PlanningProjectPlanRouteEntry[],
  filter: ReviewRouteRelationFilter,
  selectedIds: string[],
  now = new Date()
) {
  const selectedIdSet = new Set(selectedIds);
  return options.filter(
    (route) =>
      selectedOnlyMatch(route.id, selectedIdSet, filter.showSelectedOnly) &&
      (!filter.status || route.status === filter.status) &&
      matchesReviewRelationTime(route.startDate, route.endDate, filter.time, now) &&
      includesKeyword(filter.keyword, [
        route.title,
        route.description,
        route.expectedOutput
      ])
  );
}

export function filterReviewTaskOptions(
  options: PlanningProjectPlanTaskEntry[],
  filter: ReviewTaskRelationFilter,
  selectedIds: string[],
  now = new Date()
) {
  const selectedIdSet = new Set(selectedIds);
  return options.filter(
    (task) =>
      selectedOnlyMatch(task.id, selectedIdSet, filter.showSelectedOnly) &&
      (!filter.status || task.planningStatus === filter.status) &&
      matchesReviewRelationTime(task.startDate, task.endDate, filter.time, now) &&
      (!filter.priority || task.priority === filter.priority)
  );
}

function tagMatches(tags: string[], selectedTag: string) {
  const normalizedTag = normalizeSearchValue(selectedTag);
  return (
    !normalizedTag ||
    tags.some((tag) => normalizeSearchValue(tag) === normalizedTag)
  );
}

export function filterReviewExperimentOptions(
  options: Experiment[],
  filter: ReviewExperimentRelationFilter,
  selectedIds: string[]
) {
  const selectedIdSet = new Set(selectedIds);
  return options.filter(
    (experiment) =>
      selectedOnlyMatch(experiment.id, selectedIdSet, filter.showSelectedOnly) &&
      (!filter.status || experiment.status === filter.status) &&
      (!filter.rating ||
        (filter.rating === "unrated"
          ? !experiment.rating
          : experiment.rating === filter.rating)) &&
      tagMatches(experiment.tags, filter.tag)
  );
}

export function filterReviewRunOptions(
  options: ExperimentRun[],
  filter: ReviewRunRelationFilter,
  selectedIds: string[],
  now = new Date()
) {
  const selectedIdSet = new Set(selectedIds);
  return options.filter(
    (run) =>
      selectedOnlyMatch(run.id, selectedIdSet, filter.showSelectedOnly) &&
      (!filter.status || run.status === filter.status) &&
      matchesReviewRelationTime(run.startedAt, run.completedAt, filter.time, now) &&
      tagMatches(run.tags, filter.tag)
  );
}

export function filterReviewLiteratureOptions(
  options: Literature[],
  filter: ReviewLiteratureRelationFilter,
  selectedIds: string[]
) {
  const selectedIdSet = new Set(selectedIds);
  return options.filter(
    (literature) =>
      selectedOnlyMatch(literature.id, selectedIdSet, filter.showSelectedOnly) &&
      (!filter.readingStatus || literature.readingStatus === filter.readingStatus) &&
      (!filter.importance ||
        (filter.importance === "unset"
          ? !literature.importance
          : literature.importance === filter.importance)) &&
      includesKeyword(filter.keyword, [
        literature.title,
        ...literature.authors.map((author) => author.name),
        ...(literature.keywords ?? []),
        ...literature.tags,
        literature.venue,
        literature.doi
      ])
  );
}

export function buildReviewRelationTagOptions(options: Array<{ tags: string[] }>) {
  const labels = new Map<string, string>();
  for (const option of options) {
    for (const rawTag of option.tags) {
      const tag = rawTag.trim();
      if (tag) {
        labels.set(normalizeSearchValue(tag), tag);
      }
    }
  }
  return [...labels.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  );
}

export function buildReviewRelationFilterSummary(
  selectedIds: string[],
  visibleCount: number,
  totalCount: number
) {
  return {
    selectedCount: new Set(selectedIds).size,
    visibleCount,
    totalCount
  };
}

export function isReviewRelationFilterActive(
  filter:
    | ReviewRouteRelationFilter
    | ReviewTaskRelationFilter
    | ReviewExperimentRelationFilter
    | ReviewRunRelationFilter
    | ReviewLiteratureRelationFilter
) {
  return Object.entries(filter).some(([key, value]) => {
    if (key === "showSelectedOnly") {
      return value === true;
    }
    if (key === "time") {
      return value !== "all";
    }
    return Boolean(value);
  });
}
