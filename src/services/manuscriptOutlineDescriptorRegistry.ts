import type { ReviewOutlineSectionKey, ReviewType } from "../types/planning";
import {
  getOutputCanonicalValueDescriptor,
  type OutputCanonicalValueOwnerType
} from "../types/outputCanonicalValue";

export type ManuscriptOutlineOwnerType =
  | "experiment"
  | "experimentRun"
  | "literature"
  | "review"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type ManuscriptOutlineChannel =
  | "primary"
  | "literature_outline"
  | "dedicated_notes";

export interface ManuscriptOutlineFieldDescriptor {
  readonly ownerType: ManuscriptOutlineOwnerType;
  readonly channel: ManuscriptOutlineChannel;
  readonly stableKey: string;
  readonly displayLabel: string;
  readonly databaseField?: string;
  readonly persistenceProjectorIdentity: string;
  readonly order: number;
  readonly setClearRule: Readonly<{
    presentNonEmpty: "set";
    presentEmpty: "clear";
    absent: "clear";
  }>;
}

type ManuscriptOutlineFieldDraft = Omit<
  ManuscriptOutlineFieldDescriptor,
  "ownerType" | "channel"
>;

export interface ManuscriptOutlineDescriptor {
  readonly ownerType: ManuscriptOutlineOwnerType;
  readonly channel: ManuscriptOutlineChannel;
  readonly reviewType?: ReviewType;
  readonly outlineHeading: "结构化纲要";
  readonly fields: readonly ManuscriptOutlineFieldDescriptor[];
}

export interface ManuscriptOutlineRegistration {
  readonly ownerType: ManuscriptOutlineOwnerType;
  readonly channel: ManuscriptOutlineChannel;
  readonly descriptors: readonly ManuscriptOutlineDescriptor[];
}

const SET_CLEAR_RULE = Object.freeze({
  presentNonEmpty: "set",
  presentEmpty: "clear",
  absent: "clear"
} as const);

function field(
  stableKey: string,
  displayLabel: string,
  persistenceProjectorIdentity: string,
  order: number,
  databaseField?: string
): ManuscriptOutlineFieldDraft {
  return Object.freeze({
    stableKey,
    displayLabel,
    databaseField,
    persistenceProjectorIdentity,
    order,
    setClearRule: SET_CLEAR_RULE
  });
}

function descriptor(
  ownerType: ManuscriptOutlineOwnerType,
  channel: ManuscriptOutlineChannel,
  fields: readonly ManuscriptOutlineFieldDraft[],
  reviewType?: ReviewType
): ManuscriptOutlineDescriptor {
  return Object.freeze({
    ownerType,
    channel,
    reviewType,
    outlineHeading: "结构化纲要",
    fields: Object.freeze(fields.map((item) => Object.freeze({
      ...item,
      ownerType,
      channel
    })))
  });
}

export const EXPERIMENT_OUTLINE_FIELD_KEYS = Object.freeze([
  "purposeAndQuestion",
  "conditionSummary",
  "methodSummary",
  "resultSummary",
  "conclusionAndNextSteps",
  "other"
] as const);

const EXPERIMENT_DESCRIPTOR = descriptor("experiment", "primary", [
  field("purposeAndQuestion", "实验目的与问题", "experiment.purposeAndQuestion", 0, "purpose_and_question"),
  field("conditionSummary", "条件摘要", "experiment.conditionSummary", 1, "condition_summary"),
  field("methodSummary", "方法摘要", "experiment.methodSummary", 2, "method_summary"),
  field("resultSummary", "结果摘要", "experiment.resultSummary", 3, "result_summary"),
  field("conclusionAndNextSteps", "结论与下一步", "experiment.conclusionAndNextSteps", 4, "conclusion_and_next_steps"),
  field("other", "其他", "experiment.other", 5, "other")
]);

const EXPERIMENT_RUN_DESCRIPTOR = descriptor("experimentRun", "primary", [
  field("conditionSummary", "条件摘要", "experimentRun.conditionSummary", 0, "condition_summary"),
  field("variableParameterSummary", "变量与参数摘要", "experimentRun.variableParameterSummary", 1, "variable_parameter_summary"),
  field("methodSummary", "方法摘要", "experimentRun.methodSummary", 2, "method_summary"),
  field("resultSummary", "结果摘要", "experimentRun.resultSummary", 3, "result_summary"),
  field("conclusionNotes", "结论与下一步", "experimentRun.conclusion", 4, "conclusion"),
  field("other", "其他", "experimentRun.summaryOther", 5, "summary_other")
]);

const LITERATURE_OUTLINE_DESCRIPTOR = descriptor("literature", "literature_outline", [
  field("summary", "摘要", "literature.abstract", 0),
  field("research_problem", "研究问题", "literature.customFields.outlineResearchProblem", 1),
  field("application_object", "应用对象", "literature.customFields.outlineApplicationObject", 2),
  field("method_overview", "方法概要", "literature.customFields.outlineMethodOverview", 3),
  field("main_conclusion", "主要结论", "literature.customFields.outlineMainConclusion", 4),
  field("limitations", "局限性", "literature.customFields.outlineLimitations", 5),
  field("other", "其他", "literature.customFields.outlineOther", 6)
]);

const LITERATURE_NOTES_DESCRIPTOR = descriptor("literature", "dedicated_notes", [
  field("summary", "摘要", "literature.customFields.knowledgeProjectSummary", 0),
  field("project_relevance", "课题相关度建议", "literature.customFields.knowledgeProjectRelevance", 1),
  field("related_objects", "关联对象", "literature.customFields.knowledgeRelatedObjectNotes", 2),
  field("reusable_methods", "可借鉴方法", "literature.customFields.knowledgeReusableMethods", 3),
  field("comparable_conclusions", "可对比结论", "literature.customFields.knowledgeComparableConclusions", 4),
  field("other", "其他", "literature.customFields.knowledgeOther", 5)
]);

export const REVIEW_OUTLINE_FIELD_LABELS: Readonly<Record<ReviewOutlineSectionKey, string>> = Object.freeze({
  stage_summary: "阶段摘要", key_progress: "关键进展", completed_items: "已完成内容",
  major_problems: "主要问题", cause_analysis: "原因分析", next_plan: "下一步计划", other: "其他",
  period_summary: "周期摘要", period_completed: "本周期完成", period_pending: "本周期未完成 / 延期",
  next_period_plan: "下周期计划", comparison_summary: "对比摘要", comparison_targets: "对比对象",
  key_differences: "关键差异", main_conclusions: "主要结论", anomalies_and_problems: "异常与问题",
  next_experiment_plan: "下一步实验计划", literature_overview: "综述摘要", literature_scope: "对比文献范围",
  method_differences: "方法差异", consensus_and_divergence: "结论共识与分歧",
  research_gaps_and_references: "研究空白 / 可借鉴点", next_reading_or_research_plan: "后续阅读或研究计划",
  custom_summary: "摘要"
});

function reviewKeys(...keys: ReviewOutlineSectionKey[]) {
  return Object.freeze(keys);
}

export const REVIEW_OUTLINE_TEMPLATE_KEYS: Readonly<Record<ReviewType, readonly ReviewOutlineSectionKey[]>> = Object.freeze({
  stage: reviewKeys("stage_summary", "key_progress", "completed_items", "major_problems", "cause_analysis", "next_plan", "other"),
  periodic: reviewKeys("period_summary", "period_completed", "period_pending", "major_problems", "cause_analysis", "next_period_plan", "other"),
  experiment_comparison: reviewKeys("comparison_summary", "comparison_targets", "key_differences", "main_conclusions", "anomalies_and_problems", "next_experiment_plan", "other"),
  literature_comparison: reviewKeys("literature_overview", "literature_scope", "method_differences", "consensus_and_divergence", "research_gaps_and_references", "next_reading_or_research_plan", "other"),
  custom: reviewKeys("custom_summary", "completed_items", "major_problems", "cause_analysis", "next_plan", "other")
});

const REVIEW_DESCRIPTORS = (Object.keys(REVIEW_OUTLINE_TEMPLATE_KEYS) as ReviewType[]).map((reviewType) =>
  descriptor("review", "primary", REVIEW_OUTLINE_TEMPLATE_KEYS[reviewType].map((key, order) =>
    field(key, REVIEW_OUTLINE_FIELD_LABELS[key], `review.outlineSections.${key}`, order)
  ), reviewType)
);

function outputDescriptor(ownerType: OutputCanonicalValueOwnerType, fields: readonly [string, string][]) {
  const brief = getOutputCanonicalValueDescriptor(ownerType);
  return descriptor(ownerType, "primary", fields.map(([key, label], order) =>
    field(
      key,
      label,
      key === brief.stableKey ? brief.directPersistenceIdentity : `${ownerType}.structuredSummary.${key}`,
      order
    )
  ));
}

const OUTPUT_DESCRIPTORS = Object.freeze({
  resultItem: outputDescriptor("resultItem", [["summary", "结果摘要"], ["keyPhenomenon", "关键指标或现象"], ["conditionBrief", "实验条件简述"], ["initialJudgement", "初步判断"], ["conversionValue", "可转化价值"], ["other", "其他"]]),
  finding: outputDescriptor("finding", [["content", "发现内容"], ["supportingEvidence", "支撑证据"], ["noveltyDifference", "新颖性或差异"], ["reliabilityJudgement", "可靠性判断"], ["boundaryOrMissingEvidence", "边界或缺失证据"], ["other", "其他"]]),
  outputCandidate: outputDescriptor("outputCandidate", [["coreClaim", "核心主张"], ["outputType", "成果类型"], ["innovationContribution", "创新贡献"], ["evidenceSummary", "证据摘要"], ["risksAndGaps", "风险与缺口"], ["other", "其他"]]),
  outputGap: outputDescriptor("outputGap", [["gapDescription", "缺口说明"], ["gapType", "缺口类型"], ["affectedObject", "影响对象"], ["strengtheningPlan", "补强计划"], ["completionCriteria", "完成标准"], ["other", "其他"]]),
  researchOutput: outputDescriptor("researchOutput", [["summary", "成果摘要"], ["outputType", "成果类型"], ["coreContribution", "核心贡献"], ["sourceChainSummary", "来源链摘要"], ["archiveUsage", "归档用途"], ["other", "其他"]])
});

export const MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY: readonly ManuscriptOutlineRegistration[] = Object.freeze([
  { ownerType: "experiment", channel: "primary", descriptors: Object.freeze([EXPERIMENT_DESCRIPTOR]) },
  { ownerType: "experimentRun", channel: "primary", descriptors: Object.freeze([EXPERIMENT_RUN_DESCRIPTOR]) },
  { ownerType: "literature", channel: "literature_outline", descriptors: Object.freeze([LITERATURE_OUTLINE_DESCRIPTOR]) },
  { ownerType: "literature", channel: "dedicated_notes", descriptors: Object.freeze([LITERATURE_NOTES_DESCRIPTOR]) },
  { ownerType: "review", channel: "primary", descriptors: Object.freeze(REVIEW_DESCRIPTORS) },
  ...Object.values(OUTPUT_DESCRIPTORS).map((item) => ({ ownerType: item.ownerType, channel: item.channel, descriptors: Object.freeze([item]) }))
]);

export function getManuscriptOutlineDescriptor(input: {
  ownerType: ManuscriptOutlineOwnerType;
  channel: ManuscriptOutlineChannel;
  reviewType?: ReviewType;
}) {
  const registration = MANUSCRIPT_OUTLINE_DESCRIPTOR_REGISTRY.find(
    (candidate) => candidate.ownerType === input.ownerType && candidate.channel === input.channel
  );
  const result = input.ownerType === "review"
    ? registration?.descriptors.find((candidate) => candidate.reviewType === input.reviewType)
    : registration?.descriptors[0];
  if (!result) throw new Error(`MANUSCRIPT_OUTLINE_DESCRIPTOR_NOT_FOUND: ${input.ownerType}/${input.channel}/${input.reviewType ?? ""}`);
  return result;
}

export function getOutputOutlineDescriptor(ownerType: keyof typeof OUTPUT_DESCRIPTORS) {
  return OUTPUT_DESCRIPTORS[ownerType];
}
