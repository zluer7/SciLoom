import type { Experiment, ExperimentRun } from "../types/experiment";
import type { Literature } from "../types/literature";
import type { Finding, OutputCandidate, OutputGap, ResultItem } from "../types/outputConversion";
import type { Project, Review, RouteNode, Task } from "../types/planning";
import type { ResearchOutput } from "../types/output";
import type {
  ProjectResearchTraceData,
  ProjectResearchTraceDatePrecision,
  ProjectResearchTraceEvent,
  ProjectResearchTraceEventType,
  ProjectResearchTraceHiddenSummary,
  ProjectResearchTraceLane,
  ProjectResearchTracePriority,
  ProjectResearchTraceSelectorOptions,
  ProjectResearchTraceSourceModule,
  ProjectResearchTraceTargetType,
  ProjectResearchTraceWarning,
  ResearchTraceEventPreference
} from "../types/projectResearchTrace";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { literatureService } from "./literatureService";
import { outputService } from "./outputService";
import { outputConversionService } from "./outputConversionService";
import { planningService } from "./planningService";
import {
  assignResearchTraceRenderMetadata,
  compareResearchTraceTimelineEvents,
  resolveResearchTraceBaseDisplayLimit,
  resolveResearchTraceDisplayPriority,
  selectResearchTraceRenderableEvents
} from "./projectResearchTraceDisplayRules";
import { listResearchTracePreferences } from "./projectResearchTracePreferenceService";
import { isRouteResearchTraceDefaultDisplayed } from "./projectResearchTracePreferenceUiService";

export type BuildProjectResearchTraceDataInput = {
  projectId: string;
  projectTitle?: string;
  projectExists?: boolean;
  projects?: Project[];
  routes: RouteNode[];
  tasks?: Task[];
  reviews: Review[];
  experiments?: Experiment[];
  experimentRuns?: ExperimentRun[];
  literatures?: Literature[];
  resultItems?: ResultItem[];
  findings: Finding[];
  outputCandidates: OutputCandidate[];
  outputGaps: OutputGap[];
  researchOutputs: ResearchOutput[];
  preferences?: ResearchTraceEventPreference[];
  generatedAt?: string;
};

type TraceDateResult = {
  occurredAt: string;
  occurredAtPrecision: ProjectResearchTraceDatePrecision;
};

type TraceBuildContext = {
  today: string;
  excludeFutureEvents: boolean;
};

type TraceEventSeed = {
  eventType: ProjectResearchTraceEventType;
  targetType: ProjectResearchTraceTargetType;
  targetId: string;
  projectId: string;
  title: string;
  description?: string;
  statusLabel?: string;
  sourceModule: ProjectResearchTraceSourceModule;
  dateValue: unknown;
  sourcePolicy?: "auto" | "pinned";
};

const DEFAULT_BASE_DISPLAY_LIMIT = resolveResearchTraceBaseDisplayLimit("standard");
const DEFAULT_VISIBLE_COUNT = DEFAULT_BASE_DISPLAY_LIMIT;
const DEFAULT_MAX_RENDERABLE_COUNT = 70;

const eventTypeLabels: Record<ProjectResearchTraceEventType, string> = {
  projectCreated: "课题创建",
  routeStarted: "路线启动",
  routeCompleted: "路线完成",
  reviewRecorded: "阶段复盘",
  findingCreated: "发现",
  candidateCreated: "候选成果",
  gapCreated: "成果缺口",
  researchOutputCreated: "正式成果",
  taskRecorded: "任务",
  experimentRecorded: "实验",
  experimentRunRecorded: "Run",
  literatureRecorded: "文献",
  resultItemCreated: "结果项"
};

const eventLaneByType: Record<ProjectResearchTraceEventType, ProjectResearchTraceLane> = {
  projectCreated: "axis",
  routeStarted: "lowerProgress",
  routeCompleted: "lowerProgress",
  reviewRecorded: "upperInsight",
  findingCreated: "upperInsight",
  candidateCreated: "upperOutcome",
  gapCreated: "upperInsight",
  researchOutputCreated: "upperOutcome",
  taskRecorded: "lowerProgress",
  experimentRecorded: "lowerWork",
  experimentRunRecorded: "lowerWork",
  literatureRecorded: "lowerWork",
  resultItemCreated: "lowerWork"
};

const eventPriorityByType: Record<ProjectResearchTraceEventType, ProjectResearchTracePriority> = {
  projectCreated: "normal",
  routeStarted: "normal",
  routeCompleted: "normal",
  reviewRecorded: "normal",
  findingCreated: "finding",
  candidateCreated: "outputCandidate",
  gapCreated: "normal",
  researchOutputCreated: "researchOutput",
  taskRecorded: "normal",
  experimentRecorded: "normal",
  experimentRunRecorded: "normal",
  literatureRecorded: "normal",
  resultItemCreated: "normal"
};

function emptyHiddenSummary(): ProjectResearchTraceHiddenSummary {
  return {
    hiddenMissingDate: 0,
    hiddenInvalidDate: 0,
    hiddenFutureDate: 0,
    hiddenArchivedOrDeleted: 0,
    hiddenByProject: 0,
    hiddenByDefaultPolicy: 0,
    hiddenByPreference: 0,
    overLimit: 0
  };
}

function normalizeDisplayCount(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function resolveDisplayLimits(options: ProjectResearchTraceSelectorOptions) {
  const baseDisplayLimit = normalizeDisplayCount(
    options.baseDisplayLimit,
    DEFAULT_BASE_DISPLAY_LIMIT
  );
  const defaultVisibleCount = normalizeDisplayCount(
    options.defaultVisibleCount,
    baseDisplayLimit
  );
  const maxRenderableCount = normalizeDisplayCount(
    options.maxRenderableCount ?? options.limit,
    DEFAULT_MAX_RENDERABLE_COUNT
  );
  return {
    baseDisplayLimit,
    defaultVisibleCount,
    maxRenderableCount: Math.max(defaultVisibleCount, maxRenderableCount)
  };
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncateDescription(value: unknown): string | undefined {
  const text = trimText(value);
  if (!text) {
    return undefined;
  }
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function validateDatePart(datePart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return false;
  }
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === datePart;
}

function getLocalTodayIso() {
  const now = new Date();
  const localMidnight = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return localMidnight.toISOString().slice(0, 10);
}

function normalizeToday(value: unknown) {
  return typeof value === "string" && validateDatePart(value.trim()) ? value.trim() : getLocalTodayIso();
}

function normalizeTraceDate(value: unknown): TraceDateResult | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const datePart = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)?.[1];
  if (!datePart || !validateDatePart(datePart)) {
    return undefined;
  }

  if (trimmed.length > 10 && Number.isNaN(new Date(trimmed).getTime())) {
    return undefined;
  }

  return {
    occurredAt: datePart,
    occurredAtPrecision: "day"
  };
}

function isFutureDate(date: string, today: string) {
  return date > today;
}

function isArchivedOrDeletedPlanningEntity(entity: { archivedAt?: string | null; deletedAt?: string | null }) {
  return Boolean(entity.archivedAt) || Boolean(entity.deletedAt);
}

function isDeletedOutputEntity(entity: { deletedAt?: string | null }) {
  return Boolean(entity.deletedAt);
}

function buildWarning(
  seed: Pick<TraceEventSeed, "eventType" | "targetType" | "targetId">,
  code: ProjectResearchTraceWarning["code"],
  message: string
): ProjectResearchTraceWarning {
  return {
    code,
    message,
    eventType: seed.eventType,
    targetType: seed.targetType,
    targetId: seed.targetId
  };
}

function createEvent(seed: TraceEventSeed, date: TraceDateResult, context: TraceBuildContext): ProjectResearchTraceEvent {
  const typeLabel = eventTypeLabels[seed.eventType];
  const sourcePolicy = seed.sourcePolicy ?? "auto";
  const event = {
    id: `${seed.eventType}:${seed.targetType}:${seed.targetId}:${date.occurredAt}`,
    projectId: seed.projectId,
    eventType: seed.eventType,
    targetType: seed.targetType,
    targetId: seed.targetId,
    title: seed.title,
    description: seed.description,
    occurredAt: date.occurredAt,
    occurredAtPrecision: date.occurredAtPrecision,
    sourcePolicy,
    displayState: sourcePolicy,
    canBePinned: true,
    sourceModule: seed.sourceModule,
    lane: eventLaneByType[seed.eventType],
    priority: eventPriorityByType[seed.eventType],
    traceDisplayPriority: 0,
    renderOrder: 0,
    markerStackIndex: 0,
    markerStackOffset: 0,
    typeLabel,
    statusLabel: seed.statusLabel,
    warning: isFutureDate(date.occurredAt, context.today) ? "futureDate" : undefined
  };
  return {
    ...event,
    traceDisplayPriority: resolveResearchTraceDisplayPriority(event)
  };
}

function pushEvent(
  events: ProjectResearchTraceEvent[],
  warnings: ProjectResearchTraceWarning[],
  hiddenSummary: ProjectResearchTraceHiddenSummary,
  seed: TraceEventSeed,
  context: TraceBuildContext
) {
  const rawDate = typeof seed.dateValue === "string" ? seed.dateValue.trim() : "";
  if (!rawDate) {
    hiddenSummary.hiddenMissingDate += 1;
    warnings.push(buildWarning(seed, "missingDate", `${seed.eventType} skipped because date is missing.`));
    return;
  }

  const date = normalizeTraceDate(seed.dateValue);
  if (!date) {
    hiddenSummary.hiddenInvalidDate += 1;
    warnings.push(
      buildWarning(seed, "invalidDate", `${seed.eventType} skipped because date is invalid: ${rawDate}.`)
    );
    return;
  }

  if (context.excludeFutureEvents && isFutureDate(date.occurredAt, context.today)) {
    hiddenSummary.hiddenFutureDate += 1;
    return;
  }

  const event = createEvent(seed, date, context);
  if (event.warning === "futureDate") {
    warnings.push(buildWarning(seed, "futureDate", `${seed.eventType} uses a future date: ${date.occurredAt}.`));
  }
  events.push(event);
}

function sortEvents(events: ProjectResearchTraceEvent[]) {
  return [...events].sort(compareResearchTraceTimelineEvents);
}

function resolveRange(events: ProjectResearchTraceEvent[], today: string) {
  const timelineEvents = events.filter((event) => event.eventType !== "projectCreated");
  if (timelineEvents.length === 0) {
    return {};
  }
  return {
    rangeStart: timelineEvents[0].occurredAt,
    rangeEnd: today < timelineEvents[0].occurredAt ? timelineEvents[0].occurredAt : today
  };
}

function preferenceKey(targetType: ProjectResearchTraceTargetType, targetId: string) {
  return `${targetType}:${targetId}`;
}

function buildPreferenceMap(projectId: string, preferences: ResearchTraceEventPreference[] = []) {
  return new Map(
    preferences
      .filter((preference) => preference.projectId === projectId && !preference.deletedAt)
      .map((preference) => [
        preferenceKey(preference.targetType, preference.targetId),
        preference
      ])
  );
}

function getTargetPreference(
  preferences: Map<string, ResearchTraceEventPreference>,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
) {
  return preferences.get(preferenceKey(targetType, targetId));
}

function isHiddenByPreference(
  preferences: Map<string, ResearchTraceEventPreference>,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
) {
  return getTargetPreference(preferences, targetType, targetId)?.visibility === "hidden";
}

function isPinnedByPreference(
  preferences: Map<string, ResearchTraceEventPreference>,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
) {
  return getTargetPreference(preferences, targetType, targetId)?.visibility === "pinned";
}

function getDisplaySourcePolicy(
  preferences: Map<string, ResearchTraceEventPreference>,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
): "auto" | "pinned" {
  return isPinnedByPreference(preferences, targetType, targetId) ? "pinned" : "auto";
}

function isStageReview(review: Review) {
  return review.reviewType === "stage";
}

function includeProject(project: Project | undefined, input: BuildProjectResearchTraceDataInput) {
  if (!project) {
    return;
  }
  return {
    eventType: "projectCreated",
    targetType: "project",
    targetId: project.id,
    projectId: input.projectId,
    title: project.title,
    description: truncateDescription(project.description ?? project.objective),
    statusLabel: project.status,
    sourceModule: "project",
    dateValue: project.createdAt
  } satisfies TraceEventSeed;
}

export function buildProjectResearchTraceData(
  input: BuildProjectResearchTraceDataInput,
  options: ProjectResearchTraceSelectorOptions = {}
): ProjectResearchTraceData {
  const hiddenSummary = emptyHiddenSummary();
  const warnings: ProjectResearchTraceWarning[] = [];
  const events: ProjectResearchTraceEvent[] = [];
  const { defaultVisibleCount, maxRenderableCount } = resolveDisplayLimits(options);
  const includeWarnings = options.includeWarnings !== false;
  const context: TraceBuildContext = {
    today: normalizeToday(options.today),
    excludeFutureEvents: options.excludeFutureEvents !== false
  };
  const preferences = buildPreferenceMap(input.projectId, input.preferences);

  if (input.projectExists === false) {
    warnings.push({
      code: "missingProject",
      message: `Project was not found: ${input.projectId}.`
    });
  }

  const project =
    input.projects?.find((item) => item.id === input.projectId && !item.deletedAt) ??
    (input.projectExists === false
      ? undefined
      : ({
          id: input.projectId,
          title: input.projectTitle ?? input.projectId,
          createdAt: undefined
        } as Partial<Project> as Project));

  const projectSeed = includeProject(project, input);
  if (projectSeed) {
    pushEvent(events, warnings, hiddenSummary, projectSeed, context);
  }

  for (const route of input.routes) {
    if (route.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isArchivedOrDeletedPlanningEntity(route) || route.status === "archived" || route.captureState === "archived") {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "route", route.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    const isPinnedRoute = isPinnedByPreference(preferences, "route", route.id);
    const isDefaultDisplayedRoute = isRouteResearchTraceDefaultDisplayed(route, context.today);
    if (isPinnedRoute || isDefaultDisplayedRoute) {
      pushEvent(events, warnings, hiddenSummary, {
        eventType: "routeStarted",
        targetType: "route",
        targetId: route.id,
        projectId: input.projectId,
        title: route.title,
        description: truncateDescription(route.objective ?? route.expectedOutput),
        statusLabel: route.status,
        sourceModule: "route",
        dateValue: route.startDate || route.completedAt || route.endDate,
        sourcePolicy: isPinnedRoute ? "pinned" : "auto"
      }, context);
      continue;
    }
    hiddenSummary.hiddenByDefaultPolicy += 1;
  }

  for (const review of input.reviews) {
    if (review.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isArchivedOrDeletedPlanningEntity(review)) {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "review", review.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isStageReview(review)) {
      if (isPinnedByPreference(preferences, "review", review.id)) {
        pushEvent(events, warnings, hiddenSummary, {
          eventType: "reviewRecorded",
          targetType: "review",
          targetId: review.id,
          projectId: input.projectId,
          title: review.title,
          description: truncateDescription(review.periodLabel ?? review.description),
          statusLabel: review.reviewType,
          sourceModule: "review",
          dateValue: review.periodEnd || review.createdAt,
          sourcePolicy: "pinned"
        }, context);
        continue;
      }
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    const reviewSourcePolicy = getDisplaySourcePolicy(preferences, "review", review.id);
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "reviewRecorded",
      targetType: "review",
      targetId: review.id,
      projectId: input.projectId,
      title: review.title,
      description: truncateDescription(review.periodLabel ?? review.description),
      statusLabel: review.reviewType,
      sourceModule: "review",
      dateValue: review.periodEnd || review.createdAt,
      sourcePolicy: reviewSourcePolicy
    }, context);
  }

  for (const task of input.tasks ?? []) {
    if (task.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isArchivedOrDeletedPlanningEntity(task) || task.status === "archived") {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "task", task.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isPinnedByPreference(preferences, "task", task.id)) {
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "taskRecorded",
      targetType: "task",
      targetId: task.id,
      projectId: input.projectId,
      title: task.title,
      description: truncateDescription(task.resultNote ?? task.acceptanceCriteria),
      statusLabel: task.status,
      sourceModule: "task",
      dateValue: task.completedAt || task.dueDate || task.scheduledDate || task.createdAt,
      sourcePolicy: "pinned"
    }, context);
  }

  for (const finding of input.findings) {
    if (finding.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(finding)) {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "finding", finding.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isPinnedByPreference(preferences, "finding", finding.id)) {
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "findingCreated",
      targetType: "finding",
      targetId: finding.id,
      projectId: input.projectId,
      title: finding.title,
      description: truncateDescription(finding.summary),
      statusLabel: finding.status,
      sourceModule: "outputs",
      dateValue: finding.createdAt,
      sourcePolicy: "pinned"
    }, context);
  }

  for (const candidate of input.outputCandidates) {
    if (candidate.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(candidate)) {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "outputCandidate", candidate.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "candidateCreated",
      targetType: "outputCandidate",
      targetId: candidate.id,
      projectId: input.projectId,
      title: candidate.title,
      description: truncateDescription(candidate.description),
      statusLabel: candidate.status,
      sourceModule: "outputs",
      dateValue: candidate.createdAt,
      sourcePolicy: getDisplaySourcePolicy(preferences, "outputCandidate", candidate.id)
    }, context);
  }

  for (const gap of input.outputGaps) {
    if (gap.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(gap)) {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "outputGap", gap.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (isPinnedByPreference(preferences, "outputGap", gap.id)) {
      pushEvent(events, warnings, hiddenSummary, {
        eventType: "gapCreated",
        targetType: "outputGap",
        targetId: gap.id,
        projectId: input.projectId,
        title: gap.title,
        description: truncateDescription(gap.description),
        statusLabel: gap.status,
        sourceModule: "outputs",
        dateValue: gap.createdAt,
        sourcePolicy: "pinned"
      }, context);
      continue;
    }
    hiddenSummary.hiddenByDefaultPolicy += 1;
  }

  for (const output of input.researchOutputs) {
    if (output.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(output) || output.status === "archived") {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "researchOutput", output.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "researchOutputCreated",
      targetType: "researchOutput",
      targetId: output.id,
      projectId: input.projectId,
      title: output.outputName,
      description: truncateDescription(output.description),
      statusLabel: output.status,
      sourceModule: "outputs",
      dateValue: output.createdAt,
      sourcePolicy: getDisplaySourcePolicy(preferences, "researchOutput", output.id)
    }, context);
  }

  for (const experiment of input.experiments ?? []) {
    if (experiment.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(experiment) || experiment.status === "archived") {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "experiment", experiment.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isPinnedByPreference(preferences, "experiment", experiment.id)) {
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "experimentRecorded",
      targetType: "experiment",
      targetId: experiment.id,
      projectId: input.projectId,
      title: experiment.title,
      description: truncateDescription(experiment.resultSummary ?? experiment.purposeAndQuestion),
      statusLabel: experiment.status,
      sourceModule: "experiment",
      dateValue: experiment.createdAt,
      sourcePolicy: "pinned"
    }, context);
  }

  for (const run of input.experimentRuns ?? []) {
    if (run.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(run) || run.status === "cancelled") {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "experimentRun", run.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isPinnedByPreference(preferences, "experimentRun", run.id)) {
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "experimentRunRecorded",
      targetType: "experimentRun",
      targetId: run.id,
      projectId: input.projectId,
      title: run.title,
      description: truncateDescription(run.resultSummary ?? run.conditionSummary),
      statusLabel: run.status,
      sourceModule: "experiment",
      dateValue: run.completedAt || run.startedAt || run.createdAt,
      sourcePolicy: "pinned"
    }, context);
  }

  for (const literature of input.literatures ?? []) {
    if (literature.primaryProjectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(literature) || literature.isArchived || literature.archivedAt) {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "literature", literature.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isPinnedByPreference(preferences, "literature", literature.id)) {
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "literatureRecorded",
      targetType: "literature",
      targetId: literature.id,
      projectId: input.projectId,
      title: literature.title,
      description: truncateDescription(literature.abstract ?? literature.venue),
      statusLabel: literature.readingStatus,
      sourceModule: "literature",
      dateValue: literature.createdAt,
      sourcePolicy: "pinned"
    }, context);
  }

  for (const resultItem of input.resultItems ?? []) {
    if (resultItem.projectId !== input.projectId) {
      hiddenSummary.hiddenByProject += 1;
      continue;
    }
    if (isDeletedOutputEntity(resultItem)) {
      hiddenSummary.hiddenArchivedOrDeleted += 1;
      continue;
    }
    if (isHiddenByPreference(preferences, "resultItem", resultItem.id)) {
      hiddenSummary.hiddenByPreference += 1;
      continue;
    }
    if (!isPinnedByPreference(preferences, "resultItem", resultItem.id)) {
      hiddenSummary.hiddenByDefaultPolicy += 1;
      continue;
    }
    pushEvent(events, warnings, hiddenSummary, {
      eventType: "resultItemCreated",
      targetType: "resultItem",
      targetId: resultItem.id,
      projectId: input.projectId,
      title: resultItem.title,
      description: truncateDescription(resultItem.summary),
      statusLabel: resultItem.status,
      sourceModule: "outputs",
      dateValue: resultItem.createdAt,
      sourcePolicy: "pinned"
    }, context);
  }

  const sortedEvents = sortEvents(events);
  const totalCount = sortedEvents.length;
  const visibleEvents = assignResearchTraceRenderMetadata(
    selectResearchTraceRenderableEvents(sortedEvents, maxRenderableCount, defaultVisibleCount)
  );
  const visibleCount = visibleEvents.length;
  const overLimit = Math.max(0, totalCount - visibleCount);
  if (overLimit > 0) {
    hiddenSummary.overLimit = overLimit;
    warnings.push({
      code: "overLimit",
      message: `${overLimit} research trace events were hidden by selector limit.`
    });
  }

  const { rangeStart, rangeEnd } = resolveRange(visibleEvents, context.today);
  const finalHiddenSummary =
    options.includeHiddenSummary === false ? emptyHiddenSummary() : hiddenSummary;

  return {
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rangeStart,
    rangeEnd,
    displayLimit: maxRenderableCount,
    defaultVisibleCount,
    maxRenderableCount,
    visibleCount,
    totalCount,
    overflowCount: overLimit,
    collapsedCount: overLimit,
    isLimited: overLimit > 0,
    events: visibleEvents,
    hiddenSummary: finalHiddenSummary,
    warnings: includeWarnings && warnings.length > 0 ? warnings : undefined,
    partial: input.projectExists === false || overLimit > 0 || warnings.length > 0
  };
}

export async function getProjectResearchTraceData(
  projectId: string,
  options: ProjectResearchTraceSelectorOptions = {}
): Promise<ProjectResearchTraceData> {
  const [
    project,
    routes,
    reviews,
    tasks,
    experiments,
    experimentRuns,
    literatures,
    resultItems,
    findings,
    outputCandidates,
    outputGaps,
    researchOutputs,
    preferences
  ] = await Promise.all([
    planningService.getProjectById(projectId),
    planningService.queryRouteNodes({
      projectId,
      includeArchived: true,
      includeDeleted: true
    }),
    planningService.queryReviews({
      projectId,
      includeArchived: true,
      includeDeleted: true
    }),
    planningService.queryTasks({
      projectId,
      includeArchived: true,
      includeDeleted: true
    }),
    experimentService.getExperimentsByProject(projectId),
    experimentRunService.list(),
    literatureService.queryLiteratures({
      primaryProjectId: projectId,
      includeArchived: true
    }),
    outputConversionService.listResultItems(),
    outputConversionService.listFindings(),
    outputConversionService.listOutputCandidates(),
    outputConversionService.listOutputGaps(),
    outputService.list(),
    listResearchTracePreferences(projectId)
  ]);

  return buildProjectResearchTraceData(
    {
      projectId,
      projectTitle: project?.title,
      projectExists: Boolean(project),
      projects: project ? [project] : [],
      routes,
      reviews,
      tasks,
      experiments,
      experimentRuns: experimentRuns.filter((run) => run.projectId === projectId),
      literatures,
      resultItems: resultItems.filter((item) => item.projectId === projectId),
      findings: findings.filter((finding) => finding.projectId === projectId),
      outputCandidates: outputCandidates.filter((candidate) => candidate.projectId === projectId),
      outputGaps: outputGaps.filter((gap) => gap.projectId === projectId),
      researchOutputs: researchOutputs.filter((output) => output.projectId === projectId),
      preferences
    },
    options
  );
}

export const projectResearchTraceSelectorService = {
  buildProjectResearchTraceData,
  getProjectResearchTraceData
};

export type ProjectResearchTraceSelectorService = typeof projectResearchTraceSelectorService;
