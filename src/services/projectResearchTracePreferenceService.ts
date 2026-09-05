import { publishRefreshEvent } from "./refreshEventService";
import {
  deleteResearchTracePreference,
  getResearchTracePreference as getPreference,
  listResearchTracePreferences as listPreferences,
  upsertResearchTracePreference
} from "./projectResearchTracePreferenceRepository";
import type {
  ProjectResearchTracePreferenceVisibility,
  ProjectResearchTraceTargetType,
  ResearchTraceEventPreference
} from "../types/projectResearchTrace";

export const RESEARCH_TRACE_PREFERENCE_TARGET_TYPES = [
  "review",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput",
  "route",
  "task",
  "experiment",
  "experimentRun",
  "literature",
  "resultItem"
] as const satisfies readonly ProjectResearchTraceTargetType[];

export type ResearchTracePreferenceTargetType =
  (typeof RESEARCH_TRACE_PREFERENCE_TARGET_TYPES)[number];

export type SetResearchTracePreferenceInput = {
  projectId: string;
  targetType: ProjectResearchTraceTargetType;
  targetId: string;
  visibility: ProjectResearchTracePreferenceVisibility;
  note?: string;
};

export type ResearchTracePreferenceTargetInput = Omit<
  SetResearchTracePreferenceInput,
  "visibility"
>;

const allowedTargetTypes = new Set<ProjectResearchTraceTargetType>(
  RESEARCH_TRACE_PREFERENCE_TARGET_TYPES
);

const allowedVisibility = new Set<ProjectResearchTracePreferenceVisibility>([
  "auto",
  "pinned",
  "hidden"
]);

function assertRequiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Research trace preference ${field} is required.`);
  }
}

export function isResearchTracePreferenceTargetType(
  targetType: ProjectResearchTraceTargetType
): targetType is ResearchTracePreferenceTargetType {
  return allowedTargetTypes.has(targetType);
}

function validatePreferenceTarget(input: ResearchTracePreferenceTargetInput) {
  assertRequiredString(input.projectId, "projectId");
  assertRequiredString(input.targetId, "targetId");
  if (!allowedTargetTypes.has(input.targetType)) {
    throw new Error(`Research trace preference targetType is not supported: ${input.targetType}.`);
  }
}

function validateVisibility(visibility: ProjectResearchTracePreferenceVisibility) {
  if (!allowedVisibility.has(visibility)) {
    throw new Error(`Research trace preference visibility is not supported: ${visibility}.`);
  }
}

function publishResearchTracePreferenceRefresh(
  operation: string,
  input: ResearchTracePreferenceTargetInput,
  preference?: ResearchTraceEventPreference | null
) {
  publishRefreshEvent({
    id: `research-trace-preference-refresh:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    keys: ["researchTrace.changed"],
    affectedEntities: [
      {
        type: "researchTracePreference",
        id: preference?.id ?? `${input.projectId}:${input.targetType}:${input.targetId}`,
        relation: operation.endsWith(".reset") ? "deleted" : "updated",
        label: input.targetType
      },
      {
        type: input.targetType,
        id: input.targetId,
        relation: "updated"
      }
    ],
    affectedScopes: [
      {
        module: "project",
        projectId: input.projectId,
        reason: "Research trace display preference changed."
      },
      {
        module: "researchTrace",
        projectId: input.projectId,
        reason: "Research trace selector should reload display preferences."
      }
    ],
    source: "projectResearchTracePreferenceService",
    operation,
    reason: "Research trace preference changed.",
    writeFeedbackStatus: "success",
    warnings: [],
    errors: [],
    skipped: [],
    createdAt: new Date().toISOString()
  });
}

export async function listResearchTracePreferences(
  projectId: string
): Promise<ResearchTraceEventPreference[]> {
  assertRequiredString(projectId, "projectId");
  return listPreferences(projectId.trim());
}

export async function getResearchTracePreference(
  projectId: string,
  targetType: ProjectResearchTraceTargetType,
  targetId: string
): Promise<ResearchTraceEventPreference | null> {
  validatePreferenceTarget({ projectId, targetType, targetId });
  return getPreference(projectId.trim(), targetType, targetId.trim());
}

export async function setResearchTracePreference(
  input: SetResearchTracePreferenceInput
): Promise<ResearchTraceEventPreference | null> {
  validatePreferenceTarget(input);
  validateVisibility(input.visibility);

  const normalizedInput = {
    projectId: input.projectId.trim(),
    targetType: input.targetType,
    targetId: input.targetId.trim(),
    note: input.note?.trim() || undefined
  };

  if (input.visibility === "auto") {
    await deleteResearchTracePreference(
      normalizedInput.projectId,
      normalizedInput.targetType,
      normalizedInput.targetId
    );
    publishResearchTracePreferenceRefresh("researchTrace.preference.reset", normalizedInput);
    return null;
  }

  const preference = await upsertResearchTracePreference({
    ...normalizedInput,
    visibility: input.visibility
  });
  publishResearchTracePreferenceRefresh("researchTrace.preference.set", normalizedInput, preference);
  return preference;
}

export async function pinResearchTraceTarget(
  input: ResearchTracePreferenceTargetInput
): Promise<ResearchTraceEventPreference> {
  const preference = await setResearchTracePreference({
    ...input,
    visibility: "pinned"
  });
  if (!preference) {
    throw new Error("Research trace pin operation did not create a preference.");
  }
  return preference;
}

export async function hideResearchTraceTarget(
  input: ResearchTracePreferenceTargetInput
): Promise<ResearchTraceEventPreference> {
  const preference = await setResearchTracePreference({
    ...input,
    visibility: "hidden"
  });
  if (!preference) {
    throw new Error("Research trace hide operation did not create a preference.");
  }
  return preference;
}

export async function resetResearchTracePreference(
  input: ResearchTracePreferenceTargetInput
): Promise<void> {
  validatePreferenceTarget(input);
  const normalizedInput = {
    projectId: input.projectId.trim(),
    targetType: input.targetType,
    targetId: input.targetId.trim(),
    note: input.note?.trim() || undefined
  };
  await deleteResearchTracePreference(
    normalizedInput.projectId,
    normalizedInput.targetType,
    normalizedInput.targetId
  );
  publishResearchTracePreferenceRefresh("researchTrace.preference.reset", normalizedInput);
}

export const projectResearchTracePreferenceService = {
  listResearchTracePreferences,
  getResearchTracePreference,
  setResearchTracePreference,
  pinResearchTraceTarget,
  hideResearchTraceTarget,
  resetResearchTracePreference,
  isResearchTracePreferenceTargetType
};

export type ProjectResearchTracePreferenceService =
  typeof projectResearchTracePreferenceService;
