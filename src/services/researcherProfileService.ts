import {
  DEFAULT_RESEARCHER_PROFILE_ID,
  RESEARCHER_PROFILE_SCHEMA_VERSION,
  type AIVisibility,
  type ResearcherProfile,
  type ResearcherProfileSummary,
  type ResearcherRole,
  type ResearcherStage,
  type SaveResearcherProfileInput,
  type UpdateResearcherProfileInput
} from "../types/researcherProfile";
import {
  createCrossModuleWriteFeedback,
  publishCrossModuleWriteFeedback
} from "./crossModuleWriteFeedbackService";

const RESEARCHER_PROFILE_STORAGE_KEY = "labpod.researcherProfile.v1";

const VALID_RESEARCHER_ROLES: ResearcherRole[] = [
  "master",
  "phd",
  "engineer",
  "teacher",
  "industry_researcher",
  "other"
];

const VALID_RESEARCHER_STAGES: ResearcherStage[] = [
  "exploration",
  "experiment_validation",
  "method_refinement",
  "paper_writing",
  "patent_preparation",
  "project_review",
  "paused",
  "other"
];

const VALID_AI_VISIBILITIES: AIVisibility[] = ["private", "summary_only", "allow_context"];

let memoryResearcherProfile: ResearcherProfile | null = null;

function hasLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasOwn(value: object, key: keyof SaveResearcherProfileInput) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    const text = toOptionalString(item);
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function normalizeRole(value: unknown): ResearcherRole | undefined {
  return VALID_RESEARCHER_ROLES.includes(value as ResearcherRole)
    ? (value as ResearcherRole)
    : undefined;
}

function normalizeStage(value: unknown): ResearcherStage | undefined {
  return VALID_RESEARCHER_STAGES.includes(value as ResearcherStage)
    ? (value as ResearcherStage)
    : undefined;
}

function normalizeAIVisibility(value: unknown): AIVisibility {
  return VALID_AI_VISIBILITIES.includes(value as AIVisibility)
    ? (value as AIVisibility)
    : "summary_only";
}

function createDefaultResearcherProfile(timestamp = now()): ResearcherProfile {
  return {
    id: DEFAULT_RESEARCHER_PROFILE_ID,
    researchDirections: [],
    researchKeywords: [],
    aiVisibility: "summary_only",
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: RESEARCHER_PROFILE_SCHEMA_VERSION
  };
}

function normalizeResearcherProfile(
  profile: Partial<ResearcherProfile> | null | undefined
): ResearcherProfile {
  const timestamp = now();

  return {
    id: profile?.id ?? DEFAULT_RESEARCHER_PROFILE_ID,
    nickname: toOptionalString(profile?.nickname),
    role: normalizeRole(profile?.role),
    discipline: toOptionalString(profile?.discipline),
    researchDirections: normalizeStringList(profile?.researchDirections),
    researchKeywords: normalizeStringList(profile?.researchKeywords),
    researchSummary: toOptionalString(profile?.researchSummary),
    currentFocus: toOptionalString(profile?.currentFocus),
    methodPreferences: toOptionalString(profile?.methodPreferences),
    outputPreferences: toOptionalString(profile?.outputPreferences),
    currentStage: normalizeStage(profile?.currentStage),
    aiCommunicationPreference: toOptionalString(profile?.aiCommunicationPreference),
    aiGlobalConstraints: toOptionalString(profile?.aiGlobalConstraints),
    aiVisibility: normalizeAIVisibility(profile?.aiVisibility),
    createdAt: profile?.createdAt ?? timestamp,
    updatedAt: profile?.updatedAt ?? timestamp,
    schemaVersion: profile?.schemaVersion ?? RESEARCHER_PROFILE_SCHEMA_VERSION
  };
}

function buildProfileFromInput(
  input: SaveResearcherProfileInput,
  createdAt: string,
  updatedAt: string
): ResearcherProfile {
  return {
    id: DEFAULT_RESEARCHER_PROFILE_ID,
    nickname: toOptionalString(input.nickname),
    role: normalizeRole(input.role),
    discipline: toOptionalString(input.discipline),
    researchDirections: normalizeStringList(input.researchDirections),
    researchKeywords: normalizeStringList(input.researchKeywords),
    researchSummary: toOptionalString(input.researchSummary),
    currentFocus: toOptionalString(input.currentFocus),
    methodPreferences: toOptionalString(input.methodPreferences),
    outputPreferences: toOptionalString(input.outputPreferences),
    currentStage: normalizeStage(input.currentStage),
    aiCommunicationPreference: toOptionalString(input.aiCommunicationPreference),
    aiGlobalConstraints: toOptionalString(input.aiGlobalConstraints),
    aiVisibility: normalizeAIVisibility(input.aiVisibility),
    createdAt,
    updatedAt,
    schemaVersion: RESEARCHER_PROFILE_SCHEMA_VERSION
  };
}

function applyUpdatePatch(
  profile: ResearcherProfile,
  input: UpdateResearcherProfileInput
): ResearcherProfile {
  const updated: ResearcherProfile = {
    ...profile,
    researchDirections: [...profile.researchDirections],
    researchKeywords: [...profile.researchKeywords],
    updatedAt: now(),
    schemaVersion: RESEARCHER_PROFILE_SCHEMA_VERSION
  };

  if (hasOwn(input, "nickname")) {
    updated.nickname = toOptionalString(input.nickname);
  }
  if (hasOwn(input, "role")) {
    updated.role = normalizeRole(input.role);
  }
  if (hasOwn(input, "discipline")) {
    updated.discipline = toOptionalString(input.discipline);
  }
  if (hasOwn(input, "researchDirections")) {
    updated.researchDirections = normalizeStringList(input.researchDirections);
  }
  if (hasOwn(input, "researchKeywords")) {
    updated.researchKeywords = normalizeStringList(input.researchKeywords);
  }
  if (hasOwn(input, "researchSummary")) {
    updated.researchSummary = toOptionalString(input.researchSummary);
  }
  if (hasOwn(input, "currentFocus")) {
    updated.currentFocus = toOptionalString(input.currentFocus);
  }
  if (hasOwn(input, "methodPreferences")) {
    updated.methodPreferences = toOptionalString(input.methodPreferences);
  }
  if (hasOwn(input, "outputPreferences")) {
    updated.outputPreferences = toOptionalString(input.outputPreferences);
  }
  if (hasOwn(input, "currentStage")) {
    updated.currentStage = normalizeStage(input.currentStage);
  }
  if (hasOwn(input, "aiCommunicationPreference")) {
    updated.aiCommunicationPreference = toOptionalString(input.aiCommunicationPreference);
  }
  if (hasOwn(input, "aiGlobalConstraints")) {
    updated.aiGlobalConstraints = toOptionalString(input.aiGlobalConstraints);
  }
  if (hasOwn(input, "aiVisibility")) {
    updated.aiVisibility = normalizeAIVisibility(input.aiVisibility);
  }

  return updated;
}

async function persistResearcherProfile(profile: ResearcherProfile): Promise<ResearcherProfile> {
  const normalized = normalizeResearcherProfile(profile);

  if (hasLocalStorage()) {
    window.localStorage.setItem(RESEARCHER_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  } else {
    memoryResearcherProfile = clone(normalized);
  }

  return clone(normalized);
}

export async function getResearcherProfile(): Promise<ResearcherProfile | null> {
  if (!hasLocalStorage()) {
    return memoryResearcherProfile ? clone(memoryResearcherProfile) : null;
  }

  const raw = window.localStorage.getItem(RESEARCHER_PROFILE_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return normalizeResearcherProfile(JSON.parse(raw) as Partial<ResearcherProfile>);
  } catch (error) {
    console.warn("Failed to parse researcher profile.", error);
    return null;
  }
}

export async function ensureResearcherProfile(): Promise<ResearcherProfile> {
  const existing = await getResearcherProfile();
  if (existing) {
    return existing;
  }

  return persistResearcherProfile(createDefaultResearcherProfile());
}

export async function saveResearcherProfile(
  input: SaveResearcherProfileInput
): Promise<ResearcherProfile> {
  const existing = await getResearcherProfile();
  const timestamp = now();
  const profile = buildProfileFromInput(input, existing?.createdAt ?? timestamp, timestamp);
  return persistResearcherProfile(profile);
}

export async function updateResearcherProfile(
  input: UpdateResearcherProfileInput
): Promise<ResearcherProfile> {
  const existing = await ensureResearcherProfile();
  const profile = await persistResearcherProfile(applyUpdatePatch(existing, input));
  publishCrossModuleWriteFeedback(
    createCrossModuleWriteFeedback({
      operation: "researcherProfile.updateResearcherProfile",
      data: profile,
      primaryEntity: {
        type: "researcherProfile",
        id: profile.id,
        relation: "updated",
        label: profile.nickname
      },
      affectedScopes: [
        {
          module: "ai",
          reason: "ResearcherProfile controls AI context visibility and preferences."
        },
        {
          module: "global",
          reason: "ResearcherProfile is global local user metadata."
        }
      ],
      refreshKeys: ["researcherProfile.changed", "aiContext.changed", "global.changed"]
    }),
    "researcherProfile.updateResearcherProfile"
  );
  return profile;
}

export async function buildResearcherProfileSummary(): Promise<ResearcherProfileSummary | null> {
  const profile = await getResearcherProfile();
  if (!profile) {
    return null;
  }

  const lines = [
    profile.nickname ? `用户昵称：${profile.nickname}` : undefined,
    profile.role ? `身份：${profile.role}` : undefined,
    profile.discipline ? `学科方向：${profile.discipline}` : undefined,
    profile.researchDirections.length > 0
      ? `研究方向：${profile.researchDirections.join("、")}`
      : undefined,
    profile.researchKeywords.length > 0
      ? `研究关键词：${profile.researchKeywords.join("、")}`
      : undefined,
    profile.researchSummary ? `研究简介：${profile.researchSummary}` : undefined,
    profile.currentFocus ? `当前重点：${profile.currentFocus}` : undefined,
    profile.methodPreferences ? `研究方法 / 技术偏好：${profile.methodPreferences}` : undefined,
    profile.outputPreferences ? `成果目标 / 输出偏好：${profile.outputPreferences}` : undefined,
    profile.currentStage ? `当前阶段：${profile.currentStage}` : undefined,
    profile.aiCommunicationPreference
      ? `AI 交流偏好：${profile.aiCommunicationPreference}`
      : undefined,
    profile.aiGlobalConstraints ? `AI 全局约束：${profile.aiGlobalConstraints}` : undefined
  ].filter((line): line is string => Boolean(line));

  return {
    nickname: profile.nickname,
    role: profile.role,
    discipline: profile.discipline,
    researchDirections: [...profile.researchDirections],
    researchKeywords: [...profile.researchKeywords],
    researchSummary: profile.researchSummary,
    currentFocus: profile.currentFocus,
    methodPreferences: profile.methodPreferences,
    outputPreferences: profile.outputPreferences,
    currentStage: profile.currentStage,
    aiCommunicationPreference: profile.aiCommunicationPreference,
    aiGlobalConstraints: profile.aiGlobalConstraints,
    aiVisibility: profile.aiVisibility,
    summaryText: lines.join("\n"),
    updatedAt: profile.updatedAt
  };
}

export const researcherProfileService = {
  getResearcherProfile,
  ensureResearcherProfile,
  saveResearcherProfile,
  updateResearcherProfile,
  buildResearcherProfileSummary
};

export type ResearcherProfileService = typeof researcherProfileService;
