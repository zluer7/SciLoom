import type {
  AIStandardResult,
  AIStandardResultManuscriptEffect
} from "../types/aiStandardResult";
import {
  readAIStandardResultManuscriptEffects,
  stripAIStandardResultManuscriptEffects,
  stripAIStandardResultProposalMetadata
} from "./aiStandardResultService";

export type AIStandardOperationFact = {
  label: string;
  value: string;
  markdown?: boolean;
};

export type AIStandardOperationPresentation = {
  heading: string;
  actionSummary: string;
  targetSummary: string;
  businessScopeSummary: string;
  effectSummary: string;
  facts: AIStandardOperationFact[];
  manuscriptEffects: AIStandardOperationMechanicalEffect[];
  currentDefaultInvariant?: string;
  structuredEditManuscriptNonSyncNotice?: string;
  requestedOutcomeNotice: string;
};

export type AIStandardOperationMechanicalEffect = {
  ownerType: string;
  ownerLabel: string;
  ownerIdentity: string;
  channel: AIStandardResultManuscriptEffect["channel"];
  planSummary: string;
};

export type AIStandardOperationPresentationOptions = {
  targetName?: string;
};

const MODULE_LABELS: Record<string, string> = {
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

const ACTION_LABELS: Record<string, string> = {
  CREATE: "新建",
  UPDATE: "更新",
  DELETE_SUGGESTION: "删除建议"
};

const FIELD_LABELS: Record<string, string> = {
  title: "名称",
  description: "说明",
  objective: "目标",
  expectedOutput: "预期输出",
  nodeType: "路线类型",
  status: "状态",
  startDate: "开始日期",
  endDate: "结束日期",
  timeLabel: "时间说明",
  timePrecision: "时间精度",
  showInGantt: "路线图展示",
  priority: "优先级",
  taskType: "任务类型",
  timeBucket: "时间范围",
  scheduledDate: "计划日期",
  dueDate: "截止日期",
  acceptanceCriteria: "完成标准",
  blockedReason: "受阻原因",
  purposeAndQuestion: "目的与问题",
  conditionSummary: "条件摘要",
  variableParameterSummary: "变量与参数",
  methodSummary: "方法摘要",
  resultSummary: "结果摘要",
  conclusionAndNextSteps: "结论与下一步",
  conclusion: "结论",
  other: "其他说明",
  summaryOther: "其他摘要",
  rating: "评价",
  usableForPaper: "论文适用",
  usableForReport: "报告适用",
  usableForPatent: "专利适用",
  runLabel: "运行标记",
  startedAt: "开始时间",
  completedAt: "完成时间",
  reviewType: "复盘类型",
  periodStart: "复盘开始",
  periodEnd: "复盘结束",
  periodLabel: "周期说明",
  publicationType: "文献类型",
  year: "年份",
  venue: "发表来源",
  abstract: "摘要",
  doi: "DOI",
  readingStatus: "阅读状态",
  importance: "重要性",
  findingType: "发现类型",
  confidence: "可信程度",
  maturity: "成熟程度",
  summary: "摘要",
  reason: "建议理由",
  body: "候选文稿",
  tags: "标签",
  keywords: "关键词",
  authors: "作者",
  outlineSections: "复盘提纲",
  targets: "关联对象",
  conditionItems: "结构化条件",
  methodSteps: "方法步骤",
  variables: "研究变量",
  materials: "研究材料",
  customFields: "自定义信息"
};

const ENUM_LABELS: Record<string, string> = {
  planned: "计划中",
  active: "进行中",
  paused: "已暂停",
  adjusted: "已调整",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  todo: "待办",
  doing: "进行中",
  delayed: "已延期",
  blocked: "受阻",
  high: "高",
  medium: "中",
  low: "低",
  uncertain: "不确定",
  stage: "阶段复盘",
  periodic: "定期复盘",
  experiment_comparison: "实验对比复盘",
  literature_comparison: "文献对比复盘",
  custom: "自定义复盘",
  reading: "文献阅读",
  experiment: "实验",
  coding: "编程",
  writing: "写作",
  analysis: "分析",
  meeting: "会议",
  idea: "想法",
  review: "复盘",
  other: "其他",
  today: "今天",
  this_week: "本周",
  this_month: "本月",
  long_term: "长期",
  none: "未指定",
  literature: "文献",
  algorithm: "算法",
  output: "成果",
  day: "日",
  week: "周",
  month: "月",
  quarter: "季度",
  phase: "阶段",
  free: "自由说明",
  excellent: "优秀",
  good: "良好",
  usable: "可用",
  inconclusive: "结论不明确",
  phenomenon: "现象",
  comparison: "对比",
  method: "方法",
  limitation: "局限",
  evidence: "证据",
  hypothesis: "假设",
  negative_result: "负向结果"
};

const FIELD_ORDER = [
  "title", "description", "objective", "expectedOutput", "nodeType", "status",
  "priority", "taskType", "timeBucket", "scheduledDate", "dueDate", "timeLabel",
  "timePrecision", "startDate", "endDate", "acceptanceCriteria", "blockedReason",
  "purposeAndQuestion", "conditionSummary", "variableParameterSummary", "methodSummary",
  "resultSummary", "conclusionAndNextSteps", "conclusion", "other", "summaryOther",
  "rating", "usableForPaper", "usableForReport", "usableForPatent", "runLabel",
  "startedAt", "completedAt", "reviewType", "periodStart", "periodEnd", "periodLabel",
  "outlineSections", "targets", "authors", "year", "venue", "publicationType", "abstract",
  "keywords", "doi", "readingStatus", "importance", "findingType", "confidence", "maturity",
  "summary", "reason", "body", "tags", "conditionItems", "methodSteps", "variables",
  "materials", "customFields", "showInGantt"
] as const;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function objectArraySummary(value: unknown, key: string): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (key === "authors") {
    const names = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const name = text((item as Record<string, unknown>).name);
      return name ? [name] : [];
    });
    return names.length > 0 ? names.join("、") : `${value.length} 项`;
  }
  if (key === "outlineSections") {
    const contents = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const content = text((item as Record<string, unknown>).content);
      return content ? [content] : [];
    });
    return contents.length > 0 ? contents.join("；") : `${value.length} 个提纲段落`;
  }
  if (key === "targets") return `${value.length} 个已校验关联对象`;
  if (value.every((item) => typeof item === "string")) {
    return (value as string[]).map((item) => item.trim()).filter(Boolean).join("、") || undefined;
  }
  const label = FIELD_LABELS[key] ?? "结构化信息";
  return `${value.length} 项${label}`;
}

function displayValue(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return ENUM_LABELS[value] ?? (value.trim() || undefined);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return objectArraySummary(value, key);
}

export function buildAIStandardOperationPresentation(
  result: Pick<AIStandardResult, "action" | "target" | "visiblePayload" | "validationIssues">,
  options: AIStandardOperationPresentationOptions = {}
): AIStandardOperationPresentation {
  const moduleLabel = MODULE_LABELS[result.target.module] ?? "研究对象";
  const actionLabel = ACTION_LABELS[result.action] ?? "建议操作";
  const manuscriptEffects = result.action === "NEW_MANUSCRIPT"
    ? []
    : readAIStandardResultManuscriptEffects(result.visiblePayload, {
        action: result.action,
        target: result.target
      });
  const businessPayload = stripAIStandardResultProposalMetadata(
    stripAIStandardResultManuscriptEffects(result.visiblePayload)
  );
  const facts = [...FIELD_ORDER.flatMap((field) => {
    const value = displayValue(field, businessPayload[field]);
    return value
      ? [{ label: FIELD_LABELS[field], value, ...(field === "body" ? { markdown: true } : {}) }]
      : [];
  })];
  const proposedName = text(businessPayload.title);
  const targetName = options.targetName?.trim();
  const existingTargetId = "entityId" in result.target ? result.target.entityId : undefined;
  const existingTargetIdentity = existingTargetId
    ? `${moduleLabel}${targetName ? `“${targetName}”` : ""}（ID：${existingTargetId}）`
    : undefined;
  const targetSummary = existingTargetIdentity
    ? `目标：${existingTargetIdentity}`
    : `拟新建${moduleLabel}${proposedName ? `“${proposedName}”` : ""}；执行前不预造 owner ID。`;
  const businessEffectRequested = result.action === "CREATE" || result.action === "DELETE_SUGGESTION" ||
    result.action === "UPDATE" && Object.keys(businessPayload).length > 0;
  const businessScopeSummary = result.action === "CREATE"
    ? `数据库：将创建 1 个${moduleLabel}`
    : result.action === "DELETE_SUGGESTION"
      ? `数据库：这是针对 exact existing ${moduleLabel}的删除建议；继续沿用现有删除安全流程。`
      : businessEffectRequested
        ? `数据库：将修改 1 个 exact existing ${moduleLabel}`
        : "数据库字段：本次无实际修改";
  const mechanicalEffects = manuscriptEffects.map((effect): AIStandardOperationMechanicalEffect => ({
    ownerType: result.target.entityType,
    ownerLabel: moduleLabel,
    ownerIdentity: existingTargetIdentity ?? "由 canonical business CREATE receipt 返回的新 owner",
    channel: effect.channel,
    planSummary: `${result.target.entityType} / ${effect.channel} · 计划保存 1 份新迭代稿`
  }));
  const effectSummary = result.action === "DELETE_SUGGESTION"
    ? "附属文稿：无。删除建议不会删除 manuscript、candidate 或 workspace。"
    : manuscriptEffects.length === 0
      ? "附属文稿：无。本次确认不会保存普通 Chat 草稿或外部附件。"
      : `附属文稿：计划保存 ${manuscriptEffects.length} 份 create-only 新迭代稿。`;
  return {
    heading: `${moduleLabel} · ${actionLabel}`,
    actionSummary: result.validationIssues.length > 0
      ? `当前建议有 ${result.validationIssues.length} 项校验提示，解决前不能确认执行。`
      : "当前建议已通过结构校验，仍需用户显式确认才会产生业务效果。",
    targetSummary,
    businessScopeSummary,
    effectSummary,
    facts,
    manuscriptEffects: mechanicalEffects,
    ...(manuscriptEffects.length > 0
      ? {
          currentDefaultInvariant: "当前稿与默认稿保持不变",
          structuredEditManuscriptNonSyncNotice:
            "编辑结构化字段不会同步重写本次附属文稿候选；如需同时调整文稿内容，请返回对话并重新生成操作建议。"
        }
      : {}),
    requestedOutcomeNotice: "以上为请求/计划范围；实际结果只以 durable terminal receipt 为准。"
  };
}

function validateBoundedDescriptionEdit(
  value: unknown,
  label: "任务说明" | "路线说明"
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return `${label}不能为空。`;
  if (value.includes("\0")) return `${label}包含不支持的字符。`;
  if (Array.from(value.trim()).length > 4_000) return `${label}不能超过 4000 个字符。`;
  return undefined;
}

export function validateBoundedTaskDescriptionEdit(value: unknown): string | undefined {
  return validateBoundedDescriptionEdit(value, "任务说明");
}

export function validateBoundedRouteDescriptionEdit(value: unknown): string | undefined {
  return validateBoundedDescriptionEdit(value, "路线说明");
}
