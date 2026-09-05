import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextLevel,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { EntitySummary } from "../types/entityContext";
import { fileRefService } from "./fileRefService";
import { planningSelectorService } from "./planningSelectorService";
import { planningService } from "./planningService";

export class ReviewResearchObjectResolutionError extends Error {
  constructor(
    readonly code:
      | "REVIEW_NOT_FOUND"
      | "REVIEW_UNAVAILABLE"
      | "REVIEW_PROJECT_MISMATCH"
      | "REVIEW_CONTEXT_STALE"
      | "REVIEW_CONTEXT_PROJECT_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "ReviewResearchObjectResolutionError";
  }
}

function estimatedChars(...values: Array<string | undefined>): number {
  return values.reduce((total, value) => total + (value?.length ?? 0), 0);
}

function safeRequestableLabel(value: string, fallback: string): string {
  const cleaned = value.replace(/[\0-\x1F\x7F]/gu, " ").trim();
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  const leaf = parts[parts.length - 1]?.trim();
  return Array.from(leaf || fallback).slice(0, 160).join("");
}

function sourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  field: string,
  level: AIContextLevel,
  role: AIContextSourceRef["contextRole"]
): AIContextSourceRef {
  return {
    ...descriptor.sourceRef,
    field,
    contextMode: mode,
    contextLevel: level,
    contextRole: role,
    contextDisposition: "included"
  };
}

function relatedSourceRef(
  summary: EntitySummary,
  mode: AIContextMode,
  reviewId: string
): AIContextSourceRef {
  const module = summary.entityType === "routeNode"
    ? "route"
    : summary.entityType === "task"
      ? "task"
      : summary.entityType === "experiment" || summary.entityType === "experimentSummary"
        ? "experiment"
        : "review";
  const entityType = summary.entityType === "experimentSummary" ? "experiment" : summary.entityType;
  return {
    module,
    entityType: entityType as AIContextSourceRef["entityType"],
    entityId: summary.entityId,
    label: summary.title,
    field: "review-scoped direct relation summary",
    sourceKind: "derivedSummary",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: false,
    contextMode: mode,
    contextLevel: 2,
    contextRole: "related",
    contextDisposition: "included",
    relationHint: `review_scope:review=${reviewId}`
  };
}

function contextItem(input: {
  id: string;
  title: string;
  summary: string;
  module: AIContextItem["module"];
  entityType: AIContextItem["entityType"];
  sourceRef: AIContextSourceRef;
  level: AIContextLevel;
  stableOrder: number;
  protectedFromContextBudget?: boolean;
}): AIContextItem {
  return {
    id: input.id,
    title: input.title,
    summary: input.summary || input.title,
    module: input.module,
    entityType: input.entityType,
    sourceRefs: [input.sourceRef],
    priority: input.level === 1 ? "critical" : "high",
    contextLevel: input.level,
    protectedFromContextBudget: input.protectedFromContextBudget,
    stableOrder: input.stableOrder,
    charCount: estimatedChars(input.title, input.summary || input.title),
    sendable: true,
    truncated: false
  };
}

export async function resolveReviewResearchObjectDescriptor(
  reviewId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const review = await planningService.getReviewById(reviewId);
  if (!review) {
    throw new ReviewResearchObjectResolutionError(
      "REVIEW_NOT_FOUND",
      `Selected Review is missing or no longer active: ${reviewId}`
    );
  }
  if (review.deletedAt || review.structuredLifecycleStatus === "deleted" ||
      review.structuredLifecycleStatus === "permanently_deleted") {
    throw new ReviewResearchObjectResolutionError(
      "REVIEW_UNAVAILABLE",
      `Selected Review is unavailable for new AI context: ${reviewId}`
    );
  }
  if (review.projectId !== expectedProjectId) {
    throw new ReviewResearchObjectResolutionError(
      "REVIEW_PROJECT_MISMATCH",
      `Selected Review ${reviewId} does not belong to Project ${expectedProjectId}.`
    );
  }
  return {
    objectType: "review",
    objectId: review.id,
    projectId: review.projectId,
    label: review.title,
    description: review.description,
    sourceRef: {
      module: "review",
      entityType: "review",
      entityId: review.id,
      label: review.title,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      reviewType: review.reviewType,
      periodStart: review.periodStart ?? null,
      periodEnd: review.periodEnd ?? null,
      periodLabel: review.periodLabel ?? null,
      updatedAt: review.updatedAt
    },
    ownerModule: "review",
    channel: "global_chat"
  };
}

export async function listReviewResearchObjectDescriptors(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const reviews = await planningService.queryReviewFirstLayerIdentities({ projectId });
  return reviews.map((review) => ({
    objectType: "review",
    objectId: review.id,
    projectId: review.projectId,
    label: review.title,
    description: review.description,
    sourceRef: {
      module: "review",
      entityType: "review",
      entityId: review.id,
      label: review.title,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      periodStart: review.periodStart ?? null,
      periodEnd: review.periodEnd ?? null,
      periodLabel: review.periodLabel ?? null,
      updatedAt: review.updatedAt
    },
    ownerModule: "review",
    channel: "global_chat"
  }));
}

export type ReviewResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

const REVIEW_RELATED_CONTEXT_LIMIT = 8;
const REVIEW_FILE_REF_REQUEST_INDEX_LIMIT = 10;

export async function buildReviewResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): Promise<ReviewResearchObjectContextCandidates> {
  const basic = await planningSelectorService.getReviewBasicContext(descriptor.objectId);
  if (!basic || basic.review.id !== descriptor.objectId) {
    throw new ReviewResearchObjectResolutionError(
      "REVIEW_CONTEXT_STALE",
      `Review context became stale before package finalization: ${descriptor.objectId}`
    );
  }
  if (!basic.project || basic.project.entityId !== descriptor.projectId) {
    throw new ReviewResearchObjectResolutionError(
      "REVIEW_CONTEXT_PROJECT_MISMATCH",
      `Review ${descriptor.objectId} no longer resolves to Project ${descriptor.projectId}.`
    );
  }
  const period = [basic.period.start, basic.period.end].filter(Boolean).join(" → ");
  const summary = mode !== "MINIMAL"
    ? [
        `Type: ${basic.review.reviewType}`,
        basic.review.description?.trim(),
        period ? `Period: ${period}` : undefined,
        basic.period.label ? `Period label: ${basic.period.label}` : undefined,
        basic.outlineSections.some((section) => section.content.trim())
          ? basic.outlineSections
              .filter((section) => section.content.trim())
              .map((section) => `${section.key}: ${section.content.trim()}`)
              .join("\n")
          : undefined
      ].filter(Boolean).join(" | ")
    : `Type: ${basic.review.reviewType}`;
  const primary = contextItem({
    id: `primary-review:${descriptor.objectId}`,
    title: descriptor.label,
    summary,
    module: "review",
    entityType: "review",
    sourceRef: sourceRef(
      descriptor,
      mode,
      mode !== "MINIMAL" ? "bounded review summary" : "identity",
      1,
      "primary"
    ),
    level: 1,
    stableOrder: selectionOrder,
    protectedFromContextBudget: true
  });

  const relationSummaries = [...basic.routeNodes, ...basic.tasks, ...basic.experiments]
    .filter((item) => item.sourceAvailable !== false)
    .sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
  const related = mode !== "MINIMAL"
    ? relationSummaries.slice(0, REVIEW_RELATED_CONTEXT_LIMIT).map((item, index) => {
        const ref = relatedSourceRef(item, mode, descriptor.objectId);
        return contextItem({
          id: `review-related:${descriptor.objectId}:${item.entityType}:${item.entityId}`,
          title: item.title,
          summary: [item.subtitle, item.status ? `Status: ${item.status}` : undefined].filter(Boolean).join(" | "),
          module: ref.module,
          entityType: ref.entityType,
          sourceRef: ref,
          level: 2,
          stableOrder: selectionOrder * 100 + index
        });
      })
    : [];
  const excluded: AIContextExcludedItem[] = [];
  if (mode === "MINIMAL" && relationSummaries.length > 0) {
    excluded.push({
      reason: "notSelected",
      module: "review",
      entityType: "review",
      entityId: descriptor.objectId,
      label: `${relationSummaries.length} Review relations were excluded by ${mode}.`,
      sourceRefs: []
    });
  } else if (relationSummaries.length > REVIEW_RELATED_CONTEXT_LIMIT) {
    excluded.push({
      reason: "notSelected",
      module: "review",
      entityType: "review",
      entityId: descriptor.objectId,
      label: `${relationSummaries.length - REVIEW_RELATED_CONTEXT_LIMIT} additional Review relations were excluded by the bounded policy.`,
      sourceRefs: []
    });
  }

  const fileRefs = await fileRefService.getFileRefsByOwner("review", descriptor.objectId);
  const requestableRefs: AIContextRequestableRef[] = fileRefs
    .filter((fileRef) => !fileRef.deletedAt && fileRef.resourceKind === "file")
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, REVIEW_FILE_REF_REQUEST_INDEX_LIMIT)
    .map((fileRef) => ({
      refKind: "FILE_REF",
      refId: fileRef.id,
      projectId: descriptor.projectId,
      label: safeRequestableLabel(fileRef.title || fileRef.path, fileRef.id),
      entityType: "fileRef",
      allowedContributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
    }));
  const warnings = [...basic.warnings].sort();
  if (fileRefs.length > REVIEW_FILE_REF_REQUEST_INDEX_LIMIT) {
    warnings.push(
      `${fileRefs.length - REVIEW_FILE_REF_REQUEST_INDEX_LIMIT} additional Review FileRefs were omitted from the bounded Context Request index.`
    );
  }
  return { primary, related, excluded, warnings, requestableRefs };
}
