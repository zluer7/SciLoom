export type AIAutoPullContextBudgetPreset =
  | "compact"
  | "standard"
  | "expanded"
  | "maximum"
  | "custom";

/** Product ceiling for allowlisted, automatically pulled research context only. */
export const AI_AUTO_PULL_CONTEXT_DEFAULT_CHARS = 15_000;
export const AI_AUTO_PULL_CONTEXT_MAX_CHARS = 30_000;
export const AI_AUTO_PULL_CONTEXT_CUSTOM_PERCENT_MIN = 50;
export const AI_AUTO_PULL_CONTEXT_CUSTOM_PERCENT_MAX = 200;
export const AI_AUTO_PULL_CONTEXT_DEFAULT_PERCENT = 100;

/**
 * Shared 45k ceiling. PARSE_DRAFT applies it only to software dynamic context;
 * legacy non-Parse callers retain their existing complete-payload guard.
 */
export const AI_PARSE_DYNAMIC_CONTEXT_BUDGET_CHARS = 45_000;
export const AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS =
  AI_PARSE_DYNAMIC_CONTEXT_BUDGET_CHARS;

const PRESET_PERCENTAGES: Record<Exclude<AIAutoPullContextBudgetPreset, "custom">, number> = {
  compact: 60,
  standard: 100,
  expanded: 150,
  maximum: 200
};

export type AIAutoPullContextBudget = {
  percent: number;
  maxChars: number;
};

function clampCustomPercent(percent: number): number {
  return Math.min(
    AI_AUTO_PULL_CONTEXT_CUSTOM_PERCENT_MAX,
    Math.max(AI_AUTO_PULL_CONTEXT_CUSTOM_PERCENT_MIN, percent)
  );
}

export function resolveCustomAutoPullContextPercent(value: string, lastValidPercent: number): number {
  const normalized = value.trim();
  const fallback = Number.isSafeInteger(lastValidPercent)
    ? clampCustomPercent(lastValidPercent)
    : AI_AUTO_PULL_CONTEXT_DEFAULT_PERCENT;
  if (!/^-?\d+$/.test(normalized)) return fallback;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? clampCustomPercent(parsed) : fallback;
}

export function resolveAIAutoPullContextBudget(
  preset: AIAutoPullContextBudgetPreset,
  customPercentInput: string,
  lastValidCustomPercent: number
): AIAutoPullContextBudget {
  const percent = preset === "custom"
    ? resolveCustomAutoPullContextPercent(customPercentInput, lastValidCustomPercent)
    : PRESET_PERCENTAGES[preset];
  return {
    percent,
    maxChars: Math.min(
      AI_AUTO_PULL_CONTEXT_MAX_CHARS,
      Math.round(AI_AUTO_PULL_CONTEXT_DEFAULT_CHARS * percent / 100)
    )
  };
}
