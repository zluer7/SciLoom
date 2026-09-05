import type {
  ReviewOutlineSection,
  ReviewOutlineSectionKey,
  ReviewType
} from "../types/planning";
import { REVIEW_OUTLINE_TEMPLATE_KEYS } from "./manuscriptOutlineDescriptorRegistry";

export const REVIEW_CORE_SCHEMA_VERSION = 3;

export type ReviewOutlineRoleAdditions = {
  summaryContent?: string;
  problemContent?: string;
  nextPlanContent?: string;
};

export const REVIEW_OUTLINE_TEMPLATES: Readonly<
  Record<ReviewType, readonly ReviewOutlineSectionKey[]>
> = REVIEW_OUTLINE_TEMPLATE_KEYS;

const ALL_OUTLINE_KEYS = new Set<ReviewOutlineSectionKey>(
  Object.values(REVIEW_OUTLINE_TEMPLATES).flat()
);

const SUMMARY_KEYS = new Set<ReviewOutlineSectionKey>([
  "stage_summary",
  "period_summary",
  "comparison_summary",
  "literature_overview",
  "custom_summary"
]);
const COMPLETED_KEYS = new Set<ReviewOutlineSectionKey>([
  "completed_items",
  "period_completed",
  "main_conclusions",
  "consensus_and_divergence"
]);
const PROBLEM_KEYS = new Set<ReviewOutlineSectionKey>([
  "major_problems",
  "anomalies_and_problems",
  "research_gaps_and_references"
]);
const NEXT_PLAN_KEYS = new Set<ReviewOutlineSectionKey>([
  "next_plan",
  "next_period_plan",
  "next_experiment_plan",
  "next_reading_or_research_plan"
]);

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function appendContent(existing: string, addition: string) {
  if (!addition.trim()) return existing;
  return existing.trim() ? `${existing}\n\n${addition}` : addition;
}

function targetKeyForRole(
  reviewType: ReviewType,
  key: ReviewOutlineSectionKey
): ReviewOutlineSectionKey | undefined {
  const template = REVIEW_OUTLINE_TEMPLATES[reviewType];
  if (template.includes(key)) return key;
  if (SUMMARY_KEYS.has(key)) return template.find((candidate) => SUMMARY_KEYS.has(candidate));
  if (COMPLETED_KEYS.has(key)) return template.find((candidate) => COMPLETED_KEYS.has(candidate));
  if (PROBLEM_KEYS.has(key)) return template.find((candidate) => PROBLEM_KEYS.has(candidate));
  if (NEXT_PLAN_KEYS.has(key)) return template.find((candidate) => NEXT_PLAN_KEYS.has(candidate));
  return undefined;
}

function firstTemplateKeyForRole(
  reviewType: ReviewType,
  keys: ReadonlySet<ReviewOutlineSectionKey>
) {
  return REVIEW_OUTLINE_TEMPLATES[reviewType].find((candidate) => keys.has(candidate));
}

function normalizeInputSections(value: unknown): ReviewOutlineSection[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<ReviewOutlineSectionKey, string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const key = (candidate as { key?: unknown }).key;
    if (typeof key !== "string" || !ALL_OUTLINE_KEYS.has(key as ReviewOutlineSectionKey)) {
      continue;
    }
    const content = text((candidate as { content?: unknown }).content);
    const typedKey = key as ReviewOutlineSectionKey;
    byKey.set(typedKey, appendContent(byKey.get(typedKey) ?? "", content));
  }
  return [...byKey].map(([key, content]) => ({ key, content }));
}

export function normalizeReviewType(value: unknown): ReviewType {
  if (value === undefined) return "stage";
  switch (value) {
    case "periodic":
    case "experiment_comparison":
    case "literature_comparison":
    case "stage":
    case "custom":
      return value as ReviewType;
    default:
      throw new Error("Review type contract violation: reviewType is unsupported.");
  }
}

export function createDefaultReviewOutlineSections(
  reviewType: ReviewType
): ReviewOutlineSection[] {
  return REVIEW_OUTLINE_TEMPLATES[reviewType].map((key) => ({ key, content: "" }));
}

export function reconcileReviewOutlineSections(
  reviewType: ReviewType,
  outlineSections: unknown
): ReviewOutlineSection[] {
  const next = new Map(
    createDefaultReviewOutlineSections(reviewType).map((section) => [
      section.key,
      section.content
    ])
  );

  for (const section of normalizeInputSections(outlineSections)) {
    const targetKey = targetKeyForRole(reviewType, section.key);
    if (targetKey) {
      next.set(targetKey, appendContent(next.get(targetKey) ?? "", section.content));
    } else if (section.content) {
      next.set(
        "other",
        appendContent(next.get("other") ?? "", `[${section.key}]\n${section.content}`)
      );
    }
  }

  return REVIEW_OUTLINE_TEMPLATES[reviewType].map((key) => ({
    key,
    content: next.get(key) ?? ""
  }));
}

export function reviewOutlineContent(
  outlineSections: ReviewOutlineSection[],
  key: ReviewOutlineSectionKey
) {
  return outlineSections.find((section) => section.key === key)?.content ?? "";
}

export function appendReviewOutlineContent(
  reviewType: ReviewType,
  outlineSections: ReviewOutlineSection[],
  additions: ReviewOutlineRoleAdditions
): ReviewOutlineSection[] {
  const sections = reconcileReviewOutlineSections(reviewType, outlineSections);
  const byKey = new Map(sections.map((section) => [section.key, section.content]));
  const values: Array<[ReviewOutlineSectionKey | undefined, string]> = [
    [firstTemplateKeyForRole(reviewType, SUMMARY_KEYS), text(additions.summaryContent)],
    [firstTemplateKeyForRole(reviewType, PROBLEM_KEYS), text(additions.problemContent)],
    [firstTemplateKeyForRole(reviewType, NEXT_PLAN_KEYS), text(additions.nextPlanContent)]
  ];
  for (const [key, content] of values) {
    if (key && content) {
      byKey.set(key, appendContent(byKey.get(key) ?? "", content));
    }
  }
  return sections.map((section) => ({
    ...section,
    content: byKey.get(section.key) ?? section.content
  }));
}

export const reviewCoreContractService = {
  normalizeReviewType,
  createDefaultReviewOutlineSections,
  reconcileReviewOutlineSections,
  reviewOutlineContent,
  appendReviewOutlineContent
};
