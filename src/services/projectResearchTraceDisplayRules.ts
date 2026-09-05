import type {
  ProjectResearchTraceEvent,
  ProjectResearchTraceEventType,
  ProjectResearchTraceTargetType,
  ResearchTraceAxisBreak,
  ResearchTraceDisplayDensity,
  ResearchTraceSegmentedTimelineEvent,
  ResearchTraceSegmentedTimelineViewModel,
  ResearchTraceTimeSegment,
  ResearchTraceTimeSegmentId
} from "../types/projectResearchTrace";
import { resolveResearchTraceTicks } from "./projectResearchTraceTickResolver";

export const RESEARCH_TRACE_DISPLAY_PRIORITY = {
  projectCreated: 120,
  researchOutput: 110,
  outputCandidate: 100,
  stageReview: 90,
  finding: 80,
  route: 70,
  outputGap: 60,
  resultItem: 50,
  task: 40,
  otherReview: 30,
  experiment: 20,
  experimentRun: 20,
  literature: 10
} as const;

export const RESEARCH_TRACE_TIME_SCALE_MODE = "segmentedCompressed" as const;

export const RESEARCH_TRACE_DISPLAY_DENSITY_BASE_LIMIT: Record<ResearchTraceDisplayDensity, number> = {
  compact: 10,
  standard: 16,
  relaxed: 20
};

export const RESEARCH_TRACE_DISPLAY_DENSITY_OPTIONS: ResearchTraceDisplayDensity[] = [
  "compact",
  "standard",
  "relaxed"
];

const RESEARCH_TRACE_SEGMENT_DEFINITIONS = [
  {
    id: "history",
    timeRatio: 0.55,
    widthRatio: 2,
    startXRatio: 0,
    endXRatio: 2 / 7
  },
  {
    id: "middle",
    timeRatio: 0.3,
    widthRatio: 2,
    startXRatio: 2 / 7,
    endXRatio: 4 / 7
  },
  {
    id: "recent",
    timeRatio: 0.15,
    widthRatio: 3,
    startXRatio: 4 / 7,
    endXRatio: 1
  }
] satisfies Array<{
  id: ResearchTraceTimeSegmentId;
  timeRatio: number;
  widthRatio: number;
  startXRatio: number;
  endXRatio: number;
}>;

type ResearchTracePriorityInput = Pick<
  ProjectResearchTraceEvent,
  "eventType" | "targetType" | "targetId" | "occurredAt" | "title" | "sourcePolicy" | "statusLabel"
> & { traceDisplayPriority: number };

type ResearchTraceEventSeedLike = {
  eventType: ProjectResearchTraceEventType;
  targetType: ProjectResearchTraceTargetType;
  targetId: string;
  occurredAt?: string;
  title?: string;
  sourcePolicy?: "auto" | "pinned" | "hidden";
  statusLabel?: string;
};

function isStageReviewLike(event: Pick<ResearchTracePriorityInput, "eventType" | "statusLabel">) {
  return event.eventType === "reviewRecorded" && event.statusLabel === "stage";
}

export function resolveResearchTraceDisplayPriority(event: ResearchTraceEventSeedLike): number {
  switch (event.eventType) {
    case "projectCreated":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.projectCreated;
    case "researchOutputCreated":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.researchOutput;
    case "candidateCreated":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.outputCandidate;
    case "reviewRecorded":
      return isStageReviewLike(event)
        ? RESEARCH_TRACE_DISPLAY_PRIORITY.stageReview
        : RESEARCH_TRACE_DISPLAY_PRIORITY.otherReview;
    case "findingCreated":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.finding;
    case "routeStarted":
    case "routeCompleted":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.route;
    case "gapCreated":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.outputGap;
    case "resultItemCreated":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.resultItem;
    case "taskRecorded":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.task;
    case "experimentRecorded":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.experiment;
    case "experimentRunRecorded":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.experimentRun;
    case "literatureRecorded":
      return RESEARCH_TRACE_DISPLAY_PRIORITY.literature;
    default:
      return 0;
  }
}

function stableEventKey(event: Pick<ResearchTracePriorityInput, "eventType" | "targetType" | "targetId" | "title">) {
  return `${event.eventType}:${event.targetType}:${event.targetId}:${event.title}`;
}

function pinnedTieBreak(left: Pick<ResearchTracePriorityInput, "sourcePolicy">, right: Pick<ResearchTracePriorityInput, "sourcePolicy">) {
  if (left.sourcePolicy === right.sourcePolicy) {
    return 0;
  }
  return left.sourcePolicy === "pinned" ? -1 : 1;
}

export function compareResearchTraceSamePosition(
  left: ResearchTracePriorityInput,
  right: ResearchTracePriorityInput
) {
  return (
    right.traceDisplayPriority - left.traceDisplayPriority ||
    right.occurredAt.localeCompare(left.occurredAt) ||
    pinnedTieBreak(left, right) ||
    stableEventKey(left).localeCompare(stableEventKey(right))
  );
}

export function compareResearchTraceTimelineEvents(
  left: ResearchTracePriorityInput,
  right: ResearchTracePriorityInput
) {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    compareResearchTraceSamePosition(left, right)
  );
}

export function compareResearchTraceRetention(
  left: ResearchTracePriorityInput,
  right: ResearchTracePriorityInput
) {
  return (
    right.traceDisplayPriority - left.traceDisplayPriority ||
    right.occurredAt.localeCompare(left.occurredAt) ||
    pinnedTieBreak(left, right) ||
    stableEventKey(left).localeCompare(stableEventKey(right))
  );
}

export function assignResearchTraceRenderMetadata(
  events: ProjectResearchTraceEvent[]
): ProjectResearchTraceEvent[] {
  const groups = new Map<string, ProjectResearchTraceEvent[]>();

  for (const event of events) {
    const key = `${event.occurredAt}:${event.lane}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  let renderOrder = 0;
  return events.map((event) => {
    const group = groups.get(`${event.occurredAt}:${event.lane}`) ?? [event];
    const stackIndex = [...group].sort(compareResearchTraceSamePosition).findIndex((item) => item.id === event.id);
    renderOrder += 1;
    return {
      ...event,
      renderOrder,
      markerStackIndex: Math.max(0, stackIndex),
      markerStackOffset: 0
    };
  });
}

export function selectResearchTraceRenderableEvents(
  sortedEvents: ProjectResearchTraceEvent[],
  maxRenderableCount: number,
  defaultVisibleCount: number
) {
  if (maxRenderableCount === 0) {
    return [];
  }
  if (sortedEvents.length <= maxRenderableCount) {
    return sortedEvents;
  }

  const timelineEvents = sortedEvents.filter((event) => event.eventType !== "projectCreated");
  const selected = new Map<string, ProjectResearchTraceEvent>();

  for (const event of sortedEvents.filter((item) => item.eventType === "projectCreated")) {
    selected.set(event.id, event);
  }

  for (const event of timelineEvents.slice(-defaultVisibleCount)) {
    selected.set(event.id, event);
  }

  const protectedEvents = sortedEvents
    .filter(
      (event) =>
        event.traceDisplayPriority >= RESEARCH_TRACE_DISPLAY_PRIORITY.stageReview ||
        event.sourcePolicy === "pinned"
    )
    .sort(compareResearchTraceRetention);

  for (const event of protectedEvents) {
    selected.set(event.id, event);
  }

  if (selected.size > maxRenderableCount) {
    const retained = [...selected.values()]
      .sort(compareResearchTraceRetention)
      .slice(0, maxRenderableCount);
    const retainedIds = new Set(retained.map((event) => event.id));
    return sortedEvents.filter((event) => retainedIds.has(event.id));
  }

  const remaining = sortedEvents
    .filter((event) => !selected.has(event.id))
    .sort(compareResearchTraceRetention);

  for (const event of remaining) {
    if (selected.size >= maxRenderableCount) {
      break;
    }
    selected.set(event.id, event);
  }

  return sortedEvents.filter((event) => selected.has(event.id));
}

function isValidTraceDate(value: string | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function toTraceTime(value: string) {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

function toTraceDate(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function getLocalTodayIso() {
  const now = new Date();
  const localMidnight = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return localMidnight.toISOString().slice(0, 10);
}

function resolveTimelineRange(
  events: ProjectResearchTraceEvent[],
  today: string,
  projectCreatedAt?: string
) {
  const timelineEvents = events
    .filter(
      (event) =>
        event.eventType !== "projectCreated" &&
        isValidTraceDate(event.occurredAt) &&
        event.occurredAt <= today
    )
    .sort(compareResearchTraceTimelineEvents);
  const firstEvent = timelineEvents[0];
  if (firstEvent) {
    return {
      rangeStart: firstEvent.occurredAt,
      rangeEnd: today
    };
  }

  const fallbackStart =
    isValidTraceDate(projectCreatedAt) && (projectCreatedAt as string) <= today
      ? (projectCreatedAt as string)
      : today;
  return {
    rangeStart: fallbackStart,
    rangeEnd: today
  };
}

function getSegmentEventLimit(segmentId: ResearchTraceTimeSegmentId, baseDisplayLimit: number) {
  return segmentId === "recent" ? Math.floor(baseDisplayLimit * 1.5) : baseDisplayLimit;
}

function buildResearchTraceTimeSegments(
  rangeStart: string | undefined,
  rangeEnd: string | undefined,
  baseDisplayLimit: number
): ResearchTraceTimeSegment[] {
  const startTime = isValidTraceDate(rangeStart) ? toTraceTime(rangeStart as string) : toTraceTime(getLocalTodayIso());
  const endTime = isValidTraceDate(rangeEnd) ? toTraceTime(rangeEnd as string) : startTime;
  const safeStartTime = Number.isFinite(startTime) ? startTime : 0;
  const safeEndTime = Number.isFinite(endTime) ? Math.max(endTime, safeStartTime) : safeStartTime;
  const totalSpan = Math.max(0, safeEndTime - safeStartTime);
  const historyEnd = safeStartTime + totalSpan * 0.55;
  const middleEnd = safeStartTime + totalSpan * 0.85;
  const boundaries: Record<ResearchTraceTimeSegmentId, [number, number]> = {
    history: [safeStartTime, historyEnd],
    middle: [historyEnd, middleEnd],
    recent: [middleEnd, safeEndTime]
  };

  return RESEARCH_TRACE_SEGMENT_DEFINITIONS.map((segment) => {
    const [segmentStart, segmentEnd] = boundaries[segment.id];
    return {
      id: segment.id,
      startDate: toTraceDate(segmentStart),
      endDate: toTraceDate(segmentEnd),
      timeRatio: segment.timeRatio,
      widthRatio: segment.widthRatio,
      widthShare: segment.widthRatio / 7,
      startXRatio: segment.startXRatio,
      endXRatio: segment.endXRatio,
      eventLimit: getSegmentEventLimit(segment.id, baseDisplayLimit)
    };
  });
}

function resolveSegmentIdForDate(
  date: string,
  segments: ResearchTraceTimeSegment[]
): ResearchTraceTimeSegmentId {
  const eventTime = isValidTraceDate(date) ? toTraceTime(date) : Number.NaN;
  if (!Number.isFinite(eventTime)) {
    return "recent";
  }

  const history = segments.find((segment) => segment.id === "history");
  const middle = segments.find((segment) => segment.id === "middle");
  const historyEnd = history ? toTraceTime(history.endDate) : Number.NEGATIVE_INFINITY;
  const middleEnd = middle ? toTraceTime(middle.endDate) : Number.NEGATIVE_INFINITY;

  if (eventTime <= historyEnd) {
    return "history";
  }
  if (eventTime <= middleEnd) {
    return "middle";
  }
  return "recent";
}

function getSegmentById(segments: ResearchTraceTimeSegment[], segmentId: ResearchTraceTimeSegmentId) {
  return segments.find((segment) => segment.id === segmentId) ?? segments[segments.length - 1];
}

function getXRatioInSegment(date: string, segment: ResearchTraceTimeSegment | undefined) {
  if (!segment || !isValidTraceDate(date)) {
    return 0.5;
  }
  const startTime = toTraceTime(segment.startDate);
  const endTime = toTraceTime(segment.endDate);
  const eventTime = toTraceTime(date);
  const span = endTime - startTime;
  if (!Number.isFinite(span) || span <= 0) {
    return 0.5;
  }
  return clampRatio((eventTime - startTime) / span);
}

function getXRatioOverall(segment: ResearchTraceTimeSegment | undefined, xRatioInSegment: number) {
  if (!segment) {
    return 0.5;
  }
  return clampRatio(segment.startXRatio + clampRatio(xRatioInSegment) * segment.widthShare);
}

function compareResearchTraceSegmentQuota(left: ProjectResearchTraceEvent, right: ProjectResearchTraceEvent) {
  return compareResearchTraceRetention(left, right);
}

function selectSegmentEvents(
  events: ProjectResearchTraceEvent[],
  segments: ResearchTraceTimeSegment[]
) {
  const selected = new Map<string, ProjectResearchTraceEvent>();
  let collapsedCount = 0;

  for (const segment of segments) {
    const segmentEvents = events.filter((event) => resolveSegmentIdForDate(event.occurredAt, segments) === segment.id);
    const retained = [...segmentEvents]
      .sort(compareResearchTraceSegmentQuota)
      .slice(0, segment.eventLimit);
    collapsedCount += Math.max(0, segmentEvents.length - retained.length);
    for (const event of retained) {
      selected.set(event.id, event);
    }
  }

  return {
    collapsedCount,
    events: events.filter((event) => selected.has(event.id))
  };
}

function mapSegmentedEvent(
  event: ProjectResearchTraceEvent,
  segments: ResearchTraceTimeSegment[]
): ResearchTraceSegmentedTimelineEvent {
  const segmentId = resolveSegmentIdForDate(event.occurredAt, segments);
  const segment = getSegmentById(segments, segmentId);
  const xRatioInSegment = getXRatioInSegment(event.occurredAt, segment);
  const xRatioOverall = getXRatioOverall(segment, xRatioInSegment);
  return {
    ...event,
    segmentId,
    xRatioInSegment,
    xRatioOverall
  };
}

export function resolveResearchTraceBaseDisplayLimit(displayDensity: ResearchTraceDisplayDensity) {
  return RESEARCH_TRACE_DISPLAY_DENSITY_BASE_LIMIT[displayDensity] ?? RESEARCH_TRACE_DISPLAY_DENSITY_BASE_LIMIT.standard;
}

export function buildResearchTraceSegmentedTimelineViewModel(
  inputEvents: ProjectResearchTraceEvent[],
  options: {
    displayDensity?: ResearchTraceDisplayDensity;
    today?: string;
  } = {}
): ResearchTraceSegmentedTimelineViewModel {
  const displayDensity = options.displayDensity ?? "standard";
  const baseDisplayLimit = resolveResearchTraceBaseDisplayLimit(displayDensity);
  const today = isValidTraceDate(options.today) ? (options.today as string) : getLocalTodayIso();
  const projectCreatedEvent = inputEvents.find((event) => event.eventType === "projectCreated");
  const timelineEvents = inputEvents
    .filter((event) => event.eventType !== "projectCreated" && isValidTraceDate(event.occurredAt))
    .sort(compareResearchTraceTimelineEvents);
  const { rangeStart, rangeEnd } = resolveTimelineRange(timelineEvents, today, projectCreatedEvent?.occurredAt);
  const segments = buildResearchTraceTimeSegments(rangeStart, rangeEnd, baseDisplayLimit);
  const { events: selectedTimelineEvents, collapsedCount } = selectSegmentEvents(timelineEvents, segments);
  const mappedTimelineEvents = assignResearchTraceRenderMetadata(selectedTimelineEvents)
    .map((event) => mapSegmentedEvent(event, segments))
    .sort(compareResearchTraceTimelineEvents);
  const mappedProjectCreatedEvent = projectCreatedEvent
    ? mapSegmentedEvent(projectCreatedEvent, segments)
    : undefined;
  const adaptiveTickResult = resolveResearchTraceTicks({
    rangeStart,
    rangeEnd,
    segments,
    fallbackToday: today,
    projectCreatedAt: projectCreatedEvent?.occurredAt,
    displayedEvents: mappedTimelineEvents
  });
  const events = mappedProjectCreatedEvent
    ? [mappedProjectCreatedEvent, ...mappedTimelineEvents]
    : mappedTimelineEvents;
  const axisBreaks: ResearchTraceAxisBreak[] = [
    {
      id: "history-middle",
      xRatioOverall: 2 / 7
    },
    {
      id: "middle-recent",
      xRatioOverall: 4 / 7
    }
  ];

  return {
    timeScaleMode: RESEARCH_TRACE_TIME_SCALE_MODE,
    displayDensity,
    baseDisplayLimit,
    rangeStart,
    rangeEnd,
    segments,
    events,
    projectCreatedEvent: mappedProjectCreatedEvent,
    adaptiveTicks: adaptiveTickResult.ticks,
    tickGranularity: adaptiveTickResult.granularity,
    tickSegmentGranularity: adaptiveTickResult.segmentGranularity,
    axisBreaks,
    collapsedCount,
    totalTimelineEventCount: timelineEvents.length
  };
}
