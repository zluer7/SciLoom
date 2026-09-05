import type {
  AIContextItem,
  AIContextLevel,
  AIContextPackage,
  AIPromptPackage,
  AIResearchObjectType
} from "../types/aiContext";
import type { Language } from "../i18n/translations";

export type AIContextHumanReadablePreview = {
  markdown: string;
  referenceCount: number;
};

export type AIContextViewerProjectionItem = {
  identity: string;
  sectionId: string;
  sectionTitle: string;
  title: string;
  summary: string;
  content?: string;
  contextLevel?: AIContextLevel;
};

export type AIContextViewerLevelGroup = {
  level: AIContextLevel;
  label: `L${AIContextLevel}`;
  items: AIContextViewerProjectionItem[];
};

export type AIContextViewerExclusion = {
  identity: string;
  reason: "not_sendable_by_existing_context_contract";
};

export type AIContextLevelViewerProjection = {
  levelGroups: AIContextViewerLevelGroup[];
  unclassifiedItems: AIContextViewerProjectionItem[];
  excludedItems: AIContextViewerExclusion[];
  duplicateItemIdentities: string[];
  expectedViewerItemIdentities: string[];
  actualViewerItemIdentities: string[];
};

/**
 * Projects the exact frozen ContextPackage already held by the caller. It performs no read,
 * rebuild or semantic inference: trustworthy item-level contextLevel is used only for items
 * that are already level-atomic in the canonical package, while unknown levels stay explicit.
 */
export function buildAIContextLevelViewerProjection(
  contextPackage: AIContextPackage
): AIContextLevelViewerProjection {
  const byLevel = new Map<AIContextLevel, AIContextViewerProjectionItem[]>([
    [1, []],
    [2, []],
    [3, []],
    [4, []]
  ]);
  const seen = new Set<string>();
  const duplicateItemIdentities: string[] = [];
  const excludedItems: AIContextViewerExclusion[] = [];
  const unclassifiedItems: AIContextViewerProjectionItem[] = [];
  const expectedViewerItemIdentities: string[] = [];

  for (const section of contextPackage.sections) {
    for (const item of section.items) {
      if (seen.has(item.id)) {
        duplicateItemIdentities.push(item.id);
        continue;
      }
      seen.add(item.id);
      if (!item.sendable) {
        excludedItems.push({
          identity: item.id,
          reason: "not_sendable_by_existing_context_contract"
        });
        continue;
      }
      const projected: AIContextViewerProjectionItem = {
        identity: item.id,
        sectionId: section.id,
        sectionTitle: SECTION_LABELS_ZH[section.id] ?? section.title,
        title: item.title,
        summary: item.summary,
        ...(item.content ? { content: item.content } : {}),
        ...(item.contextLevel ? { contextLevel: item.contextLevel } : {})
      };
      expectedViewerItemIdentities.push(item.id);
      if (item.contextLevel && byLevel.has(item.contextLevel)) {
        byLevel.get(item.contextLevel)!.push(projected);
      } else {
        unclassifiedItems.push(projected);
      }
    }
  }

  const levelGroups = ([1, 2, 3, 4] as const)
    .map((level): AIContextViewerLevelGroup => ({
      level,
      label: `L${level}`,
      items: byLevel.get(level) ?? []
    }))
    .filter((group) => group.items.length > 0);
  return {
    levelGroups,
    unclassifiedItems,
    excludedItems,
    duplicateItemIdentities,
    expectedViewerItemIdentities,
    actualViewerItemIdentities: [
      ...levelGroups.flatMap((group) => group.items.map((item) => item.identity)),
      ...unclassifiedItems.map((item) => item.identity)
    ]
  };
}

const SECTION_LABELS_ZH: Record<string, string> = {
  project: "课题概况",
  routes: "研究路线",
  "primary-routes": "研究路线",
  tasks: "研究任务",
  "primary-tasks": "研究任务",
  reviews: "复盘记录",
  "primary-reviews": "复盘记录",
  experiments: "实验记录",
  "primary-experiments": "实验记录",
  "experiment-runs": "实验运行",
  "primary-experiment-runs": "实验运行",
  literatures: "文献资料",
  literature: "文献资料",
  findings: "关键发现",
  "result-items": "结果资产",
  "output-candidates": "候选成果",
  "output-gaps": "成果缺口",
  "research-outputs": "正式成果"
};

const OBJECT_LABELS_ZH: Record<AIResearchObjectType, string> = {
  route: "研究路线",
  task: "研究任务",
  review: "复盘",
  experiment: "实验",
  experimentRun: "实验运行",
  literature: "文献",
  finding: "关键发现",
  resultItem: "结果资产",
  outputCandidate: "候选成果",
  outputGap: "成果缺口",
  researchOutput: "正式成果"
};

const STATUS_LABELS_ZH: Record<string, string> = {
  active: "进行中",
  planned: "计划中",
  todo: "待办",
  doing: "进行中",
  in_progress: "进行中",
  done: "已完成",
  completed: "已完成",
  blocked: "受阻",
  paused: "已暂停",
  planning: "计划中",
  archived: "已归档",
  open: "待处理",
  resolved: "已解决",
  cancelled: "已取消"
};

/**
 * Deterministic user-facing projection of the canonical package. The returned body is used
 * both for review/editing and by the existing contextMarkdownOverride prompt seam. It does
 * not expose package ids, source-ref DTOs, budgets, fingerprints or local absolute paths.
 */
export function buildAIContextHumanReadablePreview({
  contextPackage,
  promptPackage,
  language
}: {
  contextPackage: AIContextPackage;
  promptPackage?: AIPromptPackage | null;
  language: Language;
}): AIContextHumanReadablePreview {
  const chinese = language === "zh-CN";
  const researchObjects = contextPackage.researchObjects ?? [];
  const materials = contextPackage.materialDecisions ?? [];
  const referenceCount = promptPackage?.sourceRefs.length || contextPackage.sourceRefs.length;
  const lines: string[] = [
    `# ${chinese ? "上下文内容" : "Context content"}`,
    "",
    `## ${chinese ? "当前课题" : "Current project"}`,
    cleanReadableText(contextPackage.scope.label) || (chinese ? "当前课题" : "Current project")
  ];

  const scopeDescription = cleanReadableText(contextPackage.scope.description);
  if (scopeDescription) lines.push("", scopeDescription);

  lines.push("", `## ${chinese ? "已选择的研究对象" : "Selected research objects"}`);
  if (researchObjects.length === 0) {
    lines.push(chinese ? "本次未额外选择研究对象，仅使用当前课题的基础信息。" :
      "No additional research objects were selected; only the current project overview is used.");
  } else {
    for (const object of researchObjects) {
      const typeLabel = chinese ? OBJECT_LABELS_ZH[object.objectType] : humanizeIdentifier(object.objectType);
      lines.push(`- ${typeLabel}：${cleanReadableText(object.label) || (chinese ? "未命名对象" : "Untitled item")}`);
      const description = cleanReadableText(object.description);
      if (description) lines.push(`  ${description}`);
    }
  }

  const renderedItemIds = new Set<string>();
  for (const section of contextPackage.sections) {
    const items = section.items.filter((item) => {
      if (!item.sendable || renderedItemIds.has(item.id)) return false;
      renderedItemIds.add(item.id);
      return true;
    });
    if (items.length === 0) continue;
    const sectionLabel = chinese
      ? SECTION_LABELS_ZH[section.id] ?? cleanReadableText(section.title) ?? "相关信息"
      : cleanReadableText(section.title) ?? humanizeIdentifier(section.id);
    lines.push("", `## ${sectionLabel}`);
    for (const item of items) lines.push(...formatContextItem(item, chinese));
  }

  lines.push("", `## ${chinese ? "关联文档" : "Associated documents"}`);
  if (materials.length === 0) {
    lines.push(chinese ? "本次未关联文档。" : "No documents are associated with this context.");
  } else {
    for (const material of materials) {
      lines.push(`- ${cleanReadableText(material.displayName) || (chinese ? "未命名文档" : "Untitled document")}`);
    }
    lines.push(chinese
      ? "文档正文仅在本次调用获得明确授权后使用；这里展示的是关联关系，不会改写原始材料。"
      : "Document bodies are used only after explicit authorization for this call; this list does not alter source material.");
  }

  return { markdown: compactBlankLines(lines).join("\n").trim(), referenceCount };
}

function formatContextItem(item: AIContextItem, chinese: boolean): string[] {
  const title = cleanReadableText(item.title) || (chinese ? "未命名内容" : "Untitled content");
  const status = getStatus(item);
  const statusLabel = status
    ? chinese ? STATUS_LABELS_ZH[normalizeStatus(status)] ?? cleanReadableText(status) : humanizeIdentifier(status)
    : undefined;
  const displayedStatus = status && statusLabel && statusLabel !== status
    ? `${statusLabel} / ${cleanReadableText(status)}`
    : statusLabel;
  const heading = displayedStatus
    ? `### ${title}（${chinese ? "状态" : "Status"}：${displayedStatus}）`
    : `### ${title}`;
  const summary = cleanReadableText(cleanSummary(item.summary));
  const content = cleanReadableText(item.content);
  const lines = [heading];
  if (summary) lines.push("", summary);
  if (content && content !== summary) lines.push("", content);
  return lines;
}

function getStatus(item: AIContextItem): string | undefined {
  const metadataStatus = item.metadata?.status;
  if (typeof metadataStatus === "string" && metadataStatus.trim()) return metadataStatus.trim();
  return item.summary.match(/\bStatus:\s*([^|，。,;\n]+)/iu)?.[1]?.trim();
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

function cleanSummary(value: string): string {
  return value
    .replace(/\bStatus:\s*[^|，。,;\n]+[|，。,;]?\s*/giu, "")
    .replace(/\bRelation:\s*[^|，。,;\n]+[|，。,;]?\s*/giu, "")
    .replace(/\s*\|\s*/gu, "；")
    .replace(/^；+|；+$/gu, "")
    .trim();
}

function cleanReadableText(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/[a-z][a-z0-9-]*-[0-9a-f]{8}-[0-9a-f-]{27,}/giu, "（内部标识已隐藏）")
    .replace(/(?:[a-zA-Z]:[\\/]|file:\/\/)[^\s<>"']+/gu, "（本地路径已隐藏）")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}

function compactBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (line === "" && result[result.length - 1] === "") continue;
    result.push(line);
  }
  return result;
}
