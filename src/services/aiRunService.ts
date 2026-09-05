import type { AIRun, AIRunCreateInput } from "../types";

export const AI_RUN_STORAGE_KEY = "labpod.ai.runs.v1";
export const AI_RUN_MAX_ITEMS = 50;

const ERROR_MESSAGE_MAX_CHARS = 300;

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `ai-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function limitText(value: string | undefined, maxChars: number): string {
  const text = value ?? "";
  return Array.from(text).slice(0, maxChars).join("");
}

function isAIRun(value: unknown): value is AIRun {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const run = value as Partial<AIRun>;
  return (
    typeof run.id === "string" &&
    run.provider === "deepseek" &&
    typeof run.model === "string" &&
    typeof run.prompt === "string" &&
    typeof run.outputText === "string" &&
    (run.status === "success" || run.status === "failed") &&
    typeof run.createdAt === "string"
  );
}

function toStoredAIRun(run: AIRun): AIRun {
  return {
    id: run.id,
    provider: run.provider,
    model: run.model,
    prompt: run.prompt,
    outputText: run.outputText,
    status: run.status,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage
      ? limitText(run.errorMessage, ERROR_MESSAGE_MAX_CHARS)
      : undefined,
    truncated: run.truncated,
    createdAt: run.createdAt
  };
}

export function createAIRun(input: AIRunCreateInput): AIRun {
  return {
    id: createId(),
    provider: input.provider,
    model: input.model,
    prompt: input.prompt.trim(),
    outputText: input.outputText ?? "",
    status: input.status,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage
      ? limitText(input.errorMessage, ERROR_MESSAGE_MAX_CHARS)
      : undefined,
    truncated: input.truncated,
    createdAt: new Date().toISOString()
  };
}

export function safeParseAIRuns(rawValue: string | null): AIRun[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isAIRun).map(toStoredAIRun).slice(0, AI_RUN_MAX_ITEMS);
  } catch {
    return [];
  }
}

export function listAIRuns(): AIRun[] {
  try {
    return safeParseAIRuns(localStorage.getItem(AI_RUN_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveAIRun(input: AIRunCreateInput): AIRun | null {
  try {
    const nextRun = createAIRun(input);
    const nextRuns = [nextRun, ...listAIRuns()].slice(0, AI_RUN_MAX_ITEMS);
    localStorage.setItem(AI_RUN_STORAGE_KEY, JSON.stringify(nextRuns));
    return nextRun;
  } catch {
    return null;
  }
}

export function clearAIRuns(): void {
  try {
    localStorage.removeItem(AI_RUN_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable.
  }
}
