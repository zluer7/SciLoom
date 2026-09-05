import type {
  CustomField,
  EntityId,
  OutputSourceSummary,
  OutputSourceType,
  ResultItem,
  ResultItemType
} from "../types";
import type { LiteratureDetailContext } from "../types/literatureContext";
import type { ReviewDetailContext } from "./reviewSelectorService";
import type { StructuredSummary } from "../types/outputStructuredSummary";
import {
  createDefaultStructuredSummary,
  normalizeStructuredSummary
} from "../types/outputStructuredSummary";
import { getLiteratureDetailContext } from "./literatureSelectorService";
import { outputConversionService } from "./outputConversionService";
import { createOutputSourceLink } from "./outputSourceLinkService";
import {
  countActiveResultItemsByOutputSource,
  getOutputSourceSummary
} from "./outputSourceSelectorService";
import { planningService } from "./planningService";
import { getReviewDetailContext } from "./reviewSelectorService";

export type LiteratureReviewOutputGenerationTrigger =
  | "literatureOutline"
  | "literatureProjectNote"
  | "review";

export type LiteratureReviewOutputGenerationSourceType = Extract<
  OutputSourceType,
  "literature" | "review"
>;

export type LiteratureReviewOutputGenerationDraft = {
  trigger: LiteratureReviewOutputGenerationTrigger;
  triggerId: EntityId;
  sourceType: LiteratureReviewOutputGenerationSourceType;
  sourceId: EntityId;
  sourceTitle: string;
  sourceSummarySnapshot: string;
  resultItemTitle: string;
  summary: string;
  structuredSummary: StructuredSummary;
  sourceNote: string;
  resultType: ResultItemType;
  duplicateHint?: string;
};

export type LiteratureReviewOutputGenerationCreateInput = {
  confirmedByUser: boolean;
  resultItemTitle: string;
  summary?: string;
  structuredSummary?: StructuredSummary;
  sourceNote?: string;
  resultType?: ResultItemType;
};

export type LiteratureReviewOutputGenerationResult = {
  resultItem: ResultItem;
  sourceSummary: OutputSourceSummary;
  duplicateHint?: string;
};

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?|\/(?:Users|home|mnt|Volumes|var|tmp)\/)[^\s"'<>|]+/gi;
const TRIGGER_KIND_FIELD = "literatureReviewOutputGenerationTrigger";

function redactPathLikeText(value: string | null | undefined) {
  return (value ?? "").replace(LOCAL_PATH_PATTERN, "[local path]").trim();
}

function singleLine(value: string | null | undefined) {
  return redactPathLikeText(value).replace(/\s+/g, " ").trim();
}

function clip(value: string, limit = 900) {
  const sanitized = redactPathLikeText(value);
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, limit - 1).trimEnd()}…`;
}

function joinParts(parts: Array<string | undefined | null>, separator = "\n") {
  return parts.map((part) => singleLine(part)).filter(Boolean).join(separator);
}

function emptyResultItemStructuredSummary() {
  return createDefaultStructuredSummary("resultItem");
}

async function duplicateHint(
  sourceType: LiteratureReviewOutputGenerationSourceType,
  sourceId: EntityId
) {
  const count = await countActiveResultItemsByOutputSource(sourceType, sourceId);
  if (count <= 0) {
    return undefined;
  }
  return `Existing ResultItem records already use this ${sourceType} source: ${count}.`;
}

function sourceSummaryForLiterature(context: LiteratureDetailContext) {
  const literature = context.literature;
  return clip(
    joinParts([
      literature.authors?.length
        ? `作者：${literature.authors.map((author) => author.name).filter(Boolean).join(", ")}`
        : undefined,
      literature.year ? `年份：${literature.year}` : undefined,
      literature.venue ? `来源期刊/会议：${literature.venue}` : undefined,
      literature.readingStatus ? `阅读状态：${literature.readingStatus}` : undefined,
      literature.abstract,
      context.structuredOutlineSummary.researchProblem,
      context.structuredOutlineSummary.methodOverview,
      context.structuredOutlineSummary.mainConclusion
    ])
  );
}

function sourceSummaryForReview(context: ReviewDetailContext) {
  const review = context.review;
  return clip(
    joinParts([
      review.reviewType ? `复盘类型：${review.reviewType}` : undefined,
      review.periodLabel ? `周期：${review.periodLabel}` : undefined,
      review.periodStart || review.periodEnd
        ? `日期范围：${review.periodStart ?? ""} - ${review.periodEnd ?? ""}`
        : undefined,
      review.outlineSections
        ?.filter((section) => section.content.trim())
        .slice(0, 4)
        .map((section) => `${section.key}: ${section.content}`)
        .join("\n")
    ])
  );
}

async function requireLiteratureContext(literatureId: EntityId) {
  const context = await getLiteratureDetailContext(literatureId);
  if (!context) {
    throw new Error("Literature was not found.");
  }
  if (!context.literature.primaryProjectId) {
    throw new Error("Cannot determine a project for this literature-generated ResultItem.");
  }
  return context;
}

async function requireReviewContext(reviewId: EntityId) {
  const context = await getReviewDetailContext(reviewId);
  if (!context) {
    throw new Error("Review was not found.");
  }
  if (!context.review.projectId) {
    throw new Error("Cannot determine a project for this review-generated ResultItem.");
  }
  return context;
}

export async function buildLiteratureOutlineResultItemDraft(
  literatureId: EntityId
): Promise<LiteratureReviewOutputGenerationDraft> {
  const context = await requireLiteratureContext(literatureId);
  const literature = context.literature;
  const sourceSummarySnapshot = sourceSummaryForLiterature(context);
  return {
    trigger: "literatureOutline",
    triggerId: literature.id,
    sourceType: "literature",
    sourceId: literature.id,
    sourceTitle: singleLine(literature.title),
    sourceSummarySnapshot,
    resultItemTitle: singleLine(`文献纲要结果：${literature.title}`),
    summary: "",
    structuredSummary: emptyResultItemStructuredSummary(),
    sourceNote: clip(`来源于文献纲要：${literature.title}`),
    resultType: "document",
    duplicateHint: await duplicateHint("literature", literature.id)
  };
}

export async function buildLiteratureProjectNoteResultItemDraft(
  literatureId: EntityId
): Promise<LiteratureReviewOutputGenerationDraft> {
  const context = await requireLiteratureContext(literatureId);
  const literature = context.literature;
  const sourceSummarySnapshot = sourceSummaryForLiterature(context);
  return {
    trigger: "literatureProjectNote",
    triggerId: literature.id,
    sourceType: "literature",
    sourceId: literature.id,
    sourceTitle: singleLine(literature.title),
    sourceSummarySnapshot,
    resultItemTitle: singleLine(`专属课题笔记结果：${literature.title}`),
    summary: "",
    structuredSummary: emptyResultItemStructuredSummary(),
    sourceNote: clip(`来源于文献专属课题笔记：${literature.title}`),
    resultType: "document",
    duplicateHint: await duplicateHint("literature", literature.id)
  };
}

export async function buildLiteratureResultItemDraft(
  literatureId: EntityId
): Promise<LiteratureReviewOutputGenerationDraft> {
  return buildLiteratureOutlineResultItemDraft(literatureId);
}

export async function buildReviewResultItemDraft(
  reviewId: EntityId
): Promise<LiteratureReviewOutputGenerationDraft> {
  const context = await requireReviewContext(reviewId);
  const review = context.review;
  const sourceSummarySnapshot = sourceSummaryForReview(context);
  return {
    trigger: "review",
    triggerId: review.id,
    sourceType: "review",
    sourceId: review.id,
    sourceTitle: singleLine(review.title),
    sourceSummarySnapshot,
    resultItemTitle: singleLine(`复盘结果：${review.title}`),
    summary: "",
    structuredSummary: emptyResultItemStructuredSummary(),
    sourceNote: clip(`来源于复盘：${review.title}`),
    resultType: "text",
    duplicateHint: await duplicateHint("review", review.id)
  };
}

function customFieldsFor(trigger: LiteratureReviewOutputGenerationTrigger): CustomField[] {
  return [
    {
      id: `literature-review-output-generation:${TRIGGER_KIND_FIELD}`,
      name: TRIGGER_KIND_FIELD,
      value: trigger,
      valueType: "text",
      group: "outputGeneration"
    }
  ];
}

async function createFromDraft(
  draft: LiteratureReviewOutputGenerationDraft,
  input: LiteratureReviewOutputGenerationCreateInput,
  projectId: EntityId
): Promise<LiteratureReviewOutputGenerationResult> {
  if (!input.confirmedByUser) {
    throw new Error("User confirmation is required before creating a ResultItem.");
  }
  const title = singleLine(input.resultItemTitle);
  if (!title) {
    throw new Error("结果项标题不能为空。");
  }

  const structuredSummary = normalizeStructuredSummary(
    "resultItem",
    input.structuredSummary ?? emptyResultItemStructuredSummary()
  ).map((section) => ({ ...section, value: redactPathLikeText(section.value) }));
  const sourceNote = redactPathLikeText(input.sourceNote ?? draft.sourceNote);

  const resultItem = await outputConversionService.createResultItem({
    projectId,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    title,
    resultType: input.resultType ?? draft.resultType,
    status: "pending_review",
    structuredSummary,
    summary: redactPathLikeText(input.summary ?? ""),
    tags: [],
    customFields: customFieldsFor(draft.trigger)
  });

  await createOutputSourceLink({
    projectId,
    ownerType: "resultItem",
    ownerId: resultItem.id,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    sourceTitleSnapshot: draft.sourceTitle,
    sourceSummarySnapshot: draft.sourceSummarySnapshot,
    sourceNote,
    relationType: "primary"
  });

  const [persisted, sourceSummary] = await Promise.all([
    outputConversionService.getResultItemById(resultItem.id),
    getOutputSourceSummary("resultItem", resultItem.id)
  ]);
  if (!persisted) {
    throw new Error("ResultItem was not readable after create.");
  }
  if (
    !sourceSummary.cards.some(
      (card) => card.sourceType === draft.sourceType && card.sourceId === draft.sourceId
    )
  ) {
    throw new Error("ResultItem was created but canonical source link was not readable.");
  }

  return {
    resultItem: persisted,
    sourceSummary,
    duplicateHint: draft.duplicateHint
  };
}

export async function createResultItemFromLiterature(
  literatureId: EntityId,
  input: LiteratureReviewOutputGenerationCreateInput
) {
  return createResultItemFromLiteratureOutline(literatureId, input);
}

export async function createResultItemFromLiteratureOutline(
  literatureId: EntityId,
  input: LiteratureReviewOutputGenerationCreateInput
) {
  const context = await requireLiteratureContext(literatureId);
  const draft = await buildLiteratureOutlineResultItemDraft(literatureId);
  return createFromDraft(draft, input, context.literature.primaryProjectId as EntityId);
}

export async function createResultItemFromLiteratureProjectNote(
  literatureId: EntityId,
  input: LiteratureReviewOutputGenerationCreateInput
) {
  const context = await requireLiteratureContext(literatureId);
  const draft = await buildLiteratureProjectNoteResultItemDraft(literatureId);
  return createFromDraft(draft, input, context.literature.primaryProjectId as EntityId);
}

export async function createResultItemFromReview(
  reviewId: EntityId,
  input: LiteratureReviewOutputGenerationCreateInput
) {
  const review = await planningService.getReviewById(reviewId);
  if (!review) {
    throw new Error("Review was not found.");
  }
  const draft = await buildReviewResultItemDraft(reviewId);
  return createFromDraft(draft, input, review.projectId);
}

export const literatureReviewOutputGenerationService = {
  buildLiteratureOutlineResultItemDraft,
  buildLiteratureProjectNoteResultItemDraft,
  buildLiteratureResultItemDraft,
  buildReviewResultItemDraft,
  createResultItemFromLiteratureOutline,
  createResultItemFromLiteratureProjectNote,
  createResultItemFromLiterature,
  createResultItemFromReview
};
