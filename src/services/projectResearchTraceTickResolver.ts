import type {
  ProjectResearchTraceEvent,
  ResearchTraceTick,
  ResearchTraceTickGranularity,
  ResearchTraceTickLimits,
  ResearchTraceTimeSegment,
  ResearchTraceTimeSegmentId
} from "../types/projectResearchTrace";

export const RESEARCH_TRACE_TICK_LIMITS: ResearchTraceTickLimits = {
  history: 3,
  middle: 3,
  recent: 5
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEGMENT_PRIORITY: Record<ResearchTraceTimeSegmentId, number> = {
  history: 1,
  middle: 2,
  recent: 3
};
const MIN_TICK_X_DISTANCE = 0.018;
const GRANULARITY_ORDER: ResearchTraceTickGranularity[] = ["day", "week", "month", "quarter", "year"];

export type ResearchTraceTickRangeInputEvent = Pick<ProjectResearchTraceEvent, "occurredAt">;

export interface ResearchTraceTickResolverInput {
  rangeStart?: string;
  rangeEnd?: string;
  segments: ResearchTraceTimeSegment[];
  tickLimits?: Partial<ResearchTraceTickLimits>;
  projectCreatedAt?: string;
  fallbackToday?: string;
  displayedEvents?: ResearchTraceTickRangeInputEvent[];
}

export interface ResearchTraceTickResolverResult {
  rangeStart: string;
  rangeEnd: string;
  granularity: ResearchTraceTickGranularity;
  segmentGranularity: Record<ResearchTraceTimeSegmentId, ResearchTraceTickGranularity>;
  tickLimits: ResearchTraceTickLimits;
  ticks: ResearchTraceTick[];
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function getLocalTodayIso() {
  const now = new Date();
  const localMidnight = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return localMidnight.toISOString().slice(0, 10);
}

function normalizeDatePart(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const datePart = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)?.[1];
  if (!datePart) {
    return undefined;
  }
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === datePart
    ? datePart
    : undefined;
}

function toDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toTime(value: string) {
  return toDate(value).getTime();
}

function toIsoDate(value: Date | number) {
  return new Date(value).toISOString().slice(0, 10);
}

function daysInUtcMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addDays(date: string, days: number) {
  return toIsoDate(toTime(date) + days * MS_PER_DAY);
}

function addMonths(date: string, months: number) {
  const source = toDate(date);
  const sourceMonth = source.getUTCMonth();
  const targetMonthIndex = sourceMonth + months;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const targetDay = Math.min(source.getUTCDate(), daysInUtcMonth(targetYear, normalizedMonth));
  return toIsoDate(new Date(Date.UTC(targetYear, normalizedMonth, targetDay)));
}

function addYears(date: string, years: number) {
  return addMonths(date, years * 12);
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function clampDate(date: string, start: string, end: string) {
  if (date < start) {
    return start;
  }
  if (date > end) {
    return end;
  }
  return date;
}

function pushUniqueDate(items: string[], date: string) {
  if (!items.includes(date)) {
    items.push(date);
  }
}

function firstDayOfNextMonth(date: string) {
  const source = toDate(date);
  const currentMonthStart = toIsoDate(new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), 1)));
  return currentMonthStart >= date ? currentMonthStart : addMonths(currentMonthStart, 1);
}

function firstDayOfNextQuarter(date: string) {
  const source = toDate(date);
  const quarterStartMonth = Math.floor(source.getUTCMonth() / 3) * 3;
  const currentQuarterStart = toIsoDate(new Date(Date.UTC(source.getUTCFullYear(), quarterStartMonth, 1)));
  return currentQuarterStart >= date ? currentQuarterStart : addMonths(currentQuarterStart, 3);
}

function firstDayOfNextYear(date: string) {
  const source = toDate(date);
  const currentYearStart = toIsoDate(new Date(Date.UTC(source.getUTCFullYear(), 0, 1)));
  return currentYearStart >= date ? currentYearStart : addYears(currentYearStart, 1);
}

function normalizeTickLimits(tickLimits: Partial<ResearchTraceTickLimits> = {}): ResearchTraceTickLimits {
  return {
    history: Math.max(0, Math.floor(tickLimits.history ?? RESEARCH_TRACE_TICK_LIMITS.history)),
    middle: Math.max(0, Math.floor(tickLimits.middle ?? RESEARCH_TRACE_TICK_LIMITS.middle)),
    recent: Math.max(0, Math.floor(tickLimits.recent ?? RESEARCH_TRACE_TICK_LIMITS.recent))
  };
}

function getFinerTickGranularity(granularity: ResearchTraceTickGranularity): ResearchTraceTickGranularity {
  const index = GRANULARITY_ORDER.indexOf(granularity);
  return GRANULARITY_ORDER[Math.max(0, index - 1)] ?? granularity;
}

function resolveSegmentTickGranularity(
  baseGranularity: ResearchTraceTickGranularity
): Record<ResearchTraceTimeSegmentId, ResearchTraceTickGranularity> {
  return {
    history: baseGranularity,
    middle: baseGranularity,
    recent: getFinerTickGranularity(baseGranularity)
  };
}

export function resolveResearchTraceTickRange(input: {
  rangeStart?: string;
  rangeEnd?: string;
  projectCreatedAt?: string;
  fallbackToday?: string;
  displayedEvents?: ResearchTraceTickRangeInputEvent[];
}) {
  const fallbackToday = normalizeDatePart(input.fallbackToday) ?? getLocalTodayIso();
  const requestedEnd = normalizeDatePart(input.rangeEnd);
  const rangeEnd = requestedEnd && requestedEnd <= fallbackToday ? requestedEnd : fallbackToday;
  const displayedDates = (input.displayedEvents ?? [])
    .map((event) => normalizeDatePart(event.occurredAt))
    .filter((date): date is string => Boolean(date && date <= rangeEnd))
    .sort();
  const explicitStart = normalizeDatePart(input.rangeStart);
  const projectCreatedAt = normalizeDatePart(input.projectCreatedAt);
  const startCandidate =
    displayedDates[0] ??
    (explicitStart && explicitStart <= rangeEnd ? explicitStart : undefined) ??
    (projectCreatedAt && projectCreatedAt <= rangeEnd ? projectCreatedAt : undefined) ??
    rangeEnd;

  return {
    rangeStart: startCandidate > rangeEnd ? rangeEnd : startCandidate,
    rangeEnd
  };
}

export function selectResearchTraceTickGranularity(
  rangeStart: string,
  rangeEnd: string
): ResearchTraceTickGranularity {
  const start = normalizeDatePart(rangeStart) ?? normalizeDatePart(rangeEnd) ?? getLocalTodayIso();
  const endCandidate = normalizeDatePart(rangeEnd) ?? start;
  const end = endCandidate < start ? start : endCandidate;

  if (end < addDays(start, 14)) {
    return "day";
  }
  if (end < addMonths(start, 2)) {
    return "week";
  }
  if (end < addMonths(start, 18)) {
    return "month";
  }
  if (end < addYears(start, 4)) {
    return "quarter";
  }
  return "year";
}

function formatTickLabel(date: string, granularity: ResearchTraceTickGranularity, rangeStart: string, rangeEnd: string) {
  const parsed = toDate(date);
  const year = parsed.getUTCFullYear();
  const month = pad2(parsed.getUTCMonth() + 1);
  const day = pad2(parsed.getUTCDate());
  const isCrossYear = rangeStart.slice(0, 4) !== rangeEnd.slice(0, 4);

  switch (granularity) {
    case "day":
    case "week":
      return isCrossYear ? `${year}-${month}-${day}` : `${month}-${day}`;
    case "month":
      return `${year}-${month}`;
    case "quarter":
      return `${year} Q${Math.floor(parsed.getUTCMonth() / 3) + 1}`;
    case "year":
      return String(year);
    default:
      return date;
  }
}

function generateCandidateDates(
  segmentStart: string,
  segmentEnd: string,
  granularity: ResearchTraceTickGranularity
) {
  if (segmentEnd < segmentStart) {
    return [];
  }

  const dates: string[] = [];
  pushUniqueDate(dates, segmentStart);

  if (granularity === "day") {
    for (let cursor = addDays(segmentStart, 1); cursor < segmentEnd; cursor = addDays(cursor, 1)) {
      pushUniqueDate(dates, cursor);
    }
  } else if (granularity === "week") {
    for (let cursor = addDays(segmentStart, 7); cursor < segmentEnd; cursor = addDays(cursor, 7)) {
      pushUniqueDate(dates, cursor);
    }
  } else if (granularity === "month") {
    for (let cursor = firstDayOfNextMonth(segmentStart); cursor < segmentEnd; cursor = addMonths(cursor, 1)) {
      pushUniqueDate(dates, cursor);
    }
  } else if (granularity === "quarter") {
    for (let cursor = firstDayOfNextQuarter(segmentStart); cursor < segmentEnd; cursor = addMonths(cursor, 3)) {
      pushUniqueDate(dates, cursor);
    }
  } else if (granularity === "year") {
    for (let cursor = firstDayOfNextYear(segmentStart); cursor < segmentEnd; cursor = addYears(cursor, 1)) {
      pushUniqueDate(dates, cursor);
    }
  }

  pushUniqueDate(dates, segmentEnd);
  return dates.sort();
}

function sampleTicks<T>(candidates: T[], limit: number) {
  if (limit <= 0) {
    return [];
  }
  if (candidates.length <= limit) {
    return candidates;
  }
  if (limit === 1) {
    return [candidates[Math.round((candidates.length - 1) / 2)]];
  }

  const indexes = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round((index * (candidates.length - 1)) / (limit - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => candidates[index]);
}

function getXRatioInSegment(date: string, segmentStart: string, segmentEnd: string) {
  const span = toTime(segmentEnd) - toTime(segmentStart);
  if (!Number.isFinite(span) || span <= 0) {
    return 0.5;
  }
  return clampRatio((toTime(date) - toTime(segmentStart)) / span);
}

function getXRatioOverall(segment: ResearchTraceTimeSegment, xRatioInSegment: number) {
  return clampRatio(
    segment.startXRatio + clampRatio(xRatioInSegment) * (segment.endXRatio - segment.startXRatio)
  );
}

function buildSegmentTicks(
  segment: ResearchTraceTimeSegment,
  rangeStart: string,
  rangeEnd: string,
  granularity: ResearchTraceTickGranularity,
  tickLimit: number
) {
  const rawSegmentStart = normalizeDatePart(segment.startDate);
  const rawSegmentEnd = normalizeDatePart(segment.endDate);
  if (!rawSegmentStart || !rawSegmentEnd) {
    return [];
  }

  const segmentStart = clampDate(rawSegmentStart, rangeStart, rangeEnd);
  const segmentEnd = clampDate(rawSegmentEnd < rawSegmentStart ? rawSegmentStart : rawSegmentEnd, rangeStart, rangeEnd);
  const candidates = generateCandidateDates(segmentStart, segmentEnd, granularity);
  return sampleTicks(candidates, tickLimit).map((date) => {
    const xRatioInSegment = getXRatioInSegment(date, segmentStart, segmentEnd);
    const label = formatTickLabel(date, granularity, rangeStart, rangeEnd);
    return {
      id: `${segment.id}:${granularity}:${date}`,
      segmentId: segment.id,
      label,
      occurredAt: date,
      xRatioInSegment,
      xRatioOverall: getXRatioOverall(segment, xRatioInSegment),
      granularity
    } satisfies ResearchTraceTick;
  });
}

function shouldPreferTick(candidate: ResearchTraceTick, existing: ResearchTraceTick) {
  const priorityDiff = SEGMENT_PRIORITY[candidate.segmentId] - SEGMENT_PRIORITY[existing.segmentId];
  return priorityDiff > 0 || (priorityDiff === 0 && candidate.xRatioOverall >= existing.xRatioOverall);
}

function dedupeTicks(ticks: ResearchTraceTick[]) {
  const byDate = new Map<string, ResearchTraceTick>();
  for (const tick of ticks) {
    const existing = byDate.get(tick.occurredAt);
    if (!existing || shouldPreferTick(tick, existing)) {
      byDate.set(tick.occurredAt, tick);
    }
  }

  const byLabel = new Map<string, ResearchTraceTick>();
  for (const tick of byDate.values()) {
    const existing = byLabel.get(tick.label);
    if (!existing || shouldPreferTick(tick, existing)) {
      byLabel.set(tick.label, tick);
    }
  }

  const sortedTicks = [...byLabel.values()].sort(
    (left, right) => left.xRatioOverall - right.xRatioOverall || left.occurredAt.localeCompare(right.occurredAt)
  );
  const retained: ResearchTraceTick[] = [];
  for (const tick of sortedTicks) {
    const previous = retained[retained.length - 1];
    if (!previous || Math.abs(tick.xRatioOverall - previous.xRatioOverall) >= MIN_TICK_X_DISTANCE) {
      retained.push(tick);
      continue;
    }
    if (shouldPreferTick(tick, previous)) {
      retained[retained.length - 1] = tick;
    }
  }

  return retained.sort(
    (left, right) => left.xRatioOverall - right.xRatioOverall || left.occurredAt.localeCompare(right.occurredAt)
  );
}

export function resolveResearchTraceTicks(
  input: ResearchTraceTickResolverInput
): ResearchTraceTickResolverResult {
  const tickLimits = normalizeTickLimits(input.tickLimits);
  const { rangeStart, rangeEnd } = resolveResearchTraceTickRange(input);
  const granularity = selectResearchTraceTickGranularity(rangeStart, rangeEnd);
  const segmentGranularity = resolveSegmentTickGranularity(granularity);
  const ticks = dedupeTicks(
    input.segments.flatMap((segment) =>
      buildSegmentTicks(segment, rangeStart, rangeEnd, segmentGranularity[segment.id], tickLimits[segment.id])
    )
  );

  return {
    rangeStart,
    rangeEnd,
    granularity,
    segmentGranularity,
    tickLimits,
    ticks
  };
}

export function buildResearchTraceTickViewModel(
  input: ResearchTraceTickResolverInput
): ResearchTraceTickResolverResult {
  return resolveResearchTraceTicks(input);
}
