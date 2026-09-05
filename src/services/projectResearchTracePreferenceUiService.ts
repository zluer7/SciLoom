import {
  getResearchTracePreference,
  hideResearchTraceTarget,
  pinResearchTraceTarget,
  resetResearchTracePreference
} from "./projectResearchTracePreferenceService";
import type {
  ProjectResearchTraceTargetType,
  ResearchTraceEventPreference
} from "../types/projectResearchTrace";

export type ResearchTraceDisplayPreferenceTarget = {
  projectId: string;
  targetType: ProjectResearchTraceTargetType;
  targetId: string;
};

export type ResearchTraceDisplayPreferenceInput =
  ResearchTraceDisplayPreferenceTarget & {
    defaultDisplayed: boolean;
    checked: boolean;
  };

export type ResearchTraceRouteDefaultDisplayInput = {
  startDate?: string | null;
  endDate?: string | null;
  completedAt?: string | null;
  status?: string | null;
  captureState?: string | null;
};

function getLocalTodayIsoDate() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function normalizePreferenceDate(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

function resolveRouteResearchTraceDate(route: ResearchTraceRouteDefaultDisplayInput) {
  return (
    normalizePreferenceDate(route.startDate) ||
    normalizePreferenceDate(route.completedAt) ||
    normalizePreferenceDate(route.endDate)
  );
}

export function isRouteResearchTraceDefaultDisplayed(
  route: ResearchTraceRouteDefaultDisplayInput,
  today = getLocalTodayIsoDate()
) {
  if (route.captureState === "archived" || route.status === "archived") {
    return false;
  }
  const routeDate = resolveRouteResearchTraceDate(route);
  const todayDate = normalizePreferenceDate(today) || getLocalTodayIsoDate();
  return Boolean(routeDate && routeDate <= todayDate);
}

export function resolveResearchTraceDisplayChecked(
  defaultDisplayed: boolean,
  preference: ResearchTraceEventPreference | null | undefined
) {
  if (preference?.visibility === "pinned") {
    return true;
  }
  if (preference?.visibility === "hidden") {
    return false;
  }
  return defaultDisplayed;
}

export async function getResearchTraceDisplayChecked(
  input: ResearchTraceDisplayPreferenceTarget & { defaultDisplayed: boolean }
) {
  const preference = await getResearchTracePreference(
    input.projectId,
    input.targetType,
    input.targetId
  );
  return resolveResearchTraceDisplayChecked(input.defaultDisplayed, preference);
}

export async function saveResearchTraceDisplayPreference(
  input: ResearchTraceDisplayPreferenceInput
) {
  const target = {
    projectId: input.projectId,
    targetType: input.targetType,
    targetId: input.targetId
  };

  if (input.defaultDisplayed) {
    if (input.checked) {
      await resetResearchTracePreference(target);
      return;
    }
    await hideResearchTraceTarget(target);
    return;
  }

  if (input.checked) {
    await pinResearchTraceTarget(target);
    return;
  }
  await resetResearchTracePreference(target);
}

export function isStageReviewDefaultDisplayed(reviewType: string) {
  return reviewType === "stage";
}
