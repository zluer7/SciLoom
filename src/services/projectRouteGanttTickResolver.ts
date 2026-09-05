import type {
  ProjectRouteGanttTickGranularity,
  ProjectRouteGanttTimeTick
} from "../types/projectRouteGantt";

export const PROJECT_ROUTE_GANTT_MAX_TICKS = 12;

export type ResolveProjectRouteGanttTicksInput = {
  rangeStart?: string;
  rangeEnd?: string;
  maxTicks?: number;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDateOnly(value: string | undefined): DateParts | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return undefined;
  }

  return { year, month, day };
}

function toUtcTime(parts: DateParts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function formatDateOnly(parts: DateParts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function fromUtcTime(time: number): DateParts {
  const date = new Date(time);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function addDays(parts: DateParts, days: number) {
  return fromUtcTime(toUtcTime(parts) + days * DAY_MS);
}

function addCalendarMonths(parts: DateParts, months: number) {
  const monthIndex = parts.year * 12 + parts.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  return {
    year,
    month,
    day: Math.min(parts.day, daysInMonth(year, month))
  };
}

function addCalendarYears(parts: DateParts, years: number) {
  const year = parts.year + years;
  return {
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month))
  };
}

function resolveGranularity(start: DateParts, end: DateParts): ProjectRouteGanttTickGranularity {
  const spanDays = (toUtcTime(end) - toUtcTime(start)) / DAY_MS;
  if (spanDays < 14) {
    return "day";
  }
  if (toUtcTime(end) < toUtcTime(addCalendarMonths(start, 2))) {
    return "week";
  }
  if (toUtcTime(end) < toUtcTime(addCalendarMonths(start, 18))) {
    return "month";
  }
  if (toUtcTime(end) < toUtcTime(addCalendarYears(start, 4))) {
    return "quarter";
  }
  return "year";
}

function firstCandidate(start: DateParts, granularity: ProjectRouteGanttTickGranularity) {
  switch (granularity) {
    case "day":
      return start;
    case "week": {
      const weekday = new Date(toUtcTime(start)).getUTCDay();
      const monday = addDays(start, -(weekday === 0 ? 6 : weekday - 1));
      return toUtcTime(monday) < toUtcTime(start) ? addDays(monday, 7) : monday;
    }
    case "month": {
      const monthStart = { year: start.year, month: start.month, day: 1 };
      return toUtcTime(monthStart) < toUtcTime(start)
        ? addCalendarMonths(monthStart, 1)
        : monthStart;
    }
    case "quarter": {
      const quarterStart = {
        year: start.year,
        month: Math.floor((start.month - 1) / 3) * 3 + 1,
        day: 1
      };
      return toUtcTime(quarterStart) < toUtcTime(start)
        ? addCalendarMonths(quarterStart, 3)
        : quarterStart;
    }
    case "year": {
      const yearStart = { year: start.year, month: 1, day: 1 };
      return toUtcTime(yearStart) < toUtcTime(start)
        ? { year: start.year + 1, month: 1, day: 1 }
        : yearStart;
    }
  }
}

function nextCandidate(parts: DateParts, granularity: ProjectRouteGanttTickGranularity) {
  switch (granularity) {
    case "day":
      return addDays(parts, 1);
    case "week":
      return addDays(parts, 7);
    case "month":
      return addCalendarMonths(parts, 1);
    case "quarter":
      return addCalendarMonths(parts, 3);
    case "year":
      return addCalendarYears(parts, 1);
  }
}

function buildCandidateDates(
  start: DateParts,
  end: DateParts,
  granularity: ProjectRouteGanttTickGranularity
) {
  const startTime = toUtcTime(start);
  const endTime = toUtcTime(end);
  const dates: string[] = [];
  let cursor = firstCandidate(start, granularity);

  while (toUtcTime(cursor) <= endTime) {
    const cursorTime = toUtcTime(cursor);
    if (cursorTime >= startTime) {
      dates.push(formatDateOnly(cursor));
    }
    cursor = nextCandidate(cursor, granularity);
  }

  return dates.length > 0 ? dates : [formatDateOnly(start)];
}

function normalizeMaxTicks(maxTicks: number | undefined) {
  return Number.isFinite(maxTicks) && Number.isInteger(maxTicks) && (maxTicks as number) > 0
    ? maxTicks as number
    : PROJECT_ROUTE_GANTT_MAX_TICKS;
}

function sampleDates(dates: string[], maxTicks: number) {
  if (dates.length <= maxTicks) {
    return dates;
  }
  if (maxTicks === 1) {
    return [dates[0]];
  }

  const sampled: string[] = [];
  for (let index = 0; index < maxTicks; index += 1) {
    const sourceIndex = Math.round(index * (dates.length - 1) / (maxTicks - 1));
    const date = dates[sourceIndex];
    if (sampled[sampled.length - 1] !== date) {
      sampled.push(date);
    }
  }
  return sampled;
}

function buildLabel(
  date: string,
  granularity: ProjectRouteGanttTickGranularity,
  rangeCrossesYears: boolean
) {
  switch (granularity) {
    case "day":
    case "week":
      return rangeCrossesYears ? date : date.slice(5);
    case "month":
      return date.slice(0, 7);
    case "quarter":
      return `${date.slice(0, 4)} Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
    case "year":
      return date.slice(0, 4);
  }
}

export function resolveProjectRouteGanttTicks(
  input: ResolveProjectRouteGanttTicksInput
): ProjectRouteGanttTimeTick[] {
  const start = parseDateOnly(input.rangeStart);
  const end = parseDateOnly(input.rangeEnd);
  if (!start || !end || toUtcTime(start) > toUtcTime(end)) {
    return [];
  }

  const granularity = resolveGranularity(start, end);
  const candidateDates = [...new Set(buildCandidateDates(start, end, granularity))];
  const dates = sampleDates(candidateDates, normalizeMaxTicks(input.maxTicks));
  const rangeCrossesYears = start.year !== end.year;

  return dates.map((date) => ({
    id: `gantt-tick:${granularity}:${date}`,
    date,
    label: buildLabel(date, granularity, rangeCrossesYears),
    granularity
  }));
}
