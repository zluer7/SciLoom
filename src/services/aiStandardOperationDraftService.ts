import type {
  AIStandardResult,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { ReviewOutlineSectionKey } from "../types/planning";
import { REVIEW_OUTLINE_TEMPLATES } from "./reviewCoreContractService";
import { REVIEW_OUTLINE_FIELD_LABELS } from "./manuscriptOutlineDescriptorRegistry";

type DraftFieldKind = "text" | "list" | "boolean" | "integer" | "authors" | "date" | "dateTime";

type DraftFieldSpec = {
  key: string;
  label: string;
  aliases?: readonly string[];
  payloadGroupKey?: "literature_outline" | "dedicated_notes";
  editorVisible?: boolean;
  structuredKey?: string;
  reviewOutlineKey?: ReviewOutlineSectionKey;
  kind?: DraftFieldKind;
  enumValues?: readonly string[];
  enumAliases?: Readonly<Record<string, string>>;
  always?: boolean;
};

export type AIStandardOperationDraftProjection = {
  text: string;
  editable: boolean;
  bindingSummary: string;
};

export type AIStandardOperationDraftInterpretation = {
  payload: Record<string, unknown>;
  normalizedText: string;
  unknownSafeSections: string[];
};

export type AIStandardOperationProposalPayloadRead = {
  payload: Record<string, unknown>;
  nonBlockingIssues: AIStandardResultValidationIssue[];
  unknownSafeSections: string[];
};

export class AIStandardOperationDraftInterpretationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues[0] ?? "草稿内容需要调整后才能确认。");
    this.name = "AIStandardOperationDraftInterpretationError";
  }
}

const COMMON_ENUM_LABELS: Record<string, string> = {
  planned: "计划中", active: "进行中", paused: "已暂停", adjusted: "已调整",
  running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消",
  todo: "待办", doing: "进行中", delayed: "已延期", blocked: "受阻",
  high: "高", medium: "中", low: "低", uncertain: "不确定",
  stage: "阶段复盘", periodic: "定期复盘", experiment_comparison: "实验对比复盘",
  literature_comparison: "文献对比复盘", custom: "自定义复盘",
  reading: "文献阅读", experiment: "实验", coding: "编程", writing: "写作",
  analysis: "分析", meeting: "会议", idea: "想法", review: "复盘", other: "其他",
  today: "今天", this_week: "本周", this_month: "本月", long_term: "长期", none: "未指定",
  literature: "文献", algorithm: "算法", output: "成果", day: "日", week: "周",
  month: "月", quarter: "季度", phase: "阶段", free: "自由说明",
  excellent: "优秀", good: "良好", usable: "可用", inconclusive: "结论不明确",
  phenomenon: "现象", comparison: "对比", method: "方法", limitation: "局限",
  evidence: "证据", hypothesis: "假设", negative_result: "负向结果",
  unread: "未读", skimmed: "已浏览", intensive_read: "精读完成", summarized: "已总结",
  reused: "已复用", discarded: "已放弃", archived: "已归档",
  core: "核心", important: "重要", useful: "有用", background: "背景资料"
};

const ENUM_VALUE_BY_LABEL = new Map<string, string>();
for (const [value, label] of Object.entries(COMMON_ENUM_LABELS)) {
  ENUM_VALUE_BY_LABEL.set(label, value);
  ENUM_VALUE_BY_LABEL.set(value, value);
}

const ROUTE_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "路线名称", "路线标题"], always: true },
  { key: "description", label: "说明", aliases: ["路线说明", "描述"], always: true },
  { key: "objective", label: "目标", aliases: ["路线目标"], always: true },
  { key: "expectedOutput", label: "预期输出", aliases: ["预期成果"], always: true },
  { key: "nodeType", label: "路线类型", aliases: ["类型"], enumValues: ["literature", "experiment", "algorithm", "analysis", "writing", "output", "review", "other"] },
  { key: "status", label: "状态", enumValues: ["planned", "active", "paused", "adjusted"] },
  { key: "startDate", label: "开始日期", kind: "date" }, { key: "endDate", label: "结束日期", kind: "date" },
  { key: "timeLabel", label: "时间说明" }, { key: "timePrecision", label: "时间精度", enumValues: ["day", "week", "month", "quarter", "phase", "free"] },
  { key: "showInGantt", label: "路线图展示", kind: "boolean" },
  { key: "tags", label: "标签", kind: "list" }
];

const TASK_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "任务名称", "任务标题"], always: true },
  { key: "description", label: "说明", aliases: ["任务说明", "描述"], always: true },
  { key: "priority", label: "优先级", enumValues: ["high", "medium", "low"] },
  { key: "status", label: "状态", enumValues: ["todo", "doing", "delayed", "blocked", "cancelled"], enumAliases: { planned: "todo", pending: "todo", active: "doing", inprogress: "doing", paused: "delayed" } },
  { key: "taskType", label: "任务类型", aliases: ["类型"], enumValues: ["reading", "experiment", "coding", "writing", "analysis", "meeting", "idea", "review", "other"] },
  { key: "timeBucket", label: "时间范围", enumValues: ["today", "this_week", "this_month", "long_term", "none"] },
  { key: "scheduledDate", label: "计划日期", kind: "date" },
  { key: "dueDate", label: "截止日期", kind: "date" }, { key: "timeLabel", label: "时间说明" },
  { key: "acceptanceCriteria", label: "完成标准", aliases: ["验收标准"], always: true },
  { key: "blockedReason", label: "受阻原因" }, { key: "tags", label: "标签", kind: "list" }
];

const REVIEW_OUTLINE_FIELDS: readonly DraftFieldSpec[] = [...new Set(
  Object.values(REVIEW_OUTLINE_TEMPLATES).flat()
)].map((key) => ({
  key,
  label: REVIEW_OUTLINE_FIELD_LABELS[key],
  reviewOutlineKey: key
}));

const REVIEW_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "复盘名称", "复盘标题"], always: true },
  { key: "description", label: "复盘说明", aliases: ["说明", "描述", "其他说明"], always: true },
  { key: "reviewType", label: "复盘类型", aliases: ["类型"], enumValues: ["stage", "periodic", "experiment_comparison", "literature_comparison", "custom"], always: true },
  { key: "periodStart", label: "开始日期", aliases: ["周期开始", "复盘开始"], kind: "date" },
  { key: "periodEnd", label: "结束日期", aliases: ["周期结束", "复盘结束"], kind: "date" },
  { key: "periodLabel", label: "周期说明", aliases: ["周期", "时间范围"] },
  ...REVIEW_OUTLINE_FIELDS,
  { key: "tags", label: "标签", kind: "list" }
];

const EXPERIMENT_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "实验名称", "实验标题"], always: true },
  { key: "purposeAndQuestion", label: "目的与问题", aliases: ["目的", "问题", "实验说明"], always: true },
  { key: "conditionSummary", label: "条件", aliases: ["条件摘要", "实验条件"], always: true },
  { key: "methodSummary", label: "方法摘要", aliases: ["方法", "实验方法"], always: true },
  { key: "resultSummary", label: "结果摘要", aliases: ["结果", "实验结果"], always: true },
  { key: "conclusionAndNextSteps", label: "结论与下一步", aliases: ["结论", "下一步"], always: true },
  { key: "other", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "status", label: "状态", enumValues: ["planned", "running", "completed", "paused", "failed"] },
  { key: "rating", label: "评价", enumValues: ["excellent", "good", "usable", "inconclusive", "failed"] },
  { key: "usableForPaper", label: "可用于论文", kind: "boolean" },
  { key: "usableForReport", label: "可用于报告", kind: "boolean" },
  { key: "usableForPatent", label: "可用于专利", kind: "boolean" },
  { key: "tags", label: "标签", kind: "list" }
];

const EXPERIMENT_RUN_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "运行名称"], always: true },
  { key: "runLabel", label: "运行标记" },
  { key: "status", label: "状态", enumValues: ["planned", "running", "completed", "paused", "failed", "cancelled"] },
  { key: "startedAt", label: "开始时间", kind: "dateTime" }, { key: "completedAt", label: "结束时间", kind: "dateTime" },
  { key: "conditionSummary", label: "条件", aliases: ["条件摘要"], always: true },
  { key: "variableParameterSummary", label: "变量与参数", aliases: ["参数"], always: true },
  { key: "methodSummary", label: "方法摘要", aliases: ["方法"], always: true },
  { key: "resultSummary", label: "结果摘要", aliases: ["结果"], always: true },
  { key: "conclusion", label: "结论", always: true },
  { key: "summaryOther", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "rating", label: "评价", enumValues: ["excellent", "good", "usable", "inconclusive", "failed"] }, { key: "tags", label: "标签", kind: "list" }
];

const LITERATURE_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "文献标题"], always: true },
  { key: "authors", label: "作者", kind: "authors", always: true },
  { key: "year", label: "年份", kind: "integer" }, { key: "venue", label: "发表来源" },
  { key: "publicationType", label: "文献类型", aliases: ["类型"], enumValues: ["journal_article", "conference_paper", "review", "book", "book_chapter", "thesis", "patent", "standard", "technical_report", "preprint", "dataset", "software", "webpage", "other"], enumAliases: { journalarticle: "journal_article", conferencepaper: "conference_paper", bookchapter: "book_chapter", technicalreport: "technical_report", "期刊论文": "journal_article", "会议论文": "conference_paper", "综述": "review", "专利": "patent", "预印本": "preprint" } },
  { key: "abstract", label: "摘要", always: true },
  { key: "keywords", label: "关键词", kind: "list" }, { key: "doi", label: "DOI" },
  { key: "readingStatus", label: "阅读状态", enumValues: ["unread", "skimmed", "reading", "intensive_read", "summarized", "reused", "discarded", "archived"] },
  { key: "importance", label: "重要性", enumValues: ["core", "important", "useful", "background", "low", "uncertain"] },
  { key: "tags", label: "标签", kind: "list" },
  // The objective-outline summary is the same canonical Literature.abstract
  // truth already projected above. Keep the Provider carrier readable, but do
  // not expose a second editable copy in the one-detail experience.
  { key: "summary", label: "客观纲要 · 摘要", payloadGroupKey: "literature_outline", editorVisible: false },
  { key: "research_problem", label: "客观纲要 · 研究问题", payloadGroupKey: "literature_outline", always: true },
  { key: "application_object", label: "客观纲要 · 应用对象", payloadGroupKey: "literature_outline", always: true },
  { key: "method_overview", label: "客观纲要 · 方法概要", payloadGroupKey: "literature_outline", always: true },
  { key: "main_conclusion", label: "客观纲要 · 主要结论", payloadGroupKey: "literature_outline", always: true },
  { key: "limitations", label: "客观纲要 · 局限性", payloadGroupKey: "literature_outline", always: true },
  { key: "other", label: "客观纲要 · 其他", payloadGroupKey: "literature_outline", always: true },
  { key: "summary", label: "专属笔记纲要 · 摘要", payloadGroupKey: "dedicated_notes", always: true },
  { key: "project_relevance", label: "专属笔记纲要 · 课题相关度建议", payloadGroupKey: "dedicated_notes", always: true },
  { key: "related_objects", label: "专属笔记纲要 · 关联对象", payloadGroupKey: "dedicated_notes", always: true },
  { key: "reusable_methods", label: "专属笔记纲要 · 可借鉴方法", payloadGroupKey: "dedicated_notes", always: true },
  { key: "comparable_conclusions", label: "专属笔记纲要 · 可对比结论", payloadGroupKey: "dedicated_notes", always: true },
  { key: "other", label: "专属笔记纲要 · 其他", payloadGroupKey: "dedicated_notes", always: true }
];

const FINDING_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "发现名称", "发现标题"], always: true },
  { key: "summary", label: "发现摘要", aliases: ["摘要", "说明"], always: true },
  { key: "supportingEvidence", structuredKey: "supportingEvidence", label: "支撑证据", always: true },
  { key: "noveltyDifference", structuredKey: "noveltyDifference", label: "新颖性或差异", always: true },
  { key: "reliabilityJudgement", structuredKey: "reliabilityJudgement", label: "可靠性判断", always: true },
  { key: "boundaryOrMissingEvidence", structuredKey: "boundaryOrMissingEvidence", label: "边界或缺失证据", always: true },
  { key: "other", structuredKey: "other", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "findingType", label: "发现类型", aliases: ["类型"], enumValues: ["phenomenon", "comparison", "method", "limitation", "evidence", "hypothesis", "negative_result", "other"] },
  { key: "confidence", label: "可信程度", enumValues: ["high", "medium", "low", "uncertain"] }, { key: "maturity", label: "成熟程度", enumValues: ["high", "medium", "low", "uncertain"] },
  { key: "tags", label: "标签", kind: "list" }
];

const RESULT_ITEM_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "结果名称", "结果资产名称"], always: true },
  { key: "summary", label: "结果摘要", aliases: ["摘要", "说明"], always: true },
  { key: "keyPhenomenon", structuredKey: "keyPhenomenon", label: "关键指标或现象", always: true },
  { key: "conditionBrief", structuredKey: "conditionBrief", label: "条件简述", always: true },
  { key: "initialJudgement", structuredKey: "initialJudgement", label: "初步判断", always: true },
  { key: "conversionValue", structuredKey: "conversionValue", label: "转化价值", always: true },
  { key: "other", structuredKey: "other", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "resultType", label: "结果类型", enumValues: ["data", "figure", "table", "metric", "code", "model", "log", "text", "sample", "case", "document", "other"] },
  { key: "status", label: "状态", enumValues: ["pending_review", "marked", "ignored"] },
  { key: "value", label: "结果值" }, { key: "unit", label: "单位" },
  { key: "isAsset", label: "标记为结果资产", kind: "boolean" },
  { key: "assetReason", label: "资产理由" },
  { key: "assetQuality", label: "资产质量", enumValues: ["high", "medium", "low", "uncertain"] },
  { key: "usableFor", label: "可用于", kind: "list" }, { key: "tags", label: "标签", kind: "list" }
];

const OUTPUT_CANDIDATE_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "候选成果名称"], always: true },
  { key: "description", label: "候选成果说明", aliases: ["摘要", "说明", "核心主张"], always: true },
  { key: "structuredOutputType", structuredKey: "outputType", label: "成果类型说明", always: true },
  { key: "innovationContribution", structuredKey: "innovationContribution", label: "创新贡献", always: true },
  { key: "evidenceSummary", structuredKey: "evidenceSummary", label: "证据摘要", always: true },
  { key: "risksAndGaps", structuredKey: "risksAndGaps", label: "风险与缺口", always: true },
  { key: "other", structuredKey: "other", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "candidateType", label: "标准候选类型", aliases: ["候选类型"], enumValues: ["paper", "patent", "report", "dataset", "software", "method", "model", "caseStudy", "presentation", "futureProject", "other"] },
  { key: "status", label: "状态", enumValues: ["pending_evaluation", "needs_gap_resolution", "ready_for_formal", "converted"] },
  { key: "maturity", label: "成熟程度", enumValues: ["low", "medium", "high"] },
  { key: "priority", label: "优先级", enumValues: ["high", "medium", "low"] },
  { key: "tags", label: "标签", kind: "list" }
];

const OUTPUT_GAP_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "成果缺口名称"], always: true },
  { key: "description", label: "缺口说明", aliases: ["摘要", "说明", "缺口描述"], always: true },
  { key: "structuredGapType", structuredKey: "gapType", label: "缺口类型说明", always: true },
  { key: "affectedObject", structuredKey: "affectedObject", label: "受影响对象", always: true },
  { key: "strengtheningPlan", structuredKey: "strengtheningPlan", label: "补强计划", always: true },
  { key: "completionCriteria", structuredKey: "completionCriteria", label: "完成标准", always: true },
  { key: "other", structuredKey: "other", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "gapType", label: "标准缺口分类", enumValues: ["data", "analysis", "validation", "figure", "theory", "literature", "writing", "experiment", "code", "other"] },
  { key: "status", label: "状态", enumValues: ["pending", "task_created", "route_feedback_created", "resolved", "abandoned"] },
  { key: "priority", label: "优先级", enumValues: ["high", "medium", "low"] }
];

const RESEARCH_OUTPUT_FIELDS: readonly DraftFieldSpec[] = [
  { key: "title", label: "名称", aliases: ["标题", "正式成果名称", "成果名称"], always: true },
  { key: "description", label: "成果说明", aliases: ["摘要", "说明"], always: true },
  { key: "structuredOutputType", structuredKey: "outputType", label: "成果类型说明", always: true },
  { key: "coreContribution", structuredKey: "coreContribution", label: "核心贡献", always: true },
  { key: "sourceChainSummary", structuredKey: "sourceChainSummary", label: "来源链摘要", always: true },
  { key: "archiveUsage", structuredKey: "archiveUsage", label: "归档用途", always: true },
  { key: "other", structuredKey: "other", label: "其他说明", aliases: ["备注", "补充说明"], always: true },
  { key: "outputType", label: "标准成果分类", enumValues: ["figure", "table", "dataset", "result", "note", "report", "paper_draft", "presentation", "code", "other"] },
  { key: "status", label: "状态", enumValues: ["draft", "organizing", "archived"] },
  { key: "usableForPaper", label: "可用于论文", kind: "boolean" }
];

const OUTPUT_MODULES = new Set([
  "resultItem", "finding", "outputCandidate", "outputGap", "researchOutput"
]);

const DELETE_FIELDS: readonly DraftFieldSpec[] = [
  { key: "reason", label: "删除理由", aliases: ["理由", "原因", "建议理由"], always: true }
];

const MANUSCRIPT_FIELDS: readonly DraftFieldSpec[] = [
  { key: "body", label: "候选文稿", aliases: ["文稿", "正文"], always: true }
];

const HIDDEN_ALLOWED_FIELDS: Record<string, readonly string[]> = {
  route: [],
  task: ["routeNodeId"],
  review: ["outlineSections", "targets"],
  experiment: ["routeId", "taskId"],
  experimentRun: [
    "routeId", "taskId", "conditionItems", "methodSteps", "variables", "materials", "customFields"
  ],
  literature: [],
  resultItem: ["structuredSummary"],
  finding: ["routeId", "taskId", "experimentId", "resultItemIds", "structuredSummary"],
  outputCandidate: ["structuredSummary"],
  outputGap: ["structuredSummary"],
  researchOutput: ["structuredSummary"]
};

const MACHINE_BINDING_LABELS = new Set([
  "关联路线", "关联路线id", "路线id", "关联任务", "关联任务id", "任务id",
  "关联实验", "关联实验id", "实验id", "目标id", "对象id", "课题id", "项目id",
  "owner", "ownerid", "entityid", "projectid", "channel", "manuscriptchannel"
].map((value) => normalizeLabel(value)));

function normalizeLabel(value: string): string {
  return value
    .replace(/^\s*(?:#{1,6}|[-*+]\s*|\d+[.)、]\s*)/u, "")
    .replace(/[\s_()（）\[\]【】]/gu, "")
    .toLocaleLowerCase();
}

function fieldsFor(result: Pick<AIStandardResult, "action" | "target">): readonly DraftFieldSpec[] {
  if (result.action === "DELETE_SUGGESTION") return DELETE_FIELDS;
  if (result.action === "NEW_MANUSCRIPT") return MANUSCRIPT_FIELDS;
  if (result.target.module === "route") return ROUTE_FIELDS;
  if (result.target.module === "task") return TASK_FIELDS;
  if (result.target.module === "review") return REVIEW_FIELDS;
  if (result.target.module === "experiment") return EXPERIMENT_FIELDS;
  if (result.target.module === "experimentRun") return EXPERIMENT_RUN_FIELDS;
  if (result.target.module === "literature") return LITERATURE_FIELDS;
  if (result.target.module === "resultItem") return RESULT_ITEM_FIELDS;
  if (result.target.module === "finding") return FINDING_FIELDS;
  if (result.target.module === "outputCandidate") return OUTPUT_CANDIDATE_FIELDS;
  if (result.target.module === "outputGap") return OUTPUT_GAP_FIELDS;
  if (result.target.module === "researchOutput") return RESEARCH_OUTPUT_FIELDS;
  return [];
}

function safeSinkFor(result: Pick<AIStandardResult, "action" | "target">): string | undefined {
  if (result.action === "NEW_MANUSCRIPT") return "body";
  if (result.action === "DELETE_SUGGESTION") return "reason";
  if (result.target.module === "experiment") return "other";
  if (result.target.module === "experimentRun") return "summaryOther";
  if (result.target.module === "route" || result.target.module === "task" || result.target.module === "review") {
    return "description";
  }
  if (["resultItem", "finding", "outputCandidate", "outputGap", "researchOutput"].includes(result.target.module)) {
    return "other";
  }
  if (result.target.module === "literature") return "abstract";
  return undefined;
}

function displayScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return COMMON_ENUM_LABELS[value] ?? value;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return value.join("、");
    const authors = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const name = (item as Record<string, unknown>).name;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    });
    return authors.join("、");
  }
  return "";
}

function appendText(existing: unknown, addition: string): string {
  const current = typeof existing === "string" ? existing.trim() : "";
  const next = addition.trim();
  return [current, next].filter(Boolean).join(current && next ? "\n\n" : "");
}

const MACHINE_PAYLOAD_KEYS = new Set([
  "projectid", "entityid", "ownerid", "ownertype", "channel", "manuscriptchannel",
  "bindingid", "filerefid", "authorizationid", "resultid", "operationid", "id",
  "manuscripteffects"
]);

const MODULE_WIRE_ALIASES: Record<string, Readonly<Record<string, string>>> = {
  route: {
    name: "title", routename: "title", details: "description", goal: "objective",
    expectedresult: "expectedOutput", expectedoutcome: "expectedOutput", type: "nodeType"
  },
  task: {
    name: "title", taskname: "title", details: "description", type: "taskType",
    deadline: "dueDate", criteria: "acceptanceCriteria", completioncriteria: "acceptanceCriteria",
    routeid: "routeNodeId"
  },
  review: {
    name: "title", reviewname: "title", type: "reviewType", summary: "description",
    summaryother: "description", notes: "description", note: "description", content: "description", period: "periodLabel",
    outline: "outlineSections", sections: "outlineSections", relations: "targets"
  },
  experiment: {
    name: "title", experimentname: "title", description: "purposeAndQuestion",
    purpose: "purposeAndQuestion", question: "purposeAndQuestion", conditions: "conditionSummary",
    method: "methodSummary", result: "resultSummary", conclusion: "conclusionAndNextSteps",
    nextsteps: "conclusionAndNextSteps", notes: "other", note: "other"
  },
  experimentRun: {
    name: "title", runname: "title", description: "summaryOther", conditions: "conditionSummary",
    parameters: "variableParameterSummary", method: "methodSummary", result: "resultSummary",
    conclusionnotes: "conclusion", conclusionandnextsteps: "conclusion",
    notes: "summaryOther", note: "summaryOther", other: "summaryOther"
  },
  literature: {
    name: "title", author: "authors", source: "venue", journal: "venue",
    type: "publicationType", description: "abstract", summary: "abstract", notes: "abstract"
  },
  finding: {
    name: "title", description: "summary", type: "findingType", confidencelevel: "confidence",
    maturitylevel: "maturity"
  },
  resultItem: {
    name: "title", resultname: "title", description: "summary"
  },
  outputCandidate: {
    name: "title", candidatename: "title", summary: "description", coreclaim: "description"
  },
  outputGap: {
    name: "title", gapname: "title", summary: "description", gapdescription: "description"
  },
  researchOutput: {
    name: "title", outputname: "title", summary: "description"
  }
};

function payloadFieldMap(
  result: Pick<AIStandardResult, "action" | "target">
): Map<string, DraftFieldSpec> {
  const map = new Map<string, DraftFieldSpec>();
  for (const field of fieldsFor(result)) {
    if (field.payloadGroupKey) continue;
    for (const candidate of [field.key, field.label, ...(field.aliases ?? [])]) {
      map.set(normalizeLabel(candidate), field);
    }
  }
  return map;
}

function payloadGroupFieldMap(
  result: Pick<AIStandardResult, "action" | "target">,
  groupKey: string
): Map<string, DraftFieldSpec> {
  return new Map(fieldsFor(result)
    .filter((field) => field.payloadGroupKey === groupKey)
    .map((field) => [normalizeLabel(field.key), field]));
}

function boundedSafeText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  const normalized = text.replace(/\0/gu, "").trim();
  return normalized ? Array.from(normalized).slice(0, 8_000).join("") : undefined;
}

function coerceProposalFieldValue(field: DraftFieldSpec, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (field.kind === "list") {
    const values = Array.isArray(value) ? value : typeof value === "string" ? parseList(value) : [];
    const strings = values.flatMap((candidate) => {
      const text = boundedSafeText(candidate);
      return text ? [text] : [];
    });
    return strings.length > 0 ? [...new Set(strings)] : undefined;
  }
  if (field.kind === "authors") {
    const candidates = Array.isArray(value) ? value : [value];
    const authors = candidates.flatMap((candidate) => {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const name = boundedSafeText((candidate as Record<string, unknown>).name);
        return name ? [{ name }] : [];
      }
      const names = typeof candidate === "string" ? parseList(candidate) : [];
      return names.map((name) => ({ name }));
    });
    return authors.length > 0 ? authors : [];
  }
  if (field.kind === "boolean") {
    if (typeof value === "boolean") return value;
    const text = boundedSafeText(value)?.toLocaleLowerCase();
    if (text && ["是", "可", "可以", "true", "yes"].includes(text)) return true;
    if (text && ["否", "不可", "不可以", "false", "no"].includes(text)) return false;
    return undefined;
  }
  if (field.kind === "integer") {
    if (Number.isSafeInteger(value)) return value;
    const text = boundedSafeText(value);
    return text && /^-?\d+$/u.test(text) ? Number(text) : undefined;
  }
  if (field.kind === "date") {
    const text = boundedSafeText(value);
    if (!text || !/^\d{4}-\d{2}-\d{2}$/u.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
      return undefined;
    }
    return text;
  }
  if (field.kind === "dateTime") {
    const text = boundedSafeText(value);
    return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
  }
  const text = boundedSafeText(value);
  if (!text) return undefined;
  const canonical = ENUM_VALUE_BY_LABEL.get(text) ?? field.enumAliases?.[normalizeLabel(text)] ?? text;
  return !field.enumValues || field.enumValues.includes(canonical) ? canonical : undefined;
}

function appendUnknownSection(
  sections: string[],
  key: string,
  value: unknown
): boolean {
  const text = boundedSafeText(value);
  if (!text) return false;
  sections.push(`${key}：${text}`);
  return true;
}

function structuredDraftValue(payload: Record<string, unknown>, key: string): unknown {
  const raw = payload.structuredSummary;
  if (Array.isArray(raw)) {
    const section = raw.find((candidate) => (
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).key === key
    ));
    return section && typeof section === "object"
      ? (section as Record<string, unknown>).value
      : undefined;
  }
  if (raw !== null && typeof raw === "object") {
    return (raw as Record<string, unknown>)[key];
  }
  return undefined;
}

function readDraftFieldValue(payload: Record<string, unknown>, field: DraftFieldSpec): unknown {
  if (field.payloadGroupKey) {
    const group = payload[field.payloadGroupKey];
    return group !== null && typeof group === "object" && !Array.isArray(group)
      ? (group as Record<string, unknown>)[field.key]
      : undefined;
  }
  if (field.reviewOutlineKey) {
    const outline = payload.outlineSections;
    if (Array.isArray(outline)) {
      const section = outline.find((candidate) => (
        candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).key === field.reviewOutlineKey
      ));
      return section && typeof section === "object"
        ? (section as Record<string, unknown>).content
        : undefined;
    }
    if (outline !== null && typeof outline === "object") {
      return (outline as Record<string, unknown>)[field.reviewOutlineKey];
    }
    return undefined;
  }
  if (!field.structuredKey) return payload[field.key];
  const nested = structuredDraftValue(payload, field.structuredKey);
  if (nested !== undefined) return nested;
  return payload[field.key];
}

function writeDraftFieldValue(
  payload: Record<string, unknown>,
  field: DraftFieldSpec,
  value: unknown
) {
  if (field.payloadGroupKey) {
    const raw = payload[field.payloadGroupKey];
    const group = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? structuredClone(raw as Record<string, unknown>)
      : {};
    group[field.key] = value;
    payload[field.payloadGroupKey] = group;
    return;
  }
  if (field.reviewOutlineKey) {
    const current = Array.isArray(payload.outlineSections)
      ? payload.outlineSections
      : [];
    let replaced = false;
    const next = current.flatMap((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const section = candidate as Record<string, unknown>;
      if (section.key !== field.reviewOutlineKey) return [structuredClone(section)];
      replaced = true;
      return [{ key: field.reviewOutlineKey, content: value }];
    });
    if (!replaced) next.push({ key: field.reviewOutlineKey, content: value });
    payload.outlineSections = next;
    return;
  }
  if (!field.structuredKey) {
    payload[field.key] = value;
    return;
  }
  const raw = payload.structuredSummary;
  if (Array.isArray(raw)) {
    let replaced = false;
    payload.structuredSummary = raw.map((candidate) => {
      if (
        candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).key === field.structuredKey
      ) {
        replaced = true;
        return { ...(candidate as Record<string, unknown>), value };
      }
      return structuredClone(candidate);
    });
    if (!replaced) {
      (payload.structuredSummary as unknown[]).push({ key: field.structuredKey, value });
    }
    return;
  }
  const structured = raw !== null && typeof raw === "object"
    ? structuredClone(raw as Record<string, unknown>)
    : {};
  structured[field.structuredKey] = value;
  payload.structuredSummary = structured;
}

function appendDraftFieldText(
  payload: Record<string, unknown>,
  field: DraftFieldSpec,
  addition: string
) {
  writeDraftFieldValue(payload, field, appendText(readDraftFieldValue(payload, field), addition));
}

/**
 * The single tolerant proposal reader used before owner adapters. It only
 * canonicalizes wording and preserves safe text; target/scope authority stays
 * in the typed target and canonical adapter.
 */
export function readAIStandardOperationProposalPayload(input: {
  action: AIStandardResult["action"];
  target: AIStandardResult["target"];
  payload: unknown;
}): AIStandardOperationProposalPayloadRead {
  const source = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : {};
  const unknownSafeSections: string[] = [];
  const nonBlockingIssues: AIStandardResultValidationIssue[] = [];

  if (input.action === "NEW_MANUSCRIPT") {
    let body = typeof source.body === "string" ? boundedSafeText(source.body) : undefined;
    for (const [key, value] of Object.entries(source)) {
      if (key === "body" || MACHINE_PAYLOAD_KEYS.has(normalizeLabel(key))) continue;
      const text = boundedSafeText(value);
      if (!text) continue;
      const addition = ["content", "markdown", "manuscript", "draft", "text"].includes(normalizeLabel(key))
        ? text
        : `${key}：${text}`;
      unknownSafeSections.push(addition);
      body = appendText(body, addition);
    }
    return {
      payload: body ? { body } : {},
      nonBlockingIssues,
      unknownSafeSections
    };
  }

  if (input.action === "DELETE_SUGGESTION") {
    let reason = boundedSafeText(source.reason);
    for (const [key, value] of Object.entries(source)) {
      if (key === "reason" || MACHINE_PAYLOAD_KEYS.has(normalizeLabel(key))) continue;
      const text = boundedSafeText(value);
      if (!text) continue;
      unknownSafeSections.push(`${key}：${text}`);
      reason = appendText(reason, text);
    }
    return {
      payload: { reason: reason ?? "请到对应业务条目复核后决定是否删除。" },
      nonBlockingIssues,
      unknownSafeSections
    };
  }

  const result = { action: input.action, target: input.target };
  const fields = payloadFieldMap(result);
  const aliases = MODULE_WIRE_ALIASES[input.target.module] ?? {};
  const hiddenAllowed = new Set(HIDDEN_ALLOWED_FIELDS[input.target.module] ?? []);
  const normalized: Record<string, unknown> = {};
  let recognizedCoreCount = 0;
  let unreadableCoreCount = 0;
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = normalizeLabel(key);
    if (MACHINE_PAYLOAD_KEYS.has(normalizedKey)) continue;
    const aliasKey = aliases[normalizedKey] ?? key;
    const groupedFields = payloadGroupFieldMap(result, aliasKey);
    if (groupedFields.size > 0) {
      const group = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
      if (!group) {
        if (appendUnknownSection(unknownSafeSections, key, value)) unreadableCoreCount += 1;
        continue;
      }
      for (const [groupFieldKey, groupFieldValue] of Object.entries(group)) {
        const groupField = groupedFields.get(normalizeLabel(groupFieldKey));
        if (!groupField) {
          if (appendUnknownSection(unknownSafeSections, `${key}.${groupFieldKey}`, groupFieldValue)) {
            unreadableCoreCount += 1;
          }
          continue;
        }
        const candidate = coerceProposalFieldValue(groupField, groupFieldValue);
        if (candidate === undefined) {
          if (appendUnknownSection(unknownSafeSections, groupField.label, groupFieldValue)) {
            unreadableCoreCount += 1;
          }
          continue;
        }
        writeDraftFieldValue(normalized, groupField, candidate);
        recognizedCoreCount += 1;
      }
      continue;
    }
    if (input.target.module === "review" && aliasKey === "outlineSections") {
      const outlineEntries: Array<[string, unknown]> = Array.isArray(value)
        ? value.flatMap((candidate) => {
            if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
            const row = candidate as Record<string, unknown>;
            return typeof row.key === "string" ? [[row.key, row.content] as [string, unknown]] : [];
          })
        : value !== null && typeof value === "object"
          ? Object.entries(value as Record<string, unknown>)
          : [];
      if (outlineEntries.length === 0 && value !== undefined && value !== null) {
        appendUnknownSection(unknownSafeSections, key, value);
        unreadableCoreCount += 1;
      }
      for (const [outlineKey, outlineValue] of outlineEntries) {
        const outlineField = fields.get(normalizeLabel(outlineKey));
        if (!outlineField?.reviewOutlineKey) {
          if (appendUnknownSection(unknownSafeSections, outlineKey, outlineValue)) unreadableCoreCount += 1;
          continue;
        }
        const candidate = coerceProposalFieldValue(outlineField, outlineValue);
        if (candidate === undefined) {
          if (appendUnknownSection(unknownSafeSections, outlineField.label, outlineValue)) unreadableCoreCount += 1;
          continue;
        }
        writeDraftFieldValue(normalized, outlineField, candidate);
        recognizedCoreCount += 1;
      }
      continue;
    }
    if (hiddenAllowed.has(aliasKey)) {
      if (value !== undefined && value !== null) normalized[aliasKey] = structuredClone(value);
      continue;
    }
    const field = fields.get(normalizeLabel(aliasKey));
    if (!field) {
      const preserved = appendUnknownSection(unknownSafeSections, key, value);
      if (preserved && /目标|目的|方法|结果|结论|摘要|说明|提纲|作者|证据|objective|method|result|conclusion|summary|outline|author|evidence/iu.test(key)) {
        unreadableCoreCount += 1;
      }
      continue;
    }
    if (input.target.module === "review" && field.key === "reviewType") {
      const exactType = boundedSafeText(value);
      if (exactType && field.enumValues?.includes(exactType)) {
        writeDraftFieldValue(normalized, field, exactType);
        recognizedCoreCount += 1;
      } else {
        // Preserve an explicitly supplied unsupported semantic value so the
        // Review adapter can reject the whole batch. It must not disappear
        // into a description sink and then acquire the missing-field default.
        normalized.reviewType = structuredClone(value);
        unreadableCoreCount += 1;
      }
      continue;
    }
    const candidate = coerceProposalFieldValue(field, value);
    if (candidate === undefined) {
      const preserved = appendUnknownSection(unknownSafeSections, field.label, value);
      if (preserved && field.always) unreadableCoreCount += 1;
      continue;
    }
    writeDraftFieldValue(normalized, field, candidate);
    if (field.always || field.reviewOutlineKey) recognizedCoreCount += 1;
  }
  const sink = safeSinkFor(result);
  if (sink && unknownSafeSections.length > 0 && input.target.module !== "review") {
    const sinkField = fieldsFor(result).find((field) => field.key === sink);
    if (sinkField) appendDraftFieldText(normalized, sinkField, unknownSafeSections.join("\n\n"));
    else normalized[sink] = appendText(normalized[sink], unknownSafeSections.join("\n\n"));
  }
  if (input.target.module === "review") preserveIncompleteNonPeriodicReviewPeriod(normalized);
  if (input.target.module === "task" && normalized.status === "blocked" && !normalized.blockedReason) {
    normalized.description = appendText(normalized.description, "原状态：受阻（受阻原因待补充）");
    if (input.action === "CREATE") normalized.status = "todo";
    else delete normalized.status;
  }
  if (
    input.target.module === "route" && typeof normalized.startDate === "string" &&
    typeof normalized.endDate === "string" && normalized.endDate < normalized.startDate
  ) {
    normalized.description = appendText(normalized.description, `原时间说明：${normalized.startDate} 至 ${normalized.endDate}`);
    delete normalized.startDate;
    delete normalized.endDate;
  }
  if (
    input.target.module === "task" && typeof normalized.scheduledDate === "string" &&
    typeof normalized.dueDate === "string" && normalized.dueDate < normalized.scheduledDate
  ) {
    normalized.description = appendText(normalized.description, `原时间说明：${normalized.scheduledDate} 至 ${normalized.dueDate}`);
    delete normalized.scheduledDate;
    delete normalized.dueDate;
  }
  if (
    input.target.module === "experimentRun" && typeof normalized.startedAt === "string" &&
    typeof normalized.completedAt === "string" && normalized.completedAt < normalized.startedAt
  ) {
    normalized.summaryOther = appendText(normalized.summaryOther, `原时间说明：${normalized.startedAt} 至 ${normalized.completedAt}`);
    delete normalized.startedAt;
    delete normalized.completedAt;
  }
  if (unreadableCoreCount >= 3 && recognizedCoreCount <= 1) {
    nonBlockingIssues.push({
      code: "P1_MAJOR_UNREADABLE_NONBLOCKING",
      message: "部分核心内容未能结构化识别，请确认建议内容后再决定是否执行。"
    });
  }
  return { payload: normalized, nonBlockingIssues, unknownSafeSections };
}

function bindingSummary(options?: {
  projectName?: string;
  targetName?: string;
  parentName?: string;
}): string {
  return [
    `课题：${options?.projectName?.trim() || "未能确认课题名称"}`,
    `对象：${options?.targetName?.trim() || "未能确认对象名称"}`,
    ...(options?.parentName?.trim() ? [`所属实验：${options.parentName.trim()}`] : [])
  ].join("；");
}

function unknownPayloadText(
  result: Pick<AIStandardResult, "target">,
  payload: Record<string, unknown>,
  fields: readonly DraftFieldSpec[]
): string {
  const known = new Set([
    ...fields.map((field) => field.key),
    ...fields.flatMap((field) => field.payloadGroupKey ? [field.payloadGroupKey] : []),
    ...(HIDDEN_ALLOWED_FIELDS[result.target.module] ?? []),
    "manuscriptEffects"
  ]);
  return Object.entries(payload)
    .filter(([key, value]) => !known.has(key) && value !== undefined && value !== null && value !== "")
    .map(([, value]) => displayScalar(value) || (typeof value === "object" ? JSON.stringify(value) : String(value)))
    .filter(Boolean)
    .join("\n");
}

export function projectAIStandardOperationDraft(
  result: Pick<AIStandardResult, "action" | "target" | "visiblePayload">,
  options?: { projectName?: string; targetName?: string; parentName?: string }
): AIStandardOperationDraftProjection {
  const fields = fieldsFor(result);
  const sink = safeSinkFor(result);
  const unknown = unknownPayloadText(result, result.visiblePayload, fields);
  const lines = fields.flatMap((field) => {
    if (field.editorVisible === false) return [];
    let value = displayScalar(readDraftFieldValue(result.visiblePayload, field));
    if (field.key === sink && unknown) value = appendText(value, unknown);
    return field.always || value ? [`${field.label}：${value}`] : [];
  });
  return {
    text: lines.join("\n\n"),
    editable: result.action !== "DELETE_SUGGESTION" && fields.length > 0,
    bindingSummary: bindingSummary(options)
  };
}

type ParsedBlock = { label?: string; value: string; raw: string };

function parseBlocks(input: string): ParsedBlock[] {
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ParsedBlock[] = [];
  let current: { label?: string; values: string[]; raw: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    blocks.push({
      ...(current.label ? { label: current.label } : {}),
      value: current.values.join("\n").trim(),
      raw: current.raw.join("\n").trim()
    });
    current = undefined;
  };
  for (const line of lines) {
    const match = line.match(/^\s*(?:#{1,6}\s*|[-*+]\s*|\d+[.)、]\s*)?([^：:\n]{1,40})[：:]\s*(.*)$/u);
    if (match) {
      flush();
      current = { label: match[1].trim(), values: [match[2]], raw: [line] };
    } else if (current) {
      current.values.push(line);
      current.raw.push(line);
    } else if (line.trim()) {
      current = { values: [line], raw: [line] };
    }
  }
  flush();
  return blocks;
}

function parseList(value: string): string[] {
  return [...new Set(value.split(/[\n,，、;；]/u).map((item) => item.trim()).filter(Boolean))];
}

function parseFieldValue(field: DraftFieldSpec, value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (field.kind === "list") return parseList(trimmed);
  if (field.kind === "authors") return parseList(trimmed).map((name) => ({ name }));
  if (field.kind === "boolean") {
    if (["是", "可", "可以", "true", "yes"].includes(trimmed.toLocaleLowerCase())) return true;
    if (["否", "不可", "不可以", "false", "no"].includes(trimmed.toLocaleLowerCase())) return false;
    return undefined;
  }
  if (field.kind === "integer") {
    if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
    return undefined;
  }
  if (field.kind === "date") {
    return /^\d{4}-\d{2}-\d{2}$/u.test(trimmed) && !Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))
      ? trimmed
      : undefined;
  }
  if (field.kind === "dateTime") return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
  const canonical = ENUM_VALUE_BY_LABEL.get(trimmed) ?? field.enumAliases?.[normalizeLabel(trimmed)] ?? trimmed;
  return !field.enumValues || field.enumValues.includes(canonical) ? canonical : undefined;
}

function preserveIncompleteNonPeriodicReviewPeriod(payload: Record<string, unknown>) {
  const reviewType = payload.reviewType ?? "stage";
  const periodStart = typeof payload.periodStart === "string" ? payload.periodStart.trim() : "";
  const periodEnd = typeof payload.periodEnd === "string" ? payload.periodEnd.trim() : "";
  const periodLabel = typeof payload.periodLabel === "string" ? payload.periodLabel.trim() : "";
  if (reviewType === "periodic") return;
  if ((periodStart || periodEnd || periodLabel) && !(periodStart && periodEnd)) {
    const preserved = [
      periodStart ? `开始日期：${periodStart}` : "",
      periodEnd ? `结束日期：${periodEnd}` : "",
      periodLabel ? `周期说明：${periodLabel}` : ""
    ].filter(Boolean).join("；");
    payload.description = appendText(payload.description, preserved);
    delete payload.periodStart;
    delete payload.periodEnd;
    delete payload.periodLabel;
  }
}

export function interpretAIStandardOperationDraft(
  result: Pick<AIStandardResult, "action" | "target" | "visiblePayload">,
  editorText: string,
  options?: { allowEmptyUpdate?: boolean }
): AIStandardOperationDraftInterpretation {
  if (result.action === "DELETE_SUGGESTION") {
    throw new AIStandardOperationDraftInterpretationError(["删除建议只可忽略，请到对应条目下执行删除操作。"]);
  }
  const fields = fieldsFor(result);
  if (fields.length === 0) {
    throw new AIStandardOperationDraftInterpretationError(["当前建议没有可安全编辑的自然语言字段。"]);
  }
  const aliases = new Map<string, DraftFieldSpec>();
  for (const field of fields) {
    if (field.editorVisible === false) continue;
    for (const label of [field.label, ...(field.aliases ?? [])]) aliases.set(normalizeLabel(label), field);
  }
  const payload: Record<string, unknown> = {};
  for (const key of HIDDEN_ALLOWED_FIELDS[result.target.module] ?? []) {
    if (key === "structuredSummary" && OUTPUT_MODULES.has(result.target.module)) continue;
    if (result.visiblePayload[key] !== undefined) payload[key] = structuredClone(result.visiblePayload[key]);
  }
  const unknownSafeSections: string[] = [];
  const issues: string[] = [];
  for (const block of parseBlocks(editorText)) {
    if (!block.label) {
      if (block.raw) unknownSafeSections.push(block.raw);
      continue;
    }
    const normalizedLabel = normalizeLabel(block.label);
    if (MACHINE_BINDING_LABELS.has(normalizedLabel)) {
      continue;
    }
    const field = aliases.get(normalizedLabel);
    if (!field) {
      if (block.raw) unknownSafeSections.push(block.raw);
      continue;
    }
    const value = parseFieldValue(field, block.value);
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      writeDraftFieldValue(payload, field, value);
    }
    else if (block.raw && block.value.trim()) unknownSafeSections.push(block.raw);
  }
  const sink = safeSinkFor(result);
  if (unknownSafeSections.length > 0) {
    if (!sink) issues.push("当前类型没有可安全保存未识别段落的位置，请补充明确的小标题。");
    else if (result.target.module !== "review") {
      const sinkField = fields.find((field) => field.key === sink);
      if (sinkField) appendDraftFieldText(payload, sinkField, unknownSafeSections.join("\n\n"));
      else payload[sink] = appendText(payload[sink], unknownSafeSections.join("\n\n"));
    }
  }
  if (result.target.module === "review") preserveIncompleteNonPeriodicReviewPeriod(payload);
  if (result.target.module === "task" && payload.status === "blocked" && !payload.blockedReason) {
    payload.description = appendText(payload.description, "原状态：受阻（受阻原因待补充）");
    if (result.action === "CREATE") payload.status = "todo";
    else delete payload.status;
  }
  const titleRequired = result.action === "CREATE" && [
    "route", "task", "review", "experiment", "literature", "resultItem", "finding",
    "outputCandidate", "outputGap", "researchOutput"
  ].includes(result.target.module);
  if (titleRequired && (typeof payload.title !== "string" || !payload.title.trim())) {
    issues.push("请填写名称后再确认。");
  }
  if (result.action === "UPDATE" && Object.keys(payload).length === 0 && !options?.allowEmptyUpdate) {
    issues.push("请至少保留一项需要修改的内容。");
  }
  if (issues.length > 0) throw new AIStandardOperationDraftInterpretationError([...new Set(issues)]);
  const normalizedText = projectAIStandardOperationDraft({
    action: result.action,
    target: result.target,
    visiblePayload: payload
  }).text;
  return { payload, normalizedText, unknownSafeSections };
}

export function friendlyAIStandardOperationValidationMessage(
  issue: Pick<AIStandardResultValidationIssue, "code" | "field">
): string {
  if (issue.code === "P1_MAJOR_UNREADABLE_NONBLOCKING") {
    return "部分核心内容未能结构化识别，请确认建议内容后再决定是否执行。";
  }
  if (issue.code === "DELETE_SUGGESTION_INFORMATIONAL_ONLY") {
    return "删除建议仅供参考；请到对应业务条目复核并处理。";
  }
  if (issue.field === "title" || issue.code.endsWith("FIELD_INVALID") && issue.field === "title") {
    return "请填写有效名称后再确认。";
  }
  if (issue.code.includes("PERIOD")) return "复盘周期信息需要调整；非定期说明可放入复盘说明。";
  if (issue.code.includes("SCOPE") || issue.code.includes("TARGET") || issue.code.includes("STALE")) {
    return "关联对象或上下文已经变化，请返回聊天重新解析。";
  }
  if (issue.code.includes("UNSUPPORTED")) return "草稿中含有当前操作不支持的字段，请改为自然语言说明。";
  if (issue.code.includes("REQUIRED") || issue.code.includes("INVALID")) {
    return "草稿内容不完整或格式不正确，请检查相应自然语言段落。";
  }
  return "草稿内容需要调整后才能确认执行。";
}

export function friendlyAIStandardOperationError(error: unknown): string {
  if (error instanceof AIStandardOperationDraftInterpretationError) return error.issues.join(" ");
  const message = error instanceof Error ? error.message : "";
  if (/[\u3400-\u9fff]/u.test(message) && message.length <= 240) return message;
  if (/stale|changed|fingerprint|scope|target/iu.test(message)) {
    return "建议内容或关联对象已经变化，请重新查看后再操作。";
  }
  if (/validation|invalid|required|payload/iu.test(message)) {
    return "草稿内容未通过检查，请调整后重新确认。";
  }
  return "操作未完成，尚未写入业务数据。";
}
