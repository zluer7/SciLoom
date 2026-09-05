import type { EntityId } from "../types/common";
import type { Review } from "../types/planning";
import {
  REVIEW_MANUSCRIPT_ERROR_CODES,
  type ReviewManuscriptStructuredDto,
  type ReviewManuscriptStructuredResult,
  type ReviewManuscriptTargetDto,
  type ReviewManuscriptTargetType,
  type ReviewManuscriptWarning
} from "../types/reviewManuscript";
import { planningService } from "./planningService";
import type { ReviewTargetSummary } from "./reviewTargetEntityLinkService";
import { reconcileReviewOutlineSections } from "./reviewCoreContractService";
import {
  getReviewOutlineDisplayName,
  getReviewTargetTypeDisplayName,
  getReviewTypeDisplayName
} from "./reviewManuscriptPresentationService";

export interface ReviewManuscriptStructuredDataDependencies {
  getReviewRecord(reviewId: EntityId): Promise<Review | undefined>;
  getTargets(reviewId: EntityId): Promise<ReviewTargetSummary[]>;
}

const defaultDependencies: ReviewManuscriptStructuredDataDependencies = {
  getReviewRecord: planningService.getReviewById,
  getTargets: planningService.queryReviewTargets
};

const TARGET_ORDER: Readonly<Record<ReviewManuscriptTargetType, number>> = {
  project: 0,
  routeNode: 1,
  task: 2,
  experiment: 3,
  experimentRun: 4,
  literature: 5
};

function toTarget(item: ReviewTargetSummary): Omit<ReviewManuscriptTargetDto, "order"> {
  const targetType = item.targetType as ReviewManuscriptTargetType;
  return {
    targetType,
    targetId: item.targetId,
    displayName: item.missing
      ? `缺失的${getReviewTargetTypeDisplayName(targetType)}`
      : item.title?.trim() || `未命名${getReviewTargetTypeDisplayName(targetType)}`,
    missing: item.missing
  };
}

function stableTargets(targetSummaries: ReviewTargetSummary[]) {
  return targetSummaries
    .map(toTarget)
    .sort((left, right) => {
      const typeOrder = TARGET_ORDER[left.targetType] - TARGET_ORDER[right.targetType];
      return typeOrder || left.targetId.localeCompare(right.targetId, "en");
    })
    .map((target, order) => ({ ...target, order }));
}

function safeWarnings(targets: ReviewManuscriptTargetDto[]) {
  const warnings: ReviewManuscriptWarning[] = [];
  if (!targets.some((target) => target.targetType === "project" && !target.missing)) {
    warnings.push({ code: "project_missing", message: "所属课题不可用，快照使用缺失提示。" });
  }
  for (const target of targets.filter((item) => item.missing && item.targetType !== "project")) {
    warnings.push({
      code: "target_missing",
      message: `${getReviewTargetTypeDisplayName(target.targetType)}复盘对象不可用，已保留缺失提示。`
    });
  }
  return warnings.filter(
    (warning, index, list) => list.findIndex((item) => item.code === warning.code && item.message === warning.message) === index
  );
}

export function buildReviewManuscriptStructuredDto(
  review: Review,
  targetSummaries: ReviewTargetSummary[]
): ReviewManuscriptStructuredDto {
  const targets = stableTargets(targetSummaries);
  const inputKeys = new Set(review.outlineSections.map((section) => section.key));
  const outlineSections = reconcileReviewOutlineSections(
    review.reviewType,
    review.outlineSections
  ).map((section, order) => ({
    key: section.key,
    displayName: getReviewOutlineDisplayName(section.key),
    content: section.content,
    missing: !inputKeys.has(section.key),
    order
  }));
  const projectTarget = targets.find((target) => target.targetType === "project");
  const projectMissing = !projectTarget || projectTarget.missing;
  const warnings = safeWarnings(targets);

  return {
    reviewId: review.id,
    projectId: review.projectId,
    projectDisplayName: projectMissing
      ? "所属课题不可用"
      : projectTarget.displayName,
    projectMissing,
    title: review.title,
    description: review.description ?? "",
    reviewType: review.reviewType,
    reviewTypeDisplayName: getReviewTypeDisplayName(review.reviewType),
    periodStart: review.periodStart,
    periodEnd: review.periodEnd,
    periodLabel: review.periodLabel,
    tags: [...review.tags],
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    outlineSections,
    targets,
    warnings,
    provenance: [
      { source: "复盘结构化记录", confidence: "direct" },
      { source: "正式复盘对象关系", confidence: targets.some((target) => target.missing) ? "missing" : "direct" },
      { source: "复盘对象选择服务", confidence: targets.some((target) => target.missing) ? "derived" : "direct", note: targets.some((target) => target.missing) ? "包含缺失复盘对象提示" : undefined }
    ]
  };
}

export function createReviewManuscriptStructuredDataService(
  dependencies: ReviewManuscriptStructuredDataDependencies = defaultDependencies
) {
  return {
    async get(reviewId: EntityId): Promise<ReviewManuscriptStructuredResult> {
      const review = await dependencies.getReviewRecord(reviewId);
      if (!review) {
        return {
          status: "error",
          error: {
            code: REVIEW_MANUSCRIPT_ERROR_CODES.ownerMissing,
            message: `Review does not exist: ${reviewId}.`
          }
        };
      }
      if (review.deletedAt) {
        return {
          status: "error",
          error: {
            code: REVIEW_MANUSCRIPT_ERROR_CODES.ownerDeleted,
            message: `Review is deleted: ${reviewId}.`
          }
        };
      }
      const targets = await dependencies.getTargets(reviewId);
      return {
        status: "success",
        dto: buildReviewManuscriptStructuredDto(review, targets)
      };
    }
  };
}

export const reviewManuscriptStructuredDataService =
  createReviewManuscriptStructuredDataService();
