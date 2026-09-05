import type {
  ReviewManuscriptOutlineSectionDto,
  ReviewManuscriptStructuredDto,
  ReviewManuscriptTargetType
} from "../types/reviewManuscript";
import type { ReviewOutlineSectionKey, ReviewType } from "../types/planning";
import { REVIEW_OUTLINE_FIELD_LABELS } from "./manuscriptOutlineDescriptorRegistry";
import { formatManuscriptContextSummaryMarkdown } from "./manuscriptPresentationNormalization";

const REVIEW_TYPE_DISPLAY_NAMES: Readonly<Record<ReviewType, string>> = {
  stage: "阶段复盘",
  periodic: "周期复盘",
  experiment_comparison: "实验对比复盘",
  literature_comparison: "文献对比复盘",
  custom: "自定义复盘"
};

const TARGET_TYPE_DISPLAY_NAMES: Readonly<Record<ReviewManuscriptTargetType, string>> = {
  project: "课题",
  routeNode: "路线",
  task: "任务",
  experiment: "实验",
  experimentRun: "实验 Run",
  literature: "文献"
};

const TARGET_CONTEXT_LABELS: Readonly<Record<ReviewManuscriptTargetType, string>> = {
  project: "课题",
  routeNode: "关联路线",
  task: "关联任务",
  experiment: "关联实验",
  experimentRun: "实验 Run",
  literature: "关联文献"
};

const TARGET_PRESENTATION_ORDER: readonly ReviewManuscriptTargetType[] = [
  "project",
  "routeNode",
  "task",
  "experiment",
  "experimentRun",
  "literature"
];

const OUTLINE_DISPLAY_NAMES: Readonly<Record<ReviewOutlineSectionKey, string>> =
  REVIEW_OUTLINE_FIELD_LABELS;

const SECTION_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const EMPTY_VALUE = "未填写";

function sanitizePresentationText(value: string) {
  return value
    .replace(/<!--\s*LABPOD[^>]*-->/giu, "[内部标记已省略]")
    .replace(/[A-Za-z]:[\\/][^\s，；）)]+/gu, "[本地路径已省略]")
    .replace(/(^|\s)\/(?:[^/\s]+\/)+[^\s，；）)]*/gu, "$1[本地路径已省略]");
}

function valueOrEmpty(value: unknown) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  return normalized ? sanitizePresentationText(normalized) : EMPTY_VALUE;
}

function line(label: string, value: unknown) {
  return `- ${label}：${valueOrEmpty(value)}`;
}

export function getReviewTypeDisplayName(reviewType: ReviewType) {
  return REVIEW_TYPE_DISPLAY_NAMES[reviewType];
}

export function getReviewTargetTypeDisplayName(targetType: ReviewManuscriptTargetType) {
  return TARGET_TYPE_DISPLAY_NAMES[targetType];
}

export function getReviewOutlineDisplayName(key: ReviewOutlineSectionKey) {
  return OUTLINE_DISPLAY_NAMES[key];
}

function targetSummary(dto: ReviewManuscriptStructuredDto) {
  return buildReviewTargetLines(dto)
    .map((targetLine) => targetLine.replace(/^-/u, "").trim())
    .join("；");
}

export function buildReviewMetaSnapshot(dto: ReviewManuscriptStructuredDto) {
  return [
    "## 复盘信息",
    "",
    line("复盘名称", dto.title),
    line("复盘类型", dto.reviewTypeDisplayName),
    line("所属课题", dto.projectMissing ? `【缺失】${dto.projectDisplayName}` : dto.projectDisplayName),
    line("说明", dto.description),
    line("复盘对象", targetSummary(dto)),
    line("周期标签", dto.periodLabel),
    line("周期开始", dto.periodStart),
    line("周期结束", dto.periodEnd),
    line("标签", dto.tags.length > 0 ? dto.tags.join("、") : undefined),
    line("创建时间", dto.createdAt),
    line("更新时间", dto.updatedAt)
  ].join("\n");
}

function outlineSectionMarkdown(section: ReviewManuscriptOutlineSectionDto) {
  const numeral = SECTION_NUMERALS[section.order] ?? String(section.order + 1);
  return [`### ${numeral}、${section.displayName}`, "", valueOrEmpty(section.content)].join("\n");
}

export function buildReviewOutlineSnapshot(dto: ReviewManuscriptStructuredDto) {
  return [
    "## 结构化提纲",
    "",
    ...dto.outlineSections.flatMap((section, index) => [
      outlineSectionMarkdown(section),
      ...(index < dto.outlineSections.length - 1 ? [""] : [])
    ])
  ].join("\n");
}

function buildReviewTargetLines(dto: ReviewManuscriptStructuredDto) {
  return TARGET_PRESENTATION_ORDER.flatMap((targetType) => {
    const label = TARGET_CONTEXT_LABELS[targetType];
    const targets = dto.targets.filter(
      (target) => target.targetType === targetType && !target.missing && target.displayName.trim()
    );
    if (targets.length === 0) return [line(label, undefined)];
    return targets.map((target) => line(label, target.displayName));
  });
}

export function formatReviewContextInsert(dto: ReviewManuscriptStructuredDto) {
  const overview = [
    line("复盘标题", dto.title),
    line("复盘类型", dto.reviewTypeDisplayName),
    line("所属课题", dto.projectMissing ? undefined : dto.projectDisplayName),
    line("简要说明", dto.description),
    line("周期标签", dto.periodLabel),
    line("周期开始", dto.periodStart),
    line("周期结束", dto.periodEnd)
  ];
  return formatManuscriptContextSummaryMarkdown({
    heading: "复盘上下文摘要",
    bodyGroups: [overview, buildReviewTargetLines(dto)],
    descriptorLookupIdentity: {
      ownerType: "review",
      channel: "primary",
      reviewType: dto.reviewType
    },
    structuredValues: Object.fromEntries(
      dto.outlineSections.map((section) => [section.key, section.content])
    ),
    emptyValue: EMPTY_VALUE,
    sanitizeValue: sanitizePresentationText
  });
}

export const reviewManuscriptPresentationService = {
  getReviewTypeDisplayName,
  getReviewTargetTypeDisplayName,
  getReviewOutlineDisplayName,
  buildMetaSnapshot: buildReviewMetaSnapshot,
  buildOutlineSnapshot: buildReviewOutlineSnapshot,
  formatContextInsert: formatReviewContextInsert
};
