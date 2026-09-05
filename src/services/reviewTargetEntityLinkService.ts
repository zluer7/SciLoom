import type {
  EntityId,
  EntityLink,
  EntityType,
  RelationType,
  Review,
  ReviewType
} from "../types/planning";

export type ReviewFormalTargetType =
  | "project"
  | "routeNode"
  | "task"
  | "experiment"
  | "experimentRun"
  | "literature";

export type ReviewLinkTargetType = Exclude<ReviewFormalTargetType, "project">;

export type ReviewTargetInput = {
  targetType: ReviewLinkTargetType;
  targetId: EntityId;
  relationType?: RelationType;
  description?: string;
};

export type ReviewTargetSummary = {
  targetType: ReviewFormalTargetType;
  targetId: EntityId;
  title?: string;
  status?: string;
  summary?: string;
  sourceBoundary: "directTarget";
  missing: boolean;
  warning?: string;
  linkId?: EntityId;
  relationType?: RelationType;
};

export type ReviewTargetSnapshotSummary = {
  title?: string;
  status?: string;
  summary?: string;
  projectId?: EntityId | null;
  experimentId?: EntityId | null;
};

export type ReviewTargetSnapshotSummaryMap = {
  [targetType in ReviewFormalTargetType]?: Record<EntityId, ReviewTargetSnapshotSummary>;
};

export type ReviewTargetValidationResult = {
  normalizedTargets: ReviewTargetInput[];
};

const FORMAL_LINK_TARGET_TYPES: ReviewLinkTargetType[] = [
  "routeNode",
  "task",
  "experiment",
  "experimentRun",
  "literature"
];

const FORMAL_LINK_TARGET_TYPE_SET = new Set<string>(FORMAL_LINK_TARGET_TYPES);

export function isReviewFormalLinkTargetType(value: unknown): value is ReviewLinkTargetType {
  return typeof value === "string" && FORMAL_LINK_TARGET_TYPE_SET.has(value);
}

export function isReviewFormalTargetType(value: unknown): value is ReviewFormalTargetType {
  return value === "project" || isReviewFormalLinkTargetType(value);
}

function assertReviewPeriodContract(
  review: Pick<Review, "reviewType" | "periodStart" | "periodEnd" | "periodLabel">
) {
  const hasPeriodStart = Boolean(review.periodStart);
  const hasPeriodEnd = Boolean(review.periodEnd);
  const hasPeriod = hasPeriodStart || hasPeriodEnd;
  const hasPeriodLabel = Boolean(review.periodLabel?.trim());

  if (hasPeriodStart !== hasPeriodEnd) {
    throw new Error(
      "Review period contract violation: periodStart and periodEnd must be provided together."
    );
  }
  if (review.periodStart && review.periodEnd && review.periodStart > review.periodEnd) {
    throw new Error(
      "Review period contract violation: periodStart must not be later than periodEnd."
    );
  }
  // A fully absent period is legal P2 content for every Review type, including
  // periodic. Once any period value is supplied, the tuple/order/label checks
  // above and below remain the canonical execution boundary.
  if (hasPeriodLabel && !hasPeriod) {
    throw new Error(
      "Review period contract violation: periodLabel is display-only and cannot replace periodStart / periodEnd."
    );
  }
}

function normalizeReviewTarget(target: ReviewTargetInput | { targetType: string; targetId: EntityId }) {
  const targetType = String(target.targetType).trim();
  const targetId = String(target.targetId ?? "").trim();

  if (targetType === "project") {
    throw new Error(
      "Review target contract violation: Project target must be expressed by Review.projectId."
    );
  }
  if (!isReviewFormalLinkTargetType(targetType)) {
    throw new Error(`Review targetType is not supported: ${targetType}.`);
  }
  if (!targetId) {
    throw new Error(`Review targetId is required for ${targetType}.`);
  }
  if ("relationType" in target && target.relationType && target.relationType !== "summarizes") {
    throw new Error(`Review target relationType must be summarizes: ${target.relationType}.`);
  }

  return {
    ...target,
    targetType,
    targetId,
    relationType: "summarizes" as const
  };
}

export function uniqueReviewTargets(
  targets: Array<ReviewTargetInput | { targetType: string; targetId: EntityId }>
): ReviewTargetInput[] {
  const byKey = new Map<string, ReviewTargetInput>();
  for (const target of targets) {
    const normalized = normalizeReviewTarget(target);
    byKey.set(`${normalized.targetType}:${normalized.targetId}`, normalized);
  }
  return [...byKey.values()];
}

function targetSnapshot(
  summaries: ReviewTargetSnapshotSummaryMap,
  target: ReviewTargetInput
) {
  return summaries[target.targetType]?.[target.targetId];
}

function assertTargetProject(
  reviewProjectId: EntityId,
  target: ReviewTargetInput,
  summary: ReviewTargetSnapshotSummary | undefined
) {
  if (!summary) {
    throw new Error(
      `Review target contract violation: ${target.targetType} target ${target.targetId} is missing.`
    );
  }
  if (summary.projectId !== reviewProjectId) {
    throw new Error(
      `Review target contract violation: ${target.targetType} target ${target.targetId} must belong to project ${reviewProjectId}.`
    );
  }
}

function assertCountRules(reviewType: ReviewType, targets: ReviewTargetInput[]) {
  if (reviewType === "experiment_comparison") {
    const experimentLikeCount = targets.filter(
      (target) => target.targetType === "experiment" || target.targetType === "experimentRun"
    ).length;
    if (experimentLikeCount < 2) {
      throw new Error(
        "Review target contract violation: experiment_comparison requires at least 2 Experiment or ExperimentRun targets."
      );
    }
  }

  if (reviewType === "literature_comparison") {
    const literatureCount = targets.filter((target) => target.targetType === "literature").length;
    if (literatureCount < 2) {
      throw new Error(
        "Review target contract violation: literature_comparison requires at least 2 Literature targets."
      );
    }
  }
}

export function validateReviewTargetContractInSnapshot(
  review: Pick<
    Review,
    "projectId" | "reviewType" | "periodStart" | "periodEnd" | "periodLabel"
  >,
  targets: Array<ReviewTargetInput | { targetType: string; targetId: EntityId }>,
  summaries: ReviewTargetSnapshotSummaryMap
): ReviewTargetValidationResult {
  if (!review.projectId?.trim()) {
    throw new Error("Review core contract violation: projectId is required.");
  }

  assertReviewPeriodContract(review);
  const normalizedTargets = uniqueReviewTargets(targets);
  for (const target of normalizedTargets) {
    assertTargetProject(review.projectId, target, targetSnapshot(summaries, target));
  }
  assertCountRules(review.reviewType, normalizedTargets);

  return { normalizedTargets };
}

function isFormalReviewTargetLink(link: EntityLink, reviewId: EntityId) {
  return (
    link.sourceType === "review" &&
    link.sourceId === reviewId &&
    link.relationType === "summarizes" &&
    (link.targetType === "project" || isReviewFormalLinkTargetType(link.targetType))
  );
}

function stableTargetLinkId(reviewId: EntityId, target: ReviewTargetInput) {
  const safeReviewId = reviewId.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeTargetId = target.targetId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `review-target-${safeReviewId}-${target.targetType}-${safeTargetId}`;
}

export function replaceReviewTargetLinksInSnapshot(
  links: EntityLink[],
  reviewId: EntityId,
  normalizedTargets: ReviewTargetInput[],
  timestamp: string
): EntityLink[] {
  const preservedLinks = links.filter((link) => !isFormalReviewTargetLink(link, reviewId));
  const nextLinks: EntityLink[] = uniqueReviewTargets(normalizedTargets).map((target) => ({
    id: stableTargetLinkId(reviewId, target),
    sourceType: "review",
    sourceId: reviewId,
    targetType: target.targetType as EntityType,
    targetId: target.targetId,
    relationType: "summarizes",
    description:
      target.description ??
      `Review ${reviewId} summarizes ${target.targetType}:${target.targetId}.`,
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: 1
  }));

  return [...preservedLinks, ...nextLinks];
}

function targetSummary(
  targetType: ReviewFormalTargetType,
  targetId: EntityId,
  summary: ReviewTargetSnapshotSummary | undefined,
  link?: EntityLink
): ReviewTargetSummary {
  return {
    targetType,
    targetId,
    title: summary?.title,
    status: summary?.status,
    summary: summary?.summary,
    sourceBoundary: "directTarget",
    missing: !summary,
    warning: summary ? undefined : `${targetType} target is missing: ${targetId}`,
    linkId: link?.id,
    relationType: link?.relationType
  };
}

export function queryReviewTargetSummariesFromSnapshot(
  review: Pick<Review, "id" | "projectId">,
  links: EntityLink[],
  summaries: ReviewTargetSnapshotSummaryMap
): ReviewTargetSummary[] {
  const results: ReviewTargetSummary[] = [
    targetSummary("project", review.projectId, summaries.project?.[review.projectId])
  ];
  const seen = new Set<string>([`project:${review.projectId}`]);
  for (const link of links) {
    if (
      link.sourceType !== "review" ||
      link.sourceId !== review.id ||
      link.relationType !== "summarizes" ||
      !isReviewFormalLinkTargetType(link.targetType)
    ) {
      continue;
    }
    const key = `${link.targetType}:${link.targetId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(
      targetSummary(
        link.targetType,
        link.targetId,
        summaries[link.targetType]?.[link.targetId],
        link
      )
    );
  }

  return results;
}
