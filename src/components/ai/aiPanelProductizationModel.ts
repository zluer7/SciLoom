import type { AIConversationSummary } from "../../types";
import type { Project } from "../../types/planning";
import type {
  AIResearchObjectDescriptor,
  AIResearchObjectType
} from "../../types/aiContext";

export type AIConversationHistoryGroup = {
  id: "today" | "recent" | "older";
  label: string;
  conversations: AIConversationSummary[];
};

export type AIResearchObjectCategory =
  | "route"
  | "task"
  | "experiment"
  | "run"
  | "literature"
  | "review"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export const AI_RESEARCH_OBJECT_CATEGORIES: ReadonlyArray<{
  id: AIResearchObjectCategory;
  label: string;
}> = Object.freeze([
  { id: "route", label: "研究路线" },
  { id: "task", label: "研究任务" },
  { id: "experiment", label: "实验" },
  { id: "run", label: "实验运行" },
  { id: "literature", label: "文献" },
  { id: "review", label: "复盘" },
  { id: "resultItem", label: "结果资产" },
  { id: "finding", label: "关键发现" },
  { id: "outputCandidate", label: "候选成果" },
  { id: "outputGap", label: "成果缺口" },
  { id: "researchOutput", label: "正式成果" }
]);

const DAY_MS = 24 * 60 * 60 * 1_000;

export function resolveMostRecentlyActiveAIProjectId(
  projects: readonly Project[]
): string | undefined {
  return [...projects]
    .filter((project) => !project.deletedAt && !project.archivedAt && project.status !== "archived")
    .sort((left, right) => {
      const leftUpdatedAt = Date.parse(left.updatedAt);
      const rightUpdatedAt = Date.parse(right.updatedAt);
      const leftTime = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : Number.NEGATIVE_INFINITY;
      const rightTime = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : Number.NEGATIVE_INFINITY;
      return rightTime - leftTime || left.id.localeCompare(right.id);
    })[0]?.id;
}

export const AI_LAST_SELECTED_PROJECT_PREFERENCE_KEY = "labpod.ai.last-selected-project.v1";

export function resolvePreferredAIProjectId(
  projects: readonly Project[],
  preferredProjectId?: string | null
): string | undefined {
  const normalizedPreference = preferredProjectId?.trim();
  if (
    normalizedPreference &&
    projects.some((project) => (
      project.id === normalizedPreference &&
      !project.deletedAt &&
      !project.archivedAt &&
      project.status !== "archived"
    ))
  ) return normalizedPreference;
  return resolveMostRecentlyActiveAIProjectId(projects);
}

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function groupAIConversationHistory(
  summaries: readonly AIConversationSummary[],
  now = new Date()
): AIConversationHistoryGroup[] {
  const todayStart = startOfLocalDay(now);
  const recentStart = todayStart - (6 * DAY_MS);
  const groups: AIConversationHistoryGroup[] = [
    { id: "today", label: "今天", conversations: [] },
    { id: "recent", label: "近 7 天", conversations: [] },
    { id: "older", label: "更早", conversations: [] }
  ];

  for (const summary of summaries) {
    const updatedAt = Date.parse(summary.updatedAt);
    const group = Number.isFinite(updatedAt) && updatedAt >= todayStart
      ? groups[0]
      : Number.isFinite(updatedAt) && updatedAt >= recentStart
        ? groups[1]
        : groups[2];
    group.conversations.push(summary);
  }

  return groups.filter((group) => group.conversations.length > 0);
}

export function researchObjectCategoryForType(
  objectType: AIResearchObjectType
): AIResearchObjectCategory {
  if (objectType === "route") return "route";
  if (objectType === "task") return "task";
  if (objectType === "experiment") return "experiment";
  if (objectType === "experimentRun") return "run";
  if (objectType === "literature") return "literature";
  if (objectType === "review") return "review";
  if (objectType === "resultItem") return "resultItem";
  if (objectType === "finding") return "finding";
  if (objectType === "outputCandidate") return "outputCandidate";
  if (objectType === "outputGap") return "outputGap";
  return "researchOutput";
}

export function filterAIResearchObjectsByCategory(
  descriptors: readonly AIResearchObjectDescriptor[],
  category: AIResearchObjectCategory
): AIResearchObjectDescriptor[] {
  return descriptors.filter((descriptor) => (
    researchObjectCategoryForType(descriptor.objectType) === category
  ));
}
