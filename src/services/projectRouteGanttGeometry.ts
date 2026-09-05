export type ProjectRouteGanttViewportGeometryInput = {
  viewportWidthPx: number;
  viewportRatio?: number;
};

export type ProjectRouteGanttViewportGeometry = {
  viewportWidthPx: number;
  viewportRatio: number;
  contentWidthPx: number;
  maxScrollLeftPx: number;
  isMeasured: boolean;
};

export type ProjectRouteGanttTodayRelation =
  | "beforeRange"
  | "inRange"
  | "afterRange"
  | "unavailable";

export type ProjectRouteGanttTodayState = {
  today: string | null;
  relation: ProjectRouteGanttTodayRelation;
  todayInRange: boolean;
  todayRatio: number | null;
};

export type ProjectRouteGanttTodayStateInput = {
  today: string | undefined;
  rangeStart?: string;
  rangeEnd?: string;
};

export type ProjectRouteGanttDefaultScrollInput = {
  todayState: ProjectRouteGanttTodayState;
  viewportWidthPx: number;
  contentWidthPx: number;
  maxScrollLeftPx: number;
  isMeasured: boolean;
  desiredViewportAnchorRatio?: number;
};

export type ProjectRouteGanttDefaultScrollResult = {
  scrollLeftPx: number | null;
  reason:
    | "todayInRange"
    | "beforeRange"
    | "afterRange"
    | "unavailable"
    | "geometryNotMeasured";
};

export const PROJECT_ROUTE_GANTT_DEFAULT_VIEWPORT_RATIO = 0.25;
export const PROJECT_ROUTE_GANTT_DEFAULT_TODAY_ANCHOR_RATIO = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

function isFinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function normalizeViewportRatio(value: number | undefined) {
  if (!isFinitePositive(value ?? Number.NaN) || (value as number) > 1) {
    return PROJECT_ROUTE_GANTT_DEFAULT_VIEWPORT_RATIO;
  }

  return value as number;
}

function dateToUtcTime(dateText: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return undefined;
  }

  const time = new Date(`${dateText}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(time)) {
    return undefined;
  }

  return new Date(time).toISOString().slice(0, 10) === dateText ? time : undefined;
}

export function resolveProjectRouteGanttViewportGeometry(
  input: ProjectRouteGanttViewportGeometryInput
): ProjectRouteGanttViewportGeometry {
  const viewportRatio = normalizeViewportRatio(input.viewportRatio);
  const viewportWidthPx = isFinitePositive(input.viewportWidthPx)
    ? input.viewportWidthPx
    : 0;

  if (!viewportWidthPx) {
    return {
      viewportWidthPx: 0,
      viewportRatio,
      contentWidthPx: 0,
      maxScrollLeftPx: 0,
      isMeasured: false
    };
  }

  const contentWidthPx = Math.max(viewportWidthPx, viewportWidthPx / viewportRatio);
  const maxScrollLeftPx = Math.max(0, contentWidthPx - viewportWidthPx);

  return {
    viewportWidthPx,
    viewportRatio,
    contentWidthPx,
    maxScrollLeftPx,
    isMeasured: true
  };
}

export function clampProjectRouteGanttScrollLeft(
  currentScrollLeft: number,
  maxScrollLeftPx: number
) {
  const safeCurrent = Number.isFinite(currentScrollLeft) ? currentScrollLeft : 0;
  const safeMax = Number.isFinite(maxScrollLeftPx) && maxScrollLeftPx > 0
    ? maxScrollLeftPx
    : 0;

  return Math.max(0, Math.min(safeCurrent, safeMax));
}

export function resolveProjectRouteGanttDateRatio(
  dateText: string | undefined,
  rangeStart: string | undefined,
  rangeEnd: string | undefined
) {
  if (!dateText || !rangeStart || !rangeEnd) {
    return 0;
  }

  const dateTime = dateToUtcTime(dateText);
  const startTime = dateToUtcTime(rangeStart);
  const endTime = dateToUtcTime(rangeEnd);

  if (dateTime === undefined || startTime === undefined || endTime === undefined) {
    return 0;
  }

  if (endTime <= startTime) {
    return dateTime > endTime ? 1 : 0;
  }

  return Math.max(0, Math.min(1, (dateTime - startTime) / Math.max(DAY_MS, endTime - startTime)));
}

export function resolveProjectRouteGanttTodayState(
  input: ProjectRouteGanttTodayStateInput
): ProjectRouteGanttTodayState {
  const todayTime = input.today ? dateToUtcTime(input.today) : undefined;
  const rangeStartTime = input.rangeStart ? dateToUtcTime(input.rangeStart) : undefined;
  const rangeEndTime = input.rangeEnd ? dateToUtcTime(input.rangeEnd) : undefined;
  const today = todayTime === undefined ? null : input.today ?? null;

  if (
    todayTime === undefined ||
    rangeStartTime === undefined ||
    rangeEndTime === undefined ||
    rangeStartTime > rangeEndTime
  ) {
    return {
      today,
      relation: "unavailable",
      todayInRange: false,
      todayRatio: null
    };
  }

  if (todayTime < rangeStartTime) {
    return {
      today,
      relation: "beforeRange",
      todayInRange: false,
      todayRatio: null
    };
  }

  if (todayTime > rangeEndTime) {
    return {
      today,
      relation: "afterRange",
      todayInRange: false,
      todayRatio: null
    };
  }

  return {
    today,
    relation: "inRange",
    todayInRange: true,
    todayRatio: resolveProjectRouteGanttDateRatio(
      input.today,
      input.rangeStart,
      input.rangeEnd
    )
  };
}

export function resolveProjectRouteGanttDefaultScrollLeft(
  input: ProjectRouteGanttDefaultScrollInput
): ProjectRouteGanttDefaultScrollResult {
  const geometryIsValid =
    input.isMeasured &&
    isFinitePositive(input.viewportWidthPx) &&
    isFinitePositive(input.contentWidthPx) &&
    input.contentWidthPx >= input.viewportWidthPx &&
    Number.isFinite(input.maxScrollLeftPx) &&
    input.maxScrollLeftPx >= 0;

  if (!geometryIsValid) {
    return {
      scrollLeftPx: null,
      reason: "geometryNotMeasured"
    };
  }

  if (input.todayState.relation === "beforeRange") {
    return {
      scrollLeftPx: 0,
      reason: "beforeRange"
    };
  }

  if (input.todayState.relation === "afterRange") {
    return {
      scrollLeftPx: input.maxScrollLeftPx,
      reason: "afterRange"
    };
  }

  if (
    input.todayState.relation !== "inRange" ||
    !input.todayState.todayInRange ||
    input.todayState.todayRatio === null ||
    !Number.isFinite(input.todayState.todayRatio) ||
    input.todayState.todayRatio < 0 ||
    input.todayState.todayRatio > 1
  ) {
    return {
      scrollLeftPx: null,
      reason: "unavailable"
    };
  }

  const desiredViewportAnchorRatio =
    Number.isFinite(input.desiredViewportAnchorRatio) &&
    (input.desiredViewportAnchorRatio as number) >= 0 &&
    (input.desiredViewportAnchorRatio as number) <= 1
      ? input.desiredViewportAnchorRatio as number
      : PROJECT_ROUTE_GANTT_DEFAULT_TODAY_ANCHOR_RATIO;
  const todayX = input.todayState.todayRatio * input.contentWidthPx;
  const rawScrollLeft =
    todayX - input.viewportWidthPx * desiredViewportAnchorRatio;

  return {
    scrollLeftPx: clampProjectRouteGanttScrollLeft(
      rawScrollLeft,
      input.maxScrollLeftPx
    ),
    reason: "todayInRange"
  };
}
