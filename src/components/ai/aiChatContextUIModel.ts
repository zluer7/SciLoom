import type { AIContextBudget, AIContextWarning } from "../../types/aiContext";

export const AI_CHAT_OTHER_SCOPE_VALUE = "__other_scope__";

export type AIChatScopeSelection =
  | { kind: "project"; projectId: string }
  | { kind: "other"; projectId: string }
  | { kind: "none"; projectId: "" };

export function createAIChatContextBudget(maxChars: number): AIContextBudget {
  return {
    maxChars,
    reservedForUserQuestion: 0,
    reservedForSystemInstruction: 0,
    maxSectionChars: maxChars,
    maxItemChars: Math.min(1_200, maxChars),
    strategy: "priorityFirst"
  };
}

export function resolveAIChatScopeSelection(
  value: string,
  currentProjectId: string
): AIChatScopeSelection {
  if (value === AI_CHAT_OTHER_SCOPE_VALUE) {
    return { kind: "other", projectId: currentProjectId };
  }
  if (!value) return { kind: "none", projectId: "" };
  return { kind: "project", projectId: value };
}

export function isTechnicalCapacityWarning(
  warning: Pick<AIContextWarning, "code">
): boolean {
  return warning.code === "technical_capacity_or_safety_error";
}
