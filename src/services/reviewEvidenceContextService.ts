import type { EntityId } from "../types/common";
import type { EntitySummary, EvidenceSummary, LinkedEntitySummary } from "../types/entityContext";
import type { MissingEntityReference } from "../types/entityReference";
import type { Review } from "../types/planning";
import type {
  ReviewDirectTargetEvidence,
  ReviewEvidenceBase,
  ReviewEvidenceBoundary,
  ReviewEvidenceContext,
  ReviewEvidenceLimitations,
  ReviewEvidenceRole,
  ReviewEvidenceScopeSensitivity,
  ReviewEvidenceSourceKind,
  ReviewEvidenceStats,
  ReviewPeriodContextOptions,
  ReviewContextScope,
  ReviewScopeSummary
} from "../types/planningContext";

const DEFERRED_WIRING_WARNING =
  "Review evidence context DTO is defined; aggregation wiring is deferred to UI-8-4/UI-8-5.";

const EMPTY_STATS: ReviewEvidenceStats = {
  directTargetEvidenceCount: 0,
  periodEvidenceCount: 0,
  indirectEvidenceCount: 0,
  derivedOutputEvidenceCount: 0,
  existingReviewContentEvidenceCount: 0,
  taskEvidenceCount: 0,
  experimentEvidenceCount: 0,
  literatureEvidenceCount: 0,
  outputEvidenceCount: 0,
  warningCount: 0,
  missingReferenceCount: 0,
  partialEvidenceCount: 0
};

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function missingReferenceKey(reference: MissingEntityReference) {
  return [
    reference.sourceType ?? "",
    reference.sourceId ?? "",
    reference.targetType,
    reference.targetId,
    reference.relationType ?? "",
    reference.reason
  ].join(":");
}

function uniqueMissingReferences(references: MissingEntityReference[]): MissingEntityReference[] {
  const byKey = new Map<string, MissingEntityReference>();
  references.forEach((reference) => byKey.set(missingReferenceKey(reference), reference));
  return [...byKey.values()];
}

function targetSummaryFromTarget(target: EntitySummary | LinkedEntitySummary): EntitySummary {
  return "target" in target ? target.target : target;
}

function targetTypeForSummary(summary: EntitySummary): string {
  return summary.entityType === "route" ? "routeNode" : summary.entityType;
}

function sourceKindForTarget(summary: EntitySummary): ReviewDirectTargetEvidence["sourceKind"] {
  return summary.entityType === "project" ? "scope_anchor" : "direct_target_evidence";
}

function roleForTarget(summary: EntitySummary): ReviewDirectTargetEvidence["role"] {
  if (!summary.sourceAvailable) return "missing";
  return summary.entityType === "project" ? "anchor" : "direct";
}

function sensitivityForTarget(summary: EntitySummary): ReviewEvidenceScopeSensitivity[] {
  const sensitivities: ReviewEvidenceScopeSensitivity[] =
    summary.entityType === "project" ? ["scope_anchor", "project_boundary"] : ["target_bound"];
  if (summary.entityType === "routeNode" || summary.entityType === "route") {
    sensitivities.push("route_boundary");
  }
  if (summary.entityType === "task") {
    sensitivities.push("task_boundary");
  }
  return sensitivities;
}

function sourceBoundaryForTarget(summary: EntitySummary): string {
  if (summary.entityType === "project") return "Review project anchor.";
  if (summary.entityType === "routeNode" || summary.entityType === "route") {
    return "Review route-node target.";
  }
  if (summary.entityType === "task") return "Review task target.";
  return "Review direct target.";
}

export function buildReviewScopeSummary(
  review: Pick<
    Review,
    | "id"
    | "projectId"
    | "periodStart"
    | "periodEnd"
    | "periodLabel"
  >,
  targets: Array<EntitySummary | LinkedEntitySummary> = []
): ReviewScopeSummary {
  const targetSummaries = targets.map(targetSummaryFromTarget);
  const targetProjectIds = targetSummaries
    .filter((summary) => summary.entityType === "project")
    .map((summary) => summary.entityId);
  const targetRouteNodeIds = targetSummaries
    .filter((summary) => summary.entityType === "routeNode" || summary.entityType === "route")
    .map((summary) => summary.entityId);
  const targetTaskIds = targetSummaries
    .filter((summary) => summary.entityType === "task")
    .map((summary) => summary.entityId);
  const allRouteNodeIds = uniqueStrings(targetRouteNodeIds) as EntityId[];
  const allTaskIds = uniqueStrings(targetTaskIds) as EntityId[];
  const scope: ReviewContextScope =
    allRouteNodeIds.length > 0 && allTaskIds.length > 0
      ? "mixed"
      : allTaskIds.length > 0
        ? "task"
        : allRouteNodeIds.length > 0
          ? "route"
          : "project";

  return {
    reviewId: review.id,
    projectId: review.projectId,
    scope,
    period: {
      start: review.periodStart,
      end: review.periodEnd,
      label: review.periodLabel
    },
    targetProjectIds: uniqueStrings([review.projectId, ...targetProjectIds]),
    targetRouteNodeIds: allRouteNodeIds,
    targetTaskIds: allTaskIds,
    hasExplicitTargets:
      targetSummaries.length > 0 ||
      allRouteNodeIds.length > 0 ||
      allTaskIds.length > 0,
    hasPeriod: Boolean(review.periodStart && review.periodEnd)
  };
}

export function createReviewScopeSummary(scope: ReviewContextScope): ReviewScopeSummary {
  return {
    scope,
    period: {},
    targetProjectIds: [],
    targetRouteNodeIds: [],
    targetTaskIds: [],
    hasExplicitTargets: false,
    hasPeriod: false
  };
}

export function createPeriodReviewScopeSummary(
  options: Pick<ReviewPeriodContextOptions, "projectId" | "routeNodeId" | "startDate" | "endDate">
): ReviewScopeSummary {
  const hasPeriod = Boolean(options.startDate || options.endDate);

  return {
    projectId: options.projectId,
    scope: options.routeNodeId ? "route" : "project",
    period: {
      start: options.startDate,
      end: options.endDate
    },
    targetProjectIds: options.projectId ? [options.projectId] : [],
    targetRouteNodeIds: options.routeNodeId ? [options.routeNodeId] : [],
    targetTaskIds: [],
    hasExplicitTargets: Boolean(options.projectId || options.routeNodeId),
    hasPeriod
  };
}

export function createReviewEvidenceBoundary(
  sourceKinds: ReviewEvidenceSourceKind[] = [
    "scope_anchor",
    "direct_target_evidence",
    "period_evidence",
    "indirect_cross_module_evidence",
    "derived_output_evidence",
    "existing_review_content",
    "warning_only"
  ]
): ReviewEvidenceBoundary {
  return {
    sourceKinds,
    scopeSensitivity: [
      "scope_anchor",
      "target_bound",
      "period_bound",
      "link_bound",
      "derived_chain",
      "project_summary",
      "warning_only"
    ],
    sourceBoundary:
      "Review evidence is source-classified before aggregation consumers treat it as context.",
    excludesLocalFileBodies: true,
    excludesPdfFullText: true,
    excludesExperimentRawData: true,
    aggregationWiringDeferred: true
  };
}

export function createEmptyReviewEvidenceContext(
  scopeSummary: ReviewScopeSummary,
  options: {
    warnings?: string[];
    missingReferences?: MissingEntityReference[];
    partialReasons?: string[];
    limitations?: ReviewEvidenceLimitations[];
  } = {}
): ReviewEvidenceContext {
  const warnings = uniqueStrings([DEFERRED_WIRING_WARNING, ...(options.warnings ?? [])]);
  const partialReasons = uniqueStrings([
    "aggregation_wiring_deferred",
    ...(options.partialReasons ?? [])
  ]);

  return {
    scopeSummary,
    directTargetEvidence: [],
    periodEvidence: [],
    indirectEvidence: [],
    derivedOutputEvidence: [],
    existingReviewContentEvidence: [],
    taskEvidence: [],
    experimentEvidence: [],
    literatureEvidence: [],
    outputEvidence: [],
    stats: {
      ...EMPTY_STATS,
      warningCount: warnings.length,
      missingReferenceCount: options.missingReferences?.length ?? 0
    },
    boundary: createReviewEvidenceBoundary(),
    warnings,
    missingReferences: uniqueMissingReferences(options.missingReferences ?? []),
    partial: true,
    partialReasons,
    limitations: [
      {
        code: "aggregation_wiring_deferred",
        message: "UI-8-3 defines DTO and helper boundaries only; UI-8-4/UI-8-5 will wire real aggregation evidence."
      },
      ...(options.limitations ?? [])
    ]
  };
}

export function createReviewEvidenceContext(input: {
  scopeSummary: ReviewScopeSummary;
  directTargetEvidence?: ReviewEvidenceContext["directTargetEvidence"];
  periodEvidence?: ReviewEvidenceContext["periodEvidence"];
  indirectEvidence?: ReviewEvidenceContext["indirectEvidence"];
  derivedOutputEvidence?: ReviewEvidenceContext["derivedOutputEvidence"];
  existingReviewContentEvidence?: ReviewEvidenceContext["existingReviewContentEvidence"];
  taskEvidence?: ReviewEvidenceContext["taskEvidence"];
  experimentEvidence?: ReviewEvidenceContext["experimentEvidence"];
  literatureEvidence?: ReviewEvidenceContext["literatureEvidence"];
  outputEvidence?: ReviewEvidenceContext["outputEvidence"];
  warnings?: string[];
  missingReferences?: MissingEntityReference[];
  partial?: boolean;
  partialReasons?: string[];
  limitations?: ReviewEvidenceLimitations[];
}): ReviewEvidenceContext {
  const contextWithoutStats = {
    scopeSummary: input.scopeSummary,
    directTargetEvidence: input.directTargetEvidence ?? [],
    periodEvidence: input.periodEvidence ?? [],
    indirectEvidence: input.indirectEvidence ?? [],
    derivedOutputEvidence: input.derivedOutputEvidence ?? [],
    existingReviewContentEvidence: input.existingReviewContentEvidence ?? [],
    taskEvidence: input.taskEvidence ?? [],
    experimentEvidence: input.experimentEvidence ?? [],
    literatureEvidence: input.literatureEvidence ?? [],
    outputEvidence: input.outputEvidence ?? [],
    boundary: {
      ...createReviewEvidenceBoundary(),
      aggregationWiringDeferred: false,
      sourceBoundary:
        "Review aggregation evidence is classified by scope anchor, direct target, existing content, indirect cross-module support, and derived output chain."
    },
    warnings: uniqueStrings(input.warnings ?? []),
    missingReferences: uniqueMissingReferences(input.missingReferences ?? []),
    partial: Boolean(input.partial),
    partialReasons: uniqueStrings(input.partialReasons ?? []),
    limitations: input.limitations ?? []
  };

  return {
    ...contextWithoutStats,
    stats: summarizeReviewEvidenceStats(contextWithoutStats)
  };
}

export function classifyReviewTargetEvidence(
  targets: Array<EntitySummary | LinkedEntitySummary>
): ReviewDirectTargetEvidence[] {
  return targets.map((target) => {
    const summary = targetSummaryFromTarget(target);
    const missingReferences: MissingEntityReference[] = summary.sourceAvailable
      ? []
      : [
          {
            targetType: targetTypeForSummary(summary),
            targetId: summary.entityId,
            reason: "target_not_found",
            message: summary.missingReason
          }
        ];

    return {
      sourceKind: sourceKindForTarget(summary),
      role: roleForTarget(summary),
      scopeSensitivity: sensitivityForTarget(summary),
      sourceBoundary: sourceBoundaryForTarget(summary),
      entity: summary,
      link: "target" in target ? target : undefined,
      targetType: targetTypeForSummary(summary),
      targetId: summary.entityId,
      warnings: summary.sourceAvailable
        ? []
        : [`Review direct target is missing: ${targetTypeForSummary(summary)}:${summary.entityId}.`],
      missingReferences,
      partial: !summary.sourceAvailable
    };
  });
}

export function createReviewEvidenceBase(input: {
  sourceKind: ReviewEvidenceSourceKind;
  role: ReviewEvidenceRole;
  scopeSensitivity: ReviewEvidenceScopeSensitivity[];
  sourceBoundary: string;
  evidence?: EvidenceSummary;
  entity?: EntitySummary;
  link?: LinkedEntitySummary;
  warnings?: string[];
  missingReferences?: MissingEntityReference[];
  partial?: boolean;
}): ReviewEvidenceBase {
  return {
    sourceKind: input.sourceKind,
    role: input.role,
    scopeSensitivity: input.scopeSensitivity,
    sourceBoundary: input.sourceBoundary,
    evidence: input.evidence,
    entity: input.entity,
    link: input.link,
    warnings: uniqueStrings(input.warnings ?? []),
    missingReferences: uniqueMissingReferences(input.missingReferences ?? []),
    partial: Boolean(input.partial)
  };
}

export function summarizeReviewEvidenceStats(
  context: Pick<
    ReviewEvidenceContext,
    | "directTargetEvidence"
    | "periodEvidence"
    | "indirectEvidence"
    | "derivedOutputEvidence"
    | "existingReviewContentEvidence"
    | "taskEvidence"
    | "experimentEvidence"
    | "literatureEvidence"
    | "outputEvidence"
    | "warnings"
    | "missingReferences"
  >
): ReviewEvidenceStats {
  const allEvidence = [
    ...context.directTargetEvidence,
    ...context.periodEvidence,
    ...context.indirectEvidence,
    ...context.derivedOutputEvidence,
    ...context.existingReviewContentEvidence,
    ...context.taskEvidence,
    ...context.experimentEvidence,
    ...context.literatureEvidence,
    ...context.outputEvidence
  ];

  return {
    directTargetEvidenceCount: context.directTargetEvidence.length,
    periodEvidenceCount: context.periodEvidence.length,
    indirectEvidenceCount: context.indirectEvidence.length,
    derivedOutputEvidenceCount: context.derivedOutputEvidence.length,
    existingReviewContentEvidenceCount: context.existingReviewContentEvidence.length,
    taskEvidenceCount: context.taskEvidence.length,
    experimentEvidenceCount: context.experimentEvidence.length,
    literatureEvidenceCount: context.literatureEvidence.length,
    outputEvidenceCount: context.outputEvidence.length,
    warningCount: context.warnings.length,
    missingReferenceCount: context.missingReferences.length,
    partialEvidenceCount: allEvidence.filter((item) => item.partial).length
  };
}

export function mergeReviewEvidenceWarnings(...warningGroups: string[][]): string[] {
  return uniqueStrings(warningGroups.flat());
}

export function markReviewEvidencePartial(
  context: ReviewEvidenceContext,
  reason: string,
  warnings: string[] = []
): ReviewEvidenceContext {
  const nextWarnings = mergeReviewEvidenceWarnings(context.warnings, warnings);
  const nextContext = {
    ...context,
    warnings: nextWarnings,
    partial: true,
    partialReasons: uniqueStrings([...context.partialReasons, reason])
  };

  return {
    ...nextContext,
    stats: summarizeReviewEvidenceStats(nextContext)
  };
}

export const reviewEvidenceContextService = {
  buildReviewScopeSummary,
  createReviewScopeSummary,
  createPeriodReviewScopeSummary,
  createReviewEvidenceBoundary,
  createEmptyReviewEvidenceContext,
  classifyReviewTargetEvidence,
  createReviewEvidenceContext,
  createReviewEvidenceBase,
  summarizeReviewEvidenceStats,
  mergeReviewEvidenceWarnings,
  markReviewEvidencePartial
};

export type ReviewEvidenceContextService = typeof reviewEvidenceContextService;
