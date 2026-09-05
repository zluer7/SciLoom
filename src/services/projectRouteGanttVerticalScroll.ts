export const PROJECT_ROUTE_GANTT_DEFAULT_VERTICAL_TOP_INSET_PX = 8;

export type ProjectRouteGanttDefaultScrollTopReason =
  | "activeAnchor"
  | "naturalTop"
  | "anchorUnavailable"
  | "geometryNotMeasured";

export type ResolveProjectRouteGanttDefaultScrollTopInput = {
  hasActiveAnchor: boolean;
  targetOffsetTopPx?: number;
  targetHeightPx?: number;
  viewportHeightPx: number;
  scrollHeightPx: number;
  headerHeightPx?: number;
  topInsetPx?: number;
};

export type ProjectRouteGanttDefaultScrollTopResult = {
  scrollTopPx: number | null;
  maxScrollTopPx: number;
  reason: ProjectRouteGanttDefaultScrollTopReason;
};

function isFiniteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

export function hasProjectRouteGanttVerticalContextChanged(
  currentProjectId: string | null,
  nextProjectId: string
) {
  return currentProjectId !== nextProjectId;
}

export function clampProjectRouteGanttScrollTop(value: number, maxScrollTopPx: number) {
  if (!Number.isFinite(value) || !isFiniteNonNegative(maxScrollTopPx)) {
    return 0;
  }

  return Math.min(Math.max(0, value), maxScrollTopPx);
}

export function resolveProjectRouteGanttDefaultScrollTop(
  input: ResolveProjectRouteGanttDefaultScrollTopInput
): ProjectRouteGanttDefaultScrollTopResult {
  if (
    !Number.isFinite(input.viewportHeightPx) ||
    input.viewportHeightPx <= 0 ||
    !Number.isFinite(input.scrollHeightPx) ||
    input.scrollHeightPx <= 0
  ) {
    return {
      scrollTopPx: null,
      maxScrollTopPx: 0,
      reason: "geometryNotMeasured"
    };
  }

  const maxScrollTopPx = Math.max(0, input.scrollHeightPx - input.viewportHeightPx);

  if (!input.hasActiveAnchor) {
    return {
      scrollTopPx: 0,
      maxScrollTopPx,
      reason: "naturalTop"
    };
  }

  const headerHeightPx = input.headerHeightPx ?? 0;
  const topInsetPx = input.topInsetPx ?? PROJECT_ROUTE_GANTT_DEFAULT_VERTICAL_TOP_INSET_PX;
  if (!isFiniteNonNegative(headerHeightPx) || !isFiniteNonNegative(topInsetPx)) {
    return {
      scrollTopPx: null,
      maxScrollTopPx,
      reason: "geometryNotMeasured"
    };
  }

  if (
    input.targetOffsetTopPx === undefined ||
    !isFiniteNonNegative(input.targetOffsetTopPx) ||
    input.targetHeightPx === undefined ||
    !Number.isFinite(input.targetHeightPx) ||
    input.targetHeightPx <= 0
  ) {
    return {
      scrollTopPx: null,
      maxScrollTopPx,
      reason: "anchorUnavailable"
    };
  }

  return {
    scrollTopPx: clampProjectRouteGanttScrollTop(
      input.targetOffsetTopPx - headerHeightPx - topInsetPx,
      maxScrollTopPx
    ),
    maxScrollTopPx,
    reason: "activeAnchor"
  };
}
