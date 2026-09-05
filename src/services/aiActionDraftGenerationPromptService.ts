import type { AIContextSourceRef } from "../types/aiContext";
import { AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS } from "./aiPromptBudgetService";

export type AIActionDraftGenerationProjectSummary = {
  id: string;
  title: string;
  status?: string;
};

export type AIActionDraftLightweightContext = {
  routeNodes?: Array<{
    id: string;
    title: string;
    status?: string;
    order?: number;
  }>;
  tasks?: Array<{
    id: string;
    title: string;
    status?: string;
    priority?: string;
    routeNodeId?: string;
  }>;
  outputGaps?: Array<{
    id: string;
    title: string;
    status?: string;
  }>;
  sourceRefs?: Array<{
    sourceType: string;
    id: string;
    title?: string;
    label?: string;
  }>;
};

export type AIActionDraftGenerationPromptInput = {
  originalUserQuestion?: string;
  ordinaryAIResponse?: string;
  project?: AIActionDraftGenerationProjectSummary;
  lightweightContext?: AIActionDraftLightweightContext;
  allowedDraftTypes?: string[];
  maxDrafts?: number;

  /**
   * Backward-compatible aliases used by AI-D7-5.
   * contextMarkdown is intentionally not included in the generated prompt.
   */
  userQuestion?: string;
  ordinaryAnswer?: string;
  projectId?: string;
  projectTitle?: string;
  sourceRefs?: Array<Pick<AIContextSourceRef, "module" | "entityType" | "entityId"> &
    Partial<Pick<AIContextSourceRef, "label" | "field">>>;
  contextMarkdown?: string;
};

const DEFAULT_ALLOWED_DRAFT_TYPES = [
  "task_create",
  "review_candidate",
  "output_gap_create",
  "output_candidate_create",
  "entity_link_create"
];

const PRIORITY_DRAFT_TYPES = ["task_create", "review_candidate", "output_gap_create"];

const FORBIDDEN_DRAFT_TYPES = [
  "task_update",
  "route_update",
  "review_overwrite",
  "output_gap_update",
  "output_gap_close",
  "finding_create",
  "finding_verify",
  "finding_verified_create",
  "output_candidate_to_formal_output",
  "formal_output_create",
  "bulk_link_create",
  "bulk_accept_all",
  "bulk_write_all",
  "auto_execute_all",
  "literature_link_create"
];

function truncate(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join("") : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function sanitize(value: string | undefined): string {
  return (value ?? "")
    .replace(/\0/g, "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[sensitive content omitted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "[sensitive content omitted]")
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s|]+/gi, "[sensitive content omitted]")
    .replace(/[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/g, "[local path omitted]");
}

function compactText(value: string | undefined, maxChars: number): string | undefined {
  const text = truncate(sanitize(value), maxChars);
  return text || undefined;
}

function compactItem<T extends Record<string, unknown>>(item: T): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (typeof value === "string") {
      const text = compactText(value, key === "title" || key === "label" ? 160 : 80);
      if (text) compacted[key] = text;
    } else if (typeof value === "number") {
      compacted[key] = value;
    }
  }
  return compacted;
}

function normalizeSourceRefs(
  input: AIActionDraftGenerationPromptInput
): NonNullable<AIActionDraftLightweightContext["sourceRefs"]> {
  const explicitRefs = input.lightweightContext?.sourceRefs ?? [];
  const promptPackageRefs = (input.sourceRefs ?? []).map((sourceRef) => ({
    sourceType: "aiContext",
    id: sanitize(sourceRef.entityId),
    title: sanitize(sourceRef.label),
    label: [
      sourceRef.module,
      sourceRef.entityType,
      sourceRef.field
    ].filter(Boolean).join("/")
  }));
  return [...explicitRefs, ...promptPackageRefs]
    .map((sourceRef) => ({
      sourceType: compactText(sourceRef.sourceType, 80) ?? "unknown",
      id: compactText(sourceRef.id, 120) ?? "",
      title: compactText(sourceRef.title, 160),
      label: compactText(sourceRef.label, 160)
    }))
    .filter((sourceRef) => sourceRef.id || sourceRef.title || sourceRef.label)
    .slice(0, 15);
}

function buildLightweightContextPayload(
  input: AIActionDraftGenerationPromptInput,
  project: AIActionDraftGenerationProjectSummary
): Record<string, unknown> {
  const context = input.lightweightContext ?? {};
  return {
    project: compactItem(project),
    routeNodes: (context.routeNodes ?? []).slice(0, 8).map(compactItem),
    tasks: (context.tasks ?? []).slice(0, 15).map(compactItem),
    outputGaps: (context.outputGaps ?? []).slice(0, 8).map(compactItem),
    sourceRefs: normalizeSourceRefs(input)
  };
}

export function buildAIActionDraftContractPrompt(maxDrafts = 3): string {
  const cappedMaxDrafts = Math.max(0, Math.min(3, Math.floor(maxDrafts || 3)));
  return `AIActionDraft 结构化翻译字典（以当前 TypeScript 类型、parser、manager、executor 和 apply adapters 为准，不从历史 md 读取）：

1. 根对象必须是 {"drafts":[...]}。只输出可解析 JSON，不输出 Markdown、代码围栏、解释或前后缀。
2. 最多生成 ${cappedMaxDrafts} 条；不确定就少生成或输出 {"drafts":[]}；不要为了凑数生成草稿。
3. 每条草稿使用字段：draftType、title、summary、detail、target、proposedPayload、sourceRefs。
4. sourceRefs 只能引用 prompt 中给出的来源；不能编造来源、实体 ID 或本地文件内容。rationale/reason 只能解释普通回答中已有建议为什么被转译。
5. 每条草稿必须绑定当前 projectId；存在 proposedPayload.projectId 字段的类型必须写入当前 projectId。
6. AI 只生成建议草稿，不写入 LabPod；用户仍需接受、预览并明确确认写入。

优先生成：
- task_create：把普通回答中明确出现的下一步行动转成新任务。proposedPayload 核心字段：projectId、title、description、priority、status、taskType、timeBucket、routeNodeId、sourceOutputGapId。不要生成 task_update。
- review_candidate：把普通回答中明确适合作为复盘候选文稿的内容转成 Markdown Candidate 预览。proposedPayload 核心字段：projectId、reviewId、candidateMarkdown、suggestedSummary、suggestedWarnings、suggestedNextActionsText、suggestedQuestions、suggestedTargetNotes。只有普通回答或来源摘要明确指向 reviewId 时才生成；确认后只新建 non-current Candidate，不能修改 Review、outlineSections、targets、current、EntityLink、Task 或 OutputGap。
- output_gap_create：把普通回答中明确指出的成果缺口转成新缺口草稿。proposedPayload 核心字段：projectId、outputCandidateId、title、description、gapType、priority、status。只有明确 outputCandidateId 时才生成；不能关闭或修改已有 OutputGap。

谨慎保留：
- output_candidate_create：只在普通回答明确提出候选成果且有足够来源 ID 时生成。proposedPayload 核心字段：projectId、title、summary、description、candidateType、status、findingIds / linkedFindingIds / resultItemIds / linkedResultItemIds / linkedAssetIds。status 不能是 converted 或 archived；不能生成 Formal Output。
- entity_link_create：只在普通回答明确说明一个单一关系且 source/target ID 都可靠时生成。proposedPayload 核心字段：sourceType、sourceId、targetType、targetId、relationType。不能批量关联。

禁止生成：
${FORBIDDEN_DRAFT_TYPES.map((draftType) => `- ${draftType}`).join("\n")}`;
}

export function buildAIActionDraftGenerationPrompt(
  input: AIActionDraftGenerationPromptInput
): string {
  const project: AIActionDraftGenerationProjectSummary = {
    id: sanitize(input.project?.id ?? input.projectId).trim(),
    title: sanitize(input.project?.title ?? input.projectTitle).trim(),
    status: compactText(input.project?.status, 80)
  };
  const originalUserQuestion = compactText(input.originalUserQuestion ?? input.userQuestion, 4_000);
  const ordinaryAIResponse = compactText(input.ordinaryAIResponse ?? input.ordinaryAnswer, 12_000);
  if (!project.id || !originalUserQuestion || !ordinaryAIResponse) {
    throw new Error("Project, original user question, and ordinary AI response are required.");
  }

  const maxDrafts = Math.max(0, Math.min(3, Math.floor(input.maxDrafts ?? 3)));
  const allowedDraftTypes = (input.allowedDraftTypes?.length
    ? input.allowedDraftTypes
    : DEFAULT_ALLOWED_DRAFT_TYPES
  ).filter((draftType) => !FORBIDDEN_DRAFT_TYPES.includes(draftType));
  const lightweightContext = buildLightweightContextPayload(input, project);
  const contract = buildAIActionDraftContractPrompt(maxDrafts);

  const prompt = `你是 LabPod 的 AIActionDraft 结构化转译器。

任务定位：
- 你不是在重新分析科研项目。
- 你不是在扩展新的科研建议。
- 你是在把用户已经认可的普通 AI 回答转译成 LabPod 可解析的 AIActionDraft JSON。
- 只能基于第一次普通 AI 回答中已经明确出现的可操作建议生成草稿。
- 不要添加普通回答中没有的新任务、新缺口、新发现、新候选成果或新关系。
- 不确定时少生成或不生成；不要为了凑数生成草稿。

输出硬规则：
- 只输出 JSON。
- 不要输出 Markdown。
- 不要输出代码围栏。
- 不要输出解释性文字。
- 最多生成 ${maxDrafts} 条。
- 允许 draftType：${allowedDraftTypes.join(", ")}。
- 优先 draftType：${PRIORITY_DRAFT_TYPES.join(", ")}。
- 禁止 draftType：${FORBIDDEN_DRAFT_TYPES.join(", ")}。
- AI 只生成建议草稿，不写入 LabPod；用户仍需接受、预览并明确确认写入。

${contract}

当前课题：
${JSON.stringify(compactItem(project), null, 2)}

用户第一次问题 originalUserQuestion：
${originalUserQuestion}

第一次普通 AI 回答 ordinaryAIResponse：
${ordinaryAIResponse}

轻量实体/来源摘要（仅用于绑定标题、ID 和来源，不用于重新科研分析）：
${JSON.stringify(lightweightContext, null, 2)}

再次强调：不要使用完整 ProjectResearchContext、Context Preview Markdown 或大段 route/task/experiment/literature/output 上下文重新分析课题。只转译 ordinaryAIResponse 中已经明确出现的建议。`;

  if (Array.from(prompt).length > AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS) {
    throw new Error("Structured action draft prompt exceeds the application character limit.");
  }
  return prompt;
}
